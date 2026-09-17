import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { resourceAdmissionReason } from "../modules/resourceAdmission.js";
import { createServerMetrics } from "../modules/serverMetrics.js";

const limits = { maxCpuPercent: 95, maxMemoryPercent: 98 };
const resources = (cpuPercent = 20, used = 50) => ({ cpuPercent, totalMemoryBytes: 1000, availableMemoryBytes: (100 - used) * 10 });
test("CPU and memory thresholds include the boundary and reject missing, invalid or stale measurements", () => {
  const snapshot = (value) => ({ resources: value, sampledAt: 1000 });
  assert.equal(resourceAdmissionReason(snapshot(resources(94.9, 97.9)), limits, 1000), "");
  assert.match(resourceAdmissionReason(snapshot(resources(95)), limits, 1000), /CPU/);
  assert.match(resourceAdmissionReason(snapshot(resources(20, 98)), limits, 1000), /메모리/);
  for (const value of [null, resources(null), resources(NaN), resources(101), { ...resources(), totalMemoryBytes: 0 }]) {
    assert.match(resourceAdmissionReason(snapshot(value), limits, 1000), /측정/);
  }
  assert.match(resourceAdmissionReason(snapshot(resources()), limits, 21_001), /측정/);
  assert.match(resourceAdmissionReason({ ...snapshot(resources()), resourceError: "failed" }, limits, 1000), /측정/);
});

// Execute the server's actual admission and queue drain functions with a controllable
// collector; no host-wide CPU/memory exhaustion is needed to verify automatic recovery.
const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function sourceFunction(name) {
  const start = serverSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = serverSource.indexOf("\nfunction ", start + 1);
  const nextAsync = serverSource.indexOf("\nasync function ", start + 1);
  return serverSource.slice(start, Math.min(...[next, nextAsync].filter((n) => n >= 0)));
}
test("both queues automatically resume after sampling recovery without closing running work", async () => {
  let sample = resources(99);
  const started = [];
  const sessions = new Map([["waiting", { id: "waiting", clientId: "a" }], ["running", { id: "running", clientId: "b", busy: true }]]);
  const context = vm.createContext({
    resourceAdmissionReason, currentConcurrencySettings: () => limits,
    sessions, maxBusySessionsPerClient: 3,
    responseCapacityQueue: [{ sessionId: "waiting", type: "message", request: {}, queuedAt: 0 }],
    sessionCapacityQueue: [{ id: "new", options: {}, queuedAt: 0 }],
    capacityQueueDrainRunning: false, capacityQueueDrainPending: false,
    emit() {}, emitResponseQueuePositions() {}, httpError: (status) => Object.assign(new Error(), { status }),
    startSessionMessage: (s) => { s.busy = true; started.push(s.id); },
    createBackendSession: async () => ({ id: "new", workspace: {} }),
    rememberSessionCapacityResult: (id) => started.push(id),
  });
  let drain;
  context.serverMetrics = createServerMetrics({
    sampleResources: async () => { if (sample === null) throw new Error(); return sample; },
    readLoad: () => ({}), onSample: () => { drain = context.drainCapacityQueues(); },
  });
  vm.runInContext(["countBusySessionsForClient", "sessionHasCapacity", "responseHasCapacity", "pruneAbandonedSessionRequests", "drainCapacityQueues"].map(sourceFunction).join("\n"), context);
  for (const value of [resources(99), resources(20, 99), null]) {
    sample = value;
    await context.serverMetrics.sample(); await drain;
    assert.deepEqual(started, []);
    assert.equal(sessions.get("running").busy, true);
  }
  sample = resources();
  await context.serverMetrics.sample(); await drain;
  assert.deepEqual(started, ["waiting", "new"]);
  assert.equal(sessions.get("running").busy, true);
  for (let i = 0; i < 550; i++) sessions.set(`s${i}`, { clientId: `c${i}`, busy: true });
  assert.equal(context.sessionHasCapacity(), true);
  assert.equal(context.responseHasCapacity({ clientId: "fresh" }), true);
  sessions.set("same1", { clientId: "limited", busy: true });
  sessions.set("same2", { clientId: "limited", busy: true });
  sessions.set("same3", { clientId: "limited", busy: true });
  assert.equal(context.responseHasCapacity({ clientId: "limited" }), false);
});


