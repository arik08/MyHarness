import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createResourceSampler, createServerMetrics } from "../modules/serverMetrics.js";
import { fileURLToPath } from "node:url";
import { pythonEnvironmentCandidates } from "../modules/pythonEnvironment.js";

test("metrics retain 15 minutes, distinguish unavailable data, and bound samples", async () => {
  let time = 0;
  let failure = false;
  let calls = 0;
  const metrics = createServerMetrics({
    now: () => time, readLoad: () => ({ busySessions: 2 }),
    sampleResources: async () => { calls += 1; if (failure) throw new Error(); return { appMemoryBytes: 500 }; },
  });
  assert.equal(metrics.snapshot().resources, null);
  assert.equal(metrics.snapshot().queueWait.p95Ms, null);
  await metrics.sample();
  assert.equal(metrics.snapshot().resources.appMemoryBytes, 500);
  metrics.snapshot(); metrics.snapshot(true);
  assert.equal(calls, 1, "viewing metrics never samples resources again");
  for (let index = 1; index <= 20; index += 1) { time = index * 100; metrics.recordQueueWait(0); }
  assert.deepEqual(metrics.snapshot().queueWait, { count: 20, p95Ms: 1900 });
  time = 901_999;
  assert.equal(metrics.snapshot(true).history.length, 0);
  assert.equal(metrics.snapshot().queueWait.count, 1);
  failure = true;
  await metrics.sample();
  assert.equal(metrics.snapshot().resources, null);
  assert.equal(metrics.snapshot().sampledAt, null);
  assert.ok(metrics.snapshot().resourceError);
  for (let index = 0; index < 10_005; index += 1) metrics.recordQueueWait(time);
  assert.equal(metrics.snapshot().queueWait.count, 10_000);
});

test("ordinary API latency excludes streams, telemetry, errors and AI submissions", () => {
  const metrics = createServerMetrics({ now: () => 100, readLoad: () => ({}), sampleResources: async () => ({}) });
  function request(url, method = "GET", type = "application/json", code = 200) {
    const response = new EventEmitter();
    response.statusCode = code;
    response.getHeader = () => type;
    metrics.observeRequest({ url, method }, response);
    response.emit("finish");
  }
  request("/api/live-sessions");
  request("/api/history");
  request("/api/history", "GET", "application/json", 500);
  request("/api/message", "POST");
  request("/api/events", "GET", "text/event-stream");
  request("/api/server-metrics?history=1");
  request("/api/settings/concurrency");
  request("/api/auth/status");
  request("/index.html", "GET", "text/html");
  assert.equal(metrics.snapshot().api.count, 2);
  assert.ok(metrics.snapshot().api.p95Ms >= 0);
});

test("resource sampler measures this process tree and shuts down cleanly", async (t) => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const python = pythonEnvironmentCandidates(repoRoot)[0] || { file: "python", args: [] };
  const sampler = createResourceSampler(python, fileURLToPath(new URL("../scripts/resource_sample.py", import.meta.url)));
  t.after(() => sampler.stop());
  const first = await sampler.sample();
  assert.ok(Number.isFinite(first.cpuPercent) && first.cpuPercent >= 0 && first.cpuPercent <= 100);
  assert.ok(first.appMemoryBytes > 0);
  assert.ok(first.availableMemoryBytes > 0);
  assert.ok(first.totalMemoryBytes >= first.availableMemoryBytes);
  assert.ok(first.processCount >= 2);
  const next = await sampler.sample();
  assert.ok(next.cpuPercent >= 0 && next.cpuPercent <= 100);
});

test("failed collector returns an error and does not restart on every poll", async (t) => {
  const sampler = createResourceSampler({ file: "nonexistent-myharness-python", args: [] }, "missing.py");
  t.after(() => sampler.stop());
  await assert.rejects(sampler.sample());
  await assert.rejects(sampler.sample());
});
