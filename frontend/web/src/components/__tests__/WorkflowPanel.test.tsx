import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { WorkflowPanel } from "../WorkflowPanel";

function readStylesheet() {
  return readFileSync(resolve(__dirname, "../../../styles.css"), "utf8").replace(/\r\n/g, "\n");
}

function stylesheetBlock(selector: string) {
  const stylesheet = readStylesheet();
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`Stylesheet selector not found: ${selector}`);
  }
  const end = stylesheet.indexOf("\n}", start);
  return stylesheet.slice(start, end + 2);
}

describe("WorkflowPanel", () => {
  it.each(["provider-summary", "progress"] as const)("renders inline markdown in %s notes", (noteSource) => {
    render(<AppStateProvider><WorkflowPanel events={[{
      id: "markdown-note", toolName: "", title: "진행 메모", detail: "**Checking sources** and *comparing* `PPTX`", status: "done", role: "reasoning", noteSource,
    }]} /></AppStateProvider>);
    const note = document.querySelector(noteSource === "progress" ? ".workflow-progress-prose" : ".workflow-reasoning-preview")!;
    expect(note.querySelector("strong")?.textContent).toBe("Checking sources");
    expect(note.querySelector("em")?.textContent).toBe("comparing");
    expect(note.querySelector("code")?.textContent).toBe("PPTX");
    expect(note.textContent).not.toContain("**");
    if (noteSource === "provider-summary") {
      act(() => screen.getByRole("button", { name: "추론 요약 펼치기" }).click());
      expect(document.querySelector(".workflow-reasoning-full strong")?.textContent).toBe("Checking sources");
    }
  });
  it.each([false, true])("keeps warning details inside disclosure without a summary alert (mixed: %s)", (mixed) => {
    const parent = { id: "warning-group", toolName: "", title: "조회", detail: "", status: "warning" as const, role: "purpose" as const, groupId: "warning-group" };
    const child = { id: "warning-child", toolName: "web_fetch", title: "웹 페이지 조회", detail: "접근 제한", status: "warning" as const, level: "child" as const, groupId: parent.groupId };
    render(<AppStateProvider><WorkflowPanel events={[parent, child, ...(mixed ? [{ ...child, id: "success-child", status: "done" as const }] : [])]} /></AppStateProvider>);
    const toggle = document.querySelector<HTMLButtonElement>(".workflow-narrative-toggle")!;
    expect(toggle.querySelector(".workflow-narrative-meta")).toBeNull();
    expect(toggle.querySelector(".workflow-narrative-alert")).toBeNull();
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(true);
    act(() => toggle.click());
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector(".workflow-step.warning")).toBeTruthy();
  });
  it.each([false, true])("discloses full provider summaries independently of tools (%s)", (restored) => {
    const note = { id: "summary", toolName: "", title: "진행 메모", detail: "Checking sources.\n\nComparing all available evidence.", status: "done" as const, role: "reasoning" as const, noteSource: "provider-summary" as const, groupId: "g", restored };
    const parent = { id: "g", toolName: "", title: "작업", detail: "", status: "done" as const, role: "purpose" as const, groupId: "g" };
    const { rerender } = render(<AppStateProvider><WorkflowPanel events={[note, parent]} /></AppStateProvider>);
    const toggle = screen.getByRole("button", { name: "추론 요약 펼치기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll(".workflow-reasoning-summary")).toHaveLength(1);
    expect(document.querySelector(".workflow-reasoning-full")).toBeNull();
    act(() => toggle.click());
    expect(document.querySelector(".workflow-reasoning-full")?.textContent).toBe("Checking sources. · Comparing all available evidence.");
    rerender(<AppStateProvider><WorkflowPanel events={[{ ...note, detail: `${note.detail}\nUpdated.` }, parent]} /></AppStateProvider>);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".workflow-reasoning-full")?.textContent).toBe("Checking sources. · Comparing all available evidence. · Updated.");
    act(() => toggle.click());
    expect(document.querySelector(".workflow-reasoning-full")).toBeNull();
  });
  it.each([false, true])("shows planning narration once, including restored history (%s)", (restored) => {
    const detail = "공식 지표를 확인하고 부문별로 비교하겠습니다.";
    const plan = { id: "plan", toolName: "", title: "작업 계획 수립", detail, status: "done" as const, role: "planning" as const, restored };
    const note = { id: "progress", toolName: "", title: "진행 메모", detail: `  ${detail}\n`, status: "done" as const, role: "reasoning" as const, noteSource: "progress" as const, restored };
    const { rerender } = render(<AppStateProvider><WorkflowPanel events={[note, plan]} /></AppStateProvider>);
    expect(document.body.textContent?.split(detail)).toHaveLength(2);
    expect(document.querySelector(".workflow-progress-prose")).toBeNull();
    rerender(<AppStateProvider><WorkflowPanel events={[plan, { ...note, detail: "추가 자료가 필요합니다." }]} /></AppStateProvider>);
    expect(screen.getByText("추가 자료가 필요합니다.")).toBeTruthy();
    rerender(<AppStateProvider><WorkflowPanel events={[plan, { ...note, status: "error" }]} /></AppStateProvider>);
    expect(document.querySelector(".workflow-progress-prose")?.textContent).toBe(detail);
  });
  it("shows every tool count and distinct skill names directly in the summary", () => {
    const parent = { id: "mixed", toolName: "", title: "작업", detail: "", status: "done" as const, role: "purpose" as const, groupId: "mixed" };
    const child = { status: "done" as const, level: "child" as const, groupId: "mixed", detail: "", title: "" };
    render(<AppStateProvider><WorkflowPanel events={[parent,
      ...Array.from({ length: 8 }, (_, i) => ({ ...child, id: `search-${i}`, toolName: "web_search" })),
      ...Array.from({ length: 3 }, (_, i) => ({ ...child, id: `fetch-${i}`, toolName: "web_fetch" })),
      { ...child, id: "skill-1", toolName: "skill", toolInput: { name: "visual-artifact" } },
      { ...child, id: "skill-2", toolName: "skill", toolInput: { name: "visual-artifact" } },
      { ...child, id: "skill-3", toolName: "skill", output: "Skill: new-research-skill\nDescription: research", restored: true },
    ]} /></AppStateProvider>);
    const summary = document.querySelector(".workflow-narrative-sentence")?.textContent;
    expect(summary).toBe("웹 검색 8회 · 웹 페이지 조회 3회 · 스킬 · visual-artifact, new-research-skill");
  });
  it("counts actual calls per tool in the collapsed summary including restored and failed calls", () => {
    const parent = { id: "counts", toolName: "", title: "정보 수집", detail: "", status: "done" as const, role: "purpose" as const, groupId: "counts" };
    const searches = Array.from({ length: 8 }, (_, i) => ({ id: `search-${i}`, toolCallId: `call-${i}`, toolName: "web_search", title: "웹 검색", detail: `query ${i}`, status: "done" as const, level: "child" as const, groupId: "counts", restored: true }));
    const extra = { id: "other", toolName: "mcp__new__lookup", title: "조회", detail: "failed", status: "error" as const, level: "child" as const, groupId: "counts", restored: true };
    render(<AppStateProvider><WorkflowPanel events={[parent, ...searches, { ...searches[0], id: "same-call-update" }, extra, { id: "note", toolName: "", title: "진행 메모", detail: "자료를 비교합니다.", status: "done", role: "reasoning", noteSource: "progress" }]} /></AppStateProvider>);
    const toggle = document.querySelector<HTMLButtonElement>(".workflow-narrative-toggle")!;
    expect(toggle.textContent).toContain("웹 검색 8회");
    expect(toggle.textContent).toContain("mcp · new · lookup 1회");
    expect(toggle.textContent).not.toContain("작업 9회");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(true);
    act(() => toggle.click());
    expect(panel.hidden).toBe(false);
    expect(toggle.closest("section")?.classList.contains("warning")).toBe(true);
    expect(toggle.querySelector(".workflow-narrative-meta")).toBeNull();
    expect(toggle.querySelector(".workflow-narrative-alert")).toBeNull();
    expect(toggle.querySelector(".workflow-narrative-status")?.textContent).toBe("›");
  });
  it("keeps narrative visible outside the disclosure and preserves error status", () => {
    const parent = { id: "group", toolName: "", title: "정보 수집", detail: "필요한 정보를 확인했습니다.", status: "done" as const, level: "parent" as const, role: "purpose" as const, groupId: "group" };
    const child = { id: "child", toolName: "mcp__new__lookup", title: "조회", detail: "response", status: "done" as const, level: "child" as const, groupId: "group" };
    const note = { id: "note", toolName: "", title: "진행 메모", detail: "공개 자료에서 확인한 조직의 역할을 중심으로 보고서 범위를 정리합니다.", status: "done" as const, role: "reasoning" as const, noteSource: "progress" as const };
    const { rerender } = render(<AppStateProvider><WorkflowPanel events={[note, parent, child]} /></AppStateProvider>);
    expect(document.querySelector(".workflow-progress-prose")?.textContent).toBe(note.detail);
    expect(screen.getByText(note.detail).closest("button")).toBeNull();
    expect(screen.getAllByText(note.detail)).toHaveLength(1);
    expect(screen.queryByText(parent.detail)).toBeNull();
    rerender(<AppStateProvider><WorkflowPanel events={[note, parent, { ...child, status: "error" }]} /></AppStateProvider>);
    expect(document.querySelector(".workflow-narrative")?.classList.contains("error")).toBe(true);
    expect(document.querySelector(".workflow-progress-prose")?.textContent).toBe(note.detail);
    expect(screen.getByText(note.detail).closest("button")).toBeNull();
    rerender(<AppStateProvider><WorkflowPanel events={[{ ...note, noteSource: "provider-summary" }, parent, child]} /></AppStateProvider>);
    expect(document.querySelector(".workflow-progress-prose")).toBeNull();
  });
  it("labels notes by provenance rather than language and keeps unknown notes neutral", () => {
    const base = { toolName: "", title: "진행 메모", status: "done" as const, level: "parent" as const, role: "reasoning" as const };
    render(<AppStateProvider><WorkflowPanel events={[
      { ...base, id: "provider", detail: "공식 자료를 먼저 검토합니다.", noteSource: "provider-summary" },
      { ...base, id: "progress", detail: "Checking the report.", noteSource: "progress" },
      { ...base, id: "legacy", detail: "Historical note." },
    ]} /></AppStateProvider>);
    expect(screen.getAllByText("내부 추론")).toHaveLength(1);
    expect(screen.getAllByText("진행 메모")).toHaveLength(1);
    expect(screen.getByText("공식 자료를 먼저 검토합니다.").closest(".workflow-copy")?.textContent).toContain("내부 추론");
    expect(screen.getByText("Checking the report.").closest(".workflow-progress-prose")).toBeTruthy();
  });
  it("does not display per-step seconds even when timing is available", () => {
    const timed = { id: "timed", toolName: "mcp__company-disclosure__search_catalog", title: "search", detail: "response", status: "done" as const, startedAtMs: 1000, finishedAtMs: 4500 };
    const { rerender } = render(<AppStateProvider><WorkflowPanel events={[timed]} /></AppStateProvider>);
    expect(screen.queryByText("3초")).toBeNull();
    rerender(<AppStateProvider><WorkflowPanel events={[{ ...timed, startedAtMs: undefined, finishedAtMs: undefined }]} /></AppStateProvider>);
    expect(document.querySelector(".workflow-elapsed")).toBeNull();
  });
  it("discloses narrative actions, retains expansion on updates, and surfaces child failures", () => {
    const parent = { id: "narrative", toolName: "", title: "작업 실행", detail: "최근 공시를 확인합니다.", status: "done" as const, level: "parent" as const, role: "purpose" as const, groupId: "narrative" };
    const child = { id: "new-tool", toolName: "mcp__new_server__new_action", title: "new_action", detail: "opaque response", status: "done" as const, level: "child" as const, groupId: "narrative" };
    const note = { ...parent, id: "note", role: "reasoning" as const, groupId: undefined };
    const view = (events: typeof parent[] | Array<typeof parent | typeof child | typeof note>) => <AppStateProvider><WorkflowPanel events={events} /></AppStateProvider>;
    const { rerender } = render(view([note, parent, child]));
    const toggle = document.querySelector<HTMLButtonElement>(".workflow-narrative-toggle")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.textContent).toContain("new_action");
    expect(toggle.textContent).not.toContain(parent.detail);
    expect(screen.getAllByText(parent.detail)).toHaveLength(1);
    expect(panel.hidden).toBe(true);
    act(() => toggle.click());
    expect(panel.hidden).toBe(false);
    rerender(<AppStateProvider><WorkflowPanel events={[note, parent, { ...child, status: "error" }]} /></AppStateProvider>);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.closest("section")?.classList.contains("error")).toBe(true);
    act(() => toggle.click());
    expect(panel.hidden).toBe(true);
    expect(toggle.textContent).toContain("new_action 1회");
    expect(document.body.textContent).not.toContain("응답을 받았습니다");
  });
  it("replaces generic historical MCP titles with the actual server and action", () => {
    render(<AppStateProvider><WorkflowPanel events={[{
      id: "unlisted-mcp", toolName: "mcp__sqlite_analysis__list_tables",
      title: "외부 도구 작업", detail: "tables: signals", status: "done", level: "child",
    }]} /></AppStateProvider>);
    expect(screen.getByText("mcp · sqlite_analysis · list_tables")).toBeTruthy();
    expect(screen.queryByText("외부 도구 작업")).toBeNull();
  });
  it("keeps a Korean work note beside its web tool after completion", () => {
    const input = { query: "POSCO", progress_message: "포스코의 최근 언론 동향을 검색하고 있습니다." };
    const running = { id: "web", toolName: "web_search", title: "web_search", detail: "query: POSCO", toolInput: input, status: "running" as const, level: "child" as const };
    const { rerender } = render(<AppStateProvider><WorkflowPanel events={[running]} /></AppStateProvider>);
    expect(screen.getByText("웹 검색").closest(".workflow-step")?.querySelector("small")?.textContent).toContain(input.progress_message);
    rerender(<AppStateProvider><WorkflowPanel events={[{ ...running, status: "done", output: "검색 결과: POSCO\n1. article\nURL: https://example.com" }]} /></AppStateProvider>);
    const step = screen.getByText("웹 검색").closest(".workflow-step")!;
    expect(step.querySelector("small")?.textContent).toContain(input.progress_message);
    expect(step.querySelector("small")?.textContent).not.toContain("조회 완료");
    expect(step.querySelector("small")?.textContent).not.toContain("URL:");
    expect(step.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
  it("shows readable MCP results with the original output in a closed disclosure", () => {
    const output = JSON.stringify({ total: 5, items: [{ billName: "철강산업 특별법" }] });
    render(<AppStateProvider><WorkflowPanel events={[{
      id: "bill-result", toolName: "mcp__national-assembly__assembly_bill",
      title: "mcp__national-assembly__assembly_bill", detail: output.slice(0, 20),
      output, status: "done", level: "child",
    }]} /></AppStateProvider>);
    const step = screen.getByText("mcp · national-assembly · assembly_bill").closest(".workflow-step")!;
    expect(step.querySelector("small")?.textContent).toContain("조회 결과 5건 · 철강산업 특별법");
    expect(step.querySelector("small")?.textContent).not.toContain('{"total"');
    const toggle = step.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(step.querySelector("pre")).toBeNull();
    act(() => { toggle.querySelector("strong")!.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(step.querySelector("pre")?.textContent).toContain(output);
    act(() => { step.querySelector("pre")!.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => { toggle.querySelector("small")!.click(); });
    expect(step.querySelector("pre")).toBeNull();
  });

  it("keeps MCP failures visible even when raw output is collapsed", () => {
    render(<AppStateProvider><WorkflowPanel events={[{
      id: "bill-error", toolName: "mcp__national-assembly__bill_detail",
      title: "mcp__national-assembly__bill_detail", detail: "invalid bill_id",
      output: "invalid bill_id", status: "error", level: "child",
    }]} /></AppStateProvider>);
    const step = screen.getByText("mcp · national-assembly · bill_detail").closest(".workflow-step")!;
    expect(step.querySelector("small")?.textContent).toContain("실패했습니다");
    expect(step.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the full reasoning progress memo instead of clamping it to two lines", () => {
    const memoStyles = stylesheetBlock(".workflow-copy small");

    expect(memoStyles).toContain("display: block;");
    expect(memoStyles).toContain("white-space: normal;");
    expect(memoStyles).not.toContain("max-height");
    expect(memoStyles).not.toContain("line-clamp");
    expect(memoStyles).not.toContain("overflow: hidden");
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

  it("shows progress memo inline without requiring a separate disclosure", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "reasoning",
              toolName: "",
              title: "진행 메모",
              detail: "**포스코 관련 기사와 출처를 확인하고 있습니다.**",
              status: "done",
              level: "parent",
              role: "reasoning",
            },
          ]}
        />
      </AppStateProvider>,
    );

    const emphasized = screen.getByText("포스코 관련 기사와 출처를 확인하고 있습니다.");
    expect(emphasized.tagName).toBe("STRONG");
    const step = emphasized.closest(".workflow-step")!;
    expect(step.querySelector("details")).toBeNull();
    expect(step.querySelector(".workflow-status-detail")?.textContent).toBe("포스코 관련 기사와 출처를 확인하고 있습니다.");
    expect(step.querySelector(".workflow-dot")).toBeNull();
    expect(screen.getByText("진행 메모")).toBeTruthy();
    expect(screen.queryByText("내부 진행 기록")).toBeNull();
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
    expect(document.querySelectorAll(".workflow-step")).toHaveLength(2);
    expect(activity?.textContent || "").toContain("다음 단계 검토 중");
    expect(list?.lastElementChild).toBe(activity);
    expect((list?.textContent || "").indexOf("근거 확인 중")).toBeLessThan((list?.textContent || "").indexOf("다음 단계 검토 중"));
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

  it("does not keep a completed activity status active while a file write is still running", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "judging",
              toolName: "",
              title: "다음 단계 검토 중",
              detail: "다음 작업을 정했습니다.",
              status: "done",
              level: "parent",
              role: "activity",
            },
            {
              id: "write",
              toolName: "write_file",
              title: "write_file",
              detail: "outputs/report.html",
              status: "running",
              level: "child",
              toolInput: {
                path: "outputs/report.html",
                content: "<html><body>작성 중</body></html>",
              },
            },
          ]}
        />
      </AppStateProvider>,
    );

    expect(document.querySelector(".workflow-activity-status")).toBeNull();
    expect(screen.getByText("작성 중인 결과물 - report.html")).toBeTruthy();
  });

  it("shows the generated SKILL.md content for save_skill", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "save-skill",
              toolName: "save_skill",
              title: "save_skill",
              detail: "hai-prefix",
              status: "running",
              level: "child",
              toolInput: {
                name: "hai-prefix",
                description: "응답 시작에 하이!를 붙입니다.",
                instructions: "# 하이 접두사\n\n`scripts/prefix.py`를 실행해 접두사를 만드세요.",
                supporting_files: [
                  {
                    path: "scripts/prefix.py",
                    content: "print('하이!')\n",
                  },
                ],
                mode: "create",
              },
            },
          ]}
        />
      </AppStateProvider>,
    );

    expect(screen.getByText("스킬 파일 작성")).toBeTruthy();
    expect(screen.getByText("작성 중인 결과물 - SKILL.md")).toBeTruthy();
    expect(screen.getByText("작성 중인 결과물 - prefix.py")).toBeTruthy();
    const previews = [...document.querySelectorAll(".workflow-output-body")].map((element) => element.textContent);
    expect(previews[0]).toContain("name: hai-prefix");
    expect(previews[0]).toContain("scripts/prefix.py");
    expect(previews[1]).toContain("print('하이!')");
  });

  it("does not keep a stale running activity status active after later concrete work starts", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "judging",
              toolName: "",
              title: "다음 단계 검토 중",
              detail: "도구 결과를 읽고 다음 작업이나 최종 답변을 결정하고 있습니다.",
              status: "running",
              level: "parent",
              role: "activity",
            },
            {
              id: "write",
              toolName: "write_file",
              title: "write_file",
              detail: "outputs/report.html",
              status: "running",
              level: "child",
              toolInput: {
                path: "outputs/report.html",
                content: "<html><body>작성 중</body></html>",
              },
            },
          ]}
        />
      </AppStateProvider>,
    );

    expect(document.querySelector(".workflow-activity-status")).toBeNull();
    expect(screen.getByText("작성 중인 결과물 - report.html")).toBeTruthy();
  });

  it("buffers continued running output preview updates before scheduling the next frame", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");

    const runningWriteEvent = (content: string) => ({
      id: "write",
      toolName: "write_file",
      title: "write_file",
      detail: "outputs/report.html",
      status: "running" as const,
      level: "child" as const,
      toolInput: {
        path: "outputs/report.html",
        content,
      },
    });

    const { rerender } = render(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("first")]} />
      </AppStateProvider>,
    );

    setTimeoutSpy.mockClear();
    requestAnimationFrameSpy.mockClear();

    rerender(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("first second")]} />
      </AppStateProvider>,
    );

    expect(document.querySelector(".workflow-output-line-count")?.textContent || "").toContain("2 토큰");
    expect(document.querySelector(".workflow-output-line-count")?.textContent || "").not.toContain("4 토큰");
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

    const visualBufferDelays = setTimeoutSpy.mock.calls
      .map(([, timeout]) => Number(timeout))
      .filter((timeout) => Number.isFinite(timeout));
    expect(visualBufferDelays).toContain(50);

    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(requestAnimationFrameSpy).toHaveBeenCalled();
  });

  it("uses recent small chunk cadence to pace workflow output preview chunks", () => {
    vi.useFakeTimers();

    const runningWriteEvent = (content: string) => ({
      id: "write",
      toolName: "write_file",
      title: "write_file",
      detail: "outputs/report.html",
      status: "running" as const,
      level: "child" as const,
      toolInput: {
        path: "outputs/report.html",
        content,
      },
    });

    const { rerender } = render(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("aa")]} />
      </AppStateProvider>,
    );

    rerender(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("aabb")]} />
      </AppStateProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(120);
    });

    rerender(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("aabbcc")]} />
      </AppStateProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(64);
    });

    expect(document.querySelector(".workflow-output-body")?.textContent || "").toBe("aabb");

    act(() => {
      vi.advanceTimersByTime(40);
    });

    const pacedText = document.querySelector(".workflow-output-body")?.textContent || "";
    expect(pacedText.length).toBeGreaterThan(4);
    expect(pacedText.length).toBeLessThan(6);
  });

  it("paces the running workflow output token counter with the revealed content", () => {
    vi.useFakeTimers();

    const runningWriteEvent = (content: string) => ({
      id: "write",
      toolName: "write_file",
      title: "write_file",
      detail: "outputs/report.html",
      status: "running" as const,
      level: "child" as const,
      toolInput: {
        path: "outputs/report.html",
        content,
      },
    });

    const { rerender } = render(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("가".repeat(20))]} />
      </AppStateProvider>,
    );

    expect(document.querySelector(".workflow-output-line-count")?.textContent || "").toContain("20 토큰");

    rerender(
      <AppStateProvider>
        <WorkflowPanel events={[runningWriteEvent("가".repeat(100))]} />
      </AppStateProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(49);
    });

    expect(document.querySelector(".workflow-output-body")?.textContent?.length || 0).toBe(20);
    expect(document.querySelector(".workflow-output-line-count")?.textContent || "").toContain("20 토큰");

    act(() => {
      vi.advanceTimersByTime(17);
    });

    const firstVisibleLength = document.querySelector(".workflow-output-body")?.textContent?.length || 0;
    const firstCount = document.querySelector(".workflow-output-line-count")?.textContent || "";
    expect(firstVisibleLength).toBeGreaterThan(20);
    expect(firstVisibleLength).toBeLessThan(100);
    expect(firstCount).toContain(`${firstVisibleLength.toLocaleString()} 토큰`);

    act(() => {
      vi.advanceTimersByTime(3_500);
    });

    expect(document.querySelector(".workflow-output-line-count")?.textContent || "").toContain("100 토큰");
  });

  it("continues the running workflow output token counter when the tab is hidden", () => {
    vi.useFakeTimers();
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")
      || Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });

    const runningWriteEvent = (content: string) => ({
      id: "write",
      toolName: "write_file",
      title: "write_file",
      detail: "outputs/report.html",
      status: "running" as const,
      level: "child" as const,
      toolInput: {
        path: "outputs/report.html",
        content,
      },
    });

    try {
      const { rerender } = render(
        <AppStateProvider>
          <WorkflowPanel events={[runningWriteEvent("가".repeat(20))]} />
        </AppStateProvider>,
      );

      rerender(
        <AppStateProvider>
          <WorkflowPanel events={[runningWriteEvent("가".repeat(100))]} />
        </AppStateProvider>,
      );

      expect(document.querySelector(".workflow-output-line-count")?.textContent || "").toContain("20 토큰");

      act(() => {
        vi.advanceTimersByTime(180);
      });

      const hiddenTabCount = document.querySelector(".workflow-output-line-count")?.textContent || "";
      expect(hiddenTabCount).not.toContain("20 토큰");
    } finally {
      if (hiddenDescriptor) {
        Object.defineProperty(document, "hidden", hiddenDescriptor);
      } else {
        delete (document as { hidden?: boolean }).hidden;
      }
    }
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

  it("renders context compaction progress as a centered divider", () => {
    render(
      <AppStateProvider>
        <WorkflowPanel
          events={[
            {
              id: "compact",
              toolName: "context_compaction",
              title: "컨텍스트 자동 압축",
              detail: "컨텍스트 초과를 막기 위해 이전 대화를 자동 압축하고 있습니다.",
              status: "running",
              level: "parent",
            },
          ]}
        />
      </AppStateProvider>,
    );

    expect(screen.getByText("컨텍스트 자동 압축 중")).toBeTruthy();
    expect(document.querySelector(".workflow-context-compact-divider")).toBeTruthy();
    expect(document.querySelector(".workflow-card")).toBeNull();
    expect(document.querySelector(".workflow-step")).toBeNull();
  });
});
