import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseWriter, encodeSseEvent, writeSseReplayEvent } from "../modules/sseWriter.js";

class Response extends EventEmitter {
  frames = [];
  accept = false;
  destroyed = false;
  write(frame) { this.frames.push(frame); return this.accept; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("a blocked write is accepted once; later frames drain in exact id/data order", async () => {
  const response = new Response();
  const writer = createSseWriter(response);
  const frames = [1, 2, 3].map((id) => encodeSseEvent({ type: "assistant_delta", text: `한글 ${id}` }, id));
  for (const frame of frames) assert.equal(writer.write(frame), true);
  assert.deepEqual(response.frames, [frames[0]]);
  assert.equal(writer.queuedBytes, Buffer.byteLength(frames[1] + frames[2]));
  const completion = writer.waitForIdle();
  response.accept = true;
  response.emit("drain");
  assert.equal(await completion, true);
  assert.deepEqual(response.frames, frames);
  assert.equal(writer.queuedBytes, 0);
  writer.close();
});

test("a slow client exceeding its byte budget disconnects without blocking another client", async () => {
  const slow = new Response();
  const fast = new Response();
  fast.accept = true;
  const blocked = createSseWriter(slow, { maxQueuedBytes: 20 });
  const healthy = createSseWriter(fast);
  blocked.write("accepted");
  const waiting = blocked.waitForIdle();
  assert.equal(blocked.write("한".repeat(6)), true);
  assert.equal(blocked.write("한"), false);
  assert.equal(slow.destroyed, true);
  assert.equal(blocked.queuedBytes, 0);
  assert.equal(await waiting, false);
  assert.equal(healthy.write("still serving"), true);
  assert.deepEqual(fast.frames, ["still serving"]);
  healthy.close();
});

test("repeated partial drains preserve a long stream when new frames arrive while blocked", async () => {
  const response = new Response();
  const writer = createSseWriter(response);
  const frames = Array.from({ length: 10_000 }, (_, id) => encodeSseEvent({ text: `row ${id}` }, id));
  for (const frame of frames) assert.equal(writer.write(frame), true);
  for (let index = 0; index < 1200; index++) response.emit("drain");
  const extra = encodeSseEvent({ text: "after partial drain" }, 10_000);
  assert.equal(writer.write(extra), true);
  const completion = writer.waitForIdle();
  response.accept = true;
  response.emit("drain");
  assert.equal(await completion, true);
  assert.deepEqual(response.frames, [...frames, extra]);
  assert.equal(writer.queuedBytes, 0);
  writer.close();
});

test("replay waits for drain and wakes on a disconnect without acknowledging later frames", async () => {
  const response = new Response();
  let completed = false;
  const write = writeSseReplayEvent(response, { type: "history_snapshot" }, 10).then((ok) => { completed = true; return ok; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(response.frames.length, 1);
  response.destroy();
  assert.equal(await write, false);
});

test("a legitimate single large replay frame can drain before the next frame", async () => {
  const response = new Response();
  const write = writeSseReplayEvent(response, { type: "history_snapshot", text: "x".repeat(9 * 1024 * 1024) });
  assert.equal(response.destroyed, false);
  response.accept = true;
  response.emit("drain");
  assert.equal(await write, true);
  response.destroy();
});
