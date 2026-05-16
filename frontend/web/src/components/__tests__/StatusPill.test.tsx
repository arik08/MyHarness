import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusPill } from "../StatusPill";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";

function RestoreControls() {
  const { dispatch } = useAppState();
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: "begin_history_restore", sessionId: "saved-session" })}>
        복원 시작
      </button>
      <button type="button" onClick={() => dispatch({ type: "finish_history_restore" })}>
        복원 종료
      </button>
    </>
  );
}

function renderStatusPill() {
  render(
    <AppStateProvider
      initialState={{
        ...initialAppState,
        sessionId: "session-active",
        status: "ready",
        statusText: "준비됨",
      }}
    >
      <StatusPill />
      <RestoreControls />
    </AppStateProvider>,
  );
}

describe("StatusPill", () => {
  it("hides history restore loading text when restore finishes within 500ms", () => {
    vi.useFakeTimers();
    try {
      renderStatusPill();

      fireEvent.click(screen.getByRole("button", { name: "복원 시작" }));
      expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");

      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.click(screen.getByRole("button", { name: "복원 종료" }));

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows history restore loading text after 500ms when restore is still pending", () => {
    vi.useFakeTimers();
    try {
      renderStatusPill();

      fireEvent.click(screen.getByRole("button", { name: "복원 시작" }));
      expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");

      act(() => {
        vi.advanceTimersByTime(499);
      });
      expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.querySelector("#readyPill")?.textContent).toBe("대화 불러오는 중");
    } finally {
      vi.useRealTimers();
    }
  });
});
