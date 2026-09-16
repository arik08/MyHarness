import { describe, expect, it } from "vitest";
import { isKnownLookupTool, toolDisplayName, toolResultSummary, workflowGroupStatus, workflowActionSummary } from "../toolPresentation";
import type { WorkflowEvent } from "../../types/ui";

const event = (output: string, status: WorkflowEvent["status"] = "done"): WorkflowEvent => ({
  id: "bill", toolName: "mcp__national-assembly__assembly_bill", title: "", detail: "truncated...", output, status,
});

describe("tool presentation without model calls", () => {
  const call = (id: string, toolName: string, extra: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
    id, toolName, title: "", detail: "", status: "done", ...extra,
  });
  it("summarizes one or two categories and falls back when the row would get crowded", () => {
    const searches = [call("1", "web_search"), call("2", "grep")];
    expect(workflowActionSummary(searches)).toBe("검색 2회");
    expect(workflowActionSummary([...searches, call("3", "read_file")])).toBe("검색 2회 · 파일 확인 1회");
    expect(workflowActionSummary([...searches, call("3", "read_file"), call("4", "edit_file")])).toBe("작업 4회");
  });
  it("counts calls, not notes, duplicate updates, successes, or unique files", () => {
    const first = call("1", "read_file", { toolCallId: "a", status: "running" });
    expect(workflowActionSummary([
      first, { ...first, id: "2", status: "error" },
      call("3", "read_file", { toolCallId: "b", status: "done" }),
      call("4", "", { role: "activity" }), call("5", "read_file", { role: "reasoning" }),
    ])).toBe("파일 확인 2회");
    expect(workflowActionSummary([call("old1", "read_file", { restored: true }), call("old2", "read_file", { restored: true })])).toBe("파일 확인 2회");
    expect(workflowActionSummary([call("note", "", { role: "reasoning" })])).toBe("처리 내역");
  });
  it("never guesses the intent of new tools or shell commands from names and arguments", () => {
    for (const toolName of ["mcp__new__search_and_delete", "bash", "cmd", "future_search"]) {
      expect(workflowActionSummary([call("1", "web_search"), call("2", toolName, { toolInput: { command: "cat file.txt" } })])).toBe("작업 2회");
    }
  });
  it("classifies mixed outcomes as warnings regardless of order and keeps active work running", () => {
    expect(workflowGroupStatus([event("", "error"), event("", "done")])).toBe("warning");
    expect(workflowGroupStatus([event("", "done"), event("", "error")])).toBe("warning");
    expect(workflowGroupStatus([event("", "error"), event("", "done"), event("", "error")])).toBe("warning");
    expect(workflowGroupStatus([event("", "error"), event("", "error")])).toBe("error");
    expect(workflowGroupStatus([event("", "warning"), event("", "error")])).toBe("warning");
    expect(workflowGroupStatus([event("", "error"), event("", "running")])).toBe("running");
    expect(workflowGroupStatus([event("", "error"), { ...event("", "done"), role: "reasoning" }])).toBe("error");
    expect(workflowGroupStatus([event("", "done")])).toBe("done");
  });
  it("keeps the per-call Korean work description after completion without exposing raw HTTP output", () => {
    const running: WorkflowEvent = {
      ...event(""), toolName: "web_fetch", status: "running",
      toolInput: { url: "https://example.com/article", progress_message: "기사의 발행일과 주요 내용을 확인하고 있습니다." },
    };
    expect(toolResultSummary(running)).toContain("기사의 발행일과 주요 내용을 확인하고 있습니다.");
    const done = { ...running, status: "done" as const, output: "URL: https://example.com/article\n상태: 200\nContent-Type: text/html" };
    expect(toolResultSummary(done)).toBe("기사의 발행일과 주요 내용을 확인하고 있습니다.");
    expect(toolResultSummary({ ...done, status: "warning" })).toContain("부분응답");
    expect(toolResultSummary({ ...done, status: "error" })).toContain("조회 실패");
  });

  it("uses an honest fallback for older searches and distinguishes empty results", () => {
    const old = { ...event("검색 결과가 없습니다.", "warning"), toolName: "web_search", toolInput: { query: "POSCO steel" } };
    expect(toolResultSummary(old)).toBe("‘POSCO steel’ 관련 자료 검색 · 이 검색 조건에서는 결과가 없습니다.");
  });
  it("labels known queries without treating arbitrary MCP actions as lookups", () => {
    expect(toolDisplayName(event("").toolName)).toBe("mcp · national-assembly · assembly_bill");
    expect(isKnownLookupTool(event("").toolName)).toBe(true);
    expect(isKnownLookupTool("mcp__other__delete")).toBe(false);
  });
  it("identifies unlisted MCP servers and actions instead of collapsing them into a generic label", () => {
    expect(toolDisplayName("mcp__sqlite_analysis__list_tables")).toBe("mcp · sqlite_analysis · list_tables");
    expect(toolDisplayName("mcp__other__delete")).toBe("mcp · other · delete");
    expect(toolDisplayName("mcp__other__nested__action")).toBe("mcp · other · nested__action");
    expect(toolDisplayName("read_file")).toBe("");
  });
  it("uses full output rather than the truncated detail and limits visible items", () => {
    const summary = toolResultSummary(event(JSON.stringify({ total: 50, items: Array.from({ length: 5 }, (_, i) => ({ billName: `법안 ${i}` })) })));
    expect(summary).toContain("조회 결과 50건");
    expect(summary).toContain("법안 2");
    expect(summary).not.toContain("법안 3");
    expect(summary).toContain("외 2건");
  });
  it("does not overstate empty, missing, or partial data", () => {
    expect(toolResultSummary(event('{"total":0,"items":[]}'))).toBe("이 조회 조건에서는 결과가 없습니다.");
    expect(toolResultSummary(event('{"items":[]}'))).toContain("응답에 포함된 항목 0건");
    expect(toolResultSummary(event('{"detail":{"total":0,"items":[]}}'))).toContain("이 조회 조건");
    expect(toolResultSummary(event('{"total":5,...'))).toBe("응답 수신");
  });
  it("keeps errors and warnings explicit, including successful transports with error payloads", () => {
    expect(toolResultSummary(event('{"total":0,"items":[]}', "error"))).toContain("실패");
    expect(toolResultSummary(event('{}', "warning"))).toContain("부분응답");
    expect(toolResultSummary(event('{"error":"denied"}'))).toContain("오류");
  });
  it("summarizes actual bill details without inventing status", () => {
    expect(toolResultSummary(event('{"detail":{"BILL_NM":"철강법","PROC_RESULT":null}}'))).toBe("상세 정보 확인 · 철강법");
  });
});
