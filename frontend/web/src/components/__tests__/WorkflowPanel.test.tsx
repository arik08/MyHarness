import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { WorkflowPanel } from "../WorkflowPanel";

describe("WorkflowPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not append a second elapsed timer when the detail already contains elapsed text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);

    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "waiting",
              toolName: "",
              title: "streaming 이벤트 지연",
              detail: "report_v1.html 작업 요청은 전달됐습니다. 58초 경과입니다. 첫 streaming 이벤트가 늦어지고 있어 계속 대기 중입니다.",
              status: "running",
              level: "parent",
              role: "waiting",
            },
          ]}
          durationSeconds={58}
        />
      </AppStateProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    const step = screen.getByText("streaming 이벤트 지연").closest(".workflow-step");
    const elapsedMatches = step?.textContent?.match(/(?:\d+분(?: \d+초)?|\d+초) 경과/g) || [];
    expect(elapsedMatches).toEqual(["58초 경과"]);
  });
});
