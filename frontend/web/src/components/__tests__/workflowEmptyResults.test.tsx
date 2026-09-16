import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AsideWorkflowTimeline } from "../AsideWorkflowTimeline";
import { workflowDisplayStatus, workflowGroupStatus } from "../../utils/toolPresentation";
import type { WorkflowEvent } from "../../types/ui";

afterEach(cleanup);
const empty: WorkflowEvent = { id: "empty", toolName: "web_search", title: "검색", detail: "", output: "검색 결과가 없습니다.", status: "warning" };

it("shows no results in restored call details, call headers and the group", () => {
  render(<AsideWorkflowTimeline events={[empty, { ...empty, id: "second", restored: true }]}
    scope="empty-results" duration={1} busy={false} expanded />);
  expect(screen.getAllByText("결과 없음")).toHaveLength(5);
  expect(screen.queryByText("부분응답")).toBeNull();
});

it("recognizes explicit empty result contracts from new tools without hiding errors or missing data", () => {
  const structured = { ...empty, toolName: "mcp__future__lookup", output: '{"total":0,"items":[]}' };
  expect(workflowDisplayStatus(structured)).toBe("empty");
  expect(workflowDisplayStatus({ ...structured, status: "error" })).toBe("error");
  expect(workflowDisplayStatus({ ...structured, status: "running" })).toBe("running");
  for (const output of ['{}', '{"items":[]}', '{"total":3,"items":[]}', '{"error":"timeout","total":0,"items":[]}', 'invalid']) {
    expect(workflowDisplayStatus({ ...structured, output })).toBe("warning");
  }
});

it("keeps mixed and in-progress group outcomes distinct", () => {
  const done = { ...empty, output: "found", status: "done" as const };
  const error = { ...done, status: "error" as const };
  expect(workflowGroupStatus([empty, empty])).toBe("empty");
  expect(workflowGroupStatus([empty, done])).toBe("done");
  expect(workflowGroupStatus([empty, error])).toBe("error");
  expect(workflowGroupStatus([empty, { ...done, status: "running" }])).toBe("running");
});
