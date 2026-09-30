import { describe, expect, it } from "vitest";
import { appReducer, initialAppState } from "../reducer";

function streamInput(input: string, chunkSize: number, toolName = "write_file") {
  let state: typeof initialAppState = { ...initialAppState, sessionId: "stream-runtime" };
  for (let index = 0; index < input.length; index += chunkSize) {
    state = appReducer(state, {
      type: "backend_event",
      sessionId: "stream-runtime",
      event: {
        type: "tool_input_delta",
        tool_name: toolName,
        tool_call_id: "stream-call",
        arguments_delta: input.slice(index, index + chunkSize),
      },
    });
  }
  return state;
}

describe("streamed tool input previews", () => {
  it.each([1, 2, 3, 7, 4096])("preserves escaped content across %i-character chunks", (chunkSize) => {
    const content = '한글 😀\n"quoted"\\folder\\\t\r\b\f\u0000 literal \\u12 마지막\\';
    const state = streamInput(JSON.stringify({ content, path: "outputs/보고서.html" }), chunkSize);
    const preview = state.workflowEvents.find((event) => event.toolName === "write_file");
    expect(preview?.toolInput?.path).toBe("outputs/보고서.html");
    expect(preview?.toolInput?.content).toBe(content);
  });

  it("waits for an incomplete Unicode escape instead of displaying its syntax", () => {
    const partial = '{"path":"unicode.html","content":"before\\uD';
    let state = streamInput(partial, partial.length);
    expect(state.workflowEvents.find((event) => event.toolName === "write_file")?.toolInput?.content).toBe("before");
    state = appReducer(state, {
      type: "backend_event",
      sessionId: "stream-runtime",
      event: { type: "tool_input_delta", tool_name: "write_file", tool_call_id: "stream-call", arguments_delta: '55C after"}' },
    });
    expect(state.workflowEvents.find((event) => event.toolName === "write_file")?.toolInput?.content).toBe("before한 after");
  });

  it("preserves the full large file in the preview and its final tool event", () => {
    const content = '<p class="보고서">업무 내용 😀</p>\n'.repeat(75_000);
    let state = streamInput(JSON.stringify({ path: "large.html", content }), 4096, "mcp_custom_write_document");
    const preview = state.workflowEvents.find((event) => event.toolName === "mcp_custom_write_document");
    expect(preview?.toolInput?.content).toBe(content);
    state = appReducer(state, {
      type: "backend_event",
      sessionId: "stream-runtime",
      event: { type: "tool_started", tool_name: "mcp_custom_write_document", tool_call_id: "stream-call", tool_input: { path: "large.html", content } },
    });
    expect(state.workflowEvents.filter((event) => event.toolName === "mcp_custom_write_document")).toHaveLength(1);
    expect(state.workflowEvents.find((event) => event.toolName === "mcp_custom_write_document")?.toolInput?.content).toBe(content);
  }, 15_000);

  it("retains the best-effort preview for malformed escape sequences", () => {
    const input = '{"path":"draft.html","content":"before\\xafter';
    const state = streamInput(input, input.length);
    expect(state.workflowEvents.find((event) => event.toolName === "write_file")?.toolInput?.content).toBe("beforexafter");
  });
});
