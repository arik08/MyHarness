import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRawSessionEvent,
  canReplayFromLastEventId,
  createSessionReplayState,
  rawEventsAfterLastEventId,
  rememberSuppressedUserTranscript,
  replayEventsForState,
  updateSessionReplayState,
  withEventTimestamp,
} from "../modules/sessionReplay.js";

test("supplemental user responses preserve active streams across reconnects", () => {
  for (const kind of ["steering", "queued", "question_answer"]) {
    const state = createSessionReplayState();
    updateSessionReplayState(state, { type: "assistant_delta", message: "앞 문장. " });
    updateSessionReplayState(state, { type: "tool_input_delta", tool_name: "new_tool", tool_call_id: "tool-1", arguments_delta: '{"value":' });
    updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", kind, text: "추가 입력" } });
    updateSessionReplayState(state, { type: "assistant_delta", message: "뒤 문장." });
    updateSessionReplayState(state, { type: "tool_input_delta", tool_name: "new_tool", tool_call_id: "tool-1", arguments_delta: '42}' });
    const replay = replayEventsForState(state);
    assert.equal(replay.find(event => event.type === "assistant_delta")?.message, "앞 문장. 뒤 문장.", kind);
    assert.equal(replay.find(event => event.type === "assistant_delta")?.snapshot, true);
    assert.equal(replay.find(event => event.type === "tool_input_delta")?.arguments_delta, '{"value":42}', kind);
    updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", text: "실제 새 질문" } });
    assert.equal(replayEventsForState(state).some(event => ["assistant_delta", "tool_input_delta"].includes(event.type)), false);
  }
});

test("null call indexes do not collide with call zero in replay", () => {
  const state = createSessionReplayState();
  updateSessionReplayState(state, { type: "tool_input_delta", tool_name: "custom-a", tool_call_index: null, arguments_delta: "A" });
  updateSessionReplayState(state, { type: "tool_input_delta", tool_name: "custom-b", tool_call_index: 0, arguments_delta: "B" });
  assert.deepEqual(replayEventsForState(state).filter((event) => event.type === "tool_input_delta").map((event) => event.arguments_delta), ["A", "B"]);
});

test("original turn timestamps survive compact and cursor replay independently per session", () => {
  for (const startedAt of [1000, 9000]) {
    const state = createSessionReplayState();
    const raw = [];
    const event = withEventTimestamp({ type: "transcript_item", timestamp_ms: startedAt,
      item: { role: "user", text: "arbitrary request" } });
    updateSessionReplayState(state, event);
    appendRawSessionEvent(raw, 1, event);
    for (let visit = 0; visit < 3; visit++) {
      assert.equal(replayEventsForState(state)[0].timestamp_ms, startedAt);
      assert.equal(rawEventsAfterLastEventId(raw, "0")[0].event.timestamp_ms, startedAt);
    }
    rememberSuppressedUserTranscript(state, "next request");
    assert.ok(replayEventsForState(state).at(-1).timestamp_ms > startedAt);
  }
});

test("restoring saved history replaces the bootstrap identity before replay", () => {
  const state = createSessionReplayState();
  updateSessionReplayState(state, { type: "active_session", value: "bootstrap" });
  updateSessionReplayState(state, { type: "session_title", message: "새 대화" });
  updateSessionReplayState(state, { type: "clear_transcript" });
  updateSessionReplayState(state, {
    type: "history_snapshot", value: "saved-history", message: "저장된 대화",
    history_events: [{ type: "user", text: "원래 질문" }],
  });
  for (let visit = 0; visit < 3; visit += 1) {
    const replay = replayEventsForState(state);
    assert.equal(replay.some((event) => event.value === "bootstrap" || event.message === "새 대화"), false);
    assert.equal(replay.find((event) => event.type === "active_session")?.value, "saved-history");
    assert.equal(replay.find((event) => event.type === "session_title")?.message, "저장된 대화");
  }
});

