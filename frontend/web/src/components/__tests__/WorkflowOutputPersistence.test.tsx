import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { appReducer, initialAppState, type AppAction } from "../../state/reducer";
import type { BackendEvent } from "../../types/backend";
import type { AppState } from "../../types/ui";
import { MessageList } from "../MessageList";

function renderConversation(state: AppState) {
  let sendAction: (action: AppAction) => void;
  let currentState = state;
  function StateProbe() {
    const context = useAppState();
    sendAction = context.dispatch;
    currentState = context.state;
    return null;
  }
  render(<AppStateProvider initialState={state}><StateProbe /><MessageList /></AppStateProvider>);
  return {
    action: (action: AppAction) => act(() => sendAction(action)),
    event: (event: BackendEvent) => act(() => sendAction({ type: "backend_event", event })),
    state: () => currentState,
  };
}

function assertVisibleOutputs(expectedCount: number) {
  const previews = Array.from(document.querySelectorAll<HTMLElement>(".workflow-output-preview"));
  expect(previews).toHaveLength(expectedCount);
  for (const preview of previews) {
    expect(preview.closest("[hidden], [aria-hidden='true'], details:not([open])")).toBeNull();
    expect(preview.closest(".aside-timeline")).toBeNull();
    expect(preview.querySelector(".workflow-output-body")).toBeTruthy();
  }
  return previews;
}

