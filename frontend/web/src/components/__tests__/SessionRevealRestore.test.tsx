import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { appReducer, initialAppState } from "../../state/reducer";
import type { AppState } from "../../types/ui";
import { MessageList } from "../MessageList";
import { StreamingTextRenderer } from "../StreamingTextRenderer";

afterEach(() => vi.useRealTimers());

it("shows all running workflow rows from a live replay snapshot without replay delays", () => {
  vi.useFakeTimers();
  const restored = appReducer({ ...initialAppState, busy: true }, {
    type: "backend_event",
    event: {
      type: "history_snapshot", live_replay: true,
      history_events: [
        { type: "user", text: "Research" },
        { type: "assistant", text: "Research plan" },
        { type: "tool_started", tool_name: "web_fetch", tool_input: { url: "https://example.com" } },
      ],
    },
  });
  expect(restored.workflowEvents.length).toBeGreaterThan(1);
  expect(restored.workflowEvents.every((event) => event.restored)).toBe(true);
  render(<AppStateProvider initialState={restored}><MessageList /></AppStateProvider>);
  expect(document.querySelectorAll(".workflow-step").length).toBeGreaterThan(1);
  expect(document.body.textContent).toContain("웹 페이지 조회");
});

it("shows cached running progress immediately after switching away and back", () => {
  vi.useFakeTimers();
  const running: AppState = {
    ...initialAppState, sessionId: "a", busy: true,
    messages: [
      { id: "u", role: "user", text: "Research" },
      { id: "a", role: "assistant", text: "Already received answer" },
    ],
    workflowAnchorMessageId: "u",
    workflowEvents: [
      { id: "p", toolName: "", title: "Plan", detail: "Ready", role: "planning", status: "done" },
      { id: "t", toolName: "web_fetch", title: "Fetch", detail: "Latest progress", status: "running" },
    ],
  };
  const away = appReducer(running, { type: "session_started", sessionId: "b" });
  const back = appReducer({ ...away, messages: [], workflowEvents: [] }, {
    type: "session_started", sessionId: "a", busy: true, replay: true,
  });
  render(<AppStateProvider initialState={back}><MessageList /></AppStateProvider>);
  expect(document.querySelectorAll(".workflow-step")).toHaveLength(2);
  expect(back.workflowEvents.some((event) => event.detail === "Latest progress")).toBe(true);
  expect(document.body.textContent).toContain("웹 페이지 조회");
  expect(document.body.textContent).toContain("Already received answer");
});

it("snaps restored text updates while continuing to animate new live text", () => {
  vi.useFakeTimers();
  const settings = { streamStartBufferMs: 200, streamRevealDurationMs: 500 };
  const view = render(<StreamingTextRenderer text="Saved" restoredText="Saved" settings={settings} streaming />);
  expect(view.container.textContent?.trim()).toBe("Saved");
  view.rerender(<StreamingTextRenderer text="Saved snapshot" restoredText="Saved snapshot" settings={settings} streaming />);
  expect(view.container.textContent?.trim()).toBe("Saved snapshot");
  view.rerender(<StreamingTextRenderer text="Saved snapshot new live text" restoredText="Saved snapshot" settings={settings} streaming />);
  expect(view.container.textContent?.trim()).toBe("Saved snapshot");
  act(() => vi.advanceTimersByTime(600));
  expect(view.container.textContent?.trim()).toBe("Saved snapshot new live text");
});
