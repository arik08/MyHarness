import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMessageAutoFollow } from "../useMessageAutoFollow";
import { initialAppState } from "../../state/reducer";

afterEach(() => vi.useRealTimers());

it("positions completed chats before paint without animating later text layout changes", () => {
  vi.useFakeTimers();
  let height = 1400;
  let top = 0;
  const dispatch = vi.fn();
  const frames = vi.spyOn(window, "requestAnimationFrame");
  function Harness({ busy = false, text = "Completed answer" }) {
    const message = { id: "a", role: "assistant" as const, text, isComplete: !busy };
    const follow = useMessageAutoFollow({
      state: { ...initialAppState, busy, messages: [message],
        appSettings: { ...initialAppState.appSettings, streamScrollDurationMs: 600 } },
      dispatch, lastMessage: message, activeWorkflowFollowSignature: "",
    });
    return <>
      <section ref={(element) => {
        follow.messagesRef.current = element;
        if (element) Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => height },
          clientHeight: { configurable: true, get: () => 400 },
          scrollTop: { configurable: true, get: () => top,
            set: (value: number) => { top = Math.max(0, Math.min(height - 400, value)); } },
        });
      }} />
      <button onClick={follow.handleVisibleTextChange}>Text layout</button>
    </>;
  }
  const view = render(<Harness />);
  expect(top).toBe(1000);
  expect(frames).not.toHaveBeenCalled();
  height = 1800;
  fireEvent.click(screen.getByText("Text layout"));
  expect(top).toBe(1400);
  expect(frames).not.toHaveBeenCalled();
  height = 2200;
  view.rerender(<Harness text="Another completed answer" />);
  expect(top).toBe(1800);
  expect(frames).not.toHaveBeenCalled();
  height = 2600;
  view.rerender(<Harness busy text="New live answer" />);
  expect(frames).toHaveBeenCalled();
  expect(top).toBe(1800);
  view.rerender(<Harness text="New answer finished" />);
  expect(top).toBe(2200);
  act(() => vi.advanceTimersByTime(1000));
  expect(top).toBe(2200);
  frames.mockRestore();
});

it("shows a jump button away from the bottom and resumes streaming until the user scrolls up", () => {
  vi.useFakeTimers();
  let height = 1400;
  let top = 0;
  const dispatch = vi.fn();
  function Harness({ text = "first", busy = true, readOnly = false }) {
    const message = { id: "a", role: "assistant" as const, text, isComplete: !busy };
    const follow = useMessageAutoFollow({
      state: { ...initialAppState, busy, historyReadOnly: readOnly, messages: [message],
        appSettings: { ...initialAppState.appSettings, streamScrollDurationMs: 0 } },
      dispatch, lastMessage: message, activeWorkflowFollowSignature: "",
    });
    return <>
      <section data-testid="messages" ref={(element) => {
        follow.messagesRef.current = element;
        if (element) Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => height },
          clientHeight: { configurable: true, get: () => 400 },
          scrollTop: { configurable: true, get: () => top,
            set: (value: number) => { top = Math.max(0, Math.min(height - 400, value)); } },
        });
      }} onScroll={(event) => follow.handleScroll(event.currentTarget)}
      onWheel={(event) => follow.handleWheel(event.currentTarget, event.deltaY)} />
      {follow.showJumpToLatest && <button onClick={follow.jumpToLatest}>Jump</button>}
    </>;
  }
  const view = render(<Harness />);
  const messages = screen.getByTestId("messages");
  fireEvent.scroll(messages);
  expect(screen.queryByText("Jump")).toBeNull();

  fireEvent.wheel(messages, { deltaY: -200 });
  top = 300;
  fireEvent.scroll(messages);
  expect(screen.getByText("Jump")).toBeTruthy();
  height += 200;
  view.rerender(<Harness text="second" />);
  expect(top).toBe(300);

  fireEvent.click(screen.getByText("Jump"));
  expect(top).toBe(1200);
  expect(screen.queryByText("Jump")).toBeNull();
  height += 200;
  view.rerender(<Harness text="third" />);
  expect(top).toBe(1400);

  fireEvent.wheel(messages, { deltaY: -200 });
  top = 400;
  fireEvent.scroll(messages);
  height += 200;
  view.rerender(<Harness text="fourth" />);
  expect(top).toBe(400);
  expect(screen.getByText("Jump")).toBeTruthy();

  view.rerender(<Harness text="done" busy={false} readOnly />);
  fireEvent.click(screen.getByText("Jump"));
  expect(top).toBe(height - 400);
  expect(screen.queryByText("Jump")).toBeNull();
  act(() => vi.runOnlyPendingTimers());
});

it("stops settled animation frames and resumes on text or delayed layout growth without taking over user scrolling", () => {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let now = performance.now();
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { callbacks.delete(id); });
  let resize: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  let height = 1400;
  let top = 0;
  function Harness({ text = "stream" }) {
    const message = { id: "a", role: "assistant" as const, text, isComplete: false };
    const follow = useMessageAutoFollow({ state: { ...initialAppState, busy: true, messages: [message],
      appSettings: { ...initialAppState.appSettings, streamScrollDurationMs: 600 } },
      dispatch: () => {}, lastMessage: message, activeWorkflowFollowSignature: "" });
    return <section data-testid="settle-messages" ref={(element) => {
      follow.messagesRef.current = element;
      if (element) Object.defineProperties(element, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, get: () => 400 },
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(height - 400, value); } },
      });
    }} onWheel={(event) => follow.handleWheel(event.currentTarget, event.deltaY)} />;
  }
  const advanceFrames = () => act(() => {
    for (let count = 0; count < 600 && callbacks.size; count++) {
      now += 16;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(now));
    }
  });
  try {
    const view = render(<Harness />);
    advanceFrames();
    expect(top).toBeCloseTo(1000, 0);
    expect(callbacks.size).toBe(0);
    height += 300;
    act(() => resize?.());
    expect(callbacks.size).toBe(1);
    advanceFrames();
    expect(top).toBeCloseTo(1300, 0);
    expect(callbacks.size).toBe(0);
    height += 300;
    view.rerender(<Harness text="more streamed text" />);
    advanceFrames();
    expect(top).toBeCloseTo(1600, 0);
    expect(callbacks.size).toBe(0);
    fireEvent.wheel(screen.getByTestId("settle-messages"), { deltaY: -200 });
    top = 500;
    height += 300;
    act(() => resize?.());
    view.rerender(<Harness text="next while reading above" />);
    expect(callbacks.size).toBe(0);
    expect(top).toBe(500);
  } finally {
    raf.mockRestore(); cancel.mockRestore(); vi.unstubAllGlobals();
  }
});
