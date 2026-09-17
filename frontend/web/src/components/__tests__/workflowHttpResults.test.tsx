import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AsideWorkflowTimeline } from "../AsideWorkflowTimeline";
import { httpStatusLabel, toolResultSummary, workflowDisplayStatus, workflowGroupStatus } from "../../utils/toolPresentation";
import type { WorkflowEvent } from "../../types/ui";

afterEach(cleanup);
const failure = (output: string, extra: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  id: "http", toolName: "web_fetch", title: "페이지 조회", detail: "", output, status: "warning", ...extra,
});

it.each([
  [400, "잘못된 요청"], [401, "인증 필요"], [402, "결제 필요"], [403, "접근 거부"],
  [404, "페이지 없음"], [408, "요청 시간 초과"], [429, "요청 제한"],
  [500, "서버 오류"], [502, "게이트웨이 오류"], [503, "서비스 이용 불가"], [504, "게이트웨이 시간 초과"],
  [499, "요청 오류"], [599, "서버 오류"],
])("classifies HTTP %i by code for existing and new tools", (code, label) => {
  for (const toolName of ["web_fetch", "mcp__new__lookup", "future_tool"]) {
    for (const output of [
      `web_fetch 실패: Client error '${code} HTTP Forbidden' for url 'https://example.com'`,
      `HTTP/1.1 ${code}`, `HTTP status code: ${code}`, `${code} Client Error: reason`,
      JSON.stringify({ error: { status_code: code } }), JSON.stringify({ statusCode: String(code) }),
    ]) {
      const event = failure(output, { toolName });
      expect(workflowDisplayStatus(event)).toBe(`http_${code}`);
      expect(httpStatusLabel(workflowDisplayStatus(event))).toBe(label);
      expect(toolResultSummary(event)).toContain(label);
      expect(toolResultSummary(event)).not.toContain(String(code));
    }
  }
});

it("does not interpret ordinary numbers, successful content, or active calls as HTTP failures", () => {
  for (const output of ["총 401건", "Permission denied", "timeout", "https://example.com/403", '{"total":404}', "HTTP 200"]) {
    expect(workflowDisplayStatus(failure(output))).toBe("warning");
  }
  for (const status of ["running", "done"] as const) {
    expect(workflowDisplayStatus(failure("HTTP 403", { status }))).toBe(status);
  }
  expect(workflowDisplayStatus(failure("timeout", { status: "error" }))).toBe("error");
});

it("renders restored and live failures consistently in group, header and expanded details", () => {
  const event = failure("web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://example.com'");
  render(<AsideWorkflowTimeline events={[event, { ...event, id: "old", restored: true }]}
    scope="http-results" duration={1} busy={false} expanded />);
  expect(screen.getAllByText("인증 필요")).toHaveLength(5);
  expect(screen.queryByText("인증 필요 · 401")).toBeNull();
  expect(screen.getAllByText(/Client error '401 HTTP Forbidden'/).length).toBeGreaterThan(0);
  expect(screen.queryByText("부분응답")).toBeNull();
  expect(screen.queryByText("실패")).toBeNull();
});

it("keeps mixed HTTP, general failure, success and running group outcomes distinct", () => {
  const denied = failure("HTTP 403");
  expect(workflowGroupStatus([denied, denied])).toBe("http_403");
  for (const other of [failure("HTTP 404"), failure("timeout", { status: "error" }), failure("ok", { status: "done" })]) {
    expect(workflowGroupStatus([denied, other])).toBe("warning");
    expect(workflowGroupStatus([other, denied])).toBe("warning");
  }
  expect(workflowGroupStatus([denied, failure("", { status: "running" })])).toBe("running");
});
