import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBackendEvents } from "../../api/events";
import { listLiveSessions, startSession } from "../../api/session";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { useBackendSession } from "../useBackendSession";

vi.mock("../../api/events", () => ({
  openBackendEvents: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("../../api/session", () => ({
  listLiveSessions: vi.fn(),
  startSession: vi.fn(),
}));

function Probe() {
  useBackendSession();
  const { state } = useAppState();
  return (
    <>
      <output data-testid="session">{state.sessionId || ""}</output>
      <output data-testid="busy">{String(state.busy)}</output>
      <output data-testid="workspace">{state.workspacePath}</output>
      <output data-testid="messages">{state.messages.map((message) => message.text).join("|")}</output>
      <output data-testid="workflow-anchor">{state.workflowAnchorMessageId || ""}</output>
    </>
  );
}

describe("useBackendSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "new-session" });
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
    expect(openBackendEvents).toHaveBeenCalled();
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
    act(() => {
      eventHandlers?.onEvent({ type: "clear_transcript" } as any);
      eventHandlers?.onEvent({ type: "transcript_item", item: { role: "user", text: "진행 중 질문" } });
      eventHandlers?.onEvent({ type: "assistant_delta", message: "돌아와도 보이는 답변" });
    });

    expect(screen.getByTestId("messages").textContent).toBe("진행 중 질문|돌아와도 보이는 답변");
    expect(screen.getByTestId("workflow-anchor").textContent).toBeTruthy();
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
  });

  it("starts a new backend session when no live session is available", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(listLiveSessions).toHaveBeenCalledWith({ clientId: "client-1" });
    expect(startSession).toHaveBeenCalledWith({ clientId: "client-1" });
  });

  it("passes client runtime preferences into a new backend session", async () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({
      activeProfile: "codex",
      model: "gpt-5.4",
      effort: "high",
    }));

    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "client-1" }}>
        <Probe />
      </AppStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("new-session"));
    expect(startSession).toHaveBeenCalledWith({
      clientId: "client-1",
      activeProfile: "codex",
      model: "gpt-5.4",
      effort: "high",
    });
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
    expect(startSession).toHaveBeenCalledWith({ clientId: "client-1" });
    expect(startSession).toHaveBeenCalledWith({ clientId: "client-2" });
  });
});
