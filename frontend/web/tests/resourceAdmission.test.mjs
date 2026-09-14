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


test("closed waiting tabs expire while clients that keep polling retain their place", () => {
  const sessionCapacityQueue = [{ id: "closed", lastPolledAt: Date.now() - 61_000 }, { id: "live", lastPolledAt: Date.now() }];
  const context = vm.createContext({ sessionCapacityQueue });
  vm.runInContext(sourceFunction("pruneAbandonedSessionRequests"), context);
  context.pruneAbandonedSessionRequests();
  assert.deepEqual(sessionCapacityQueue.map((entry) => entry.id), ["live"]);
});
