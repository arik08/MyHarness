import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalogCache } from "../modules/modelCatalogCache.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("concurrent cold requests share discovery and warm reads reuse it", async () => {
  let calls = 0;
  const work = deferred();
  const read = createModelCatalogCache(() => { calls++; return work.promise; });
  const first = read("config");
  const second = read("config");
  work.resolve({ models: ["new-model"] });
  assert.deepEqual(await first, await second);
  assert.deepEqual(await read("config"), { models: ["new-model"] });
  assert.equal(calls, 1);
});

test("expired metadata returns immediately while one refresh runs", async () => {
  let time = 0, calls = 0;
  const refresh = deferred();
  const read = createModelCatalogCache(() => ++calls === 1 ? "old" : refresh.promise,
    { ttlMs: 10, now: () => time });
  assert.equal(await read("config"), "old");
  time = 11;
  assert.equal(await read("config"), "old");
  assert.equal(await read("config"), "old");
  assert.equal(calls, 2);
  refresh.resolve("new");
  await new Promise(setImmediate);
  assert.equal(await read("config"), "new");
});

test("configuration changes cannot be overwritten by an older discovery", async () => {
  const old = deferred();
  let calls = 0;
  const read = createModelCatalogCache(() => ++calls === 1 ? old.promise : "custom-provider");
  const first = read("old-config");
  assert.equal(await read("new-config"), "custom-provider");
  old.resolve("old-provider");
  await first;
  assert.equal(await read("new-config"), "custom-provider");
  assert.equal(calls, 2);
});

test("failed cold loads retry and failed refreshes retain usable metadata", async () => {
  let calls = 0, time = 0;
  const read = createModelCatalogCache(() => {
    calls++;
    if (calls === 1 || calls === 3) throw new Error("unavailable");
    return calls;
  }, { ttlMs: 10, now: () => time });
  await assert.rejects(read("config"), /unavailable/);
  assert.equal(await read("config"), 2);
  time = 11;
  assert.equal(await read("config"), 2);
  await new Promise(setImmediate);
  assert.equal(await read("config"), 2);
  await new Promise(setImmediate);
  assert.equal(await read("config"), 4);
});
