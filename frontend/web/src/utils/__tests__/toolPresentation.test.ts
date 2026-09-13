import { describe, expect, it } from "vitest";
import { isKnownLookupTool, toolDisplayName, toolResultSummary } from "../toolPresentation";
import type { WorkflowEvent } from "../../types/ui";

const event = (output: string, status: WorkflowEvent["status"] = "done"): WorkflowEvent => ({
  id: "bill", toolName: "mcp__national-assembly__assembly_bill", title: "", detail: "truncated...", output, status,
});

describe("tool presentation without model calls", () => {
  it("keeps the per-call Korean work description after completion without exposing raw HTTP output", () => {
    const running: WorkflowEvent = {
      ...event(""), toolName: "web_fetch", status: "running",
      toolInput: { url: "https://example.com/article", progress_message: "기사의 발행일과 주요 내용을 확인하고 있습니다." },
    };
    expect(toolResultSummary(running)).toContain("기사의 발행일과 주요 내용을 확인하고 있습니다.");
    const done = { ...running, status: "done" as const, output: "URL: https://example.com/article\n상태: 200\nContent-Type: text/html" };
    expect(toolResultSummary(done)).toBe("기사의 발행일과 주요 내용을 확인하고 있습니다. · 조회 완료");
    expect(toolResultSummary({ ...done, status: "warning" })).toContain("확인 필요");
    expect(toolResultSummary({ ...done, status: "error" })).toContain("조회 실패");
  });

  it("uses an honest fallback for older searches and distinguishes empty results", () => {
    const old = { ...event("검색 결과가 없습니다.", "warning"), toolName: "web_search", toolInput: { query: "POSCO steel" } };
    expect(toolResultSummary(old)).toBe("‘POSCO steel’ 관련 자료 검색 · 이 검색 조건에서는 결과가 없습니다.");
  });
  it("labels known queries without treating arbitrary MCP actions as lookups", () => {
    expect(toolDisplayName(event("").toolName)).toBe("국회 법안 검색");
    expect(isKnownLookupTool(event("").toolName)).toBe(true);
    expect(isKnownLookupTool("mcp__other__delete")).toBe(false);
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
    expect(toolResultSummary(event('{"total":5,...'))).toContain("응답을 받았습니다");
  });
  it("keeps errors and warnings explicit, including successful transports with error payloads", () => {
    expect(toolResultSummary(event('{"total":0,"items":[]}', "error"))).toContain("실패");
    expect(toolResultSummary(event('{}', "warning"))).toContain("확인해야");
    expect(toolResultSummary(event('{"error":"denied"}'))).toContain("오류");
  });
  it("summarizes actual bill details without inventing status", () => {
    expect(toolResultSummary(event('{"detail":{"BILL_NM":"철강법","PROC_RESULT":null}}'))).toBe("상세 정보 확인 · 철강법");
  });
});
