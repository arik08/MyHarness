import { describe, expect, it, vi } from "vitest";
import type { BackendEvent } from "../../types/backend";
import { createWorkflowEventCoalescer } from "../workflowEventCoalescer";

describe("createWorkflowEventCoalescer", () => {
  it("bounds a burst of 1000 answer chunks without waiting for the next message", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coalescer = createWorkflowEventCoalescer(emit);
    for (let index = 0; index < 1000; index += 1) coalescer.push({ type: "assistant_delta", message: "가" });
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event.message).join("")).toBe("가".repeat(1000));
    coalescer.push({ type: "assistant_delta", message: "끝" });
    coalescer.push({ type: "assistant_delta", message: "!" });
    coalescer.push({ type: "line_complete" });
    expect(emit.mock.calls.slice(-2).map(([event]) => event)).toEqual([
      { type: "assistant_delta", message: "!" }, { type: "line_complete" },
    ]);
    vi.useRealTimers();
  });
  it("coalesces rapid tool input deltas on a timer", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coalescer = createWorkflowEventCoalescer(emit, { flushMs: 120 });

    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "{\"content\":\"hello",
    });
    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: " world",
    });

    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(119);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "{\"content\":\"hello world",
    });
  });

  it("keeps different tool calls separate while coalescing", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coalescer = createWorkflowEventCoalescer(emit, { flushMs: 120 });

    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "a",
    });
    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 1,
      arguments_delta: "b",
    });
    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "c",
    });

    vi.advanceTimersByTime(120);

    expect(emit.mock.calls.map((call) => call[0] as BackendEvent)).toEqual([
      {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "ac",
      },
      {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 1,
        arguments_delta: "b",
      },
    ]);
  });

  it("flushes pending deltas before non-delta events", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coalescer = createWorkflowEventCoalescer(emit, { flushMs: 120 });

    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "draft",
    });
    coalescer.push({
      type: "tool_completed",
      tool_name: "write_file",
      tool_call_index: 0,
      output: "Wrote report.html",
      is_error: false,
    });

    expect(emit.mock.calls.map((call) => call[0] as BackendEvent)).toEqual([
      {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "draft",
      },
      {
        type: "tool_completed",
        tool_name: "write_file",
        tool_call_index: 0,
        output: "Wrote report.html",
        is_error: false,
      },
    ]);
  });

  it("flushes the last pending delta during cleanup", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coalescer = createWorkflowEventCoalescer(emit, { flushMs: 120 });

    coalescer.push({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "final draft",
    });
    coalescer.flush();

    expect(emit).toHaveBeenCalledWith({
      type: "tool_input_delta",
      tool_name: "write_file",
      tool_call_index: 0,
      arguments_delta: "final draft",
    });
  });
});
