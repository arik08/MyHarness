import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineQuestion } from "../InlineQuestion";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));

function NextRequest() {
  const { dispatch } = useAppState();
  return <button onClick={() => dispatch({ type: "backend_event", event: {
    type: "modal_request", modal: { kind: "question", request_id: "next", question: "새 질문입니다" },
  } })}>다음 요청</button>;
}

function show(kind: "question" | "permission") {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "live", modal: {
    kind: "backend", payload: { kind, request_id: "old", question: "대상 기업명을 입력해 주세요", reason: "파일 쓰기" },
  } }}><NextRequest /><InlineQuestion /></AppStateProvider>);
}

describe("InlineQuestion response lifecycle", () => {
  it.each([false, true])("preserves the next request when an older response settles (failure=%s)", async (failure) => {
    let resolve!: (value: { ok: boolean }) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(sendBackendRequest).mockReset().mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    show("permission");
    const allow = screen.getByRole("button", { name: /허용/ });
    act(() => { fireEvent.click(allow); fireEvent.click(allow); });
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "다음 요청" }));
    await userEvent.type(screen.getByRole("textbox"), "새 답변");
    await act(async () => { if (failure) reject(new Error("old failure")); else resolve({ ok: true }); });
    expect(screen.getByText("새 질문입니다")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("새 답변");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["question", "permission"] as const)("keeps a failed %s response available for retry", async (kind) => {
    vi.mocked(sendBackendRequest).mockReset().mockRejectedValueOnce(new Error("전송 실패")).mockResolvedValueOnce({ ok: true });
    show(kind);
    if (kind === "question") {
      await userEvent.type(screen.getByRole("textbox"), "입력한 답변");
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    } else await userEvent.click(screen.getByRole("button", { name: /허용/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "전송 실패");
    if (kind === "question") {
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("입력한 답변");
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    } else await userEvent.click(screen.getByRole("button", { name: /허용/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(sendBackendRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendBackendRequest).mock.calls[0]).toEqual(vi.mocked(sendBackendRequest).mock.calls[1]);
  });
});
