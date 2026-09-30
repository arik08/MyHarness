import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantActions } from "../AssistantActions";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { postJson } from "../../api/http";
import type { ChatMessage } from "../../types/ui";

vi.mock("../../api/http", () => ({ postJson: vi.fn(), getJson: vi.fn() }));
const answer: ChatMessage = { id: "answer", role: "assistant", text: "새로운 응답", isComplete: true };
function mount(message = answer) {
  return render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "live", activeHistoryId: "saved", workspacePath: "/workspace", messages: [answer] }}>
    <AssistantActions message={message} />
  </AppStateProvider>);
}
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(postJson).mockResolvedValue({ ok: true }); });
describe("response feedback", () => {
  it.each(["좋아요", "별로예요"])("opens an inline opinion field for %s and persists it", async (label) => {
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "응답 평가" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "평가 의견" }));
    await userEvent.type(screen.getByRole("textbox"), "구체적인 의견입니다.");
    await userEvent.click(screen.getByRole("button", { name: "평가 저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postJson).toHaveBeenCalledWith("/api/response-feedback", expect.objectContaining({ sessionId: "saved", workspacePath: "/workspace", answerText: answer.text, answerIndex: 0, rating: label === "좋아요" ? "up" : "down", comment: "구체적인 의견입니다." }));
    expect(within(view.container.querySelector(".response-feedback") as HTMLElement).getByRole("status").textContent).toBe("평가를 저장했습니다.");
  });
  it("shows pending immediately, blocks repeat submissions, and retains a failed draft for retry", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(postJson).mockReturnValueOnce(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "응답 평가" }));
    await userEvent.click(screen.getByRole("button", { name: "별로예요" }));
    await userEvent.type(screen.getByRole("textbox"), "보완 필요");
    await userEvent.dblClick(screen.getByRole("button", { name: "평가 저장" }));
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "저장 중…" }).hasAttribute("disabled")).toBe(true);
    reject(new Error("연결 실패"));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("보완 필요");
    await userEvent.click(screen.getByRole("button", { name: "평가 저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("supports Escape, outside dismissal and optional comments", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "응답 평가" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "응답 평가" }));
    await userEvent.click(screen.getByRole("button", { name: "응답 평가" }));
    await userEvent.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "응답 평가" }));
    await userEvent.click(screen.getByRole("button", { name: "좋아요" }));
    await userEvent.click(screen.getByRole("button", { name: "평가 저장" }));
    expect(postJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ comment: "" }));
  });
  it("does not offer feedback for streaming or suppressed responses", () => {
    const view = mount({ ...answer, isComplete: false });
    expect(screen.queryByRole("button", { name: "응답 평가" })).toBeNull();
    view.unmount();
    mount({ ...answer, suppressActions: true });
    expect(screen.queryByRole("button", { name: "응답 평가" })).toBeNull();
  });
});