for (const replacement of [
  { type: "clear_transcript" },
  { type: "history_snapshot", value: "another-chat", history_events: [{ type: "user", text: "another question" }] },
]) {
  test(`${replacement.type} does not replay the previous conversation's todo list`, () => {
    const state = createSessionReplayState();
    updateSessionReplayState(state, { type: "ready", state: { model: "test-model" } });
    updateSessionReplayState(state, { type: "todo_update", todo_markdown: "- [ ] old task" });
    updateSessionReplayState(state, replacement);
    assert.equal(replayEventsForState(state).some((event) => event.type === "todo_update"), false);
    assert.equal(replayEventsForState(state).some((event) => event.type === "ready"), true);
    updateSessionReplayState(state, { type: "todo_update", todo_markdown: "- [ ] new task" });
    assert.equal(replayEventsForState(state).find((event) => event.type === "todo_update")?.todo_markdown, "- [ ] new task");
  });
}

test("coalesces many assistant deltas into one live replay event", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", text: "긴 답변 요청" } });
  for (let index = 0; index < 1005; index += 1) {
    updateSessionReplayState(state, { type: "assistant_delta", message: String(index % 10) });
  }

  const replay = replayEventsForState(state);
  const assistantDeltas = replay.filter((event) => event.type === "assistant_delta");

  assert.equal(assistantDeltas.length, 1);
  assert.equal(assistantDeltas[0].message.length, 1005);
  assert.equal(assistantDeltas[0].message.startsWith("0123456789"), true);
});

test("coalesces streamed tool input deltas for live file previews", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, {
    type: "tool_input_delta",
    tool_name: "write_file",
    tool_call_index: 0,
    arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"hello",
  });
  updateSessionReplayState(state, {
    type: "tool_input_delta",
    tool_name: "write_file",
    tool_call_index: 0,
    arguments_delta: " world\"}",
  });

  const replay = replayEventsForState(state);
  const toolDeltas = replay.filter((event) => event.type === "tool_input_delta");

  assert.equal(toolDeltas.length, 1);
  assert.deepEqual(toolDeltas[0], {
    type: "tool_input_delta",
    tool_name: "write_file",
    tool_call_index: 0,
    arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"hello world\"}",
  });
});

test("preserves streamed tool call ids in live file preview snapshots", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, {
    type: "tool_input_delta",
    tool_name: "write_file",
    tool_call_id: "call-write",
    arguments_delta: "{\"path\":\"outputs/live.html\"}",
  });

  const replay = replayEventsForState(state);

  assert.equal(replay[0].tool_call_id, "call-write");
});

test("keeps only the latest status progress message in live replay", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, { type: "status", message: "맥락을 확인하고 있습니다." });
  updateSessionReplayState(state, { type: "status", message: "관련 파일을 읽고 있습니다." });

  const replay = replayEventsForState(state);
  const statuses = replay.filter((event) => event.type === "status");

  assert.deepEqual(statuses.map((event) => event.message), ["관련 파일을 읽고 있습니다."]);
});

test("replays a later MCP state snapshot after the ready event", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, {
    type: "state_snapshot",
    state: {
      phase: "starting",
      runtime_options: {
        providers: [{ value: "codex", label: "Codex Subscription" }],
      },
    },
  });
  updateSessionReplayState(state, { type: "ready", mcp_servers: [] });
  updateSessionReplayState(state, {
    type: "state_snapshot",
    state: { phase: "ready" },
    mcp_servers: [{ name: "ecos" }, { name: "kosis" }, { name: "eia" }],
  });

  const replay = replayEventsForState(state);

  assert.deepEqual(replay.map((event) => event.type), ["ready", "state_snapshot"]);
  assert.deepEqual(replay.at(-1).mcp_servers.map((server) => server.name), ["ecos", "kosis", "eia"]);
  assert.deepEqual(replay.at(-1).state.runtime_options.providers, [
    { value: "codex", label: "Codex Subscription" },
  ]);
});

