import test from "node:test";
import assert from "node:assert/strict";
import { createSessionReplayState, updateSessionReplayState, replayEventsForState, rawEventsAfterLastEventId } from "../modules/sessionReplay.js";

const pending = { type: "modal_request", modal: { kind: "question", request_id: "a", questions: [{ id: "q", question: "Choose", choices: [] }] } };
const answered = { type: "modal_request", modal: { kind: "question", request_id: "a", status: "answered" } };

test("reconnect restores only the latest state of the question round", () => {
  const state = createSessionReplayState();
  updateSessionReplayState(state, pending);
  assert.deepEqual(replayEventsForState(state), [pending]);
  updateSessionReplayState(state, answered);
  assert.deepEqual(replayEventsForState(state), [answered]);
  const next = { ...pending, modal: { ...pending.modal, request_id: "b" } };
  updateSessionReplayState(state, next);
  updateSessionReplayState(state, answered);
  assert.deepEqual(replayEventsForState(state), [next]);
});

for (const kind of ["permission", "question"]) {
  test(`reconnect restores pending ${kind} and its final acknowledgement`, () => {
    const state = createSessionReplayState();
    const request = { type: "modal_request", modal: { kind, request_id: "pending-a", question: "Continue?", reason: "Write a file" } };
    const closed = { type: "modal_request", modal: { kind, request_id: "pending-a", status: "cancelled" } };
    updateSessionReplayState(state, request);
    assert.deepEqual(replayEventsForState(state), [request]);
    updateSessionReplayState(state, closed);
    assert.deepEqual(replayEventsForState(state), [closed]);
    const next = { ...request, modal: { ...request.modal, request_id: "pending-b" } };
    updateSessionReplayState(state, next);
    updateSessionReplayState(state, closed);
    assert.deepEqual(replayEventsForState(state), [next]);
    assert.deepEqual(rawEventsAfterLastEventId([request, closed].map((event, index) => ({ id: index + 1, event })), "0").map(entry => entry.event), [request, closed]);
    updateSessionReplayState(state, { type: "clear_transcript" });
    assert.deepEqual(replayEventsForState(state), []);
  });
}

test("incremental replay excludes unaddressable permission prompts", () => {
  const events = [pending, answered, { type: "modal_request", modal: { kind: "permission" } }].map((event, id) => ({ id: id + 1, event }));
  assert.deepEqual(rawEventsAfterLastEventId(events, "1").map(({ event }) => event), [answered]);
});

test("conversation reset removes pending question replay", () => {
  const state = createSessionReplayState();
  updateSessionReplayState(state, pending);
  updateSessionReplayState(state, { type: "clear_transcript" });
  assert.deepEqual(replayEventsForState(state), []);
});
