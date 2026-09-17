import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InlineQuestion } from "../InlineQuestion";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));

function SwitchQuestion() {
  const { state, dispatch } = useAppState();
  return <><button onClick={() => {
    dispatch({ type: "session_started", sessionId: "b", busy: true });
    dispatch({ type: "backend_event", event: { type: "modal_request", modal: { kind: "permission", request_id: "next", reason: "Session B permission" } } });
  }}>Switch question</button><output data-testid="modal-kind">{state.modal?.kind}</output></>;
}

describe("question session isolation", () => {
  it.each([false, true])("preserves the new permission request after an old response settles (failure=%s)", async (failure) => {
    let resolve!: (value: { ok: boolean }) => void;
    let reject!: (error: Error) => void;
    vi.mocked(sendBackendRequest).mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "a", clientId: "client", modal: { kind: "backend", payload: { kind: "permission", request_id: "old", reason: "Session A permission" } } }}>
      <InlineQuestion /><SwitchQuestion />
    </AppStateProvider>);
    fireEvent.click(screen.getByRole("button", { name: /A2.*허용/ }));
    fireEvent.click(screen.getByText("Switch question"));
    await act(async () => { if (failure) reject(new Error("old failure")); else resolve({ ok: true }); });
    expect(screen.getByText("권한 요청: Session B permission")).toBeTruthy();
    expect(screen.getByTestId("modal-kind").textContent).toBe("backend");
    expect((screen.getByRole("button", { name: /A2.*허용/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
