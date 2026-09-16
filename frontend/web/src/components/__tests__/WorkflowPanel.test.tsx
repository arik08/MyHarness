import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { appReducer, initialAppState } from "../../state/reducer";
import type { WorkflowEvent } from "../../types/ui";
import { WorkflowPanel } from "../WorkflowPanel";
import { AsideWorkflowTimeline, asideTimelineRows, workflowSafeText } from "../AsideWorkflowTimeline";

const note = (id: string, detail: string): WorkflowEvent => ({ id, detail, toolName: "", title: "진행 메모", status: "done", role: "reasoning", noteSource: "progress" });
const call = (id: string, toolName = "cmd", extra: Partial<WorkflowEvent> = {}): WorkflowEvent => ({ id, toolCallId: id, toolName, title: toolName, detail: "", status: "done", toolInput: { command: `echo ${id}` }, output: `output ${id}`, ...extra });
function panel(events: WorkflowEvent[]) {
  return <AppStateProvider><WorkflowPanel events={events} persistenceKey="test-turn" durationSeconds={83} /></AppStateProvider>;
}
function openActivity() {
  const toggle = document.querySelector<HTMLButtonElement>(".aside-activity > .aside-toggle")!;
  fireEvent.click(toggle);
  return toggle;
}
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("Aside work history", () => {
  it.each(["mcp__future__lookup", "read_file"])("keeps response activity visible after %s finishes", (toolName) => {
    const events = [call("one", toolName), call("two", toolName)];
    const timeline = (busy: boolean) => <AsideWorkflowTimeline events={events} scope="response-test" duration={56} busy={busy} />;
    const view = render(timeline(true));
    const spinner = screen.getByRole("status", { name: "응답 생성 중" });
    expect(spinner.previousElementSibling?.classList.contains("aside-chevron")).toBe(true);
    expect(spinner.closest(".aside-activity")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "작업 과정 펼침/접기" }));
    expect(screen.getByRole("status", { name: "응답 생성 중" })).toBeTruthy();
    view.rerender(timeline(false));
    expect(screen.queryByRole("status", { name: "응답 생성 중" })).toBeNull();
  });

  it("shows compaction quantities and window percentages on the status line", () => {
    const event = call("compact", "context_compaction", { title: "컨텍스트 자동 압축", executionMetadata: {
      pre_compact_tokens: 180000, post_compact_tokens: 40000, context_window_tokens: 200000, tokens_estimated: true,
    } });
    const view = render(panel([event]));
    expect(document.querySelector(".aside-system-event")?.textContent).toBe("컨텍스트 자동 압축 · 완료 · 약 180,000 토큰 (90%) → 40,000 토큰 (20%)");
    view.rerender(panel([{ ...event, status: "running" }]));
    expect(document.querySelector(".aside-system-event")?.textContent).toContain("180,000 토큰 (90%) → 압축 중");
    view.rerender(panel([{ ...event, status: "error" }]));
    expect(document.querySelector(".aside-system-event")?.textContent).toContain("→ 확인 불가");
  });

  it.each([null, -1, NaN, Infinity, "100"])("does not fabricate compaction percentages from invalid usage %s", (invalid) => {
    render(panel([call("compact", "context_compaction", { executionMetadata: {
      source: "provider", pre_compact_tokens: invalid, post_compact_tokens: invalid, context_window_tokens: 200000,
    } })]));
    expect(document.querySelector(".aside-system-event")?.textContent).toContain("전·후 사용량 미제공");
    expect(document.querySelector(".aside-system-event")?.textContent).not.toContain("%");
  });

  it("keeps valid zero usage and displays over-limit percentages without capping them", () => {
    render(panel([call("compact", "context_compaction", { executionMetadata: {
      pre_compact_tokens: 220000, post_compact_tokens: 0, context_window_tokens: 200000,
    } })]));
    expect(document.querySelector(".aside-system-event")?.textContent).toContain("220,000 토큰 (110%) → 0 토큰 (0%)");
  });
  it.each(["write_file", "future_write_document"])("keeps %s previews inside collapsible details while content updates", (toolName) => {
    const writing = call("writing", toolName, { status: "running", toolInput: { path: "report.html", content: "first chunk" } });
    const view = render(panel([call("search", "web_search"), writing]));
    expect(document.querySelector(".workflow-output-body")).toBeNull();
    const group = openActivity();
    expect(screen.getAllByRole("button", { name: /상세 실행 기록/, expanded: false })).toHaveLength(2);
    const detail = screen.getByRole("button", { name: /report.html 상세 실행 기록/ });
    fireEvent.click(detail);
    expect(document.querySelector(".workflow-output-body")?.textContent).toBe("first chunk");
    view.rerender(panel([call("search", "web_search"), { ...writing, toolInput: { path: "report.html", content: "first chunk second chunk" } }]));
    expect(document.querySelector(".workflow-output-body")?.textContent).toBe("first chunk second chunk");
    view.rerender(panel([call("search", "web_search"), { ...writing, status: "error", toolInput: { path: "report.html", content: "first chunk second chunk" } }]));
    expect(document.querySelector(".workflow-output-body")?.textContent).toBe("first chunk second chunk");
    fireEvent.click(detail);
    expect(document.querySelector(".workflow-output-body")).toBeNull();
    fireEvent.click(detail);
    fireEvent.click(group);
    expect(document.querySelector(".workflow-output-body")).toBeNull();
  });

  it.each(["web_search", "write_file", "mcp__future__lookup"])("shows a running indicator for %s and removes it on completion", (toolName) => {
    const event = call("active", toolName, { status: "running" });
    const view = render(panel([event]));
    expect(document.querySelectorAll(".aside-running-spinner")).toHaveLength(1);
    expect(screen.getByText("실행 중")).toBeTruthy();
    for (const status of ["done", "error", "warning"] as const) {
      view.rerender(panel([{ ...event, status }]));
      expect(document.querySelector(".aside-running-spinner")).toBeNull();
    }
  });

  it("keeps a collapsed group spinning while any call runs, including after another call fails", () => {
    const events = [call("failed", "web_search", { status: "error" }), call("active", "web_fetch", { status: "running" })];
    const view = render(panel(events));
    expect(document.querySelectorAll(".aside-running-spinner")).toHaveLength(1);
    openActivity();
    expect(document.querySelectorAll(".aside-running-spinner")).toHaveLength(2);
    view.rerender(panel([events[0], { ...events[1], status: "done" }]));
    expect(document.querySelector(".aside-running-spinner")).toBeNull();
    expect(screen.getByText("부분응답")).toBeTruthy();
  });

  it.each([false, true])("hides routine lifecycle history including restored=%s", (restored) => {
    const events: WorkflowEvent[] = [undefined, "planning", "activity", "final"].map((role, index) => ({
      id: `system-${index}`, toolName: "", title: `arbitrary lifecycle ${index}`, detail: "internal bookkeeping", status: "done", role: role as WorkflowEvent["role"], restored,
    }));
    const view = render(panel(events));
    expect(view.container.textContent).toBe("");
    view.unmount();
    render(panel(events));
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("shows one waiting indicator then replaces it with real progress and hides empty completion", () => {
    const lifecycle: WorkflowEvent = { id: "start", toolName: "", title: "request", detail: "internal", status: "running", role: "planning" };
    const timeline = (events: WorkflowEvent[], busy = true) => <AsideWorkflowTimeline events={events} scope="waiting-test" duration={11} busy={busy} />;
    const view = render(timeline([]));
    expect(screen.getByRole("status").textContent).toBe("답변 준비 중");
    view.rerender(timeline([lifecycle, { ...lifecycle, id: "next", role: "final" }]));
    expect(document.querySelectorAll(".aside-running-spinner")).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(timeline([lifecycle, note("progress", "자료의 기준을 비교합니다."), call("lookup", "mcp__new__lookup")]));
    expect(screen.queryByText("답변 준비 중")).toBeNull();
    expect(screen.getByText("자료의 기준을 비교합니다.")).toBeTruthy();
    expect(screen.queryByText("진행 기록")).toBeNull();
    view.rerender(timeline([{ ...lifecycle, status: "done" }], false));
    expect(view.container.textContent).toBe("");
  });

  it.each(["error", "warning"] as const)("keeps lifecycle %s visible alongside meaningful work", (status) => {
    render(panel([note("progress", "자료를 확인합니다."), { id: "failure", toolName: "", title: "연결 확인 필요", detail: "응답을 받지 못했습니다.", status, role: "final" }]));
    expect(screen.queryByText("응답을 받지 못했습니다.")).toBeNull();
    const toggle = screen.getByRole("button", { name: /연결 확인 필요/ });
    fireEvent.click(toggle);
    expect(screen.getByText("응답을 받지 못했습니다.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("응답을 받지 못했습니다.")).toBeNull();
    expect(screen.getByText("자료를 확인합니다.")).toBeTruthy();
  });

  it.each(["done", "warning", "error"] as const)("keeps prose and counted tools without duplicate purpose rows (%s)", (status) => {
    const prose = "자료를 비교합니다.";
    render(panel([
      note("p", prose),
      { id: "purpose", toolName: "", title: "정보 수집", detail: prose, status, role: "purpose" },
      call("one", "future_tool", { status }),
      note("p2", "결과를 검증합니다."), call("two"), call("three"),
    ]));
    expect(screen.getAllByText(prose)).toHaveLength(1);
    expect(screen.queryByText("정보 수집")).toBeNull();
    expect(document.querySelector(".aside-timeline")?.children).toHaveLength(4);
    expect(document.querySelectorAll(".aside-activity")[0].textContent).toContain("(1건)");
    expect(document.querySelectorAll(".aside-activity")[1].textContent).toContain("(2건)");
    const toggle = screen.getByRole("button", { name: /future_tool 상세 실행 기록/ });
    fireEvent.click(toggle);
    expect(screen.getByText("output one")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("output one")).toBeNull();
    expect(screen.getByText(prose)).toBeTruthy();
  });

  it("omits empty progress and heading-only summaries without an empty disclosure", () => {
    const view = render(panel([note("empty", "  "), { ...note("heading", "**Thinking**"), noteSource: "provider-summary" }]));
    expect(view.container.textContent).toBe("");
  });

  it("keeps prose between groups and opens actual calls, then their input and output", () => {
    render(panel([note("start", "설정과 실행 경로를 확인하겠습니다."), call("one"), call("two", "mcp__new-server__lookup", { toolInput: { query: "new data" } }), note("next", "응답에서 오류를 확인했습니다."), call("three")]));
    expect(screen.getByText("설정과 실행 경로를 확인하겠습니다.")).toBeTruthy();
    expect(screen.queryByText("output one")).toBeNull();
    const group = openActivity();
    expect(group.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "echo one 상세 실행 기록" }));
    expect(screen.getByText("output one")).toBeTruthy();
    expect(screen.getByText(/"command": "echo one"/)).toBeTruthy();
    expect(document.querySelector(".aside-timeline")?.children[2].textContent).toBe("응답에서 오류를 확인했습니다.");
    fireEvent.click(group);
    expect(screen.queryByText("output one")).toBeNull();
    expect(screen.getByText("응답에서 오류를 확인했습니다.")).toBeTruthy();
    expect(document.querySelector(".workflow-card")).toBeNull();
    expect(document.body.textContent).not.toContain("도구 3개");
    expect(document.body.textContent).not.toContain("⌄");
  });

  it("does not merge distinct calls to the same path or move calls across prose", () => {
    const events = [call("a", "write_file", { groupId: "g", toolInput: { path: "same.txt", content: "first" } }), note("n", "추가 내용을 반영합니다."), call("b", "write_file", { groupId: "g", toolInput: { path: "same.txt", content: "second" } })];
    const rows = asideTimelineRows(events);
    expect(rows.map((row) => row.kind)).toEqual(["actions", "note", "actions"]);
    expect(rows.filter((row) => row.kind === "actions").flatMap((row) => row.events).map((event) => event.toolCallId)).toEqual(["a", "b"]);
    expect(asideTimelineRows([...events, { ...events[0], output: "updated" }])).toHaveLength(3);
    expect(events[0].output).toBe("output a");
  });

  it("retains open call details when more calls arrive, on completion, collapse and remount", () => {
    const first = call("one", "cmd", { status: "running", output: "first chunk" });
    const view = render(panel([first]));
    fireEvent.click(screen.getByRole("button", { name: "echo one 상세 실행 기록" }));
    view.rerender(panel([{ ...first, output: "first chunk\nsecond chunk" }, call("two")]));
    expect(screen.getByText(/second chunk/)).toBeTruthy();
    view.rerender(panel([{ ...first, status: "done", output: "completed" }, call("two")]));
    expect(screen.getByText("completed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "작업 과정 펼침/접기" }));
    expect(screen.queryByText("completed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "작업 과정 펼침/접기" }));
    expect(screen.getByText("completed")).toBeTruthy();
    view.unmount();
    render(panel([{ ...first, id: "restored-one", status: "done", output: "completed", restored: true }, call("two")]));
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders provider summaries separately and preserves their full original text", () => {
    render(panel([note("n", "한국어 진행 설명입니다."), { ...note("r", "Checking sources.\nComparing evidence."), noteSource: "provider-summary" }]));
    expect(screen.queryByText(/Checking sources/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "추론 요약" }));
    expect(screen.getByText("Checking sources. Comparing evidence.")).toBeTruthy();
    expect(screen.getByText("한국어 진행 설명입니다.")).toBeTruthy();
  });

  it("shows failures for unknown tools and exposes credential-safe actual data", () => {
    render(panel([call("unknown", "mcp__future__custom", { status: "error", toolInput: { api_key: "never-show", nested: { password: "hidden" }, query: "valid query" }, output: 'authorization=secret-value\nHTTP 403' })]));
    expect(screen.getByText("실패")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /상세 실행 기록/ }));
    expect(document.body.textContent).toContain("HTTP 403");
    expect(document.body.textContent).toContain("valid query");
    for (const secret of ["never-show", "hidden", "secret-value"]) expect(document.body.textContent).not.toContain(secret);
    expect(workflowSafeText({ api_key: "never-show" })).toContain("[가림]");
    expect(workflowSafeText("Authorization: Bearer secret-token-value")).not.toContain("secret-token-value");
  });

  it("preserves an empty successful output and missing metadata without inventing values", () => {
    render(panel([call("empty", "new_tool", { toolInput: null, output: "", detail: "" })]));
    fireEvent.click(screen.getByRole("button", { name: /상세 실행 기록/ }));
    expect(screen.getByText("상세 출력 없음")).toBeTruthy();
    expect(screen.queryByText("종료 코드")).toBeNull();
  });

  it("shows captured exit code, cwd, time and expandable long output", () => {
    render(panel([call("long", "cmd", { startedAtMs: 1000, finishedAtMs: 2500, executionMetadata: { returncode: 7, cwd: "C:/work" }, output: "x".repeat(17000) + "END" })]));
    fireEvent.click(screen.getByRole("button", { name: /상세 실행 기록/ }));
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("C:/work")).toBeTruthy();
    expect(screen.getByText("완료 · 1.5초")).toBeTruthy();
    expect(document.querySelector(".aside-output")?.textContent).not.toContain("END");
    fireEvent.click(screen.getByRole("button", { name: /전체 출력 보기/ }));
    expect(document.body.textContent).toContain("END");
  });

  it("shows saved file content and real edit diffs only after opening details", () => {
    render(panel([call("write", "write_file", { toolInput: { path: "report.html", content: "<h1>Report</h1>" } }), call("edit", "edit_file", { toolInput: { path: "report.html", old_string: "Report", new_string: "Updated" } })]));
    expect(document.querySelector(".workflow-output-body")).toBeNull();
    openActivity();
    for (const toggle of screen.getAllByRole("button", { name: /상세 실행 기록/ })) fireEvent.click(toggle);
    expect(document.querySelector(".workflow-output-body")?.textContent).toContain("Report");
    expect(document.querySelector(".workflow-output-body.diff")?.textContent).toContain("Updated");
  });

  it("shows agent work at its recorded position with separate details", () => {
    render(panel([note("start", "역할을 나누어 검증합니다."), { id: "agents", toolName: "", title: "", detail: "", status: "done", role: "agents", agents: [{ id: "a", task: "검색 검증", model: "test-model", status: "completed", lastOutput: "실제 조회 성공", prompt: "검색을 검증하세요" }] }, note("end", "결과를 정리합니다.")]));
    fireEvent.click(screen.getByRole("button", { name: "서브에이전트 1개 사용" }));
    fireEvent.click(screen.getByRole("button", { name: /검색 검증/ }));
    expect(screen.getByText("검색을 검증하세요")).toBeTruthy();
    expect(screen.getAllByText("실제 조회 성공").length).toBeGreaterThan(0);
    expect(screen.getByText("결과를 정리합니다.")).toBeTruthy();
  });

  it("restores public progress, distinct same-path parallel calls and execution metadata", () => {
    let state = appReducer(initialAppState, { type: "backend_event", event: { type: "history_snapshot", value: "restored", history_events: [
      { type: "user", text: "검증" },
      { type: "progress_note", message: "병렬로 확인합니다." },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "a", tool_call_index: 0, tool_input: { path: "same.txt" }, timestamp: 1700000000000 },
      { type: "tool_started", tool_name: "write_file", tool_call_id: "b", tool_call_index: 1, tool_input: { path: "same.txt" }, timestamp: 1700000000100 },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "b", output: "second", timestamp: 1700000000200 },
      { type: "tool_completed", tool_name: "write_file", tool_call_id: "a", output: "first", execution_metadata: { returncode: 0 }, timestamp: 1700000000300 },
      { type: "assistant", text: "완료", has_tool_uses: false },
    ] } });
    expect(state.workflowEvents.filter((event) => event.toolName === "write_file").map((event) => event.output)).toEqual(["first", "second"]);
    expect(state.workflowEvents.find((event) => event.toolCallId === "a")?.executionMetadata?.returncode).toBe(0);
    render(<AppStateProvider initialState={state}><WorkflowPanel persistenceKey="restore" /></AppStateProvider>);
    expect(screen.getByText("병렬로 확인합니다.")).toBeTruthy();
  });

  it("keeps duplicate completion replay idempotent without reopening or losing other calls", () => {
    let state = initialAppState;
    const emit = (event: any) => { state = appReducer(state, { type: "backend_event", event }); };
    emit({ type: "tool_started", tool_name: "cmd", tool_call_id: "a", tool_call_index: 0, tool_input: { command: "one" } });
    emit({ type: "tool_started", tool_name: "cmd", tool_call_id: "b", tool_call_index: 0, tool_input: { command: "two" } });
    emit({ type: "tool_completed", tool_name: "cmd", tool_call_id: "a", output: "done" });
    emit({ type: "tool_completed", tool_name: "cmd", tool_call_id: "a", output: "done" });
    emit({ type: "tool_started", tool_name: "cmd", tool_call_id: "a", tool_input: { command: "one" } });
    const calls = state.workflowEvents.filter((event) => event.toolName === "cmd");
    expect(calls).toHaveLength(2);
    expect(calls.find((event) => event.toolCallId === "a")?.status).toBe("done");
    expect(calls.find((event) => event.toolCallId === "b")?.status).toBe("running");
  });

  it("hides heading-only summaries and shows the complete detailed body on restore", () => {
    const first = "여러 출처의 발표 시점과 근거를 비교했습니다. 서로 다른 조건의 수치를 구분했습니다.";
    const last = "확인되지 않은 내용은 별도로 표시합니다. 최종 비교에는 확인된 자료를 사용합니다.";
    render(panel([
      { ...note("short", "**Planning segmented web fetching for full texts**"), noteSource: "provider-summary", restored: true },
      { ...note("long", `## 자료 검토\n\n${first}\n\n**검토 결과**\n\n${last}`), noteSource: "provider-summary", restored: true },
    ]));
    expect(screen.getAllByRole("button", { name: "추론 요약" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "추론 요약" }));
    expect(screen.getByText(first)).toBeTruthy();
    expect(screen.getByText(last)).toBeTruthy();
    expect(screen.queryByText("자료 검토")).toBeNull();
    expect(screen.queryByText("검토 결과")).toBeNull();
    expect(document.querySelectorAll(".aside-note-detail p")).toHaveLength(2);
  });

  it("restores partial command output while the recorded call is still running", () => {
    const state = appReducer(initialAppState, { type: "backend_event", event: { type: "history_snapshot", value: "partial", history_events: [
      { type: "user", text: "검증" },
      { type: "tool_started", tool_name: "cmd", tool_call_id: "partial", tool_input: { command: "echo output" } },
      { type: "tool_progress", tool_name: "cmd", tool_call_id: "partial", output: "first chunk", execution_metadata: { cwd: "C:/work" } },
    ] } });
    expect(state.workflowEvents.find((event) => event.toolCallId === "partial")).toMatchObject({ output: "first chunk", executionMetadata: { cwd: "C:/work" } });
  });
});
