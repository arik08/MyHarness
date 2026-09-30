import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createSessionReplayState, rememberSuppressedUserTranscript, replayEventsForState, updateSessionReplayState } from "../modules/sessionReplay.js";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const startMessageSource = source.slice(source.indexOf("function startSessionMessage("), source.indexOf("function enqueueSessionMessage("));

test("late runtime acknowledgements and errors do not finish a new question", () => {
  const updateSource = source.slice(source.indexOf("function updateSessionStateFromBackendEvent("), source.indexOf("function liveSessionPayload("));
  let idleCloses = 0;
  const update = vm.runInNewContext(`(${updateSource})`, {
    activityLog: { event() {} },
    cancelIdleClientClose() {},
    scheduleIdleClientClose() { idleCloses += 1; },
    scheduleCapacityQueueDrain() {},
  });
  const session = { busy: false };
  update(session, { type: "status" });
  for (const type of ["line_complete", "error"]) {
    update(session, { type, request_scope: "runtime" });
    assert.equal(session.busy, true);
    assert.equal(idleCloses, 0);
  }
  update(session, { type: "line_complete", quiet: true });
  assert.equal(session.busy, false);
  assert.equal(idleCloses, 1);
});

function harness() {
  const session = { replayState: createSessionReplayState() };
  let payload;
  const start = vm.runInNewContext(`(${startMessageSource})`, {
    rememberSuppressedUserTranscript,
    visibleSubmittedUserText: (line) => line,
    sendBackend: (_session, value) => { payload = value; return true; },
    activityLog: { received() {} },
    emit: (_session, event) => updateSessionReplayState(session.replayState, event),
  });
  return { session, start, payload: () => payload };
}

test("replays a question after a late new-session reset and switching back during a tool run", () => {
  const { session, start, payload } = harness();
  const question = "태양계 행성 궤도 3D 시뮬레이터를 HTML로";
  start(session, { line: question, attachments: [], attachmentRefs: [], suppressUserTranscript: true });
  // The backend processes an earlier start_new_session before submit_line.
  updateSessionReplayState(session.replayState, { type: "clear_transcript" });
  if (!payload().suppress_user_transcript) {
    updateSessionReplayState(session.replayState, { type: "transcript_item", item: { role: "user", text: question } });
  }
  updateSessionReplayState(session.replayState, { type: "tool_started", tool_name: "skill" });
  updateSessionReplayState(session.replayState, { type: "tool_completed", tool_name: "skill", output: "loaded" });
  const replay = replayEventsForState(session.replayState);
  assert.equal(replay[0]?.item?.text, question);
  assert.equal(replay.filter((event) => event.item?.role === "user").length, 1);
  assert.equal(replay.at(-1).type, "tool_completed");
});

test("attachment-only questions also receive an authoritative backend transcript", () => {
  const { session, start, payload } = harness();
  start(session, { line: "", attachments: [{ name: "image.png" }], suppressUserTranscript: true });
  assert.equal(payload().suppress_user_transcript, false);
});

test("quiet commands retain their transcript suppression", () => {
  for (const line of ["/help", "/plan", "!dir"]) {
    const { session, start, payload } = harness();
    start(session, { line, suppressUserTranscript: true });
    assert.equal(payload().suppress_user_transcript, true);
  }
});
