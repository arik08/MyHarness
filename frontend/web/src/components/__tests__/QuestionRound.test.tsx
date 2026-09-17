import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InlineQuestion } from "../InlineQuestion";
import { MessageList } from "../MessageList";
import { Composer } from "../Composer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState, appReducer } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));
const questions = [
  { id: "audience", question: "누가 읽나요?", choices: [{ value: "board", label: "임원 (추천)", description: "핵심 요약" }, { value: "team", label: "실무자" }] },
  { id: "detail", question: "추가 조건은?", choices: [] },
];
const payload = { kind: "question", request_id: "round-a", questions };
function Events() {
  const { dispatch } = useAppState();
  return <button onClick={() => dispatch({ type: "backend_event", event: { type: "modal_request", modal: { kind: "question", request_id: "round-a", status: "answered" } } })}>서버 확인</button>;
}
function show() {
  return render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c", modal: { kind: "backend", payload } }}><InlineQuestion /><Events /></AppStateProvider>);
}
beforeEach(() => { sessionStorage.clear(); vi.mocked(sendBackendRequest).mockReset().mockResolvedValue({ ok: true }); });
afterEach(cleanup);

it("keeps per-question choices and custom text editable until one explicit submission", async () => {
  show();
  const groups = screen.getAllByRole("group");
  expect(within(groups[1]).queryByRole("button", { name: /임원/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /임원/ }));
  expect(sendBackendRequest).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "답변 보내기" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("2번 질문에 직접 답변"), { target: { value: "내부용 근거 포함" } });
  expect(screen.queryByRole("button", { name: "적용" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "실무자" }));
  fireEvent.click(screen.getByRole("button", { name: "답변 보내기" }));
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(sendBackendRequest).mock.calls[0][2];
  expect(JSON.parse(String(sent.answer))).toEqual([
    { id: "audience", answer: ["board", "team"], kind: "choice" }, { id: "detail", answer: "내부용 근거 포함", kind: "text" },
  ]);
  expect(screen.getByLabelText("AI 확인 질문")).toBeTruthy();
  fireEvent.click(screen.getByText("서버 확인"));
  expect(screen.queryByLabelText("AI 확인 질문")).toBeNull();
});

it("lets custom text replace a selection and preserves it through errors and remounts", async () => {
  vi.mocked(sendBackendRequest).mockRejectedValueOnce(new Error("연결 실패"));
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: /임원/ }));
  fireEvent.change(screen.getByLabelText("1번 질문에 직접 답변"), { target: { value: "외부 독자" } });
  fireEvent.change(screen.getByLabelText("2번 질문에 직접 답변"), { target: { value: "상세하게" } });
  expect(screen.getByRole("button", { name: /임원/ }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "답변 보내기" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("1번 질문에 직접 답변").getAttribute("disabled")).toBeNull();
  view.unmount(); show();
  expect((screen.getByLabelText("1번 질문에 직접 답변") as HTMLTextAreaElement).value).toBe("외부 독자");
  fireEvent.click(screen.getByRole("button", { name: "답변 보내기" }));
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(2));
});

it("does not submit on Enter or Korean composition and rejects whitespace answers", () => {
  show();
  fireEvent.change(screen.getByLabelText("1번 질문에 직접 답변"), { target: { value: " " } });
  fireEvent.keyDown(screen.getByLabelText("1번 질문에 직접 답변"), { key: "Enter", isComposing: true });
  expect(sendBackendRequest).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "답변 보내기" }).hasAttribute("disabled")).toBe(true);
});

it("ignores an old acknowledgement when a newer question is open", () => {
  const state = { ...initialAppState, modal: { kind: "backend" as const, payload: { ...payload, request_id: "round-b" } } };
  const result = appReducer(state, { type: "backend_event", event: { type: "modal_request", modal: { kind: "question", request_id: "round-a", status: "answered" } } });
  expect(result.modal).toEqual(state.modal);
});

it("renders the Lumina card inside the conversation and never inside the composer", () => {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c", modal: { kind: "backend", payload } }}>
    <MessageList /><Composer />
  </AppStateProvider>);
  const card = screen.getByLabelText("AI 확인 질문");
  expect(document.querySelector(".messages")?.contains(card)).toBe(true);
  expect(document.querySelector(".composer")?.contains(card)).toBe(false);
  expect(screen.getAllByLabelText("AI 확인 질문")).toHaveLength(1);
  expect(screen.queryByText("무엇을 도와드릴까요?")).toBeNull();
});

it("AI judgment fills the answers but still requires explicit submission", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "AI가 판단" }));
  expect(sendBackendRequest).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "답변 보내기" }).hasAttribute("disabled")).toBe(false);
});
