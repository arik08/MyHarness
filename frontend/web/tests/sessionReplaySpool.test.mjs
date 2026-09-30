import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionReplayState, updateSessionReplayState } from "../modules/sessionReplay.js";
import { createSessionReplaySpool, snapshotSessionReplay, replaySessionSnapshot } from "../modules/sessionReplaySpool.js";

test("full replay preserves every conversation turn across eviction and immediate reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myharness-replay-test-"));
  const backlog = [];
  const spool = createSessionReplaySpool({ directory, onBufferedBytes: (bytes) => backlog.push(bytes) });
  const state = createSessionReplayState({ onEvict: (entry) => spool.append(entry), onReset: () => spool.reset() });
  const original = [];
  try {
    updateSessionReplayState(state, { type: "ready", state: { model: "fixture" } });
    for (let turn = 0; turn < 91; turn++) {
      const events = [{ type: "transcript_item", item: { role: "user", text: `question ${turn}` } }];
      for (let call = 0; call < 5; call++) events.push(
        { type: "tool_started", tool_call_id: `${turn}-${call}`, tool_name: "custom-tool" },
        { type: "tool_completed", tool_call_id: `${turn}-${call}`, tool_name: "custom-tool", output: "done" },
      );
      events.push({ type: "assistant_complete", message: `answer ${turn}` }, { type: "line_complete" });
      original.push(...events);
      for (const event of events) updateSessionReplayState(state, event);
    }
    assert.equal(state.stableEvents.length, 1000);
    const snapshot = snapshotSessionReplay(state, spool);
    // Evict more entries after capture, before the captured append queue drains.
    for (let index = 0; index < 50; index++) updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", text: `later ${index}` } });
    const replay = [];
    for await (const event of replaySessionSnapshot(snapshot, spool)) replay.push(event);
    assert.deepEqual(replay.filter((event) => event.type !== "ready"), original);
    assert.equal(replay.filter((event) => event.item?.role === "user").length, 91);
    assert.equal(replay.some((event) => event.item?.text.startsWith("later")), false);
    assert.equal(state.stableEvents.length, 1000);
    updateSessionReplayState(state, { type: "clear_transcript" });
    updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", text: "new conversation" } });
    const reset = [];
    for await (const event of replaySessionSnapshot(snapshotSessionReplay(state, spool), spool)) reset.push(event);
    assert.equal(reset.some((event) => event.item?.text.startsWith("question")), false);
  } finally {
    await spool.dispose();
    assert.ok(backlog.some((bytes) => bytes > 0));
    assert.equal(backlog.at(-1), 0);
    assert.deepEqual(await readdir(directory), []);
    await rm(directory, { recursive: true, force: true });
  }
});

test("reset waits for an existing snapshot reader and releases all spool files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myharness-replay-test-"));
  const spool = createSessionReplaySpool({ directory });
  try {
    spool.append({ order: 1, event: { type: "assistant_complete", message: "previous" } });
    const snapshot = spool.snapshot();
    spool.reset();
    const events = [];
    for await (const entry of spool.readBefore(snapshot, 2)) events.push(entry.event);
    assert.equal(events[0].message, "previous");
  } finally {
    await spool.dispose();
    assert.deepEqual(await readdir(directory), []);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed disk append rejects recovery before the existing transcript is cleared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myharness-replay-test-"));
  const spool = createSessionReplaySpool({ directory: join(directory, "missing") });
  try {
    spool.append({ order: 1, event: { type: "assistant_complete", message: "must remain visible" } });
    const snapshot = spool.snapshot();
    await assert.rejects(spool.ready(snapshot));
    spool.release(snapshot);
  } finally {
    await spool.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
