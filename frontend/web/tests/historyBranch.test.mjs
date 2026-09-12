import assert from "node:assert/strict";
import test from "node:test";
import { branchSnapshot } from "../history-branch.mjs";

const message = (role, text) => ({ role, content: [{ type: "text", text }] });
function source() {
  return {
    session_id: "original", summary: "원본 대화", cwd: "/workspace", model: "test",
    messages: [message("user", "first"), message("assistant", "same"), message("user", "second"), message("assistant", "same"), message("user", "future")],
    history_events: [
      { type: "user", text: "first" }, { type: "assistant", text: "same", session_usage: { input_tokens: 999 } },
      { type: "line_complete" }, { type: "user", text: "second" }, { type: "assistant", text: "same" },
      { type: "user", text: "future" },
    ],
    tool_metadata: { async_agent_tasks: ["running"], user_input_archive: ["future"], compact_checkpoints: ["future"], session_title: "원본 대화" },
    usage: { input_tokens: 999 }, pinned: true, liked: true,
  };
}

test("branches at the selected occurrence and leaves the original untouched", () => {
  const original = source();
  const before = structuredClone(original);
  const branch = branchSnapshot(original, { sessionId: "child", answerIndex: 1, expectedText: "same", now: 100 });
  assert.deepEqual(original, before);
  assert.equal(branch.summary, "원본 대화 · 분기");
  assert.equal(branch.messages.length, 4);
  assert.equal(branch.history_events.length, 5);
  assert.equal(JSON.stringify(branch).includes("future"), false);
  assert.deepEqual(branch.usage, {});
  assert.equal(branch.tool_metadata.async_agent_tasks, undefined);
  assert.equal(branch.history_events[1].session_usage, undefined);
  assert.equal(branch.pinned, false);
  assert.deepEqual(branch.tool_metadata.branch_origin, { session_id: "original", answer_index: 1 });
  branch.messages[0].content[0].text = "changed";
  assert.deepEqual(original, before);
});

test("preserves preceding tool exchanges and images without copying provider continuation state", () => {
  const original = source();
  original.messages.splice(1, 0,
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "evidence" }] },
  );
  original.messages[0].content.push({ type: "image", data: "image", media_type: "image/png" });
  original.messages[3].content.push({ type: "responses_state", response_id: "old-response" });
  const branch = branchSnapshot(original, { sessionId: "child", answerIndex: 0, expectedText: "same" });
  assert.equal(branch.messages.length, 4);
  assert.equal(branch.messages[0].content[1].type, "image");
  assert.equal(branch.messages[2].content[0].tool_use_id, "t1");
  assert.deepEqual(branch.messages[3].content, [{ type: "text", text: "same" }]);
});

test("does not treat commentary before tools as a completed branching point", () => {
  const original = source();
  original.history_events.splice(1, 0, { type: "assistant", text: "checking" }, { type: "tool_started", tool_name: "read_file" });
  const branch = branchSnapshot(original, { sessionId: "child", answerIndex: 0, expectedText: "same" });
  assert.equal(branch.history_events.at(-1).text, "same");
  assert.throws(() => branchSnapshot(original, { sessionId: "child", answerIndex: 0, expectedText: "checking" }));
});

test("rebuilds compacted history from the prefix without leaking later summary or state", () => {
  const original = source();
  original.messages = [message("user", "compacted summary with future content")];
  const branch = branchSnapshot(original, { sessionId: "child", answerIndex: 0, expectedText: "same" });
  assert.deepEqual(branch.messages, [message("user", "first"), message("assistant", "same")]);
  assert.equal(JSON.stringify(branch).includes("future"), false);
});

test("rejects missing, negative, fractional and stale anchors", () => {
  for (const answerIndex of [-1, 0.5, 2, "0", null]) {
    assert.throws(() => branchSnapshot(source(), { sessionId: "child", answerIndex, expectedText: "same" }));
  }
  assert.throws(() => branchSnapshot(source(), { sessionId: "child", answerIndex: 0, expectedText: "different" }));
});

test("does not mistake a retained later duplicate for an old compacted answer", () => {
  const original = source();
  original.messages = [message("user", "summary with future content"), message("assistant", "same")];
  const branch = branchSnapshot(original, { sessionId: "child", answerIndex: 0, expectedText: "same" });
  assert.deepEqual(branch.messages, [message("user", "first"), message("assistant", "same")]);
});
