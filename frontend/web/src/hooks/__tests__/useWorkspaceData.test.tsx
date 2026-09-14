import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listHistory } from "../../api/history";
import { listProjectFiles } from "../../api/artifacts";
import { listLiveSessions } from "../../api/session";
import { listWorkspaces } from "../../api/workspaces";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { mergeLiveSessions, useWorkspaceData } from "../useWorkspaceData";

vi.mock("../../api/artifacts", () => ({
  listProjectFiles: vi.fn(),
}));

vi.mock("../../api/history", () => ({
  historyPageSize: 25,
  listHistory: vi.fn(),
}));

vi.mock("../../api/session", () => ({
  listLiveSessions: vi.fn(),
}));

vi.mock("../../api/workspaces", () => ({
  listWorkspaces: vi.fn(),
}));

function Probe() {
  useWorkspaceData();
  const { state, dispatch } = useAppState();
  return (
    <>
      <output data-testid="history">{JSON.stringify(state.history)}</output>
      <output data-testid="history-loading">{state.historyLoading ? "loading" : "idle"}</output>
      <button type="button" onClick={() => dispatch({ type: "begin_history_restore", sessionId: "session-old" })}>
        restore history
      </button>
      <button type="button" onClick={() => dispatch({ type: "set_busy", value: true })}>
        start response
      </button>
      <button type="button" onClick={() => dispatch({ type: "session_started", sessionId: "web-reconnected" })}>
        connect session
      </button>
    </>
  );
}

