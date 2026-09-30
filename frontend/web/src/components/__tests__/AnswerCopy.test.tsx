import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantActions } from "../AssistantActions";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { copyTextToClipboard } from "../../utils/clipboard";
import { conversationTextThrough } from "../../utils/conversationCopy";
import type { ChatMessage } from "../../types/ui";

vi.mock("../../utils/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
const answer: ChatMessage = { id: "a2", role: "assistant", text: "**두 번째 답변**\n본문", isComplete: true, responsePhase: "final" };
const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "첫 질문" },
  { id: "progress", role: "assistant", text: "조사 중입니다", responsePhase: "commentary", isComplete: true },
  { id: "log", role: "log", text: "도구 실행 결과" },
  { id: "hidden", role: "assistant", text: "내부 안내", suppressActions: true, isComplete: true },
  { id: "a1", role: "assistant", text: "첫 답변", isComplete: true },
  { id: "u2", role: "user", text: "둘째 질문" },
  { id: "pending", role: "user", text: "예약 질문", pendingRequestId: "queued" },
  { id: "partial", role: "assistant", text: "미완성", isComplete: false },
  answer,
  { id: "u3", role: "user", text: "나중 질문" },
  { id: "a3", role: "assistant", text: "나중 답변", isComplete: true },
];
function mount(items = messages) {
  return render(<AppStateProvider initialState={{ ...initialAppState, messages: items }}>
    <AssistantActions message={answer} /><button>바깥 버튼</button>
  </AppStateProvider>);
}
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(copyTextToClipboard).mockResolvedValue(undefined); });

describe("answer copy choices", () => {
  it("opens two choices without copying, then copies just the original answer", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "원문 복사" }));
    expect(screen.getByRole("button", { name: "이 답변까지 질의응답 복사" })).toBeTruthy();
    expect(copyTextToClipboard).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "이 답변만 복사" }));
    expect(copyTextToClipboard).toHaveBeenCalledWith(answer.text);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("copies only questions and final answers through the selected answer with speaker labels", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "원문 복사" }));
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 질의응답 복사" }));
    expect(copyTextToClipboard).toHaveBeenCalledWith("사용자 :\n첫 질문\n\nAI :\n첫 답변\n\n사용자 :\n둘째 질문\n\nAI :\n**두 번째 답변**\n본문");
  });
  it("closes with Escape or outside click and keeps keyboard access", async () => {
    mount();
    const trigger = screen.getByRole("button", { name: "원문 복사" });
    await userEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "이 답변만 복사" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "바깥 버튼" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });
  it("reports clipboard failure and blocks duplicate copies while pending", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(copyTextToClipboard).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "원문 복사" }));
    await userEvent.click(screen.getByRole("button", { name: "이 답변만 복사" }));
    expect(screen.getByText("복사 중...")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "원문 복사" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    reject(new Error("권한 없음"));
    await waitFor(() => expect(screen.getByText("복사 실패: 권한 없음")).toBeTruthy());
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
  });
  it("does not copy another conversation if the selected answer is missing", async () => {
    mount([]);
    await userEvent.click(screen.getByRole("button", { name: "원문 복사" }));
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 질의응답 복사" }));
    expect(copyTextToClipboard).not.toHaveBeenCalled();
    expect(screen.getByText(/복사할 답변을 현재 대화에서/)).toBeTruthy();
  });
  it("preserves image-only questions without internal attachment paths and omits terminal output", () => {
    expect(conversationTextThrough([
      { id: "image", role: "user", text: "internal path", displayText: "", images: [{ name: "사진.png", path: "/private/image.png", media_type: "image/png" }] },
      { id: "terminal", role: "assistant", text: "shell output", terminal: { command: "test" }, isComplete: true },
      answer,
    ], answer.id)).toBe("사용자 :\n[첨부 이미지: 사진.png]\n\nAI :\n**두 번째 답변**\n본문");
  });
});
