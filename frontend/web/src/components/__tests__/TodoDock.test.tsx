import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { TodoDock } from "../TodoDock";

describe("TodoDock", () => {
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
