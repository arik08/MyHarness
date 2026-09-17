import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
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
});
