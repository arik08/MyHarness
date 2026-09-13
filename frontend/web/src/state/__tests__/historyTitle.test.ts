import { describe, expect, it } from "vitest";
import { appReducer, initialAppState } from "../reducer";

describe("restored history title identity", () => {
  it.each(["새 대화", "", "MyHarness"])("recovers a %s title and retains it after switching and refreshing", (placeholder) => {
    const history = [
      { value: "saved-a", label: "2 msg", description: placeholder, messageCount: 2 },
      { value: "saved-b", label: "2 msg", description: "B 제목", messageCount: 2 },
    ];
    let state = appReducer({ ...initialAppState, chatTitle: "다른 대화 제목", history }, {
      type: "backend_event", event: {
        type: "history_snapshot", value: "saved-a", message: placeholder,
        history_events: [{ type: "user", text: "A 질문" }],
      },
    });
    expect(state.chatTitle).toBe("A 질문");
    expect(state.history[0].description).toBe("A 질문");
    state = appReducer(state, { type: "begin_history_restore", sessionId: "saved-b" });
    state = appReducer(state, { type: "backend_event", event: {
      type: "history_snapshot", value: "saved-b", message: "B 제목", history_events: [],
    } });
    state = appReducer(state, { type: "set_history", history });
    expect(state.chatTitle).toBe("B 제목");
    expect(state.history.map((item) => item.description)).toEqual(["A 질문", "B 제목"]);
    state = appReducer(state, { type: "backend_event", event: {
      type: "select_request", modal: { command: "resume" }, select_options: history,
    } });
    expect(state.history.map((item) => item.description)).toEqual(["A 질문", "B 제목"]);
  });

  it("uses the selected saved title when a snapshot has no title", () => {
    const state = appReducer({ ...initialAppState, chatTitle: "이전 대화", history: [
      { value: "target", label: "2 msg", description: "저장된 제목" },
    ] }, { type: "backend_event", event: {
      type: "history_snapshot", value: "target", history_events: [{ type: "user", text: "원래 질문" }],
    } });
    expect(state.chatTitle).toBe("저장된 제목");
  });

  it("accepts real title changes even when the message count is unchanged", () => {
    const state = appReducer({ ...initialAppState, history: [
      { value: "target", label: "2 msg", description: "기존 제목", messageCount: 2 },
    ] }, { type: "set_history", history: [
      { value: "target", label: "2 msg", description: "변경 제목", messageCount: 2 },
    ] });
    expect(state.history[0].description).toBe("변경 제목");
  });
});