describe("useWorkspaceData", () => {
  it.each([null, "runtime"])("reconciles runtime aliases with saved rows for current session %s", (current) => {
    const temporary = { value: "runtime", label: "live", live: true, liveSessionId: "runtime", busy: true };
    const saved = { value: "saved", label: "saved title", pinned: true, liked: true };
    const other = { value: "other", label: "saved title", liveSessionId: "runtime" };
    const sessions = [{ sessionId: "runtime", savedSessionId: "saved", busy: false, createdAt: 1 }];
    for (const rows of [[temporary, saved, other], [saved, temporary, other]]) {
      let merged = mergeLiveSessions(rows, sessions, current);
      for (let refresh = 0; refresh < 3; refresh += 1) {
        merged = mergeLiveSessions(merged, sessions, current);
        expect(merged.map((item) => item.value)).toEqual(["saved", "other"]);
        expect(merged[0]).toMatchObject({ pinned: true, liked: true, busy: false });
      }
    }
    expect(mergeLiveSessions([temporary], sessions, current)[0].value).toBe("saved");
  });
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue({
      root: "C:/demo",
      workspaces: [{ name: "Default", path: "C:/demo" }],
      scope: { mode: "shared", name: "shared", root: "C:/demo" },
    });
    vi.mocked(listHistory).mockResolvedValue({ options: [] });
    vi.mocked(listProjectFiles).mockResolvedValue({ files: [], scope: "default" });
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
  });

  it.each(["changed", "unchanged", "empty", "failed"])("restores recent data before the network and handles a %s refresh", async (result) => {
    const oldRow = { value: "saved-cached", label: "오늘", description: "최근 받은 제목" };
    vi.mocked(listHistory).mockResolvedValue({ options: [oldRow] });
    const initial = { ...initialAppState, clientId: "cache-client" };
    const first = render(<AppStateProvider initialState={initial}><Probe /></AppStateProvider>);
    await waitFor(() => expect(screen.getByTestId("history").textContent).toContain("최근 받은 제목"));
    first.unmount();

    let resolveHistory!: (value: Awaited<ReturnType<typeof listHistory>>) => void;
    let rejectHistory!: (error: Error) => void;
    vi.mocked(listWorkspaces).mockImplementation(() => new Promise(() => {}));
    vi.mocked(listHistory).mockImplementation(() => new Promise((resolve, reject) => {
      resolveHistory = resolve;
      rejectHistory = reject;
    }));
    let latestHistory = initialAppState.history;
    function ObserveHistory() {
      latestHistory = useAppState().state.history;
      return null;
    }
    render(<AppStateProvider initialState={initial}><Probe /><ObserveHistory /></AppStateProvider>);
    expect(screen.getByTestId("history").textContent).toContain("최근 받은 제목");
    expect(screen.getByTestId("history-loading").textContent).toBe("idle");
    const cachedHistory = latestHistory;
    await act(async () => {
      if (result === "failed") rejectHistory(new Error("offline"));
      else resolveHistory({ options: result === "empty" ? [] : [{ ...oldRow,
        description: result === "changed" ? "새 제목" : oldRow.description }] });
    });
    const text = screen.getByTestId("history").textContent;
    if (result === "empty") expect(text).toBe("[]");
    else expect(text).toContain(result === "changed" ? "새 제목" : "최근 받은 제목");
    if (result === "unchanged" || result === "failed") expect(latestHistory).toBe(cachedHistory);
  });

  it("ignores another client's cache and malformed cache data", async () => {
    sessionStorage.setItem("myharness:recent:history:v1", JSON.stringify({
      scope: JSON.stringify(["other-client", "C:/demo", "Default"]),
      data: { history: [{ value: "private", label: "다른 사용자" }], hasMore: false, nextOffset: 1 },
    }));
    sessionStorage.setItem("myharness:recent:workspaces:v1", "{broken");
    vi.mocked(listHistory).mockImplementation(() => new Promise(() => {}));
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", workspaceName: "Default", workspacePath: "C:/demo" }}><Probe /></AppStateProvider>);
    expect(screen.getByTestId("history").textContent).toBe("[]");
    expect(screen.getByTestId("history-loading").textContent).toBe("loading");
    await act(async () => { await Promise.resolve(); });
  });

  it("shows saved history before a slow live-session lookup and keeps it on lookup failure", async () => {
    let rejectLive!: (error: Error) => void;
    vi.mocked(listLiveSessions).mockImplementation(() => new Promise((_resolve, reject) => { rejectLive = reject; }));
    vi.mocked(listHistory).mockResolvedValue({ options: [{ value: "saved-fast", label: "오늘", description: "최근 작업" }] });
    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", workspaceName: "Default", workspacePath: "C:/demo" }}>
        <Probe />
      </AppStateProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("history").textContent).toContain("saved-fast"));
    expect(screen.getByTestId("history-loading").textContent).toBe("idle");
    await act(async () => rejectLive(new Error("live status unavailable")));
    expect(screen.getByTestId("history").textContent).toContain("saved-fast");
  });

  it("merges live backend sessions into the history list", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "saved-old", label: "5/3 10:00 2 msg", description: "저장된 대화" }],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-live-1",
        savedSessionId: "saved-live-1",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history[0]).toMatchObject({
        value: "saved-live-1",
        live: true,
        liveSessionId: "web-live-1",
        busy: true,
      });
      expect(history[1]).toMatchObject({ value: "saved-old" });
    });
  });

  it("uses the new active session when an earlier history request finishes after switching", async () => {
    let resolveLive!: (value: Awaited<ReturnType<typeof listLiveSessions>>) => void;
    vi.mocked(listLiveSessions).mockReturnValueOnce(new Promise((resolve) => { resolveLive = resolve; }));
    render(
      <AppStateProvider initialState={{
        ...initialAppState,
        sessionId: "web-streaming",
        clientId: "client-1",
        busy: true,
        workspaceName: "Default",
        workspacePath: "C:/demo",
        messages: [{ id: "question", role: "user", text: "계속 진행할 질문" }],
      }}>
        <Probe />
      </AppStateProvider>,
    );
    await waitFor(() => expect(listLiveSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "connect session" }));
    await act(async () => resolveLive({ sessions: [{
      sessionId: "web-streaming", savedSessionId: "saved-streaming", busy: true, createdAt: 1,
      workspace: { name: "Default", path: "C:/demo" },
    }] }));
    const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
    expect(history.find((item: { value: string }) => item.value === "saved-streaming")).toMatchObject({
      live: true, liveSessionId: "web-streaming", busy: true,
    });
    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("refreshes a background live chat when it finishes", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "saved-live-1", label: "진행 중인 채팅", description: "백그라운드 작업" }],
      hasMore: true,
      nextOffset: 25,
    });
    let backgroundBusy = true;
    vi.mocked(listLiveSessions).mockImplementation(async () => ({
      sessions: [{
        sessionId: "web-live-1",
        savedSessionId: "saved-live-1",
        workspace: { name: "Default", path: "C:/demo" },
        busy: backgroundBusy,
        createdAt: 1,
      }],
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history[0]).toMatchObject({
        liveSessionId: "web-live-1",
        busy: true,
      });
    });

    backgroundBusy = false;

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history[0]).toMatchObject({
        liveSessionId: "web-live-1",
        busy: false,
      });
    }, { timeout: 4500 });

    expect(listLiveSessions).toHaveBeenCalledTimes(2);
  });

  it("loads only the first saved history page on workspace startup", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "session-1", label: "5/4 10:00 2 msg", description: "첫 대화" }],
      hasMore: true,
      nextOffset: 25,
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 0,
    }));
  });

  it("does not reload saved history for startup session and busy state changes", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "connect session" }));
      fireEvent.click(screen.getByRole("button", { name: "start response" }));
      await Promise.resolve();
    });

    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("clears a cancelled history refresh when history restoration starts", async () => {
    vi.mocked(listHistory).mockImplementation(() => new Promise(() => {}));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [{ value: "session-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("history-loading").textContent).toBe("loading"));
    fireEvent.click(screen.getByRole("button", { name: "restore history" }));

    await waitFor(() => expect(screen.getByTestId("history-loading").textContent).toBe("idle"));
  });

  it("keeps the saved title when a history item is also an open backend session", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "saved-live-1", label: "5/3 10:00 2 msg", description: "AI 최신 트렌드 웹보고서" }],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-live-1",
        savedSessionId: "saved-live-1",
        title: "열려 있는 세션",
        workspace: { name: "Default", path: "C:/demo" },
        busy: false,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        value: "saved-live-1",
        description: "AI 최신 트렌드 웹보고서",
        live: true,
        liveSessionId: "web-live-1",
        busy: false,
      });
    });
  });

  it("does not add the current backend session as a deletable history row", async () => {
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-current",
        savedSessionId: "",
        workspace: { name: "Default", path: "C:/demo" },
        busy: false,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history).toEqual([]);
    });
  });

  it.each(["", "새 대화", "MyHarness"])("does not surface idle placeholder sessions after switching history (%s)", async (title) => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [{ value: "saved-current", label: "5/4 10:00 4 msg", description: "나무위키 역사 PPTX" }],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-placeholder",
        savedSessionId: "placeholder-saved-id",
        title,
        workspace: { name: "Default", path: "C:/demo" },
        busy: false,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "saved-current",
          clientId: "client-1",
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ value: "saved-current", description: "나무위키 역사 PPTX" });
    });
  });

  it("refreshes saved history while an active saved chat is answering", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [
        { value: "session-old", label: "5/4 09:00 2 msg", description: "이전 대화" },
        { value: "session-current", label: "5/4 10:00 2 msg", description: "현재 진행 중" },
      ],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-current",
        savedSessionId: "session-current",
        title: "현재 진행 중",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 2,
      }, {
        sessionId: "web-other",
        savedSessionId: "",
        title: "다른 사용자 진행 중",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 3,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "session-current",
          clientId: "client-1",
          busy: true,
          workspaceName: "Default",
          workspacePath: "C:/demo",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 0,
    }));
    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history.map((item: { value: string }) => item.value)).toEqual(["web-other", "session-old", "session-current"]);
      expect(history[0]).toMatchObject({
        value: "web-other",
        description: "다른 사용자 진행 중",
        live: true,
        liveSessionId: "web-other",
        busy: true,
      });
    });
  });

  it("keeps the visible history order stable while a saved chat is restoring", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [
        { value: "session-second", label: "5/4 09:59 2 msg", description: "두 번째 대화" },
        { value: "session-top", label: "5/4 10:00 2 msg", description: "최상단 대화" },
      ],
    });
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "web-previous",
        savedSessionId: "",
        title: "이전 진행 중인 대화",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 3,
      }],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-restoring",
          activeHistoryId: "session-second",
          pendingHistoryId: "session-second",
          restoringHistory: true,
          clientId: "client-1",
          busy: true,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [
            { value: "session-top", label: "5/4 10:00 2 msg", description: "최상단 대화" },
            { value: "session-second", label: "5/4 09:59 2 msg", description: "두 번째 대화" },
          ],
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
    expect(listHistory).not.toHaveBeenCalled();
    expect(listLiveSessions).not.toHaveBeenCalled();
    expect(history.map((item: { value: string }) => item.value)).toEqual(["session-top", "session-second"]);
  });

  it("keeps the history list in place while reading a restored chat", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [
        { value: "session-second", label: "5/4 09:59 2 msg", description: "두 번째 대화" },
        { value: "session-top", label: "5/4 10:00 2 msg", description: "최상단 대화" },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "session-second",
          clientId: "client-1",
          historyReadOnly: true,
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [
            { value: "session-top", label: "5/4 10:00 2 msg", description: "최상단 대화" },
            { value: "session-second", label: "5/4 09:59 2 msg", description: "두 번째 대화" },
          ],
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
    expect(listHistory).not.toHaveBeenCalled();
    expect(listLiveSessions).not.toHaveBeenCalled();
    expect(history.map((item: { value: string }) => item.value)).toEqual(["session-top", "session-second"]);
  });

  it("loads saved history when reconnecting to a restored chat without a cached sidebar list", async () => {
    vi.mocked(listHistory).mockResolvedValue({
      options: [
        { value: "session-top", label: "5/4 10:00 2 msg", description: "최상단 대화" },
        { value: "session-old", label: "5/4 09:30 2 msg", description: "이전 대화" },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "web-current",
          activeHistoryId: "session-top",
          clientId: "client-1",
          historyReadOnly: true,
          busy: false,
          workspaceName: "Default",
          workspacePath: "C:/demo",
          history: [],
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledWith({
      workspacePath: "C:/demo",
      workspaceName: "Default",
      limit: 25,
      offset: 0,
    }));
    await waitFor(() => {
      const history = JSON.parse(screen.getByTestId("history").textContent || "[]");
      expect(history.map((item: { value: string }) => item.value)).toEqual(["session-top", "session-old"]);
    });
  });
});
