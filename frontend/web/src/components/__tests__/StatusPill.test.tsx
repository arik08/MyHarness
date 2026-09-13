import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      <button type="button" onClick={() => dispatch({ type: "begin_history_restore", sessionId: "another-session" })}>
        다른 복원 시작
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
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("shows a settled status after the final answer even while backend cleanup is still busy", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          status: "processing",
          statusText: "AI 후속 응답 대기 중",
          messages: [
            { id: "user", role: "user", text: "보고서를 작성해줘" },
            { id: "assistant", role: "assistant", text: "보고서를 완성했습니다.", isComplete: true },
          ],
        }}
      >
        <StatusPill />
      </AppStateProvider>,
    );

    const pill = document.querySelector("#readyPill");
    expect(pill?.textContent).toBe("답변 완료");
    expect(pill?.classList.contains("busy")).toBe(false);
  });

  it("shows history restore loading text only after 300ms and clears it when finished", () => {
    vi.useFakeTimers();
    renderStatusPill();

    fireEvent.click(screen.getByRole("button", { name: "복원 시작" }));
    expect(document.querySelector("#readyPill")).toBeNull();
    act(() => vi.advanceTimersByTime(299));
    expect(document.querySelector("#readyPill")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector("#readyPill")?.textContent).toBe("대화 불러오는 중");

    fireEvent.click(screen.getByRole("button", { name: "복원 종료" }));
    expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");
  });

  it("cancels the loading indicator when restoration finishes before 300ms", () => {
    vi.useFakeTimers();
    renderStatusPill();
    fireEvent.click(screen.getByRole("button", { name: "복원 시작" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(screen.getByRole("button", { name: "복원 종료" }));
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the delay when switching to another session and cancels it on unmount", () => {
    vi.useFakeTimers();
    renderStatusPill();
    fireEvent.click(screen.getByRole("button", { name: "복원 시작" }));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole("button", { name: "다른 복원 시작" }));
    act(() => vi.advanceTimersByTime(299));
    expect(document.querySelector("#readyPill")).toBeNull();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
