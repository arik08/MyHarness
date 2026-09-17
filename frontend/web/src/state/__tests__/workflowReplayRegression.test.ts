import { describe, expect, it } from "vitest";
import { appReducer, initialAppState } from "../reducer";
import type { BackendEvent } from "../../types/backend";

const receive = (state: typeof initialAppState, event: BackendEvent) =>
  appReducer(state, { type: "backend_event", event });

describe("workflow replay regressions", () => {
  it.each([false, true])("clears only the completed call buffer (error=%s)", (isError) => {
    let state = receive(initialAppState, { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "a", arguments_delta: '{"path":"a.txt","content":"A' });
    state = receive(state, { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "b", arguments_delta: '{"path":"b.txt","content":"B' });
    expect(Object.keys(state.workflowInputBuffers)).toHaveLength(2);
    state = receive(state, { type: "tool_completed", tool_name: "write_file", tool_call_id: "a", is_error: isError });
    expect(Object.keys(state.workflowInputBuffers)).toHaveLength(1);
    state = receive(state, { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "b", arguments_delta: ' complete"}' });
    expect(state.workflowEvents.find((event) => event.toolCallId === "b")?.toolInput?.content).toBe("B complete");
  });
  it.each([false, true])("keeps interleaved file previews isolated by call id (history=%s)", (history) => {
    const events = [
      { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "a", arguments_delta: '{"path":"a.txt","content":"A' },
      { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "b", arguments_delta: '{"path":"b.txt","content":"B' },
      { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "a", arguments_delta: ' end"}' },
      { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "b", arguments_delta: ' end"}' },
    ] as BackendEvent[];
    const state = history
      ? receive(initialAppState, { type: "history_snapshot", history_events: [{ type: "user", text: "Write both" }, ...events] })
      : events.reduce(receive, initialAppState);
    expect(state.workflowEvents.find((event) => event.toolCallId === "a")?.toolInput).toMatchObject({ path: "a.txt", content: "A end" });
    expect(state.workflowEvents.find((event) => event.toolCallId === "b")?.toolInput).toMatchObject({ path: "b.txt", content: "B end" });
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("retains tool inputs through sparse progress (history=%s, error=%s)", (history, isError) => {
    const events: BackendEvent[] = [
      { type: "tool_started", tool_name: "new_custom_tool", tool_call_id: "call-a", tool_call_index: 3, tool_input: { path: "report.csv" } },
      { type: "tool_progress", tool_name: "new_custom_tool", tool_call_id: "call-a", message: "Working", execution_metadata: { marker: "retained" } },
      { type: "tool_completed", tool_name: "new_custom_tool", tool_call_id: "call-a", output: "result", is_error: isError },
    ];
    const state = history
      ? receive(initialAppState, { type: "history_snapshot", history_events: [{ type: "user", text: "Run" }, ...events] })
      : events.reduce(receive, initialAppState);
    const call = state.workflowEvents.find((event) => event.toolCallId === "call-a");
    expect(call?.toolInput).toEqual({ path: "report.csv" });
    expect(call?.toolCallIndex).toBe(3);
    expect(call?.status).toBe(isError ? "error" : "done");
    expect(call?.executionMetadata).toEqual({ marker: "retained" });
  });

  it.each([false, true])("does not treat a null call index as zero (history=%s)", (history) => {
    const events: BackendEvent[] = [
      { type: "tool_started", tool_name: "new_custom_tool", tool_call_id: "call-a", tool_call_index: null },
    ];
    const state = history
      ? receive(initialAppState, { type: "history_snapshot", history_events: [{ type: "user", text: "Run" }, ...events] })
      : events.reduce(receive, initialAppState);
    expect(state.workflowEvents.find((event) => event.toolCallId === "call-a")?.toolCallIndex).toBeNull();
  });

  it("does not carry usage or team activity into another saved conversation", () => {
    let state = receive(initialAppState, { type: "assistant_complete", message: "done", session_usage: { input_tokens: 80, cached_input_tokens: 0, uncached_input_tokens: 80, output_tokens: 20, total_tokens: 100 } });
    state = receive(state, { type: "swarm_status", swarm_teammates: [{ id: "a", name: "Old team", status: "running" }], swarm_notifications: [{ id: "n", message: "Old notification" }] });
    expect(state.sessionUsage).not.toBeNull();
    expect(state.swarmTeammates).not.toHaveLength(0);
    state = receive(state, { type: "history_snapshot", value: "different", history_events: [{ type: "user", text: "Other chat" }, { type: "assistant", text: "Other answer" }] });
    expect(state.sessionUsage).toBeNull();
    expect(state.swarmTeammates).toEqual([]);
    expect(state.swarmNotifications).toEqual([]);
  });

  it("preserves each legacy call's own completion time and execution details", () => {
    const state = receive(initialAppState, { type: "history_snapshot", history_events: [
      { type: "user", text: "Run twice" },
      { type: "tool_started", tool_name: "custom_tool", timestamp: 1 },
      { type: "tool_completed", tool_name: "custom_tool", timestamp: 2, execution_metadata: { marker: "first" } },
      { type: "tool_started", tool_name: "custom_tool", timestamp: 3 },
      { type: "tool_completed", tool_name: "custom_tool", timestamp: 5, execution_metadata: { marker: "second" } },
    ] });
    const calls = state.workflowEvents.filter((event) => event.toolName === "custom_tool");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.finishedAtMs)).toEqual([2000, 5000]);
    expect(calls.map((call) => call.executionMetadata?.marker)).toEqual(["first", "second"]);
  });
});
