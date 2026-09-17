import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../Sidebar";
import { AssistantActions } from "../AssistantActions";
import { branchHistory } from "../../api/branch";
import { useBackendSession } from "../../hooks/useBackendSession";
import { openBackendEvents } from "../../api/events";
import { clampSidebarWidth } from "../../layout/sidebarLayout";
import { Composer } from "../Composer";
import { ModalHost } from "../ModalHost";
import { StatusPill } from "../StatusPill";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { deleteHistory, hideHistory, listHistory, loadHistorySnapshot, moveHistory, restoreHistory, toggleHistoryLike, toggleHistoryPin, updateHistoryTitle } from "../../api/history";
import { listLiveSessions, restartSession, shutdownSession, startSession } from "../../api/session";
import { sendBackendRequest, sendMessage } from "../../api/messages";
import type { Workspace } from "../../types/backend";
import { historyVisibilityKey } from "../../utils/history";

vi.mock("../../api/session", () => ({
  capacityQueueStatusEvent: "myharness:capacity-queue-status",
  restartSession: vi.fn(),
  shutdownSession: vi.fn(),
  startSession: vi.fn(),
  listLiveSessions: vi.fn(),
}));

vi.mock("../../api/events", () => ({ openBackendEvents: vi.fn() }));
vi.mock("../../api/branch", () => ({ branchHistory: vi.fn() }));

function LiveChatProbe() {
  useBackendSession();
  return <ChatStateProbe />;
}

vi.mock("../../api/history", () => ({
  deleteHistory: vi.fn(),
  historyPageSize: 25,
  hideHistory: vi.fn(),
  listHistory: vi.fn(),
  loadHistorySnapshot: vi.fn(),
  moveHistory: vi.fn(),
  restoreHistory: vi.fn(),
  toggleHistoryLike: vi.fn(),
  toggleHistoryPin: vi.fn(),
  updateHistoryTitle: vi.fn(),
}));

vi.mock("../../api/messages", () => ({
  sendBackendRequest: vi.fn(),
  sendMessage: vi.fn(),
}));

function WorkspaceProbe() {
  const { state } = useAppState();
  return <output data-testid="workspace">{state.workspaceName}</output>;
}

function ChatStateProbe() {
  const { state } = useAppState();
  return (
    <>
      <output data-testid="session">{state.sessionId || ""}</output>
      <output data-testid="message-count">{state.messages.length}</output>
      <output data-testid="message-texts">{state.messages.map((message) => message.text).join("|")}</output>
      <output data-testid="active-history">{state.activeHistoryId || ""}</output>
      <output data-testid="pending-history">{state.pendingHistoryId || ""}</output>
      <output data-testid="pending-fresh-chat">{state.pendingFreshChat ? "yes" : "no"}</output>
    </>
  );
}

function DispatchProbe({ onReady }: { onReady: (dispatch: ReturnType<typeof useAppState>["dispatch"]) => void }) {
  const { dispatch } = useAppState();
  useEffect(() => {
    onReady(dispatch);
  }, [dispatch, onReady]);
  return null;
}

