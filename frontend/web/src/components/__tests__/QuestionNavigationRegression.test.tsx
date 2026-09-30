import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InlineQuestion } from "../InlineQuestion";
import { ModalHost } from "../ModalHost";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn(async () => ({ ok: true })) }));
vi.mock("../SettingsModal", () => ({ SettingsModal: () => {
  const { dispatch } = useAppState();
  return <section role="dialog" aria-label="설정"><button onClick={() => dispatch({ type: "close_modal" })}>설정 닫기</button></section>;
} }));

let dispatch: ReturnType<typeof useAppState>["dispatch"];
function Navigation() {
  const app = useAppState();
  dispatch = app.dispatch;
  return <button onClick={() => dispatch({ type: "open_modal", modal: { kind: "settings" } })}>설정 열기</button>;
}
afterEach(cleanup);
it.each(["question", "permission"])("restores a pending %s after closing settings", (kind) => {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "runtime-a", activeHistoryId: "saved-a",
    modal: { kind: "backend", payload: { kind, request_id: "pending", question: "확인할 기업은 어디인가요?", reason: "파일 쓰기" } },
  }}><Navigation /><InlineQuestion /><ModalHost /></AppStateProvider>);
  expect(document.querySelector('[data-request-id="pending"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "설정 열기" }));
  expect(document.querySelector('[data-request-id="pending"]')).toBeNull();
  expect(screen.getByRole("dialog", { name: "설정" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
  expect(document.querySelector('[data-request-id="pending"]')).toBeTruthy();
});
it.each(["answered", "cancelled"])("does not restore a %s request closed while settings is open", (status) => {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "runtime-a",
    modal: { kind: "backend", payload: { kind: "question", request_id: "pending", question: "Choose" } },
  }}><Navigation /><InlineQuestion /><ModalHost /></AppStateProvider>);
  fireEvent.click(screen.getByRole("button", { name: "설정 열기" }));
  act(() => dispatch({ type: "backend_event", sessionId: "runtime-a", event: { type: "modal_request", modal: { kind: "question", request_id: "pending", status } } }));
  fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
  expect(document.querySelector('[data-request-id="pending"]')).toBeNull();
});
it("queues a new backend question behind settings and restores only the current session", () => {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "runtime-a" }}><Navigation /><InlineQuestion /><ModalHost /></AppStateProvider>);
  fireEvent.click(screen.getByRole("button", { name: "설정 열기" }));
  act(() => dispatch({ type: "backend_event", sessionId: "runtime-a", event: { type: "modal_request", modal: { kind: "question", request_id: "new", question: "New question" } } }));
  expect(screen.getByRole("dialog", { name: "설정" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
  expect(document.querySelector('[data-request-id="new"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "설정 열기" }));
  act(() => dispatch({ type: "session_replaced", sessionId: "runtime-b", savedSessionId: "saved-b" }));
  act(() => dispatch({ type: "close_modal" }));
  expect(document.querySelector('[data-request-id="new"]')).toBeNull();
});
