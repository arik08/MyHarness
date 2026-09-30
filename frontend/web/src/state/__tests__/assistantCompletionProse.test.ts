import { describe, expect, it } from "vitest";
import { appReducer, initialAppState } from "../reducer";
import type { BackendEvent } from "../../types/backend";
import type { AppState } from "../../types/ui";

const path = "outputs/new-report.html";
const progress = "출처를 비교하고 작은 화면의 표 배치를 확인하겠습니다.";

function send(state: AppState, event: BackendEvent) {
  return appReducer(state, { type: "backend_event", event });
}

function writtenReport() {
  let state = appReducer(initialAppState, { type: "append_message", message: { role: "user", text: "보고서를 작성하고 검증해 주세요." } });
  state = send(state, { type: "tool_started", tool_name: "write_file", tool_call_id: "write", tool_input: { path, content: "<html>Report</html>" } });
  return send(state, { type: "tool_completed", tool_name: "write_file", tool_call_id: "write", is_error: false, output: path });
}

describe("assistant completion prose", () => {
  it("keeps empty tool batches silent after a file has been written, including new tools", () => {
    let state = writtenReport();
    for (const [index, tool] of ["skill", "cmd", "mcp__future__verify", "edit_file"].entries()) {
      state = send(state, { type: "assistant_complete", message: "", has_tool_uses: true });
      expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
      expect(state.workflowEvents.filter((event) => event.noteSource === "progress")).toHaveLength(0);
      state = send(state, { type: "tool_started", tool_name: tool, tool_call_id: `check-${index}` });
      state = send(state, { type: "tool_completed", tool_name: tool, tool_call_id: `check-${index}`, is_error: index === 2, output: index === 2 ? "검증 서비스에 연결할 수 없습니다." : "checked" });
    }
    state = send(state, { type: "assistant_complete", message: progress, has_tool_uses: true });
    expect(state.workflowEvents.filter((event) => event.noteSource === "progress").map((event) => event.detail)).toEqual([progress]);
    state = send(state, { type: "assistant_complete", message: "", has_tool_uses: false });
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "", isComplete: true, artifacts: [{ path }] });
    expect(state.workflowEvents.some((event) => event.toolName === "mcp__future__verify" && event.status === "error")).toBe(true);
  });

  it.each([true, false])("keeps streamed real text when completion has no body (tool batch=%s)", (has_tool_uses) => {
    let state = writtenReport();
    state = send(state, { type: "assistant_delta", message: progress });
    state = send(state, { type: "assistant_complete", message: "", has_tool_uses });
    expect(state.messages.at(-1)?.text).toBe(progress);
    if (has_tool_uses) {
      expect(state.messages.at(-1)?.responsePhase).toBe("commentary");
      expect(state.messages.at(-1)?.artifacts || []).toEqual([]);
      expect(state.workflowEvents.find((event) => event.noteSource === "progress")?.detail).toBe(progress);
    } else {
      expect(state.messages.at(-1)?.artifacts?.map((artifact) => artifact.path)).toEqual([path]);
    }
  });

  it("retains final cards for an empty streamed answer without adding prose", () => {
    let state = writtenReport();
    state = send(state, { type: "assistant_delta", message: "" });
    state = send(state, { type: "assistant_complete", message: "", has_tool_uses: false });
    expect(state.messages.at(-1)).toMatchObject({ text: "", isComplete: true, artifacts: [{ path }] });
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it.each([true, false])("replays silent batches and final cards (explicit response phase=%s)", (explicitPhase) => {
    const phase = (has_tool_uses: boolean) => explicitPhase ? { has_tool_uses } : {};
    const state = send(initialAppState, { type: "history_snapshot", history_events: [
      { type: "user", text: "보고서 작성" },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "write", tool_input: { path, content: "<html>Report</html>" } },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "write", is_error: false, output: path },
      { type: "assistant", text: "", ...phase(true) },
      { type: "tool_started", tool_name: "mcp__new__verify", tool_call_id: "verify" },
      { type: "tool_completed", tool_name: "mcp__new__verify", tool_call_id: "verify", is_error: true, output: "연결 실패" },
      { type: "assistant", text: progress, ...phase(true) },
      { type: "tool_started", tool_name: "cmd", tool_call_id: "render" },
      { type: "tool_completed", tool_name: "cmd", tool_call_id: "render", is_error: false, output: "checked" },
      { type: "assistant", text: "", ...phase(false) },
      { type: "line_complete" },
    ] });
    expect(state.messages.map((message) => [message.role, message.text])).toEqual([["user", "보고서 작성"], ["assistant", ""]]);
    expect(state.messages.at(-1)?.artifacts?.map((artifact) => artifact.path)).toEqual([path]);
    expect(state.workflowEvents.filter((event) => event.noteSource === "progress").map((event) => event.detail)).toEqual([progress]);
    expect(state.workflowEvents.some((event) => event.toolName === "mcp__new__verify" && event.status === "error")).toBe(true);
  });

  it.each(["출처 4건을 비교했고 미확인 항목을 보고서에 표시했습니다.", ""])("ignores a trailing legacy empty record after a final answer (%s)", (text) => {
    const state = send(initialAppState, { type: "history_snapshot", history_events: [
      { type: "user", text: "보고서 작성" },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "write", tool_input: { path } },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "write", is_error: false, output: path },
      { type: "assistant", text },
      { type: "assistant", text: "" },
      { type: "line_complete" },
    ] });
    const answers = state.messages.filter((message) => message.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0].text).toBe(text);
    expect(answers[0].artifacts?.map((artifact) => artifact.path)).toEqual([path]);
    expect(state.workflowEvents.filter((event) => event.noteSource === "progress")).toHaveLength(0);
  });

  it("does not invent prose or final cards for a failed write", () => {
    let state = send(initialAppState, { type: "tool_started", tool_name: "write_file", tool_call_id: "failed", tool_input: { path } });
    state = send(state, { type: "tool_completed", tool_name: "write_file", tool_call_id: "failed", is_error: true, output: "쓰기 권한이 없습니다." });
    state = send(state, { type: "assistant_complete", message: "", has_tool_uses: true });
    state = send(state, { type: "assistant_complete", message: "", has_tool_uses: false });
    expect(state.messages).toHaveLength(0);
    expect(state.workflowEvents.some((event) => event.toolName === "write_file" && event.status === "error")).toBe(true);
  });
});
