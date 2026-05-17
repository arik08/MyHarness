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

  it("keeps previous workflow details out of the compact status line", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "judging",
              toolName: "",
              title: "다음 단계 검토 중",
              detail: "다음 작업을 정했습니다.",
              detailLog: ["도구 결과를 읽고 다음 작업이나 최종 답변을 결정하고 있습니다."],
              status: "done",
              level: "parent",
              role: "activity",
            },
          ]}
        />
      </AppStateProvider>,
    );

    expect(screen.getByText("다음 작업을 정했습니다.")).toBeTruthy();
    expect(document.querySelector(".workflow-activity-status")?.textContent || "").toContain("다음 단계 결정 완료");
    expect(document.querySelector(".workflow-activity-status")?.textContent || "").toContain("다음 작업을 정했습니다.");
    expect(document.querySelector(".workflow-activity-spinner")).toBeTruthy();
    expect(document.querySelector(".workflow-activity-dot")).toBeNull();
    expect(screen.getByText("다음 단계 결정 완료").closest(".workflow-step")).toBeNull();
    expect(screen.queryByText("도구 결과를 읽고 다음 작업이나 최종 답변을 결정하고 있습니다.")).toBeNull();
  });

  it("pins activity status below accumulating workflow records", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            { id: "request", toolName: "", title: "요청 이해", detail: "요청 확인", status: "done", level: "parent" },
            { id: "judging", toolName: "", title: "다음 단계 검토 중", detail: "다음 단계를 판단하고 있습니다.", status: "running", level: "parent", role: "activity" },
            { id: "info", toolName: "", title: "정보 수집", detail: "근거 확인 중", status: "running", level: "parent", role: "purpose", purpose: "info", groupId: "group-info" },
            { id: "file", toolName: "read_file", title: "파일 확인", detail: "a.ts", status: "done", level: "child", groupId: "group-info" },
          ]}
        />
      </AppStateProvider>,
    );

    const list = document.querySelector(".workflow-list");
    const activity = document.querySelector(".workflow-activity-status");
    expect(document.querySelectorAll(".workflow-step")).toHaveLength(3);
    expect(activity?.textContent || "").toContain("다음 단계 검토 중");
    expect(list?.lastElementChild).toBe(activity);
    expect((list?.textContent || "").indexOf("정보 수집")).toBeLessThan((list?.textContent || "").indexOf("다음 단계 검토 중"));
  });

  it("removes the activity status once final response starts", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            { id: "request", toolName: "", title: "요청 이해", detail: "요청 확인", status: "done", level: "parent" },
            { id: "judging", toolName: "", title: "다음 단계 검토 중", detail: "최종 답변 작성으로 넘어갑니다.", status: "done", level: "parent", role: "activity" },
            { id: "final", toolName: "", title: "응답 작성", detail: "답변 본문을 작성하고 있습니다.", status: "running", level: "parent", role: "final" },
          ]}
        />
      </AppStateProvider>,
    );

    expect(document.querySelector(".workflow-activity-status")).toBeNull();
    expect(screen.getByText("응답 작성")).toBeTruthy();
  });

  it("shows request and planning detail text on parent rows", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            { id: "request", toolName: "", title: "요청 이해", detail: "요청 확인 · 경쟁사 이슈를 조사합니다.", status: "done", level: "parent" },
            { id: "plan", toolName: "", title: "작업 계획 수립", detail: "글로벌 철강 생산량과 저탄소 전환 기준으로 보겠습니다.", status: "done", level: "parent", role: "planning" },
            { id: "final", toolName: "", title: "응답 작성", detail: "답변 본문을 작성하고 있습니다.", status: "running", level: "parent", role: "final" },
          ]}
        />
      </AppStateProvider>,
    );

    expect(screen.getByText("요청 확인 · 경쟁사 이슈를 조사합니다.")).toBeTruthy();
    expect(screen.getByText("글로벌 철강 생산량과 저탄소 전환 기준으로 보겠습니다.")).toBeTruthy();
  });
});
