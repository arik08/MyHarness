import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { workflowElapsedSeconds } from "../../utils/workflowTime";
import { AppStateProvider } from "../../state/app-state";
import { appReducer, initialAppState } from "../../state/reducer";
import type { WorkflowEvent } from "../../types/ui";
import { WorkflowPanel } from "../WorkflowPanel";

const wait = (start: number, end?: number, id = "question"): WorkflowEvent => ({
  id, toolName: "ask_user_question", title: "질문", detail: "답변 대기", startedAtMs: start,
  finishedAtMs: end, status: end === undefined ? "running" : "done",
});
afterEach(() => { cleanup(); vi.useRealTimers(); sessionStorage.clear(); });

it("freezes while waiting, then resumes without adding the wait", () => {
  expect(workflowElapsedSeconds(1000, [wait(6000)], 11000)).toBe(5);
  expect(workflowElapsedSeconds(1000, [wait(6000)], 311000)).toBe(5);
  expect(workflowElapsedSeconds(1000, [wait(6000, 311000)], 314000)).toBe(8);
});
it("unions overlapping rounds, ignores unrelated work and clips waits to this turn", () => {
  const events = [wait(5000, 15000), wait(10000, 20000, "second"), wait(22000, 25000, "third"),
    { ...wait(1000, 30000, "read"), toolName: "read_file" }];
  expect(workflowElapsedSeconds(1000, events, 30000)).toBe(11);
  expect(workflowElapsedSeconds(24000, events, 30000)).toBe(5);
  expect(workflowElapsedSeconds(null, events, 30000)).toBeNull();
  expect(workflowElapsedSeconds(30000, [], 20000)).toBe(0);
});
it("keeps the visible counter unchanged through five minutes of user input", () => {
  vi.useFakeTimers(); vi.setSystemTime(11000);
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "time", busy: true,
    workflowStartedAtMs: 1000, workflowEvents: [wait(6000)] }}><WorkflowPanel /></AppStateProvider>);
  expect(screen.getByText("5초 동안 작업 중")).toBeTruthy();
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.getByText("5초 동안 작업 중")).toBeTruthy();
});
it("uses the same active duration when cancellation completes a waiting turn", () => {
  const state = { ...initialAppState, busy: true, workflowStartedAtMs: 1000, workflowEvents: [wait(6000)] };
  const result = appReducer(state, { type: "backend_event", event: { type: "line_complete", timestamp_ms: 311000 } });
  expect(result.workflowDurationSeconds).toBe(5);
});