function toggleAllWorkHistory() {
  for (const toggle of screen.getAllByRole("button", { name: "작업 과정 펼침/접기" })) {
    fireEvent.click(toggle);
  }
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("file output persistence through real conversation events", () => {
  it("retains streamed content after sparse completion, work-history collapse, and the next user turn", async () => {
    const initial = appReducer({ ...initialAppState, sessionId: "output-session" }, {
      type: "append_message", message: { id: "request-1", role: "user", text: "HTML 파일을 작성해주세요." },
    });
    const conversation = renderConversation(initial);
    conversation.event({
      type: "tool_input_delta", tool_name: "write_file", tool_call_id: "write-1", tool_call_index: 0,
      arguments_delta: '{"path":"outputs/evidence.html","content":"<main>first',
    });
    expect(screen.getByText("작성 중인 결과물 - evidence.html")).toBeTruthy();
    assertVisibleOutputs(1);

    conversation.event({
      type: "tool_input_delta", tool_name: "write_file", tool_call_id: "write-1", tool_call_index: 0,
      arguments_delta: ' second</main>"}',
    });
    conversation.event({ type: "tool_started", tool_name: "write_file", tool_call_id: "write-1", tool_input: { path: "outputs/evidence.html" } });
    conversation.event({ type: "tool_progress", tool_name: "write_file", tool_call_id: "write-1", message: "저장 중" });
    await waitFor(() => expect(document.querySelector(".workflow-output-body")?.textContent).toBe("<main>first second</main>"));
    toggleAllWorkHistory();
    assertVisibleOutputs(1);

    conversation.event({ type: "tool_completed", tool_name: "write_file", tool_call_id: "write-1", output: "File saved." });
    conversation.event({ type: "assistant_complete", message: "파일을 작성했습니다." });
    conversation.event({ type: "line_complete" });
    await act(async () => {});
    expect(screen.getByText("작성 완료 - evidence.html")).toBeTruthy();
    expect(screen.getByRole("button", { name: "작업 과정 펼침/접기" }).getAttribute("aria-expanded")).toBe("false");
    expect(assertVisibleOutputs(1)[0].querySelector("pre")?.textContent).toBe("<main>first second</main>");
    toggleAllWorkHistory();
    assertVisibleOutputs(1);
    toggleAllWorkHistory();
    assertVisibleOutputs(1);

    conversation.action({ type: "append_message", message: { id: "request-2", role: "user", text: "같은 파일을 다시 작성해주세요." } });
    conversation.event({ type: "tool_started", tool_name: "write_file", tool_call_id: "write-2", tool_input: { path: "outputs/evidence.html", content: "<main>replacement</main>" } });
    conversation.event({ type: "tool_completed", tool_name: "write_file", tool_call_id: "write-2", output: "File saved again." });
    conversation.event({ type: "assistant_complete", message: "다시 작성했습니다." });
    conversation.event({ type: "line_complete" });
    await act(async () => {});
    const previews = assertVisibleOutputs(2);
    expect(previews.map((preview) => preview.querySelector("pre")?.textContent)).toEqual(["<main>first second</main>", "<main>replacement</main>"]);
    expect(conversation.state().workflowEventsByMessageId["request-1"].find((event) => event.toolCallId === "write-1")?.toolInput?.content).toBe("<main>first second</main>");
  });

  it("shows each saved write and edit independently while restored work history is collapsed", async () => {
    const conversation = renderConversation({ ...initialAppState, sessionId: "restored-session" });
    conversation.event({ type: "history_snapshot", value: "saved-output", history_events: [
      { type: "user", text: "파일 작성과 수정을 진행해주세요." },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "saved-write-1", tool_input: { path: "outputs/same.html", content: "<h1>First version</h1>" } },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "saved-write-1", output: "Saved." },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "saved-write-2", tool_input: { path: "outputs/same.html", content: "<h1>Second version</h1>" } },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "saved-write-2", output: "Saved again." },
      { type: "tool_started", tool_name: "mcp__future_files__edit_document", tool_call_id: "saved-edit", tool_input: { path: "outputs/same.html", old_string: "Second version", new_string: "Final version" } },
      { type: "tool_completed", tool_name: "mcp__future_files__edit_document", tool_call_id: "saved-edit", output: "Edited." },
      { type: "assistant", text: "완료했습니다." },
    ] });
    await act(async () => {});
    const previews = assertVisibleOutputs(3);
    expect(previews[0].querySelector("pre")?.textContent).toBe("<h1>First version</h1>");
    expect(previews[1].querySelector("pre")?.textContent).toBe("<h1>Second version</h1>");
    expect(previews[2].querySelector(".workflow-diff-line.removed")?.textContent).toContain("Second version");
    expect(previews[2].querySelector(".workflow-diff-line.added")?.textContent).toContain("Final version");
    expect(screen.getByRole("button", { name: "작업 과정 펼침/접기" }).getAttribute("aria-expanded")).toBe("false");
    toggleAllWorkHistory();
    assertVisibleOutputs(3);
    toggleAllWorkHistory();
    assertVisibleOutputs(3);
  });

  it("keeps the compact saved-source preview and its truncation marker visible on history reopen", () => {
    const content = "<!doctype html>\n...[이전 세션 빠른 복원을 위해 원문 축약 · 원본 12,000자]...\n</html>";
    const conversation = renderConversation(initialAppState);
    conversation.event({ type: "history_snapshot", preview_only: true, value: "compact-output", history_events: [
      { type: "user", text: "저장된 보고서를 확인해주세요." },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "compact-write", tool_input: { path: "outputs/compact.html", content, _history_replay_truncated: true } },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "compact-write", output: "Saved." },
      { type: "assistant", text: "작성했습니다." },
    ] });
    expect(screen.getByText("작성 완료 - compact.html")).toBeTruthy();
    expect(assertVisibleOutputs(1)[0].querySelector("pre")?.textContent).toBe(content);
    expect(screen.getByRole("button", { name: "작업 과정 펼침/접기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["error", "shutdown"] as const)("retains received file content with a failure state after %s", (type) => {
    const initial = appReducer(initialAppState, { type: "append_message", message: { role: "user", text: "새 파일을 작성해주세요." } });
    const conversation = renderConversation(initial);
    conversation.event({ type: "tool_input_delta", tool_name: "mcp__future_files__write_document", tool_call_id: "interrupted-write", arguments_delta: '{"path":"outputs/partial.txt","content":"Received partial output' });
    conversation.event(type === "error" ? { type, message: "요청이 중단되었습니다." } : { type });
    expect(screen.getByText("작성 실패 - partial.txt")).toBeTruthy();
    expect(assertVisibleOutputs(1)[0].querySelector("pre")?.textContent).toBe("Received partial output");
    expect(screen.queryByText("작성 완료 - partial.txt")).toBeNull();
  });
});