describe("Sidebar", () => {
  it("shows and reveals a saved branch ahead of existing history without sending a message", async () => {
    const workspace = { name: "Default", path: "C:/demo" };
    const message = { id: "answer", role: "assistant" as const, text: "Copied answer", isComplete: true };
    vi.mocked(branchHistory).mockResolvedValue({ sessionId: "copied", title: "Original · 분기", workspace });
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot", value: "copied", message: "Original · 분기", preview_only: true,
      history_events: [{ type: "user", text: "Question" }, { type: "assistant", text: message.text }],
    });
    const scrollIntoView = vi.fn();
    const previous = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "runtime", activeHistoryId: "source", workspacePath: workspace.path, workspaceName: workspace.name, messages: [message],
        history: Array.from({ length: 40 }, (_, index) => ({ value: `saved-${index}`, label: `Existing ${index}` })),
      }}><Sidebar /><AssistantActions message={message} /></AppStateProvider>);
      await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
      await waitFor(() => expect(document.querySelector(".history-item.active .history-title")?.textContent).toBe("Original · 분기"));
      expect(document.querySelector(".history-item .history-title")?.textContent).toBe("Original · 분기");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(sendBackendRequest).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = previous;
    }
  });

  it("retains restored titles after repeated clicks and stale nonempty list refreshes", async () => {
    const history = ["a", "b"].map((id) => ({
      value: `saved-${id}`, label: "2 msg", description: "새 대화", messageCount: 2,
    }));
    vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({
      type: "history_snapshot", value: sessionId, message: "새 대화", preview_only: true,
      history_events: [{ type: "user", text: `${sessionId} 질문` }],
    }));
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "web-current", history }}>
      <Sidebar /><ChatStateProbe /><DispatchProbe onReady={(value) => { dispatch = value; }} />
    </AppStateProvider>);
    for (const id of ["a", "b", "a", "b"]) {
      const rows = document.querySelectorAll<HTMLButtonElement>(".history-open");
      await userEvent.click(rows[id === "a" ? 0 : 1]);
      await waitFor(() => expect(screen.getByTestId("active-history").textContent).toBe(`saved-${id}`));
      await waitFor(() => expect(screen.getByTestId("pending-history").textContent).toBe(""));
      act(() => dispatch({ type: "set_history", history }));
      expect(document.querySelectorAll(".history-title")[id === "a" ? 0 : 1].textContent).toBe(`saved-${id} 질문`);
      if (id === "b") {
        expect(Array.from(document.querySelectorAll(".history-title"), (node) => node.textContent))
          .toEqual(["saved-a 질문", "saved-b 질문"]);
      }
    }
  });

  it("renders one active row after repeated refreshes and a title change for a pending cached chat", () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    render(
      <AppStateProvider initialState={{
        ...initialAppState, sessionId: "web-a", activeHistoryId: "saved-a", busy: true,
        chatTitle: "MCP 수정", workspaceName: "Default", workspacePath: "C:/demo",
        liveSessionViewsBySessionId: { "web-a": {} as any },
        history: [{
          value: "saved-a", label: "진행 중인 채팅", description: "MCP 수정",
          pending: true, live: true, liveSessionId: "web-a", busy: true,
        }],
      }}>
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );
    for (let refresh = 0; refresh < 5; refresh += 1) {
      act(() => dispatch({ type: "set_history", history: [] }));
      expect(document.querySelectorAll(".history-item")).toHaveLength(1);
      expect(document.querySelectorAll(".history-item.active")).toHaveLength(1);
    }
    act(() => {
      dispatch({ type: "backend_event", event: { type: "session_title", message: "한국 2024년 무역 데이터 조회" } });
      dispatch({ type: "set_busy", value: false });
    });
    expect(document.querySelectorAll(".history-item")).toHaveLength(1);
    expect(document.querySelector(".history-title")?.textContent).toBe("한국 2024년 무역 데이터 조회");
    expect(document.querySelectorAll(".history-item.busy")).toHaveLength(0);
  });

  it("keeps the first prompt visible through delayed empty-chat events and history refreshes", () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    render(
      <AppStateProvider initialState={{
        ...initialAppState, sessionId: "web-current", activeHistoryId: "saved-current",
        chatTitle: "새 대화", workspaceName: "Default", workspacePath: "C:/demo",
        history: [{ value: "saved-current", label: "0 msg", description: "새 대화", messageCount: 0 }],
      }}>
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );
    const expectPromptRow = () => {
      const rows = document.querySelectorAll(".history-item");
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain("최신 최적화 알고리즘을 조사해줘");
      expect(rows[0].textContent).not.toContain("새 대화");
    };
    act(() => {
      dispatch({ type: "set_busy", value: true });
      dispatch({ type: "append_message", message: { role: "user", text: "최신 최적화 알고리즘을 조사해줘" } });
    });
    expectPromptRow();
    act(() => dispatch({ type: "backend_event", event: { type: "session_title", message: "새 대화" } }));
    expectPromptRow();
    act(() => dispatch({ type: "set_history", history: [
      { value: "saved-current", label: "0 msg", description: "새 대화", messageCount: 0 },
    ] }));
    expectPromptRow();
    act(() => dispatch({ type: "backend_event", event: { type: "line_complete" } }));
    expectPromptRow();
    act(() => dispatch({ type: "backend_event", event: { type: "session_title", message: "최적화 알고리즘 조사" } }));
    expect(document.querySelector(".history-item")?.textContent).toContain("최적화 알고리즘 조사");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "session-restored" });
    vi.mocked(shutdownSession).mockResolvedValue({ ok: true });
    vi.mocked(hideHistory).mockResolvedValue({ hidden: true });
    vi.mocked(restoreHistory).mockResolvedValue({ restored: true });
    vi.mocked(listHistory).mockResolvedValue({ options: [], hasMore: false, nextOffset: 0 });
    vi.mocked(loadHistorySnapshot).mockReturnValue(new Promise(() => {}));
    vi.mocked(moveHistory).mockResolvedValue({
      ok: true,
      sessionId: "session-old",
      sourceWorkspace: { name: "Default", path: "C:/demo" },
      workspace: { name: "Other", path: "C:/other" },
    });
    vi.mocked(toggleHistoryLike).mockResolvedValue({ ok: true, liked: true, sessionId: "session-old" });
    vi.mocked(toggleHistoryPin).mockResolvedValue({ ok: true, pinned: true, sessionId: "session-old" });
    vi.mocked(updateHistoryTitle).mockResolvedValue({ ok: true, title: "바꾼 이름" });
    vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  });

  it("opens the Lumina-style session management menu from the right-side action", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const moreButton = screen.getByRole("button", { name: "이전 대화 작업 더보기" });

    expect(moreButton.getAttribute("data-tooltip")).toBe("작업 더보기");
    expect(screen.queryByRole("menu", { name: "이전 대화 세션 작업" })).toBeNull();

    await userEvent.click(moreButton);

    expect(screen.getByRole("menu", { name: "이전 대화 세션 작업" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "상단 고정" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "좋아요" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "세션명 변경" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "워크스페이스 변경" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "목록에서 숨기기" })).toBeTruthy();
  });

  it("renames a session from the management menu", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "세션명 변경" }));
    const input = screen.getByRole("textbox", { name: "대화 제목" });
    await userEvent.clear(input);
    await userEvent.type(input, "바꾼 이름{Enter}");

    await waitFor(() => expect(updateHistoryTitle).toHaveBeenCalledWith("session-old", "바꾼 이름", "C:/demo", "Default"));
    expect(screen.getByText("바꾼 이름")).toBeTruthy();
  });

  it("does not start renaming when a history row is double-clicked", async () => {
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot",
      value: "session-old",
      history_events: [
        { type: "user", text: "인사말씀" },
        { type: "assistant", text: "안녕하세요." },
      ],
    });
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          chatTitle: "새 대화",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "인사말씀" }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.dblClick(screen.getByRole("button", { name: "인사말씀" }));

    await waitFor(() => expect(screen.getByTestId("active-history").textContent).toBe("session-old"));
    expect(container.querySelector(".history-item.active .history-title")?.textContent).toBe("인사말씀");
    expect(screen.queryByRole("textbox", { name: "대화 제목" })).toBeNull();
    expect(updateHistoryTitle).not.toHaveBeenCalled();
  });

  it("moves a saved session to another workspace from the management menu", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          workspaces: [
            { name: "Default", path: "C:/demo" },
            { name: "Other", path: "C:/other" },
          ],
          history: [{
            value: "session-old",
            label: "5/3 10:00 2 msg",
            description: "이전 대화",
            workspace: { name: "Default", path: "C:/demo" },
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "워크스페이스 변경" }));
    await userEvent.click(within(screen.getByRole("menu", { name: "이동할 워크스페이스" })).getByRole("menuitem", { name: "Other" }));

    await waitFor(() => expect(moveHistory).toHaveBeenCalledWith(
      "session-old",
      "C:/demo",
      "Default",
      "C:/other",
      "Other",
    ));
    expect(screen.queryByText("이전 대화")).toBeNull();
  });

  it("selects all manageable sessions and moves them together", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          workspaces: [
            { name: "Default", path: "C:/demo" },
            { name: "Other", path: "C:/other" },
          ],
          history: [
            { value: "session-a", label: "5/3 10:00 2 msg", description: "첫 대화", workspace: { name: "Default", path: "C:/demo" } },
            { value: "session-b", label: "5/2 10:00 2 msg", description: "둘째 대화", workspace: { name: "Default", path: "C:/demo" } },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const manageButton = screen.getByRole("button", { name: "채팅 세션 관리" });
    expect(manageButton.querySelector("path[d='M13 5h8']")).not.toBeNull();
    expect(manageButton.querySelector("path[d='m2.5 12 3 3 5-6']")).toBeNull();
    await userEvent.click(manageButton);
    const selectAllButton = screen.getByRole("button", { name: "모든 세션 선택" });
    expect(selectAllButton.querySelector("path[d='M13 19h8']")).not.toBeNull();
    await userEvent.click(selectAllButton);
    expect(screen.getByText("2개 선택")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 워크스페이스 변경" }));
    await userEvent.click(within(screen.getByRole("menu", { name: "이동할 워크스페이스" })).getByRole("menuitem", { name: "Other" }));

    await waitFor(() => expect(moveHistory).toHaveBeenCalledTimes(2));
    expect(vi.mocked(moveHistory).mock.calls.map((call) => call[0])).toEqual(["session-a", "session-b"]);
    expect(screen.queryByText("첫 대화")).toBeNull();
    expect(screen.queryByText("둘째 대화")).toBeNull();
  });

  it.each([false, true])("bulk deletes the active pending conversation with other records (admin=%s)", async (adminMode) => {
    render(<AppStateProvider initialState={{
      ...initialAppState, adminMode, sessionId: "web-current", activeHistoryId: "saved-current",
      clientId: "client-1", workspaceName: "Default", workspacePath: "C:/demo",
      workspaces: [{ name: "Default", path: "C:/demo" }, { name: "Other", path: "C:/other" }],
      history: [
        { value: "saved-current", label: "현재 대화", pending: true },
        { value: "saved-other", label: "다른 대화" },
      ],
    }}><Sidebar /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "채팅 세션 관리" }));
    await userEvent.click(screen.getByRole("button", { name: "모든 세션 선택" }));
    expect(screen.getByText("2개 선택")).toBeTruthy();
    expect((screen.getByRole("button", { name: "선택한 세션 워크스페이스 변경" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제" }));
    expect(hideHistory).not.toHaveBeenCalled();
    expect(deleteHistory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제 확인, 한 번 더 누르면 삭제" }));
    if (adminMode) {
      await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("saved-other", "C:/demo", "Default"));
      expect(sendBackendRequest).toHaveBeenCalledWith("web-current", "client-1", { type: "delete_session", value: "saved-current" });
    } else {
      await waitFor(() => expect(hideHistory).toHaveBeenCalledTimes(2));
      expect(vi.mocked(hideHistory).mock.calls.map((call) => call[0])).toEqual(["saved-current", "saved-other"]);
    }
    expect(document.querySelectorAll(".history-bulk-row")).toHaveLength(0);
  });

  it("bulk removes idle live records and retains failed selections for retry", async () => {
    vi.mocked(hideHistory).mockRejectedValueOnce(new Error("temporary failure"));
    render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-current", clientId: "client-1",
      workspaceName: "Default", workspacePath: "C:/demo",
      history: [
        { value: "saved-live", label: "열린 대화", live: true, liveSessionId: "web-other" },
        { value: "saved-retry", label: "재시도 대화" },
        { value: "saved-ok", label: "일반 대화" },
      ],
    }}><Sidebar /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "채팅 세션 관리" }));
    await userEvent.click(screen.getByRole("button", { name: "모든 세션 선택" }));
    expect(screen.getByText("3개 선택")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제" }));
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제 확인, 한 번 더 누르면 삭제" }));
    await waitFor(() => expect(screen.getByText("1개 선택")).toBeTruthy());
    expect(shutdownSession).toHaveBeenCalledWith("web-other", "client-1");
    expect(hideHistory).toHaveBeenCalledWith("saved-ok", "C:/demo", "Default");
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제" }));
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제 확인, 한 번 더 누르면 삭제" }));
    await waitFor(() => expect(document.querySelectorAll(".history-bulk-row")).toHaveLength(0));
    expect(vi.mocked(hideHistory).mock.calls.map((call) => call[0])).toEqual(["saved-retry", "saved-ok", "saved-retry"]);
  });

  it("requires a second confirmation before hiding multiple selected sessions", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [
            { value: "session-a", label: "5/3 10:00 2 msg", description: "첫 대화" },
            { value: "session-b", label: "5/2 10:00 2 msg", description: "둘째 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "채팅 세션 관리" }));
    await userEvent.click(screen.getByRole("button", { name: "모든 세션 선택" }));
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제" }));
    expect(hideHistory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "선택한 세션 삭제 확인, 한 번 더 누르면 삭제" }));

    await waitFor(() => expect(hideHistory).toHaveBeenCalledTimes(2));
    expect(vi.mocked(hideHistory).mock.calls.map((call) => call[0])).toEqual(["session-a", "session-b"]);
    expect(screen.queryByText("첫 대화")).toBeNull();
    expect(screen.queryByText("둘째 대화")).toBeNull();
  });

  it("selects and deselects consecutive history rows by pointer drag", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            { value: "session-a", label: "5/3 10:00 2 msg", description: "첫 대화" },
            { value: "session-b", label: "5/2 10:00 2 msg", description: "둘째 대화" },
            { value: "session-c", label: "5/1 10:00 2 msg", description: "셋째 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "채팅 세션 관리" }));
    const first = screen.getByRole("button", { name: "첫 대화 선택" });
    const second = screen.getByRole("button", { name: "둘째 대화 선택" });
    const third = screen.getByRole("button", { name: "셋째 대화 선택" });
    const fireMousePointer = (
      target: Element,
      type: "pointerdown" | "pointerover" | "pointerup",
      pointerId: number,
      buttons: number,
      relatedTarget: EventTarget | null = null,
    ) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, relatedTarget });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "mouse" },
      });
      fireEvent(target, event);
    };

    fireMousePointer(first, "pointerdown", 1, 1);
    fireMousePointer(second, "pointerover", 1, 1, first);
    fireMousePointer(third, "pointerover", 1, 1, second);
    fireMousePointer(third, "pointerup", 1, 0);

    expect(screen.getByText("3개 선택")).toBeTruthy();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(third.getAttribute("aria-pressed")).toBe("true");

    fireMousePointer(second, "pointerdown", 2, 1);
    fireMousePointer(third, "pointerover", 2, 1, second);
    fireMousePointer(third, "pointerup", 2, 0);

    expect(screen.getByText("1개 선택")).toBeTruthy();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(third.getAttribute("aria-pressed")).toBe("false");
  });

  it("asks the shared tooltip layer to show sidebar row tooltips on the right", () => {
    render(
      <AppStateProvider initialState={initialAppState}>
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByRole("button", { name: "프로젝트 선택" }).getAttribute("data-tooltip-placement")).toBe("right");
    expect(screen.getByRole("button", { name: "새 대화" }).getAttribute("data-tooltip")).toBe("새 대화");
    expect(screen.getByRole("button", { name: "새 대화" }).getAttribute("data-tooltip-placement")).toBe("right");
    expect(screen.getByRole("button", { name: "사용 가능한 모델 관리" }).getAttribute("data-tooltip-placement")).toBe("right");
  });

  it("links the header marketplace control to the skill catalog", () => {
    render(
      <AppStateProvider initialState={initialAppState}>
        <Sidebar />
      </AppStateProvider>,
    );

    const marketplaceLink = screen.getByRole("link", { name: "스킬 내용 조회" });
    const iconPaths = Array.from(marketplaceLink.querySelectorAll("path")).map((path) => path.getAttribute("d"));

    expect(marketplaceLink.getAttribute("href")).toBe("http://172.30.86.138:3334");
    expect(marketplaceLink.getAttribute("target")).toBe("_blank");
    expect(marketplaceLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(marketplaceLink.getAttribute("data-tooltip")).toBe("스킬 내용 조회");
    expect(iconPaths).toContain("M3 9l1.5-5h15L21 9");
  });

  it("opens command help from the sidebar without contacting the chat session", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          commands: [{ name: "help", description: "도움말" }],
          skills: [{ name: "frontend-design", description: "UI 작업", source: "skill", enabled: true }],
        }}
      >
        <Sidebar />
        <ModalHost />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "명령어" }));

    expect(screen.getByRole("dialog", { name: "명령어" })).toBeTruthy();
    expect(screen.getByText("스킬")).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("shows Light before Claude in the theme cycle", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, themeId: "light" }}>
        <Sidebar />
      </AppStateProvider>,
    );

    const themeButton = screen.getByRole("button", { name: "테마 전환: Light" });

    expect(themeButton.getAttribute("data-tooltip")).toBe("테마: Light");

    await userEvent.click(themeButton);

    expect(screen.getByRole("button", { name: "테마 전환: Claude" })).toBeTruthy();
  });

  it("resizes the expanded sidebar without going below the current default width", () => {
    function SidebarResizeState() {
      const { state } = useAppState();
      return <output aria-label="sidebar resize state">{`${state.sidebarResizing}:${state.sidebarWidth}`}</output>;
    }

    render(
      <AppStateProvider initialState={{ ...initialAppState, sidebarWidth: 268 }}>
        <Sidebar />
        <SidebarResizeState />
      </AppStateProvider>,
    );

    const handle = screen.getByRole("button", { name: "사이드바 너비 조절" });
    act(() => {
      const down = new MouseEvent("pointerdown", { bubbles: true, clientX: 268 });
      Object.defineProperty(down, "buttons", { value: 1 });
      Object.defineProperty(down, "pointerId", { value: 1 });
      fireEvent(handle, down);
    });
    expect(screen.getByLabelText("sidebar resize state").textContent).toBe("true:268");

    act(() => {
      const move = new MouseEvent("pointermove", { bubbles: true, clientX: 358 });
      Object.defineProperty(move, "buttons", { value: 1 });
      window.dispatchEvent(move);
    });
    expect(screen.getByLabelText("sidebar resize state").textContent).toBe("true:358");

    act(() => {
      const move = new MouseEvent("pointermove", { bubbles: true, clientX: 120 });
      Object.defineProperty(move, "buttons", { value: 1 });
      window.dispatchEvent(move);
    });
    expect(screen.getByLabelText("sidebar resize state").textContent).toBe("true:268");

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(screen.getByLabelText("sidebar resize state").textContent).toBe("false:268");
  });

  it("keeps the current sidebar width as the minimum resize width", () => {
    expect(clampSidebarWidth(120, 1440)).toBe(268);
    expect(clampSidebarWidth(420, 1440)).toBe(420);
  });

  it.each([false, true])("only opens model availability management in admin mode=%s", async (adminMode) => {
    render(<AppStateProvider initialState={{ ...initialAppState, adminMode }}><Sidebar /></AppStateProvider>);
    const trigger = screen.getByRole("button", { name: "사용 가능한 모델 관리" });
    expect((trigger as HTMLButtonElement).disabled).toBe(!adminMode);
    await userEvent.click(trigger);
    expect(Boolean(screen.queryByRole("dialog", { name: "사용 가능한 모델 관리" }))).toBe(adminMode);
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("hides model management when the sidebar is collapsed", () => {
    render(<AppStateProvider initialState={{ ...initialAppState, adminMode: true, sidebarCollapsed: true,
      runtimePicker: { ...initialAppState.runtimePicker, open: true },
    }}><Sidebar /></AppStateProvider>);
    expect(screen.queryByRole("dialog", { name: "사용 가능한 모델 관리" })).toBeNull();
  });

  it.each([true, false])("keeps the streaming chat spinner after new chat (saved row: %s)", async (savedRow) => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    const { container } = render(
      <AppStateProvider initialState={{
        ...initialAppState,
        sessionId: "web-streaming",
        activeHistoryId: "saved-streaming",
        clientId: "client-1",
        busy: true,
        messages: [
          { id: "question", role: "user", text: "진행 중인 질문" },
          { id: "answer", role: "assistant", text: "작성 중", isComplete: false },
        ],
        history: savedRow ? [{ value: "saved-streaming", label: "진행 중인 질문" }] : [],
      }}>
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    await waitFor(() => expect(startSession).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".history-item.busy:not(.active) .history-busy-spinner")).not.toBeNull());
    act(() => dispatch({ type: "set_history", history: [{
      value: "saved-streaming", label: "진행 중인 질문", live: true, liveSessionId: "web-streaming", busy: false,
    }] }));
    expect(container.querySelector(".history-busy-spinner")).toBeNull();
  });

  it("delays restore spinners and cancels them on completion or session changes", () => {
    vi.useFakeTimers();
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    const { container, unmount } = render(
      <AppStateProvider initialState={{
        ...initialAppState,
        sessionId: "current",
        history: [{ value: "first", label: "First" }, { value: "second", label: "Second" }],
      }}>
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );
    const spinner = () => container.querySelector(".history-busy-spinner");
    try {
      act(() => dispatch({ type: "begin_history_restore", sessionId: "first" }));
      act(() => vi.advanceTimersByTime(299));
      expect(spinner()).toBeNull();
      act(() => dispatch({ type: "finish_history_restore" }));
      act(() => vi.advanceTimersByTime(300));
      expect(spinner()).toBeNull();
      act(() => dispatch({ type: "begin_history_restore", sessionId: "first" }));
      act(() => vi.advanceTimersByTime(200));
      act(() => dispatch({ type: "begin_history_restore", sessionId: "second" }));
      act(() => vi.advanceTimersByTime(299));
      expect(spinner()).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(spinner()?.parentElement?.textContent).toContain("Second");
      act(() => dispatch({ type: "finish_history_restore" }));
      expect(spinner()).toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("shows the busy spinner in the left icon slot while the active answer is running", () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          busy: true,
          history: [{ value: "session-active", label: "5/3 10:00 2 msg", description: "진행 중인 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const item = container.querySelector(".history-item");
    const spinner = container.querySelector(".history-busy-spinner");
    const actionButton = screen.queryByRole("button", { name: "진행 중인 대화 작업 더보기" });

    expect(item?.classList.contains("busy")).toBe(true);
    expect(spinner).not.toBeNull();
    expect(item?.firstElementChild).toBe(spinner);
    expect(container.querySelector(".history-like")).toBeNull();
    expect(actionButton).toBeNull();
  });

  it("removes the active history spinner once the final answer is complete", () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          busy: true,
          messages: [
            { id: "user", role: "user", text: "보고서를 작성해줘" },
            { id: "assistant", role: "assistant", text: "보고서를 완성했습니다.", isComplete: true },
          ],
          history: [{ value: "session-active", label: "5/3 10:00 2 msg", description: "완료된 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(container.querySelector(".history-item")?.classList.contains("busy")).toBe(false);
    expect(screen.getByRole("button", { name: "완료된 대화 작업 더보기" })).toBeTruthy();
  });

  it("adds a busy live history row when the active saved session is not in the loaded history yet", () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-session-active",
          activeHistoryId: "saved-session-active",
          chatTitle: "첫 요청 처리",
          busy: true,
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const busyItem = container.querySelector(".history-item.busy");
    const actionButton = screen.queryByRole("button", { name: "첫 요청 처리 작업 더보기" });

    expect(busyItem?.textContent).toContain("첫 요청 처리");
    expect(actionButton).toBeNull();
  });

  it("uses the current conversation title for the active busy history row", () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-session-active",
          activeHistoryId: "saved-session-active",
          chatTitle: "YouTube 영상 설명",
          busy: true,
          history: [{
            value: "saved-session-active",
            label: "진행 중인 채팅",
            description: "새 대화",
            pending: true,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const busyItem = container.querySelector(".history-item.busy");

    expect(busyItem?.textContent).toContain("YouTube 영상 설명");
    expect(busyItem?.textContent).not.toContain("새 대화");
  });

  it("shows compact chat history titles that fit the sidebar", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            {
              value: "session-long",
              label: "5/4 10:00 24 msg chat history 대화 제목을 짧게 나오게 해줘. 가급적 좌측 사이드바 안에 맞는 수준의 폭으로",
              description: "",
            },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const visibleTitle = screen.getByText(/chat history/);

    expect(visibleTitle.textContent).toBe("chat history 대화 제목을 짧게 나오게…");
    expect(visibleTitle.textContent?.length).toBeLessThanOrEqual(27);
  });

  it("filters chat session titles from the search field below the history heading", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            { value: "session-posco", label: "5/4 10:00 2 msg", description: "POSCO 경쟁사 보고서" },
            { value: "session-minutes", label: "5/3 10:00 2 msg", description: "회의록 작성" },
            { value: "session-budget", label: "5/2 10:00 2 msg", description: "예산 검토" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const searchToggle = screen.getByRole("button", { name: "제목 검색" });
    expect(screen.queryByRole("searchbox", { name: "채팅 세션 제목 검색" })).toBeNull();

    await userEvent.click(searchToggle);
    const search = screen.getByRole("searchbox", { name: "채팅 세션 제목 검색" });
    const historyPanel = document.querySelector(".history-panel");
    const orderedHistoryElements = Array.from(historyPanel?.children || []).map((element) => element.className);

    expect(orderedHistoryElements.slice(0, 2)).toEqual(["history-heading", "history-search"]);

    await userEvent.type(search, "posco");
    expect(screen.getByText("POSCO 경쟁사 보고서")).toBeTruthy();
    expect(screen.queryByText("회의록 작성")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "채팅 세션 제목 검색 지우기" }));
    await userEvent.type(search, "회의록작성");
    expect(screen.getByText("회의록 작성")).toBeTruthy();
    expect(screen.queryByText("예산 검토")).toBeNull();

    await userEvent.click(searchToggle);
    expect(screen.queryByRole("searchbox", { name: "채팅 세션 제목 검색" })).toBeNull();
    expect(screen.getByText("예산 검토")).toBeTruthy();
  });

  it("keeps existing history rows visible while refreshing history", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          historyLoading: true,
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByText("이전 대화")).toBeTruthy();
    expect(screen.queryByText("대화 내역을 불러오는 중...")).toBeNull();
    expect(document.querySelector(".history-list")?.getAttribute("aria-busy")).toBe("true");
  });

  it("renders every loaded history row without a fixed display cap", () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      value: `session-${index + 1}`,
      label: `5/3 10:${String(index).padStart(2, "0")} 2 msg`,
      description: `대화 ${index + 1}`,
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history,
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(document.querySelectorAll(".history-item")).toHaveLength(25);
    expect(screen.getByText("대화 25")).toBeTruthy();
  });

  it("loads the next history page when the history list is scrolled to the bottom", async () => {
    const initialHistory = Array.from({ length: 25 }, (_, index) => ({
      value: `session-${index + 1}`,
      label: `5/3 10:${String(index).padStart(2, "0")} 2 msg`,
      description: `대화 ${index + 1}`,
    }));
    const nextHistory = Array.from({ length: 25 }, (_, index) => ({
      value: `session-${index + 26}`,
      label: `5/3 09:${String(index).padStart(2, "0")} 2 msg`,
      description: `대화 ${index + 26}`,
    }));
    vi.mocked(listHistory).mockResolvedValue({ options: nextHistory, hasMore: false, nextOffset: 50 });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: initialHistory,
          historyHasMore: true,
          historyNextOffset: 25,
        } as typeof initialAppState}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const historyList = document.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(historyList, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(historyList, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 600 });
    fireEvent.scroll(historyList);

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 25,
    }));
    await waitFor(() => expect(document.querySelectorAll(".history-item")).toHaveLength(50));
    expect(screen.getByText("대화 50")).toBeTruthy();
  });

  it("keeps loading while a refreshed history list is still too short to scroll", async () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    const initialHistory = Array.from({ length: 25 }, (_, index) => ({
      value: `session-${index + 1}`,
      label: `5/3 10:${String(index).padStart(2, "0")} 2 msg`,
      description: `대화 ${index + 1}`,
    }));
    vi.mocked(listHistory)
      .mockResolvedValueOnce({
        options: [{ value: "session-hidden", label: "숨긴 대화", description: "숨긴 대화", hidden: true }],
        hasMore: true,
        nextOffset: 50,
      })
      .mockResolvedValueOnce({
        options: [{ value: "session-visible", label: "5/3 09:00 2 msg", description: "더 오래된 대화" }],
        hasMore: false,
        nextOffset: 75,
      });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: initialHistory,
          historyLoading: true,
          historyHasMore: true,
          historyNextOffset: 25,
        } as typeof initialAppState}
      >
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );

    const historyList = document.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(historyList, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(historyList, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 0 });

    act(() => {
      dispatch({ type: "set_history_loading", value: false });
    });

    await waitFor(() => expect(listHistory).toHaveBeenNthCalledWith(1, {
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 25,
    }));
    await waitFor(() => expect(listHistory).toHaveBeenNthCalledWith(2, {
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 50,
    }));
    expect(screen.getByText("더 오래된 대화")).toBeTruthy();
  });

  it("searches saved history on the server without loading every history page", async () => {
    const initialHistory = Array.from({ length: 25 }, (_, index) => ({
      value: `session-${index + 1}`,
      label: `5/3 10:${String(index).padStart(2, "0")} 2 msg`,
      description: `보고서 ${index + 1}`,
    }));
    vi.mocked(listHistory)
      .mockResolvedValueOnce({
        options: [{ value: "session-old", label: "5/1 09:00 2 msg", description: "오래된 보고서" }],
        hasMore: true,
        nextOffset: 25,
      })
      .mockResolvedValueOnce({
        options: [{ value: "session-older", label: "4/1 09:00 2 msg", description: "더 오래된 보고서" }],
        hasMore: false,
        nextOffset: 26,
      });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: initialHistory,
          historyHasMore: true,
          historyNextOffset: 25,
        } as typeof initialAppState}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const historyList = document.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(historyList, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(historyList, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 0 });

    await userEvent.click(screen.getByRole("button", { name: "제목 검색" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "채팅 세션 제목 검색" }), "보고서");

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 0,
      search: "보고서",
    }));
    expect(await screen.findByText("오래된 보고서")).toBeTruthy();
    expect(listHistory).toHaveBeenCalledTimes(1);

    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 600 });
    fireEvent.scroll(historyList);

    await waitFor(() => expect(listHistory).toHaveBeenNthCalledWith(2, {
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 25,
      search: "보고서",
    }));
    expect(await screen.findByText("더 오래된 보고서")).toBeTruthy();
  });

  it("ignores a delayed page from the workspace that was just left", async () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    let resolveOldWorkspacePage!: (value: Awaited<ReturnType<typeof listHistory>>) => void;
    vi.mocked(listHistory).mockReturnValueOnce(new Promise((resolve) => {
      resolveOldWorkspacePage = resolve;
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Project A",
          workspacePath: "C:/project-a",
          history: [{ value: "session-a", label: "5/3 10:00 2 msg", description: "프로젝트 A 대화" }],
          historyHasMore: true,
          historyNextOffset: 25,
        } as typeof initialAppState}
      >
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );

    const historyList = document.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(historyList, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(historyList, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 600 });
    fireEvent.scroll(historyList);

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/project-a",
      workspaceName: "Project A",
      limit: 25,
      offset: 25,
    }));

    act(() => {
      dispatch({ type: "set_workspace", workspace: { name: "Project B", path: "C:/project-b" } });
      dispatch({
        type: "set_history",
        history: [{ value: "session-b", label: "5/3 09:00 2 msg", description: "프로젝트 B 대화" }],
        hasMore: false,
        nextOffset: 25,
      });
    });
    await act(async () => {
      resolveOldWorkspacePage({
        options: [{ value: "session-a-old", label: "5/2 10:00 2 msg", description: "늦게 온 A 대화" }],
        hasMore: false,
        nextOffset: 50,
      });
      await Promise.resolve();
    });

    expect(screen.getByText("프로젝트 B 대화")).toBeTruthy();
    expect(screen.queryByText("늦게 온 A 대화")).toBeNull();
  });

  it("renders pinned history items before recent items sorted by title", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            { value: "session-new", label: "5/4 10:00 2 msg", description: "최신 대화" },
            { value: "session-pin-b", label: "5/3 10:00 2 msg", description: "나중 고정 대화", pinned: true },
            { value: "session-pin-a", label: "5/2 10:00 2 msg", description: "가장 앞 고정 대화", pinned: true },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const titles = Array.from(document.querySelectorAll(".history-title")).map((node) => node.textContent);

    expect(titles).toEqual(["가장 앞 고정 대화", "나중 고정 대화", "최신 대화"]);
  });

  it("shows exactly one leading icon with pin taking priority over like", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            { value: "session-pinned-liked", label: "5/3 10:00 2 msg", description: "고정 좋아요 대화", pinned: true, liked: true },
            { value: "session-liked", label: "5/2 10:00 2 msg", description: "좋아요 대화", liked: true },
            { value: "session-plain", label: "5/1 10:00 2 msg", description: "일반 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const pinnedIcon = screen.getByRole("button", { name: "고정 좋아요 대화 상단 고정 해제" });
    const likedIcon = screen.getByRole("button", { name: "좋아요 대화 좋아요 취소" });
    const chatIcon = screen.getByRole("button", { name: "일반 대화 좋아요" });

    expect(pinnedIcon.querySelectorAll("svg")).toHaveLength(1);
    expect(pinnedIcon.querySelector(".history-pinned-pin")).not.toBeNull();
    expect(pinnedIcon.querySelector("path[d^='M10.1221 3.13715']")).not.toBeNull();
    expect(pinnedIcon.querySelector(".history-liked-star")).toBeNull();
    expect(likedIcon.querySelector(".history-liked-star")).not.toBeNull();
    expect(chatIcon.querySelector("path[d^='M2.992 16.342']")).not.toBeNull();
  });

  it("toggles a saved chat like from the left icon without opening the chat", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const likeButton = screen.getByRole("button", { name: "이전 대화 좋아요" });
    expect(likeButton.getAttribute("aria-pressed")).toBe("false");
    expect(likeButton.querySelector(".history-liked-star")).toBeNull();

    await userEvent.click(likeButton);

    await waitFor(() => expect(toggleHistoryLike).toHaveBeenCalledWith("session-old", true, "C:/demo", "Default"));
    const unlikeButton = screen.getByRole("button", { name: "이전 대화 좋아요 취소" });
    expect(unlikeButton.getAttribute("aria-pressed")).toBe("true");
    expect(unlikeButton.querySelector(".history-liked-star")).not.toBeNull();
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("filters the session list to liked chats from the heading star", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [
            { value: "session-liked", label: "5/3 10:00 2 msg", description: "좋아요 대화", liked: true },
            { value: "session-plain", label: "5/2 10:00 2 msg", description: "일반 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const filterButton = screen.getByRole("button", { name: "좋아요만 보기" });
    expect(filterButton.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(filterButton);

    expect(screen.getByText("좋아요 대화")).toBeTruthy();
    expect(screen.queryByText("일반 대화")).toBeNull();
    expect(screen.getByRole("button", { name: "전체 보기" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("loads all liked history once without paging ordinary history on scroll", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "old-liked", label: "오래된 별표 대화", liked: true }],
      hasMore: false,
      nextOffset: 1,
    });
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [
            { value: "session-liked", label: "5/3 10:00 2 msg", description: "좋아요 대화", liked: true },
            { value: "session-plain", label: "5/2 10:00 2 msg", description: "일반 대화" },
          ],
          historyHasMore: true,
          historyNextOffset: 25,
        } as typeof initialAppState}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const historyList = document.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(historyList, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(historyList, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(historyList, "scrollTop", { configurable: true, value: 0 });

    await userEvent.click(screen.getByRole("button", { name: "좋아요만 보기" }));

    await waitFor(() => expect(screen.queryByText("일반 대화")).toBeNull());
    expect(await screen.findByText("오래된 별표 대화")).toBeTruthy();
    expect(listHistory).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "C:/demo", workspaceName: "Default", likedOnly: true,
    });
    fireEvent.scroll(historyList);
    fireEvent.scroll(historyList);
    expect(listHistory).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "제목 검색" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "채팅 세션 제목 검색" }), "오래된");
    expect(screen.getByText("오래된 별표 대화")).toBeTruthy();
    expect(screen.queryByText("좋아요 대화")).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores a late liked response after returning to ordinary history", async () => {
    let resolveLiked!: (value: Awaited<ReturnType<typeof listHistory>>) => void;
    vi.mocked(listHistory).mockReturnValue(new Promise((resolve) => { resolveLiked = resolve; }));
    render(
      <AppStateProvider initialState={{
        ...initialAppState,
        history: [{ value: "plain", label: "일반 대화" }],
      }}>
        <Sidebar />
      </AppStateProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "좋아요만 보기" }));
    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));
    expect(screen.getByText("좋아요한 채팅을 불러오는 중...")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    await act(async () => resolveLiked({ options: [{ value: "late", label: "늦은 별표", liked: true }] }));
    expect(screen.getByText("일반 대화")).toBeTruthy();
    expect(screen.queryByText("늦은 별표")).toBeNull();
  });

  it("shows the liked-filter empty state when no chat is liked", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          history: [{ value: "session-plain", label: "5/2 10:00 2 msg", description: "일반 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "좋아요만 보기" }));

    expect(await screen.findByText("좋아요한 채팅이 없습니다.")).toBeTruthy();
  });

  it("pins a history item from the expanded right-side action", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    const pinMenuItem = screen.getByRole("menuitem", { name: "상단 고정" });
    expect(pinMenuItem.querySelector(".history-pin-icon path[d^='M10.1221 3.13715']")).not.toBeNull();
    expect(pinMenuItem.querySelector("path[d^='M9 10.76']")).toBeNull();
    await userEvent.click(pinMenuItem);

    await waitFor(() => expect(toggleHistoryPin).toHaveBeenCalledWith("session-old", true, "C:/demo", "Default"));
    expect(screen.getByRole("button", { name: "이전 대화 상단 고정 해제" }).querySelector(".history-pinned-pin")).not.toBeNull();
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("hides a saved history item immediately without moving the remaining rows", async () => {
    let resolveHideHistory: ((value: { hidden: boolean }) => void) | undefined;
    vi.mocked(hideHistory).mockImplementationOnce(() => new Promise<{ hidden: boolean }>((resolve) => {
      resolveHideHistory = resolve;
    }));
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/current",
          history: [
            { value: "session-newer", label: "5/4 10:00 2 msg", description: "위 대화" },
            {
              value: "session-old",
              label: "5/3 10:00 2 msg",
              description: "이전 대화",
              workspace: { name: "Other", path: "C:/other" },
            },
            { value: "session-older", label: "5/2 10:00 2 msg", description: "아래 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    expect(screen.queryByText("이전 대화")).toBeNull();
    expect(Array.from(document.querySelectorAll(".history-title")).map((node) => node.textContent)).toEqual(["위 대화", "아래 대화"]);
    expect(hideHistory).toHaveBeenCalledWith("session-old", "C:/other", "Other");
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(sendBackendRequest).not.toHaveBeenCalled();
    await act(async () => resolveHideHistory?.({ hidden: true }));
  });

  it("restores an optimistically hidden history item in its original position when hiding fails", async () => {
    let rejectHideHistory: ((reason?: unknown) => void) | undefined;
    vi.mocked(hideHistory).mockImplementationOnce(() => new Promise<{ hidden: boolean }>((_resolve, reject) => {
      rejectHideHistory = reject;
    }));
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [
            { value: "session-newer", label: "5/4 10:00 2 msg", description: "위 대화" },
            { value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" },
            { value: "session-older", label: "5/2 10:00 2 msg", description: "아래 대화" },
          ],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    expect(screen.queryByText("이전 대화")).toBeNull();
    await act(async () => rejectHideHistory?.(new Error("hide failed")));
    await waitFor(() => expect(screen.getByText("이전 대화")).toBeTruthy());
    expect(Array.from(document.querySelectorAll(".history-title")).map((node) => node.textContent)).toEqual(["위 대화", "이전 대화", "아래 대화"]);
  });

  it("marks server-hidden history items in admin mode", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          adminMode: true,
          workspaceName: "Default",
          workspacePath: "C:/current",
          history: [{
            value: "session-old",
            label: "5/3 10:00 2 msg",
            description: "이전 대화",
            workspace: { name: "Other", path: "C:/other" },
            hidden: true,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByText("이전 대화").closest(".history-item")?.classList.contains("hidden-history")).toBe(true);
  });

  it("permanently deletes a hidden saved history item in admin mode", async () => {
    const hiddenKey = historyVisibilityKey("session-old", "C:/other", "Other");
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          adminMode: true,
          hiddenHistoryKeys: [hiddenKey],
          sessionId: "session-active",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/current",
          history: [{
            value: "session-old",
            label: "5/3 10:00 2 msg",
            description: "이전 대화",
            workspace: { name: "Other", path: "C:/other" },
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByText("이전 대화").closest(".history-item")?.classList.contains("hidden-history")).toBe(true);
    expect(screen.queryByText("숨김")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("session-old", "C:/other", "Other"));
    expect(screen.queryByText("이전 대화")).toBeNull();
  });

  it("restores a hidden saved history item from the admin context menu", async () => {
    const hiddenKey = historyVisibilityKey("session-old", "C:/other", "Other");
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          adminMode: true,
          hiddenHistoryKeys: [hiddenKey],
          sessionId: "session-active",
          workspaceName: "Default",
          workspacePath: "C:/current",
          history: [{
            value: "session-old",
            label: "5/3 10:00 2 msg",
            description: "이전 대화",
            workspace: { name: "Other", path: "C:/other" },
            hidden: true,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const row = screen.getByText("이전 대화").closest(".history-item");
    expect(row?.classList.contains("hidden-history")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에 복원" }));

    await waitFor(() => expect(restoreHistory).toHaveBeenCalledWith("session-old", "C:/other", "Other"));
    expect(row?.classList.contains("hidden-history")).toBe(false);
    expect(screen.queryByRole("menuitem", { name: "목록에 복원" })).toBeNull();
  });

  it("does not redraw the active saved history row after deleting it", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "session-old",
          clientId: "client-1",
          chatTitle: "이전 대화",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{
            value: "session-old",
            label: "5/3 10:00 2 msg",
            description: "이전 대화",
            workspace: { name: "Default", path: "C:/demo" },
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(screen.queryByText("이전 대화")).toBeNull());
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(screen.queryByText("이전 대화")).toBeNull();
  });

  it("does not resurrect a deleted history item from a stale refresh", async () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    const deletedItem = {
      value: "session-deleted",
      label: "5/3 10:00 2 msg",
      description: "삭제된 대화",
      workspace: { name: "Default", path: "C:/demo" },
    };
    const keptItem = {
      value: "session-kept",
      label: "5/3 11:00 2 msg",
      description: "남은 대화",
      workspace: { name: "Default", path: "C:/demo" },
    };

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [deletedItem, keptItem],
        }}
      >
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "삭제된 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(screen.queryByText("삭제된 대화")).toBeNull());
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(screen.queryByText("삭제된 대화")).toBeNull();

    act(() => {
      dispatch({ type: "set_history", history: [deletedItem, keptItem] });
    });

    expect(screen.queryByText("삭제된 대화")).toBeNull();
    expect(screen.getByText("남은 대화")).toBeTruthy();
  });

  it("closes an idle live history row instead of deleting a missing snapshot file", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          history: [{
            value: "web-live-idle",
            label: "열려 있는 채팅",
            description: "열려 있는 세션",
            live: true,
            liveSessionId: "web-live-idle",
            busy: false,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "열려 있는 세션 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "세션 닫기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(shutdownSession).toHaveBeenCalledWith("web-live-idle", "client-1"));
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(screen.queryByText("열려 있는 세션")).toBeNull();
  });

  it("does not show the current backend session as another open session", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          history: [{
            value: "web-current",
            label: "열려 있는 채팅",
            description: "열려 있는 세션",
            live: true,
            liveSessionId: "web-current",
            busy: false,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.queryByRole("button", { name: /열려 있는 세션/ })).toBeNull();
    expect(screen.queryByText("열려 있는 세션")).toBeNull();
  });

  it("keeps the saved history row visible when its live backend session is current", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "saved-current",
          clientId: "client-1",
          history: [{
            value: "saved-current",
            label: "5/3 10:00 2 msg",
            description: "저장된 live 대화",
            live: true,
            liveSessionId: "web-current",
            busy: false,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByText("저장된 live 대화")).toBeTruthy();
    expect(document.querySelector(".history-item.active")).not.toBeNull();
  });

  it("does not re-open the already active history row", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "saved-current",
          clientId: "client-1",
          busy: false,
          history: [{
            value: "saved-current",
            label: "5/3 10:00 2 msg",
            description: "저장된 live 대화",
            live: true,
            liveSessionId: "web-current",
            busy: false,
          }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "저장된 live 대화" }));

    expect(listLiveSessions).not.toHaveBeenCalled();
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-history").textContent).toBe("saved-current");
    expect(screen.getByTestId("pending-history").textContent).toBe("");
    expect(document.querySelector(".history-item.busy")).toBeNull();
  });

  it("shows the current question as the active history row when the current live row is filtered", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          busy: true,
          messages: [{ id: "message-current", role: "user", text: "데이터센터 산업의 2025~2026년 현황을 오라클 보고서" }],
          history: [{
            value: "web-current",
            label: "진행 중인 채팅",
            description: "열려 있는 세션",
            live: true,
            liveSessionId: "web-current",
            busy: true,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.getByText(/^데이터센터 산업의 2025~2026년/)).toBeTruthy();
    expect(screen.queryByText("진행 중인 대화")).toBeNull();
    expect(document.querySelector(".history-item.active")).not.toBeNull();
  });

  it("opens a saved history item in a separate backend while the current answer is running", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: true,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
    })));
    expect(sendBackendRequest).toHaveBeenCalledWith("session-restored", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    });
  });

  it("replaces an expired backend before restoring another saved conversation", async () => {
    vi.mocked(sendBackendRequest)
      .mockRejectedValueOnce(new Error("Unknown session"))
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(startSession).mockResolvedValueOnce({ sessionId: "session-recovered" });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-expired",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
        <ModalHost />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
    })));
    expect(sendBackendRequest).toHaveBeenCalledTimes(2);
    expect(sendBackendRequest).toHaveBeenLastCalledWith("session-recovered", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    });
    expect(screen.queryByText("Unknown session")).toBeNull();
  });

  it("keeps the current chat visible while a saved history item is restoring", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          messages: [{ id: "message-current", role: "user", text: "현재 화면 질문" }],
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("session-active", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    }));
    expect(screen.getByTestId("message-count").textContent).toBe("1");
    expect(screen.getByTestId("message-texts").textContent).toBe("현재 화면 질문");
    expect(screen.getByTestId("active-history").textContent).toBe("");
    expect(screen.getByTestId("pending-history").textContent).toBe("session-old");
    expect(screen.queryByText("진행 중인 대화")).toBeNull();

    const restoringRow = Array.from(document.querySelectorAll(".history-item.busy"))
      .find((item) => item.textContent?.includes("이전 대화"));
    expect(restoringRow).toBeTruthy();
    expect(restoringRow?.textContent).toContain("이전 대화");
    expect(restoringRow?.classList.contains("active")).toBe(false);
    expect(document.querySelectorAll(".history-item.busy")).toHaveLength(1);
  });

  it.each(["new", "saved"])("reattaches streaming after visiting %s chat and replays without duplication", async (destination) => {
    const streams: Array<{ session: string; handlers: Parameters<typeof openBackendEvents>[1]; close: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(openBackendEvents).mockImplementation((params, handlers) => {
      const close = vi.fn();
      streams.push({ session: params.get("session") || "", handlers, close });
      return { close } as unknown as EventSource;
    });
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{
      sessionId: "web-a", savedSessionId: "saved-a", busy: true, createdAt: 1,
      workspace: { name: "Default", path: "C:/demo" },
    }] });
    vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({
      type: "history_snapshot", value: sessionId, preview_only: true,
      history_events: [{ type: "user", text: sessionId === "saved-a" ? "오래된 미리보기" : "다른 대화 내용" }],
    }));
    render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-a", activeHistoryId: "saved-a", clientId: "client-1", busy: true,
      workspaceName: "Default", workspacePath: "C:/demo",
      messages: [{ id: "q", role: "user", text: "원래 질문" }, { id: "a", role: "assistant", text: "처음", isComplete: false }],
      history: [{ value: "saved-a", label: "원래 대화" }, { value: "saved-b", label: "다른 대화" }],
    }}><Sidebar /><LiveChatProbe /></AppStateProvider>);
    const oldStream = streams[0];
    await userEvent.click(screen.getByRole("button", { name: destination === "new" ? "새 대화" : "다른 대화" }));
    if (destination === "saved") await waitFor(() => expect(screen.getByTestId("message-texts").textContent).toBe("다른 대화 내용"));
    await userEvent.click(screen.getByRole("button", { name: "원래 대화" }));
    await waitFor(() => expect(streams.length).toBeGreaterThan(destination === "new" ? 2 : 1));
    const returned = streams.at(-1)!;
    expect(returned.session).toBe("web-a");
    expect(oldStream.close).toHaveBeenCalled();
    act(() => {
      returned.handlers.onEvent({ type: "clear_transcript", live_replay: true });
      returned.handlers.onEvent({ type: "history_snapshot", live_replay: true, value: "saved-a", history_events: [{ type: "user", text: "원래 질문" }] });
      returned.handlers.onEvent({ type: "assistant_delta", message: "처음부터 누적된 답변" });
      oldStream.handlers.onEvent({ type: "assistant_delta", message: "폐기된 연결의 이벤트" });
      returned.handlers.onEvent({ type: "assistant_delta", message: " 그리고 이어지는 답변" });
    });
    await waitFor(() => expect(screen.getByTestId("message-texts").textContent).toBe("원래 질문|처음부터 누적된 답변 그리고 이어지는 답변"));
    expect(document.querySelector(".history-item.active.busy")).not.toBeNull();
    act(() => {
      returned.handlers.onEvent({ type: "assistant_complete", message: "처음부터 누적된 답변 그리고 이어지는 답변" });
      returned.handlers.onEvent({ type: "line_complete" });
    });
    expect(screen.getByTestId("message-texts").textContent).toBe("원래 질문|처음부터 누적된 답변 그리고 이어지는 답변");
    expect(document.querySelector(".history-item.active.busy")).toBeNull();
    expect(sendBackendRequest).toHaveBeenCalledTimes(destination === "new" ? 1 : 0);
  });

  it.each([2, 3])("preserves live-only row order when switching among %s streaming chats", async (count) => {
    const ids = ["a", "b", "c"].slice(0, count);
    const history = ids.map((id) => ({ value: `web-${id}`, label: `${id} 대화`, live: true, liveSessionId: `web-${id}`, busy: true }));
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: ids.map((id) => ({ sessionId: `web-${id}`, savedSessionId: "", busy: true, createdAt: 1 })) });
    vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({
      type: "history_snapshot", value: sessionId, message: `${sessionId.slice(-1)} 대화`, preview_only: true, history_events: [],
    }));
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-a", clientId: "client-1", busy: true, chatTitle: "a 대화",
      messages: [{ id: "qa", role: "user", text: "a 대화" }], history,
    }}><Sidebar /><ChatStateProbe /><DispatchProbe onReady={(value) => { dispatch = value; }} /></AppStateProvider>);
    const order = () => Array.from(document.querySelectorAll(".history-title")).map((item) => item.textContent);
    const initialOrder = order();
    expect(initialOrder).toEqual(ids.map((id) => `${id} 대화`));
    for (const id of ["b", "a", "b"]) {
      await userEvent.click(screen.getByRole("button", { name: `${id} 대화` }));
      await waitFor(() => expect(screen.getByTestId("session").textContent).toBe(`web-${id}`));
      expect(order()).toEqual(initialOrder);
    }
    act(() => dispatch({ type: "set_history", history: [...history].reverse() }));
    expect(order()).toEqual(initialOrder);
    act(() => {
      dispatch({ type: "set_busy", value: false });
      dispatch({ type: "set_history", history: [...history].reverse().map((item) => ({ ...item, live: item.value === "web-a", busy: item.value === "web-a" })) });
    });
    expect(order()).toEqual([...initialOrder].reverse());
  });

  it("keeps concurrent responses and their list order across repeated A-B switches", async () => {
    const streams: Array<{ session: string; handlers: Parameters<typeof openBackendEvents>[1] }> = [];
    vi.mocked(openBackendEvents).mockImplementation((params, handlers) => {
      streams.push({ session: params.get("session") || "", handlers });
      return { close: vi.fn() } as unknown as EventSource;
    });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "web-b" });
    vi.mocked(sendMessage).mockResolvedValue({ ok: true });
    let savedB = "";
    vi.mocked(listLiveSessions).mockImplementation(async () => ({ sessions: ["a", "b"].map((id) => ({
      sessionId: `web-${id}`, savedSessionId: id === "b" ? savedB : "saved-a", busy: true, createdAt: 1,
    })) }));
    vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({
      type: "history_snapshot", value: sessionId, preview_only: true, history_events: [],
    }));
    render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-a", activeHistoryId: "saved-a", clientId: "client-1", busy: true, ready: true,
      messages: [{ id: "qa", role: "user", text: "A 질문" }, { id: "aa", role: "assistant", text: "A 초안", isComplete: false }],
      history: [{ value: "saved-a", label: "A 대화" }],
    }}><Sidebar /><LiveChatProbe /><Composer /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    await waitFor(() => expect(streams.at(-1)?.session).toBe("web-b"));
    savedB = (vi.mocked(sendBackendRequest).mock.calls[0][2] as { value: string }).value;
    act(() => streams.at(-1)!.handlers.onEvent({ type: "ready", state: {} }));
    await userEvent.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "B 질문");
    await userEvent.click(screen.getByRole("button", { name: "메시지 보내기" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    act(() => {
      streams.at(-1)!.handlers.onEvent({ type: "active_session", value: savedB });
      streams.at(-1)!.handlers.onEvent({ type: "session_title", message: "B 질문" });
      streams.at(-1)!.handlers.onEvent({ type: "assistant_delta", message: "B 초안" });
    });
    const historyOrder = () => Array.from(document.querySelectorAll(".history-item .history-title")).map((item) => item.textContent);
    const initialOrder = historyOrder();
    expect(initialOrder).toHaveLength(2);
    for (const [id, title, text] of [["a", "A 대화", "A 누적 1"], ["b", "B 질문", "B 누적 2"], ["a", "A 대화", "A 누적 3"]]) {
      const previous = streams.at(-1)!;
      await userEvent.click(screen.getByRole("button", { name: title }));
      await waitFor(() => expect(streams.at(-1)?.session).toBe(`web-${id}`));
      const current = streams.at(-1)!;
      act(() => {
        current.handlers.onEvent({ type: "clear_transcript", live_replay: true });
        current.handlers.onEvent({ type: "history_snapshot", live_replay: true, value: id === "b" ? savedB : "saved-a", message: id === "a" ? "A 대화" : "B 질문", history_events: [{ type: "user", text: `${id.toUpperCase()} 질문` }] });
        current.handlers.onEvent({ type: "assistant_delta", message: text });
        previous.handlers.onEvent({ type: "assistant_delta", message: "다른 세션 지연 이벤트" });
        current.handlers.onEvent({ type: "assistant_delta", message: " 계속" });
      });
      await waitFor(() => expect(screen.getByTestId("message-texts").textContent).toBe(`${id.toUpperCase()} 질문|${text} 계속`));
      expect(document.querySelectorAll(".history-item.busy")).toHaveLength(2);
      expect(historyOrder()).toEqual(initialOrder);
    }
    expect(shutdownSession).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
  });

  it("ignores an earlier live lookup after another history selection wins", async () => {
    let resolveEarlier!: (value: Awaited<ReturnType<typeof listLiveSessions>>) => void;
    vi.mocked(listLiveSessions).mockReturnValueOnce(new Promise((resolve) => { resolveEarlier = resolve; }));
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{ sessionId: "web-c", savedSessionId: "saved-c", busy: true, createdAt: 1 }] });
    vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({ type: "history_snapshot", value: sessionId, preview_only: true, history_events: [] }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "web-a", activeHistoryId: "saved-a", clientId: "client-1", history: [
      { value: "saved-b", label: "대화 B" }, { value: "saved-c", label: "대화 C" },
    ] }}><Sidebar /><ChatStateProbe /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "대화 B" }));
    await waitFor(() => expect(listLiveSessions).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "대화 C" }));
    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("web-c"));
    await act(async () => resolveEarlier({ sessions: [{ sessionId: "web-b", savedSessionId: "saved-b", busy: true, createdAt: 1 }] }));
    expect(screen.getByTestId("session").textContent).toBe("web-c");
    expect(screen.getByTestId("active-history").textContent).toBe("saved-c");
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("does not let a delayed preview overwrite a newly opened chat", async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof loadHistorySnapshot>>) => void;
    vi.mocked(loadHistorySnapshot).mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "web-a", clientId: "client-1", busy: true, history: [
      { value: "saved-b", label: "대화 B" },
    ] }}><Sidebar /><ChatStateProbe /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "대화 B" }));
    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("session-restored"));
    await act(async () => resolvePreview({ type: "history_snapshot", value: "saved-b", history_events: [{ type: "user", text: "늦은 이전 대화" }] }));
    expect(screen.getByTestId("message-texts").textContent).toBe("");
    expect(screen.getByTestId("active-history").textContent).toBe(
      (vi.mocked(sendBackendRequest).mock.calls[0][2] as { value: string }).value,
    );
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
  });

  it("shows a saved conversation before backend discovery finishes", async () => {
    vi.mocked(listLiveSessions).mockReturnValue(new Promise(() => {}));
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot",
      value: "session-old",
      message: "이전 대화",
      history_events: [
        { type: "user", text: "저장된 질문" },
        { type: "assistant", text: "저장된 답변" },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          messages: [{ id: "current", role: "user", text: "현재 질문" }],
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(screen.getByTestId("message-texts").textContent).toBe("저장된 질문|저장된 답변"));
    expect(screen.getByTestId("active-history").textContent).toBe("session-old");
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("keeps the composer in send mode and initially hides restore status", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          status: "ready",
          statusText: "준비됨",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
        <StatusPill />
        <Composer />
      </AppStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    expect(screen.getByRole("button", { name: "메시지 보내기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
    expect(document.querySelector("#readyPill")).toBeNull();
    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("session-active", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    }));
  });

  it("restores a live saved session snapshot when the current session is idle", async () => {
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "live-session-old",
        savedSessionId: "session-old",
        workspace: { name: "Default", path: "C:/demo" },
        busy: false,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(listLiveSessions).toHaveBeenCalledWith({
      clientId: "client-1",
      workspacePath: "C:/demo",
    }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("does not attach saved history to a runtime reused for another conversation", async () => {
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot", value: "saved-original", preview_only: true,
      history_events: [{ type: "user", text: "original question" }],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{
      sessionId: "reused-runtime", savedSessionId: "saved-new", busy: false, createdAt: 1,
    }] });
    render(<AppStateProvider initialState={{ ...initialAppState,
      sessionId: "current-runtime", clientId: "client-1", workspaceName: "Default", workspacePath: "C:/demo",
      history: [{ value: "saved-original", label: "Original conversation", live: true, liveSessionId: "reused-runtime" }],
    }}><Sidebar /><ChatStateProbe /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Original conversation" }));
    await waitFor(() => expect(listLiveSessions).toHaveBeenCalled());
    expect(screen.getByTestId("session").textContent).toBe("current-runtime");
    expect(screen.getByTestId("active-history").textContent).toBe("saved-original");
    expect(screen.getByTestId("message-texts").textContent).toContain("original question");
  });

  it("reattaches to an unsaved live backend session by web session id", async () => {
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-live-unsaved",
        savedSessionId: "",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{
            value: "web-live-unsaved",
            label: "진행 중인 채팅",
            description: "진행 중인 응답",
            live: true,
            liveSessionId: "web-live-unsaved",
            busy: true,
          }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(document.querySelector(".history-item.busy")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "진행 중인 응답 작업 더보기" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "진행 중인 응답" }));

    await waitFor(() => expect(listLiveSessions).toHaveBeenCalled());
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("finds a live busy history session outside the current workspace filter before resuming a saved snapshot", async () => {
    vi.mocked(listLiveSessions)
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({
        sessions: [{
          sessionId: "live-session-original",
          savedSessionId: "session-original",
          workspace: { name: "Default", path: "C:/demo" },
          busy: true,
          createdAt: 1,
        }],
      });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-viewing-other",
          clientId: "client-1",
          busy: false,
          workspaceName: "Other",
          workspacePath: "C:/other",
          history: [{
            value: "session-original",
            label: "진행 중인 채팅",
            description: "원래 답변",
            workspace: { name: "Default", path: "C:/demo" },
            live: true,
            liveSessionId: "live-session-original",
            busy: true,
          }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "원래 답변" }));

    await waitFor(() => expect(listLiveSessions).toHaveBeenCalledTimes(2));
    expect(listLiveSessions).toHaveBeenNthCalledWith(1, {
      clientId: "client-1",
      workspacePath: "C:/other",
    });
    expect(listLiveSessions).toHaveBeenNthCalledWith(2, { clientId: "client-1" });
    expect(screen.getByTestId("session").textContent).toBe("live-session-original");
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("starts a separate backend session for a new chat while the current answer is running", async () => {
    vi.mocked(startSession).mockResolvedValue({
      sessionId: "session-new",
      workspace: { name: "Default", path: "C:/demo" },
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: true,
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
    })));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it.each([
    { busy: true },
    { historyReadOnly: true },
    { restoringHistory: true, pendingHistoryId: "older" },
    { sessionId: null },
  ])("records and saves an empty new chat before any message: %j", async (overrides) => {
    let resolveStart!: (value: { sessionId: string }) => void;
    vi.mocked(startSession).mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));
    const { container } = render(
      <AppStateProvider initialState={{
        ...initialAppState,
        sessionId: "session-active",
        clientId: "client-1",
        ...overrides,
      }}>
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    expect(Array.from(container.querySelectorAll(".history-title")).some((item) => item.textContent === "새 대화")).toBe(true);
    await act(async () => { resolveStart({ sessionId: "session-new" }); });
    expect(sendBackendRequest).toHaveBeenCalledWith("session-new", "client-1", {
      type: "start_new_session", value: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(container.querySelector(".history-item.active .history-title")?.textContent).toBe("새 대화");
    expect(screen.getByTestId("message-count").textContent).toBe("0");
  });

  it("does not create duplicate empty chats on repeated clicks, including while saving", async () => {
    let resolveSave!: () => void;
    vi.mocked(sendBackendRequest).mockReturnValueOnce(new Promise((resolve) => {
      resolveSave = () => resolve({ ok: true });
    }));
    const { container } = render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-current", activeHistoryId: "saved-current", clientId: "client-1",
      history: [{ value: "saved-current", label: "사용한 대화", messageCount: 2 }],
      messages: [{ id: "q", role: "user", text: "질문" }],
    }}><Sidebar /><ChatStateProbe /></AppStateProvider>);
    const button = screen.getByRole("button", { name: "새 대화" });
    await userEvent.click(button);
    await userEvent.dblClick(button);
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave());
    await userEvent.click(button);
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".history-title")).toHaveLength(2);
  });

  it.each([true, false])("reuses an unused chat only when it is the top row: %s", async (emptyFirst) => {
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot", value: "saved-empty", preview_only: true, history_events: [],
    });
    const empty = { value: "saved-empty", label: "빈 대화", messageCount: 0 };
    const used = { value: "saved-current", label: "사용한 대화", messageCount: 2 };
    const { container } = render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "web-current", activeHistoryId: "saved-current", clientId: "client-1",
      history: emptyFirst ? [empty, used] : [used, empty],
      messages: [{ id: "q", role: "user", text: "질문" }],
    }}><Sidebar /><ChatStateProbe /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    if (emptyFirst) {
      await waitFor(() => expect(screen.getByTestId("active-history").textContent).toBe("saved-empty"));
      expect(sendBackendRequest).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".history-title")).toHaveLength(2);
    } else {
      expect(sendBackendRequest).toHaveBeenCalledWith("web-current", "client-1", expect.objectContaining({ type: "start_new_session" }));
      expect(container.querySelectorAll(".history-title")).toHaveLength(3);
    }
    expect(startSession).not.toHaveBeenCalled();
  });

  it("saves an idle new chat immediately without restarting the backend", async () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          messages: [{ id: "message-1", role: "user", text: "이전 질문" }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));

    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(sendBackendRequest).mock.calls[0][2] as { type?: string; value?: string };
    expect(screen.getByTestId("message-count").textContent).toBe("0");
    expect(screen.getByTestId("pending-fresh-chat").textContent).toBe("no");
    expect(screen.getByTestId("active-history").textContent).toBe(payload.value);
    expect(payload.type).toBe("start_new_session");
    expect(payload.value).toMatch(/^[0-9a-f]{12}$/);
    expect(container.querySelector(".history-item.active .history-title")?.textContent).toBe("새 대화");
    expect(screen.getByRole("button", { name: "새 대화 작업 더보기" })).toBeTruthy();
    expect(startSession).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
  });

  it("starts a replacement backend when an idle new chat finds an expired session", async () => {
    vi.mocked(sendBackendRequest).mockRejectedValueOnce(new Error("Unknown session"));
    vi.mocked(startSession).mockResolvedValueOnce({ sessionId: "session-recovered" });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-expired",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Sidebar />
        <ModalHost />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
    })));
    expect(screen.getByTestId("session").textContent).toBe("session-recovered");
    expect(screen.queryByText("Unknown session")).toBeNull();
  });

  it.each(["history-first", "events-first"])("does not render the bootstrap session as a second empty chat (%s)", (order) => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    const savedChat = { value: "saved-initial", label: "0 msg", description: "새 대화", messageCount: 0 };
    const { container } = render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "backend-process" }}>
        <Sidebar />
        <DispatchProbe onReady={(value) => { dispatch = value; }} />
      </AppStateProvider>,
    );
    const loadHistory = () => act(() => dispatch({ type: "set_history", history: [savedChat] }));
    const emitActive = (value: string) => act(() => dispatch({ type: "backend_event", event: { type: "active_session", value } }));
    if (order === "history-first") loadHistory();
    // Backend startup announces a transient ID before start_new_session saves
    // and announces the actual empty conversation. Render between SSE events.
    emitActive("bootstrap-unsaved");
    if (order === "events-first") loadHistory();
    expect(container.querySelectorAll(".history-item")).toHaveLength(1);
    emitActive("saved-initial");
    act(() => dispatch({ type: "backend_event", event: { type: "session_title", message: "새 대화" } }));
    expect(container.querySelectorAll(".history-item")).toHaveLength(1);
    expect(container.querySelector(".history-item.active .history-title")?.textContent).toBe("새 대화");
  });

  it("shows the initial active empty chat as a history row", async () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "backend-process",
          activeHistoryId: "saved-initial",
          chatTitle: "새 대화",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    expect(container.querySelector(".history-item.active .history-title")?.textContent).toBe("새 대화");
    expect(screen.getByRole("button", { name: "새 대화 작업 더보기" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "새 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(hideHistory).toHaveBeenCalledWith("saved-initial", "C:/demo", "Default"));
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-history").textContent).toBe("");
    expect(container.querySelector(".history-item.active .history-title")?.textContent || "").not.toBe("새 대화");
  });

  it("hides an immediately saved new chat without deleting it in normal mode", async () => {
    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          messages: [{ id: "message-1", role: "user", text: "이전 질문" }],
        }}
      >
        <Sidebar />
        <ChatStateProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "새 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "목록에서 숨기기" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제 확인" }));

    await waitFor(() => expect(container.querySelector(".history-item .history-title")?.textContent || "").not.toBe("새 대화"));
    expect(sendBackendRequest).toHaveBeenCalledTimes(1);
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-history").textContent).toBe("");
  });

  it("keeps the newly saved chat in history when another session is opened", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "saved-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
          messages: [{ id: "message-1", role: "user", text: "이전 질문" }],
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "새 대화" }));
    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "이전 대화" }));

    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("새 대화").some((node) => node.classList.contains("history-title"))).toBe(true);
    expect(vi.mocked(sendBackendRequest).mock.calls[1][2]).toEqual({
      type: "apply_select_command",
      command: "resume",
      value: "saved-old",
    });
  });

  it("keeps the restart action as an explicit backend restart", async () => {
    vi.mocked(restartSession).mockResolvedValue({ sessionId: "session-new" });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    const restartButton = screen.getByRole("button", { name: "재시작" });
    expect(restartButton.getAttribute("data-tooltip")).toBe("재시작");
    expect(restartButton.querySelectorAll("svg path")).toHaveLength(4);
    await userEvent.click(restartButton);

    await waitFor(() => expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-active",
      clientId: "client-1",
      cwd: "C:/demo",
    })));
  });

  it("keeps the selected workspace after restarting the session", async () => {
    const defaultWorkspace: Workspace = { name: "Default", path: "C:/MyHarness/Playground/Default" };
    const testWorkspace: Workspace = { name: "TEST1", path: "C:/MyHarness/Playground/TEST1" };
    vi.mocked(restartSession).mockResolvedValue({ sessionId: "session-test1" });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-default",
          clientId: "client-1",
          workspaceName: defaultWorkspace.name,
          workspacePath: defaultWorkspace.path,
          workspaces: [defaultWorkspace, testWorkspace],
        }}
      >
        <Sidebar />
        <WorkspaceProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "프로젝트 선택" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "TEST1" }));

    expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-default",
      clientId: "client-1",
      cwd: testWorkspace.path,
    }));
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("TEST1"));
  });
});
