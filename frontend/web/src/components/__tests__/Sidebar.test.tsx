import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampSidebarWidth, Sidebar } from "../Sidebar";
import { Composer } from "../Composer";
import { StatusPill } from "../StatusPill";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { deleteHistory, toggleHistoryPin } from "../../api/history";
import { listLiveSessions, restartSession, shutdownSession, startSession } from "../../api/session";
import { sendBackendRequest } from "../../api/messages";
import type { Workspace } from "../../types/backend";

vi.mock("../../api/session", () => ({
  restartSession: vi.fn(),
  shutdownSession: vi.fn(),
  startSession: vi.fn(),
  listLiveSessions: vi.fn(),
}));

vi.mock("../../api/history", () => ({
  deleteHistory: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "session-restored" });
    vi.mocked(shutdownSession).mockResolvedValue({ ok: true });
    vi.mocked(toggleHistoryPin).mockResolvedValue({ ok: true, pinned: true, sessionId: "session-old" });
    vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  });

  it("uses one right-side action slot that expands from more to delete and pin", async () => {
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
    expect(screen.queryByRole("button", { name: "이전 대화 삭제" })).toBeNull();
    expect(screen.queryByRole("button", { name: "이전 대화 상단 고정" })).toBeNull();

    await userEvent.click(moreButton);

    const deleteButton = screen.getByRole("button", { name: "이전 대화 삭제" });
    const pinButton = screen.getByRole("button", { name: "이전 대화 상단 고정" });
    const paths = Array.from(deleteButton.querySelectorAll("path")).map((path) => path.getAttribute("d"));

    expect(deleteButton.getAttribute("data-tooltip")).toBe("기록 삭제");
    expect(pinButton.getAttribute("data-tooltip")).toBe("상단 고정");
    expect(paths).toContain("M4 7h16");
    expect(paths).not.toContain("M6 6l12 12");
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
    expect(screen.getByRole("button", { name: "런타임 설정 열기" }).getAttribute("data-tooltip-placement")).toBe("right");
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

  it("sends subagent_model when the runtime picker is scoped to Sub", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          provider: "codex",
          providerLabel: "Codex Subscription",
          model: "gpt-5.5",
          subagentModel: "gpt-5.4-mini",
          runtimePicker: {
            ...initialAppState.runtimePicker,
            open: true,
            loading: false,
            selectedProvider: "codex",
            modelOpen: true,
            providers: [{ value: "codex", label: "Codex Subscription", active: true }],
            modelsByProvider: {
              codex: [
                { value: "gpt-5.5", label: "gpt-5.5", active: true },
                { value: "gpt-5.4-nano", label: "gpt-5.4-nano" },
              ],
            },
            models: [
              { value: "gpt-5.5", label: "gpt-5.5", active: true },
              { value: "gpt-5.4-nano", label: "gpt-5.4-nano" },
            ],
          },
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub" }));
    await userEvent.click(screen.getByRole("button", { name: /gpt-5\.4-nano/ }));

    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("session-active", "client-1", {
      type: "apply_select_command",
      command: "subagent_model",
      value: "gpt-5.4-nano",
    }));
  });

  it("sends subagent_effort after choosing a Sub model", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-active",
          clientId: "client-1",
          provider: "codex",
          providerLabel: "Codex Subscription",
          model: "gpt-5.5",
          subagentModel: "gpt-5.4-mini",
          subagentEffort: "medium",
          runtimePicker: {
            ...initialAppState.runtimePicker,
            open: true,
            loading: false,
            selectedProvider: "codex",
            modelOpen: true,
            providers: [{ value: "codex", label: "Codex Subscription", active: true }],
            efforts: [
              { value: "medium", label: "Medium", active: true },
              { value: "high", label: "High" },
            ],
            modelsByProvider: {
              codex: [
                { value: "gpt-5.4-mini", label: "gpt-5.4-mini", active: true },
                { value: "gpt-5.4-nano", label: "gpt-5.4-nano" },
              ],
            },
            models: [
              { value: "gpt-5.4-mini", label: "gpt-5.4-mini", active: true },
              { value: "gpt-5.4-nano", label: "gpt-5.4-nano" },
            ],
          },
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub" }));
    await userEvent.click(screen.getByRole("button", { name: /gpt-5\.4-nano/ }));
    await userEvent.click(screen.getByRole("button", { name: /High/ }));

    await waitFor(() => expect(sendBackendRequest).toHaveBeenLastCalledWith("session-active", "client-1", {
      type: "apply_select_command",
      command: "subagent_effort",
      value: "high",
    }));
  });

  it("keeps the runtime picker inside narrow viewports", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });

    try {
      const { container } = render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            sessionId: "session-active",
            clientId: "client-1",
            providerLabel: "Codex Subscription",
            model: "gpt-5.5",
            subagentModel: "gpt-5.4-mini",
            runtimePicker: {
              ...initialAppState.runtimePicker,
              open: true,
              loading: false,
              selectedProvider: "codex",
              modelOpen: true,
              effortOpen: true,
              providers: [{ value: "codex", label: "Codex Subscription", active: true }],
              models: [{ value: "gpt-5.5", label: "gpt-5.5", active: true }],
              efforts: [{ value: "medium", label: "Medium", active: true }],
            },
          }}
        >
          <Sidebar />
        </AppStateProvider>,
      );

      const button = screen.getByRole("button", { name: "런타임 설정 열기" });
      button.getBoundingClientRect = () => ({
        x: 340,
        y: 500,
        left: 340,
        top: 500,
        right: 356,
        bottom: 532,
        width: 16,
        height: 32,
        toJSON: () => ({}),
      });

      const picker = container.querySelector(".runtime-picker-layer") as HTMLElement;
      Object.defineProperty(picker, "scrollWidth", { configurable: true, value: 620 });
      Object.defineProperty(picker, "scrollHeight", { configurable: true, value: 420 });
      Object.defineProperty(picker, "offsetHeight", { configurable: true, value: 420 });

      fireEvent(window, new Event("resize"));

      await waitFor(() => expect(Number.parseFloat(picker.style.left)).toBeLessThanOrEqual(32));
      expect(picker.style.getPropertyValue("--runtime-picker-panel-max-height")).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    }
  });

  it("does not leave the runtime picker floating when the sidebar is collapsed", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sidebarCollapsed: true,
          runtimePicker: {
            ...initialAppState.runtimePicker,
            open: true,
            loading: false,
            providers: [{ value: "codex", label: "Codex Subscription", active: true }],
          },
        }}
      >
        <Sidebar />
      </AppStateProvider>,
    );

    expect(screen.queryByRole("region", { name: "Provider 선택" })).toBeNull();
  });

  it("shows the busy spinner in the delete slot while the active answer is running", () => {
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
    expect(actionButton).toBeNull();
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

    expect(visibleTitle.textContent).toBe("chat history 대화 제목을 짧게 나오게...");
    expect(visibleTitle.textContent?.length).toBeLessThanOrEqual(29);
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
    await userEvent.click(screen.getByRole("button", { name: "이전 대화 상단 고정" }));

    await waitFor(() => expect(toggleHistoryPin).toHaveBeenCalledWith("session-old", true, "C:/demo", "Default"));
    expect(screen.getByText("★")).toBeTruthy();
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("deletes a saved history item from its own workspace", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
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

    await userEvent.click(screen.getByRole("button", { name: "이전 대화 작업 더보기" }));
    await userEvent.click(screen.getByRole("button", { name: "이전 대화 삭제" }));

    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("session-old", "C:/other", "Other"));
    expect(screen.queryByText("이전 대화")).toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: "이전 대화 삭제" }));

    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("session-old", "C:/demo", "Default"));
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
    await userEvent.click(screen.getByRole("button", { name: "삭제된 대화 삭제" }));

    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("session-deleted", "C:/demo", "Default"));
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
    await userEvent.click(screen.getByRole("button", { name: "열려 있는 세션 삭제" }));

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

    await userEvent.click(screen.getAllByRole("button", { name: /저장된 live 대화/ })[0]);

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

    await userEvent.click(screen.getAllByRole("button", { name: /이전 대화/ })[0]);

    await waitFor(() => expect(startSession).toHaveBeenCalledWith({
      clientId: "client-1",
      cwd: "C:/demo",
    }));
    expect(sendBackendRequest).toHaveBeenCalledWith("session-restored", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    });
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

    fireEvent.click(screen.getAllByRole("button", { name: /이전 대화/ })[0]);

    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("session-active", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    }));
    expect(screen.getByTestId("message-count").textContent).toBe("1");
    expect(screen.getByTestId("message-texts").textContent).toBe("현재 화면 질문");
    expect(screen.getByTestId("active-history").textContent).toBe("");
    expect(screen.getByTestId("pending-history").textContent).toBe("session-old");
    expect(document.querySelector(".history-item.busy")).toBeNull();
    expect(screen.queryByText("진행 중인 대화")).toBeNull();

    const restoringRow = await waitFor(() => {
      const row = Array.from(document.querySelectorAll(".history-item.busy"))
        .find((item) => item.textContent?.includes("이전 대화"));
      expect(row).toBeTruthy();
      return row;
    }, { timeout: 800 });
    expect(restoringRow?.textContent).toContain("이전 대화");
    expect(restoringRow?.classList.contains("active")).toBe(false);
    expect(document.querySelectorAll(".history-item.busy")).toHaveLength(1);
  });

  it("keeps the composer in send mode and delays restore status while a saved history item is restoring", async () => {
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

    fireEvent.click(screen.getAllByRole("button", { name: /이전 대화/ })[0]);

    expect(screen.getByRole("button", { name: "메시지 보내기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
    expect(document.querySelector("#readyPill")?.textContent).toBe("준비됨");
    await waitFor(() => expect(document.querySelector("#readyPill")?.textContent).toBe("대화 불러오는 중"), {
      timeout: 800,
    });
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

    await userEvent.click(screen.getAllByRole("button", { name: /이전 대화/ })[0]);

    await waitFor(() => expect(listLiveSessions).toHaveBeenCalledWith({
      clientId: "client-1",
      workspacePath: "C:/demo",
    }));
    expect(sendBackendRequest).toHaveBeenCalledWith("live-session-old", "client-1", {
      type: "apply_select_command",
      command: "resume",
      value: "session-old",
    });
    expect(startSession).not.toHaveBeenCalled();
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

    await userEvent.click(screen.getAllByRole("button", { name: /진행 중인 응답/ })[0]);

    await waitFor(() => expect(listLiveSessions).toHaveBeenCalled());
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

    await waitFor(() => expect(startSession).toHaveBeenCalledWith({
      clientId: "client-1",
      cwd: "C:/demo",
    }));
    expect(restartSession).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getAllByRole("button", { name: /이전 대화/ })[0]);

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

    await userEvent.click(screen.getByRole("button", { name: "재시작" }));

    await waitFor(() => expect(restartSession).toHaveBeenCalledWith({
      sessionId: "session-active",
      clientId: "client-1",
      cwd: "C:/demo",
    }));
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

    expect(restartSession).toHaveBeenCalledWith({
      sessionId: "session-default",
      clientId: "client-1",
      cwd: testWorkspace.path,
    });
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("TEST1"));
  });
});