test("carries runtime options from ready into a later partial state snapshot", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, {
    type: "ready",
    state: {
      runtime_options: {
        models: [{ value: "gpt-5.4", label: "GPT-5.4" }],
      },
    },
  });
  updateSessionReplayState(state, {
    type: "state_snapshot",
    state: { phase: "ready" },
  });

  const replay = replayEventsForState(state);
  assert.deepEqual(replay.at(-1).state.runtime_options.models, [
    { value: "gpt-5.4", label: "GPT-5.4" },
  ]);
});

test("keeps the user transcript when status messages exceed the stable replay limit", () => {
  const state = createSessionReplayState();

  updateSessionReplayState(state, { type: "transcript_item", item: { role: "user", text: "사용자 질문" } });
  for (let index = 0; index < 1001; index += 1) {
    updateSessionReplayState(state, { type: "status", message: `상태 ${index}` });
  }

  const replay = replayEventsForState(state);
  const userMessages = replay.filter((event) => event.type === "transcript_item" && event.item?.role === "user");
  const statuses = replay.filter((event) => event.type === "status");

  assert.deepEqual(userMessages.map((event) => event.item.text), ["사용자 질문"]);
  assert.deepEqual(statuses.map((event) => event.message), ["상태 1000"]);
});

test("keeps a suppressed optimistic user transcript for full state replay", () => {
  const state = createSessionReplayState();

  rememberSuppressedUserTranscript(state, "프론트에서 먼저 표시한 질문");
  updateSessionReplayState(state, { type: "assistant_complete", message: "답변 완료" });

  assert.deepEqual(
    replayEventsForState(state).map((event) => [event.type, event.item?.role || "", event.item?.text || event.message || ""]),
    [
      ["transcript_item", "user", "프론트에서 먼저 표시한 질문"],
      ["assistant_complete", "", "답변 완료"],
    ],
  );
});

test("returns raw replay events after Last-Event-ID without duplicating the last event", () => {
  const rawEvents = [];
  appendRawSessionEvent(rawEvents, 1, { type: "assistant_delta", message: "a" });
  appendRawSessionEvent(rawEvents, 2, { type: "assistant_delta", message: "b" });
  appendRawSessionEvent(rawEvents, 3, { type: "tool_completed", tool_name: "shell_command", output: "done" });

  assert.deepEqual(
    rawEventsAfterLastEventId(rawEvents, "2").map((entry) => entry.event),
    [{ type: "tool_completed", tool_name: "shell_command", output: "done" }],
  );
});

test("detects when Last-Event-ID is too old for complete raw replay", () => {
  const rawEvents = [];
  appendRawSessionEvent(rawEvents, 10, { type: "assistant_delta", message: "a" }, 2);
  appendRawSessionEvent(rawEvents, 11, { type: "assistant_delta", message: "b" }, 2);
  appendRawSessionEvent(rawEvents, 12, { type: "assistant_delta", message: "c" }, 2);

  assert.equal(canReplayFromLastEventId(rawEvents, "10"), true);
  assert.equal(canReplayFromLastEventId(rawEvents, "9"), false);
});

test("drops obsolete raw payloads when the transcript is replaced", () => {
  const events = [];
  appendRawSessionEvent(events, 1, {
    type: "history_snapshot",
    history_events: [{ type: "tool_completed", output: "x".repeat(100_000) }],
  });
  appendRawSessionEvent(events, 2, { type: "clear_transcript" });
  appendRawSessionEvent(events, 3, {
    type: "history_snapshot",
    history_events: [{ type: "assistant", text: "새로 선택한 대화" }],
  });

  assert.deepEqual(events.map((entry) => entry.id), [2, 3]);
  assert.equal(JSON.stringify(events).includes("x".repeat(1_000)), false);
  assert.equal(canReplayFromLastEventId(events, "1"), true);
});
