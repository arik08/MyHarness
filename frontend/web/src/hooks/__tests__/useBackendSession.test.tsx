import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBackendEvents } from "../../api/events";
import { loadHistorySnapshot } from "../../api/history";
import { sendBackendRequest } from "../../api/messages";
import { listLiveSessions, startSession } from "../../api/session";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { useBackendSession } from "../useBackendSession";

vi.mock("../../api/events", () => ({
  openBackendEvents: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock("../../api/history", () => ({ loadHistorySnapshot: vi.fn() }));
vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));

vi.mock("../../api/session", () => ({
  capacityQueueStatusEvent: "myharness:capacity-queue-status",
  listLiveSessions: vi.fn(),
  startSession: vi.fn(),
}));

function Probe() {
  useBackendSession();
  const { state } = useAppState();
  return (
    <>
      <output data-testid="session">{state.sessionId || ""}</output>
      <output data-testid="restoring">{String(state.restoringHistory)}</output>
      <output data-testid="busy">{String(state.busy)}</output>
      <output data-testid="status">{state.statusText}</output>
      <output data-testid="workspace">{state.workspacePath}</output>
      <output data-testid="messages">{state.messages.map((message) => message.text).join("|")}</output>
      <output data-testid="workflow-anchor">{state.workflowAnchorMessageId || ""}</output>
      <output data-testid="workflow-preview">
        {state.workflowEvents
          .map((event) => String(event.toolInput?.content || event.toolInput?.patch || ""))
          .filter(Boolean)
          .join("|")}
      </output>
    </>
  );
}

describe("useBackendSession", () => {
  it("ignores a startup failure after another session has been selected", async () => {
    let rejectLookup!: (error: Error) => void;
    vi.mocked(listLiveSessions).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLookup = reject; }));
    function Switch() {
      const { dispatch } = useAppState();
      return <button onClick={() => dispatch({ type: "session_started", sessionId: "selected", busy: true })}>Select</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: null }}><Probe /><Switch /></AppStateProvider>);
    fireEvent.click(screen.getByText("Select"));
    await act(async () => { rejectLookup(new Error("old startup failed")); });
    expect(screen.getByTestId("session").textContent).toBe("selected");
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(screen.getByTestId("messages").textContent).not.toContain("old startup failed");
  });
  it("recovers a silent stream from its cursor while work is still busy, preserving long history", async () => {
    vi.useFakeTimers();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{
      sessionId: "session-a", savedSessionId: "saved", busy: true, createdAt: 1, latestEventId: 9002,
    }] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", sessionId: "session-a", busy: true }}><Probe /></AppStateProvider>);
    const handlers = vi.mocked(openBackendEvents).mock.calls.at(-1)![1];
    act(() => {
      handlers.onEvent({ type: "history_snapshot", value: "saved", live_replay: true,
        history_events: Array.from({ length: 500 }, (_, index) => [
          { type: "user", text: `question-${index}` }, { type: "assistant", text: `answer-${index}` },
        ]).flat(),
      } as any);
      handlers.onEvent({ type: "transcript_item", item: { role: "user", text: "latest question" } });
      handlers.onCursor?.("9000");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(openBackendEvents).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openBackendEvents).mock.calls.at(-1)![0].get("lastEventId")).toBe("9000");
    expect(screen.getByTestId("messages").textContent).toContain("question-0|answer-0");
    expect(screen.getByTestId("busy").textContent).toBe("true");
    const resumed = vi.mocked(openBackendEvents).mock.calls.at(-1)![1];
    act(() => {
      resumed.onEvent({ type: "assistant_delta", message: "recovered answer" });
      resumed.onCursor?.("9001");
      resumed.onEvent({ type: "line_complete" });
      resumed.onCursor?.("9002");
    });
    expect(screen.getByTestId("messages").textContent).toContain("latest question|recovered answer");
    expect(screen.getByTestId("busy").textContent).toBe("false");
  });

  it("ignores an idle poll that arrives after new stream activity", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (value: any) => void;
    vi.mocked(listLiveSessions).mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", sessionId: "session-a", busy: true }}><Probe /></AppStateProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const handlers = vi.mocked(openBackendEvents).mock.calls.at(-1)![1];
    act(() => { handlers.onEvent({ type: "assistant_delta", message: "new work" }); });
    await act(async () => { resolvePoll({ sessions: [{ sessionId: "session-a", busy: false, latestEventId: 1 }] }); });
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(openBackendEvents).toHaveBeenCalledTimes(1);
  });

  it("waits for missing answer events instead of completing from the status poll", async () => {
    vi.useFakeTimers();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{
      sessionId: "session-a", savedSessionId: "", busy: false, createdAt: 1, latestEventId: 12,
    }] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", sessionId: "session-a", busy: true }}><Probe /></AppStateProvider>);
    act(() => { vi.mocked(openBackendEvents).mock.calls.at(-1)![1].onCursor?.("10"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(vi.mocked(openBackendEvents).mock.calls.at(-1)![0].get("lastEventId")).toBe("10");
  });

  it("does not mistake an unaccepted new question for a completed turn", async () => {
    vi.useFakeTimers();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{
      sessionId: "session-a", savedSessionId: "", busy: false, createdAt: 1, latestEventId: 10,
    }] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1", sessionId: "session-a", busy: true }}><Probe /></AppStateProvider>);
    act(() => { vi.mocked(openBackendEvents).mock.calls.at(-1)![1].onCursor?.("10"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(openBackendEvents).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "new-session" });
    vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
    vi.mocked(loadHistorySnapshot).mockResolvedValue({ type: "history_snapshot", value: "saved-last", history_events: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects to the previous live backend session before starting a new one", async () => {
    sessionStorage.setItem("myharness:activeBackendSessionId", "live-previous");
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [
        {
          sessionId: "live-older",
          savedSessionId: "",
          busy: false,
          createdAt: 1,
        },
        {
          sessionId: "live-previous",
          savedSessionId: "saved-1",
          workspace: { name: "Default", path: "C:/demo" },
          busy: true,
          createdAt: 2,
        },
      ],
    });

    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("live-previous"));
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(screen.getByTestId("workspace").textContent).toBe("C:/demo");
    expect(startSession).not.toHaveBeenCalled();
    await waitFor(() => expect(openBackendEvents).toHaveBeenCalled());
  });

  it("applies replayed live snapshot events after reconnecting to a busy session", async () => {
    let eventHandlers: Parameters<typeof openBackendEvents>[1] | null = null;
    vi.mocked(openBackendEvents).mockImplementation((_params, handlers) => {
      eventHandlers = handlers;
      return { close: vi.fn() } as unknown as EventSource;
    });
    sessionStorage.setItem("myharness:activeBackendSessionId", "live-previous");
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "live-previous",
        savedSessionId: "",
        workspace: { name: "Default", path: "C:/demo" },
        busy: true,
        createdAt: 1,
      }],
    });

    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("live-previous"));
    await waitFor(() => expect(eventHandlers).not.toBeNull());
    act(() => {
      eventHandlers?.onEvent({ type: "clear_transcript" } as any);
      eventHandlers?.onEvent({ type: "transcript_item", item: { role: "user", text: "진행 중 질문" } });
      eventHandlers?.onEvent({ type: "assistant_delta", message: "돌아와도 보이는 답변" });
    });

    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe("진행 중 질문|돌아와도 보이는 답변"));
    expect(screen.getByTestId("workflow-anchor").textContent).toBeTruthy();
  });

  it("restores the last viewed saved conversation after the backend has restarted", async () => {
    localStorage.setItem("myharness:lastConversation", JSON.stringify({
      sessionId: "saved-last", workspacePath: "C:/other", workspaceName: "Other",
    }));
    sessionStorage.setItem("myharness:activeBackendSessionId", "unrelated-live");
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [
      { sessionId: "unrelated-live", savedSessionId: "other", busy: true, createdAt: 1 },
    ] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}><Probe /></AppStateProvider>);
    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("new-session", "client-1", {
      type: "apply_select_command", command: "resume", value: "saved-last",
    }));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:/other" }));
    expect(JSON.parse(localStorage.getItem("myharness:lastConversation")!).sessionId).toBe("saved-last");
    await waitFor(() => expect(openBackendEvents).toHaveBeenCalled());
    const handlers = vi.mocked(openBackendEvents).mock.calls.at(-1)![1];
    act(() => {
      handlers.onEvent({ type: "active_session", value: "temporary-startup" });
      handlers.onEvent({ type: "history_snapshot", value: "saved-last", history_events: [
        { type: "user", text: "마지막 대화 내용" },
      ] });
      handlers.onEvent({ type: "line_complete" });
    });
    expect(screen.getByTestId("messages").textContent).toContain("마지막 대화 내용");
    expect(screen.getByTestId("restoring").textContent).toBe("false");
    expect(JSON.parse(localStorage.getItem("myharness:lastConversation")!).sessionId).toBe("saved-last");
  });

  it.each([true, false])("restores this tab's conversation after another tab changes the recent chat (live=%s)", async (live) => {
    const view = render(<AppStateProvider initialState={{
      ...initialAppState, clientId: "client-1", sessionId: "tab-live", activeHistoryId: "tab-saved",
      workspacePath: "C:/tab-project", workspaceName: "Tab project",
    }}><Probe /></AppStateProvider>);
    view.unmount();
    localStorage.setItem("myharness:lastConversation", JSON.stringify({
      sessionId: "other-saved", workspacePath: "C:/other-project", workspaceName: "Other project",
    }));
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [
      ...(live ? [{ sessionId: "tab-live", savedSessionId: "tab-saved", busy: true, createdAt: 1 }] : []),
      { sessionId: "other-live", savedSessionId: "other-saved", busy: false, createdAt: 2 },
    ] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}><Probe /></AppStateProvider>);
    if (live) {
      await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("tab-live"));
      expect(screen.getByTestId("busy").textContent).toBe("true");
      expect(startSession).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("new-session", "client-1", {
        type: "apply_select_command", command: "resume", value: "tab-saved",
      }));
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:/tab-project" }));
    }
  });

  it("uses the last viewed conversation across visits even without tab session storage", async () => {
    localStorage.setItem("myharness:lastConversation", JSON.stringify({
      sessionId: "saved-last", workspacePath: "C:/demo", workspaceName: "Default",
    }));
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [
      { sessionId: "last-viewed", savedSessionId: "saved-last", busy: false, createdAt: 1 },
      { sessionId: "newest-process", savedSessionId: "other", busy: true, createdAt: 2 },
    ] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}><Probe /></AppStateProvider>);
    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("last-viewed"));
    expect(startSession).not.toHaveBeenCalled();
  });

  it("falls back to the recent conversation when the tab record is malformed", async () => {
    sessionStorage.setItem("myharness:lastConversation", "{invalid");
    localStorage.setItem("myharness:lastConversation", JSON.stringify({
      sessionId: "saved-last", workspacePath: "C:/demo", workspaceName: "Default",
    }));
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [
      { sessionId: "last-viewed", savedSessionId: "saved-last", busy: false, createdAt: 1 },
    ] });
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}><Probe /></AppStateProvider>);
    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("last-viewed"));
    expect(startSession).not.toHaveBeenCalled();
  });

  it.each(["local", "session"])("keeps recording the conversation when %s storage writes are blocked", (blocked) => {
    const blockedStorage = blocked === "local" ? localStorage : sessionStorage;
    const availableStorage = blocked === "local" ? sessionStorage : localStorage;
    const originalSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === blockedStorage) throw new Error("Storage unavailable");
      originalSetItem.call(this, key, value);
    });
    try {
      render(<AppStateProvider initialState={{
        ...initialAppState, clientId: "client-1", sessionId: "tab-live", activeHistoryId: "tab-saved",
        workspacePath: "C:/tab-project", workspaceName: "Tab project",
      }}><Probe /></AppStateProvider>);
      expect(JSON.parse(availableStorage.getItem("myharness:lastConversation")!)).toEqual({
        sessionId: "tab-saved", workspacePath: "C:/tab-project", workspaceName: "Tab project",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("saves the first empty chat and falls back when the previous conversation is gone", async () => {
    localStorage.setItem("myharness:lastConversation", JSON.stringify({
      sessionId: "deleted", workspacePath: "C:/demo", workspaceName: "Default",
    }));
    vi.mocked(loadHistorySnapshot).mockRejectedValue(new Error("Not found"));
    render(<AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}><Probe /></AppStateProvider>);
    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(sendBackendRequest).toHaveBeenCalledWith("new-session", "client-1", { type: "start_new_session" });
  });

  it("keeps a busy request active while EventSource reconnects after a transport error", async () => {
    let eventHandlers: Parameters<typeof openBackendEvents>[1] | null = null;
    vi.mocked(openBackendEvents).mockImplementation((_params, handlers) => {
      eventHandlers = handlers;
      return { close: vi.fn() } as unknown as EventSource;
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          clientId: "client-1",
          sessionId: "session-a",
          busy: true,
          status: "processing",
          statusText: "답변 생성 중",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(openBackendEvents).toHaveBeenCalled());
    act(() => {
      eventHandlers?.onError(new Event("error"));
    });

    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(screen.getByTestId("status").textContent).toBe("답변 생성 중");
    expect(screen.getByTestId("messages").textContent).toBe("");

    act(() => {
      eventHandlers?.onEvent({ type: "error", message: "백엔드 작업 오류" });
    });

    expect(screen.getByTestId("busy").textContent).toBe("false");
    expect(screen.getByTestId("messages").textContent).toContain("백엔드 작업 오류");
  });

  it("coalesces rapid streamed tool input events before updating workflow preview", async () => {
    let eventHandlers: Parameters<typeof openBackendEvents>[1] | null = null;
    vi.mocked(openBackendEvents).mockImplementation((_params, handlers) => {
      eventHandlers = handlers;
      return { close: vi.fn() } as unknown as EventSource;
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          clientId: "client-1",
          sessionId: "session-a",
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(openBackendEvents).toHaveBeenCalled());
    vi.useFakeTimers();

    act(() => {
      eventHandlers?.onEvent({
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/report.html\",\"content\":\"hello",
      });
      eventHandlers?.onEvent({
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: " world",
      });
    });

    expect(screen.getByTestId("workflow-preview").textContent).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(screen.getByTestId("workflow-preview").textContent).toBe("hello world");
  });

  it("repairs a stale busy state when the live session has already completed", async () => {
    vi.useFakeTimers();
    vi.mocked(listLiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: "session-a",
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
          clientId: "client-1",
          sessionId: "session-a",
          workspacePath: "C:/demo",
          busy: true,
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("busy").textContent).toBe("false");
    expect(listLiveSessions).toHaveBeenCalledWith({ clientId: "client-1", workspacePath: "C:/demo" });
    expect(openBackendEvents).toHaveBeenCalledTimes(2);
  });

  it("repairs a stale busy state when the backend session has already disappeared", async () => {
    vi.useFakeTimers();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          clientId: "client-1",
          sessionId: "session-a",
          workspacePath: "C:/demo",
          busy: true,
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("busy").textContent).toBe("false");
  });

  it("does not overlap busy-state polls when a request is still pending", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: { sessions: [] }) => void) | undefined;
    vi.mocked(listLiveSessions).mockImplementation(() => new Promise((resolve) => {
      resolvePoll = resolve;
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          clientId: "client-1",
          sessionId: "session-a",
          busy: true,
        }}
      >
        <Probe />
      </AppStateProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(listLiveSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePoll?.({ sessions: [] });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(listLiveSessions).toHaveBeenCalledTimes(2);
  });

  it("shows the session queue position reported while starting a backend", async () => {
    vi.mocked(listLiveSessions).mockReturnValue(new Promise(() => {}));
    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("myharness:capacity-queue-status", {
        detail: {
          kind: "session",
          status: "waiting",
          position: 3,
          message: "접속 대기열 3번째 · 작업 세션 자리를 기다리는 중",
        },
      }));
    });

    expect(screen.getByTestId("status").textContent).toBe("접속 대기열 3번째 · 작업 세션 자리를 기다리는 중");
    expect(screen.getByTestId("busy").textContent).toBe("false");
  });

  it("starts a new backend session when no live session is available", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(listLiveSessions).toHaveBeenCalledWith({ clientId: "client-1" });
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-1" }));
  });

  it("passes client runtime preferences into a new backend session", async () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({
      version: 2,
      activeProfile: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    }));

    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      activeProfile: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    }));
  });

  it("drops stale built-in model preferences before starting a backend session", async () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({
      activeProfile: "codex",
      model: "gpt-5.5",
      subagentModel: "gpt-5.4-mini",
      effort: "high",
    }));

    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      activeProfile: "codex",
      model: undefined,
      subagentModel: undefined,
      effort: "high",
    }));
  });

  it("does not share a pending backend start across different clients", async () => {
    vi.mocked(startSession).mockReturnValue(new Promise(() => {}));

    render(
      <>
        <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
          <Probe />
        </AppStateProvider>
        <AppStateProvider initialState={{ ...initialAppState, clientId: "client-2" }}>
          <Probe />
        </AppStateProvider>
      </>,
    );

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(2));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-1" }));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-2" }));
  });
});
