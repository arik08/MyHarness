import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AsideWorkflowTimeline, asideTimelineRows } from "../AsideWorkflowTimeline";
import { questionHistory } from "../QuestionHistory";
import type { WorkflowEvent } from "../../types/ui";
import { appReducer, initialAppState } from "../../state/reducer";

afterEach(() => { cleanup(); sessionStorage.clear(); });
const event: WorkflowEvent = {
  id: "round", toolCallId: "call", toolName: "ask_user_question", status: "done", title: "질문", detail: "완료",
  toolInput: { questions: [
    { id: "new-id", question: "필요한 자료는?", choices: [{ value: "a", label: "보고서", description: "상세 자료" }, { value: "b", label: "도표" }, { value: "c", label: "원본" }] },
    { id: "free", question: "추가 조건은?", choices: [] },
  ] },
  output: JSON.stringify({ answers: [{ id: "free", kind: "text", answer: "첫 줄\n둘째 줄" }, { id: "new-id", kind: "choice", answer: ["a", "b"] }] }),
};
it("keeps completed rounds collapsed and restores choices and multiline answers from serialized history", () => {
  const restored = JSON.parse(JSON.stringify(event));
  render(<AsideWorkflowTimeline events={[restored]} scope="test" duration={null} busy={false} expanded />);
  expect(screen.queryByLabelText("질의응답 기록")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /질의응답/ }));
  expect(screen.getByRole("button", { name: /보고서/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "도표" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "원본" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "원본" }));
  expect(screen.getByRole("button", { name: "원본" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText(/첫 줄/).textContent).toBe("첫 줄\n둘째 줄");
  expect(screen.queryByRole("button", { name: "답변 보내기" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /질의응답/ }));
  expect(screen.queryByLabelText("질의응답 기록")).toBeNull();
});
it("keeps rounds in recorded order between ordinary calls", () => {
  const call = { ...event, toolName: "read_file" };
  expect(asideTimelineRows([{ ...call, id: "before", toolCallId: "before" }, event, { ...call, id: "after", toolCallId: "after" }]).map((r) => r.kind)).toEqual(["actions", "note", "actions"]);
});
it("recovers the form from a backend history snapshot including a supplemental user answer", () => {
  const state = appReducer(initialAppState, { type: "backend_event", event: {
    type: "history_snapshot", value: "history", history_events: [
      { type: "user", text: "자료 작성" },
      { type: "tool_started", tool_name: event.toolName, tool_call_id: "call", tool_input: event.toolInput },
      { type: "user", kind: "question_answer", text: "질문과 답변" },
      { type: "tool_completed", tool_name: event.toolName, tool_call_id: "call", output: event.output },
      { type: "assistant", text: "완료" },
    ],
  } });
  const saved = Object.values(state.workflowEventsByMessageId).flat().find((item) => item.toolName === event.toolName);
  expect(saved).toBeTruthy();
  expect(questionHistory(saved!)).toEqual(questionHistory(event));
});
it("supports legacy single questions and preserves incomplete or invalid records without inventing an answer", () => {
  expect(questionHistory({ ...event, toolInput: { question: "선택?", choices: [{ value: "yes" }] }, output: "yes" })?.answers[0].kind).toBe("choice");
  expect(questionHistory({ ...event, status: "error", output: "failed" })?.answers).toEqual([]);
  expect(questionHistory({ ...event, toolInput: { questions: [null, {}] } })).toBeNull();
  expect(questionHistory({ ...event, output: "invalid" })?.answers).toEqual([]);
});
