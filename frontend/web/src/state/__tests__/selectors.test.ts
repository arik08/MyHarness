import { describe, expect, it } from "vitest";
import { isConversationResponseVisiblyBusy } from "../selectors";

describe("isConversationResponseVisiblyBusy", () => {
  it("stops showing response progress as soon as the final answer is complete", () => {
    expect(isConversationResponseVisiblyBusy(true, [
      { id: "user", role: "user", text: "보고서를 작성해줘" },
      { id: "assistant", role: "assistant", text: "보고서를 완성했습니다.", isComplete: true },
    ])).toBe(false);
  });

  it("keeps showing progress for an incomplete or tool-handoff answer", () => {
    expect(isConversationResponseVisiblyBusy(true, [
      { id: "assistant", role: "assistant", text: "작성 중", isComplete: false },
    ])).toBe(true);
    expect(isConversationResponseVisiblyBusy(true, [
      { id: "assistant", role: "assistant", text: "도구 실행 준비", isComplete: true, suppressActions: true },
    ])).toBe(true);
  });

  it("shows progress again when a follow-up user message is queued", () => {
    expect(isConversationResponseVisiblyBusy(true, [
      { id: "assistant", role: "assistant", text: "첫 답변", isComplete: true },
      { id: "follow-up", role: "user", text: "이어서 설명해줘", kind: "steering" },
    ])).toBe(true);
  });
});