test("a limited client does not block other clients and retains its own FIFO order", async () => {
  const started = [];
  const sessions = new Map([
    ["running", { id: "running", clientId: "a", busy: true }],
    ...["a1", "a2", "b1", "b2"].map((id) => [id, { id, clientId: id[0], capacityQueued: true }]),
  ]);
  const responseCapacityQueue = ["a1", "a2", "gone", "b1", "b2"].map((sessionId) => ({ sessionId, type: "message", queuedAt: 0 }));
  const context = vm.createContext({
    sessions, responseCapacityQueue, sessionCapacityQueue: [], maxBusySessionsPerClient: 1,
    capacityQueueDrainRunning: false, capacityQueueDrainPending: false,
    sessionHasCapacity: () => true, serverMetrics: { recordQueueWait() {} },
    emitResponseQueuePositions() {}, httpError: () => new Error("closed"),
    startSessionMessage: (session) => { session.busy = true; session.capacityQueued = false; started.push(session.id); },
  });
  vm.runInContext(["countBusySessionsForClient", "responseHasCapacity", "pruneAbandonedSessionRequests", "drainCapacityQueues"].map(sourceFunction).join("\n"), context);
  await context.drainCapacityQueues();
  assert.deepEqual(started, ["b1"]);
  assert.deepEqual(responseCapacityQueue.map((entry) => entry.sessionId), ["a1", "a2", "b2"]);
  sessions.get("running").busy = false;
  sessions.get("b1").busy = false;
  await context.drainCapacityQueues();
  assert.deepEqual(started, ["b1", "a1", "b2"]);
  assert.deepEqual(responseCapacityQueue.map((entry) => entry.sessionId), ["a2"]);
});

test("an immediate response gate reserves its slot before another caller can enter", async () => {
  const session = { id: "edit", clientId: "a", busy: false };
  const responseCapacityQueue = [];
  const context = vm.createContext({
    sessions: new Map([[session.id, session]]), maxBusySessionsPerClient: 1,
    sessionHasCapacity: () => true, cancelIdleClientClose() {},
    responseCapacityQueue, crypto: { randomUUID: () => "queued" }, emitResponseQueuePositions() {},
    httpError: (status) => Object.assign(new Error(), { status }),
  });
  vm.runInContext(["countBusySessionsForClient", "responseHasCapacity", "waitForResponseCapacity"].map(sourceFunction).join("\n"), context);
  const first = context.waitForResponseCapacity(session);
  assert.equal(session.busy, true);
  assert.equal(context.responseHasCapacity({ clientId: "a" }), false);
  await first;
});

test("capacity-waiting sessions survive a disconnected screen's idle timer", () => {
  let timeout;
  let closed = false;
  const context = vm.createContext({
    backendIdleClientCloseMs: 1, clearTimeout() {},
    setTimeout(callback) { timeout = callback; return { unref() {} }; },
    shutdownSession() { closed = true; },
  });
  vm.runInContext(sourceFunction("scheduleIdleClientClose"), context);
  const session = { clients: new Set(), busy: false, capacityQueued: true };
  context.scheduleIdleClientClose(session);
  assert.equal(timeout, undefined);
  session.capacityQueued = false;
  context.scheduleIdleClientClose(session);
  session.capacityQueued = true;
  timeout();
  assert.equal(closed, false);
  session.capacityQueued = false;
  context.scheduleIdleClientClose(session);
  timeout();
  assert.equal(closed, true);
});

test("closed waiting tabs expire while clients that keep polling retain their place", () => {
  const sessionCapacityQueue = [{ id: "closed", lastPolledAt: Date.now() - 61_000 }, { id: "live", lastPolledAt: Date.now() }];
  const context = vm.createContext({ sessionCapacityQueue });
  vm.runInContext(sourceFunction("pruneAbandonedSessionRequests"), context);
  context.pruneAbandonedSessionRequests();
  assert.deepEqual(sessionCapacityQueue.map((entry) => entry.id), ["live"]);
});
