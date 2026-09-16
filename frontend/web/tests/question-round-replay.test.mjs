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

test("incremental replay includes question acknowledgement but never permission prompts", () => {
  const events = [pending, answered, { type: "modal_request", modal: { kind: "permission" } }].map((event, id) => ({ id: id + 1, event }));
  assert.deepEqual(rawEventsAfterLastEventId(events, "1").map(({ event }) => event), [answered]);
});

test("conversation reset removes pending question replay", () => {
  const state = createSessionReplayState();
  updateSessionReplayState(state, pending);
  updateSessionReplayState(state, { type: "clear_transcript" });
  assert.deepEqual(replayEventsForState(state), []);
});
