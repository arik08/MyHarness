import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState, type AppAction } from "../../state/reducer";
import type { AppState } from "../../types/ui";
import { TodoDock } from "../TodoDock";

describe("TodoDock", () => {
  it.each(["new_custom_tool", "progress_note"])("shows only the current %s message without an order label", (toolName) => {
    const { container } = render(
      <AppStateProvider initialState={{
        ...initialAppState,
        busy: true,
        todoMarkdown: "- [ ] 작업 확인",
        statusText: "준비됨",
        workflowEvents: [{
          id: "activity", toolName, title: "진행", status: "running",
          detailLog: ["처음 메시지", "이전 메시지", "바로 전 메시지"],
          detail: "최신 메시지",
        }],
      }}><TodoDock /></AppStateProvider>,
    );
    const lines = [...container.querySelectorAll(".todo-activity-line")];
    expect(lines.map((line) => line.textContent)).toEqual([
      "최신 메시지",
    ]);
    expect(container.querySelector(".todo-activity-order")).toBeNull();
  });

  it("does not animate an unchecked item after the final answer is complete", () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          todoSessionId: "session-active",
          todoMarkdown: "- [x] 자료 조사\n- [ ] 렌더링 검증",
          busy: true,
          status: "processing",
          statusText: "AI 후속 응답 대기 중",
          messages: [
            { id: "user", role: "user", text: "보고서를 작성해줘" },
            { id: "assistant", role: "assistant", text: "보고서를 완성했습니다.", isComplete: true },
          ],
        }}
      >
        <TodoDock />
      </AppStateProvider>,
    );

    expect(container.querySelector(".todo-card-list .running")).toBeNull();
    expect(container.querySelector(".todo-activity-list")).toBeNull();
  });

  describe("progress message timing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    });

    afterEach(() => {
      cleanup();
      vi.useRealTimers();
    });

    function renderProgress(initialState: Partial<AppState> = {}) {
      let dispatch!: ReturnType<typeof useAppState>["dispatch"];
      function CaptureDispatch() {
        dispatch = useAppState().dispatch;
        return null;
      }
      const view = render(
        <AppStateProvider initialState={{
          ...initialAppState,
          sessionId: "session-active",
          busy: true,
          todoMarkdown: "- [ ] 작업 확인",
          statusText: "진행 메모 확인 중",
          ...initialState,
        }}>
          <CaptureDispatch />
          <TodoDock />
        </AppStateProvider>,
      );
      return {
        ...view,
        send(...actions: AppAction[]) {
          act(() => actions.forEach((action) => dispatch(action)));
        },
        progress(message: string) {
          act(() => dispatch({ type: "backend_event", event: { type: "status", message } }));
        },
        line() {
          return view.container.querySelector(".todo-activity-line")?.textContent ?? null;
        },
      };
    }

    function advance(milliseconds: number) {
      act(() => vi.advanceTimersByTime(milliseconds));
    }

    it("shows the first message immediately and replaces it with only the latest at the original one-second deadline", () => {
      const view = renderProgress();
      expect(view.line()).toBe("진행 메모 확인 중");

      advance(150);
      view.progress("자료 검색 중");
      advance(750);
      view.progress("최신 자료 정리 중");
      advance(99);
      expect(view.line()).toBe("진행 메모 확인 중");
      advance(1);
      expect(view.line()).toBe("최신 자료 정리 중");

      view.progress("보고서 작성 중");
      advance(999);
      expect(view.line()).toBe("최신 자료 정리 중");
      advance(1);
      expect(view.line()).toBe("보고서 작성 중");
    });

    it("does not restart the deadline when the displayed text is repeated or unrelated state changes", () => {
      const view = renderProgress();
      advance(700);
      view.progress("진행 메모 확인 중");
      view.send({ type: "set_draft", value: "다음 요청" });
      advance(100);
      view.progress("자료 검색 중");
      advance(199);
      expect(view.line()).toBe("진행 메모 확인 중");
      advance(1);
      expect(view.line()).toBe("자료 검색 중");
    });

    it("discards a queued intermediate message when the latest update returns to the displayed message", () => {
      const view = renderProgress();
      advance(200);
      view.progress("중간 자료 검색 중");
      advance(400);
      view.progress("진행 메모 확인 중");
      advance(400);
      expect(view.line()).toBe("진행 메모 확인 중");
      view.progress("최신 결과 확인 중");
      expect(view.line()).toBe("최신 결과 확인 중");
    });

    it("updates immediately once the current message has already been visible for a second", () => {
      const view = renderProgress();
      advance(1300);
      view.progress("결과 확인 중");
      expect(view.line()).toBe("결과 확인 중");
    });

    it.each(["new_custom_tool", "progress_note"])("applies the same timing to %s workflow details", (toolName) => {
      const view = renderProgress({
        statusText: "준비됨",
        workflowEvents: [{ id: "activity", toolName, title: "진행", status: "running", detail: "첫 도구 진행" }],
      });
      expect(view.line()).toBe("첫 도구 진행");
      advance(100);
      view.send(
        { type: "backend_event", event: { type: "tool_progress", tool_name: toolName, message: "중간 도구 진행" } },
        { type: "backend_event", event: { type: "status", message: "준비됨" } },
      );
      advance(700);
      view.send(
        { type: "backend_event", event: { type: "tool_progress", tool_name: toolName, message: "최신 도구 진행" } },
        { type: "backend_event", event: { type: "status", message: "준비됨" } },
      );
      advance(199);
      expect(view.line()).toBe("첫 도구 진행");
      advance(1);
      expect(view.line()).toBe("최신 도구 진행");
    });

    it("coalesces disappearance while busy so an older queued message never appears", () => {
      const view = renderProgress();
      advance(100);
      view.progress("중간 자료 검색 중");
      advance(100);
      view.progress("준비됨");
      advance(799);
      expect(view.line()).toBe("진행 메모 확인 중");
      advance(1);
      expect(view.line()).toBeNull();
      view.progress("새 진행 메시지");
      expect(view.line()).toBe("새 진행 메시지");
    });

    it.each(["idle", "final answer", "error"])("clears immediately on %s and never revives queued activity", (completion) => {
      const view = renderProgress();
      advance(100);
      view.progress("대기 중인 최신 진행");
      advance(100);
      if (completion === "idle") {
        view.send({ type: "set_busy", value: false });
      } else if (completion === "final answer") {
        view.send({ type: "append_message", message: { role: "assistant", text: "완료했습니다.", isComplete: true } });
      } else {
        view.send({ type: "backend_event", event: { type: "error", message: "실행 실패" } });
      }
      expect(view.line()).toBeNull();
      expect(view.container.querySelector(".todo-card-list .running")).toBeNull();
      advance(1000);
      expect(view.line()).toBeNull();
    });

    it("starts a fresh display deadline on session switch and cancels the old pending update", () => {
      const view = renderProgress();
      advance(100);
      view.progress("이전 세션 대기 메시지");
      advance(200);
      view.send(
        { type: "session_started", sessionId: "session-next", busy: true },
        { type: "backend_event", event: { type: "status", message: "새 세션 진행" } },
      );
      expect(view.line()).toBe("새 세션 진행");
      advance(700);
      expect(view.line()).toBe("새 세션 진행");
      view.progress("새 세션 최신 진행");
      advance(299);
      expect(view.line()).toBe("새 세션 진행");
      advance(1);
      expect(view.line()).toBe("새 세션 최신 진행");
    });

    it("starts a new deadline for a new request within the same session", () => {
      const view = renderProgress({ workflowStartedAtMs: Date.now() });
      advance(100);
      view.progress("이전 요청 대기 메시지");
      advance(200);
      view.send(
        { type: "append_message", message: { role: "user", text: "다음 작업을 실행해줘" } },
        { type: "backend_event", event: { type: "status", message: "새 요청 진행" } },
      );
      expect(view.line()).toBe("새 요청 진행");
      advance(700);
      expect(view.line()).toBe("새 요청 진행");
    });

    it("resets hidden progress when collapsed and displays the latest immediately when reopened", () => {
      const view = renderProgress();
      advance(100);
      view.progress("최신 자료 검색 중");
      view.send({ type: "toggle_todo_collapsed" });
      expect(view.line()).toBeNull();
      advance(100);
      view.send({ type: "toggle_todo_collapsed" });
      expect(view.line()).toBe("최신 자료 검색 중");
      advance(800);
      expect(view.line()).toBe("최신 자료 검색 중");
    });

    it("cancels scheduled activity when the checklist disappears or the component unmounts", () => {
      const view = renderProgress();
      advance(100);
      view.progress("최신 자료 검색 중");
      view.send({ type: "backend_event", event: { type: "todo_update", todo_markdown: "" } });
      expect(view.line()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      view.send({ type: "backend_event", event: { type: "todo_update", todo_markdown: "- [ ] 새 작업" } });
      expect(view.line()).toBe("최신 자료 검색 중");
      view.progress("다음 최신 진행");
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
