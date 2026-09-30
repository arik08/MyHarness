import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { sendBackendRequest } from "./api/messages";
import { listLiveSessions, restartSession, startSession } from "./api/session";
import { AppShell } from "./components/AppShell";
import { useBackendSession } from "./hooks/useBackendSession";
import { useFullscreenShortcut } from "./hooks/useFullscreenShortcut";
import { useAsyncAction } from "./hooks/useAsyncAction";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { AppStateProvider } from "./state/app-state";
import { useAppState } from "./state/app-state";
import { runtimePreferencesFromState } from "./utils/runtimePreferences";
import { adoptRestartForCurrentView, discardUnclaimedSession } from "./utils/sessionHandoff";

const isDevBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

function EntryGate({ children }: { children: React.ReactNode }) {
  const { state } = useAppState();
  const [accessState, setAccessState] = useState<"checking" | "locked" | "unlocked">("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (state.themeId === "light") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = state.themeId;
    }
  }, [state.themeId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/status", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { authenticated?: boolean };
      if (!controller.signal.aborted) {
        setAccessState(response.ok && payload.authenticated ? "unlocked" : "locked");
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setAccessState("locked");
      }
    });
    return () => controller.abort();
  }, []);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        setAccessState("unlocked");
        setPassword("");
        return;
      }
    } catch {
      setError("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    setError("비밀번호가 올바르지 않습니다.");
    setPassword("");
  }

  if (accessState === "unlocked") {
    return children;
  }

  if (accessState === "checking") {
    return (
      <main className="entry-gate" aria-busy="true">
        <section className="entry-gate-card">
          <div className="entry-gate-brand">MyHarness</div>
          <p>접근 권한을 확인하고 있습니다.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="entry-gate">
      <section className="entry-gate-card" aria-labelledby="entry-gate-title">
        <div className="entry-gate-brand">MyHarness</div>
        <h1 id="entry-gate-title">MyHarness에 오신 것을 환영합니다</h1>
        <p>계속하려면 비밀번호를 입력해 주세요.</p>
        <form className="entry-gate-form" onSubmit={(event) => void unlock(event)}>
          <label htmlFor="entry-password">비밀번호</label>
          <input
            id="entry-password"
            type="password"
            value={password}
            autoComplete="current-password"
            autoFocus
            inputMode="numeric"
            aria-describedby={error ? "entry-password-error" : undefined}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError("");
            }}
          />
          <div id="entry-password-error" className="entry-gate-error" role="alert" aria-live="polite">
            {error}
          </div>
          <button type="submit" disabled={!password}>계속</button>
        </form>
      </section>
    </main>
  );
}

function sharedChatLinkParams() {
  const params = new URLSearchParams(window.location.search);
  const chatId = String(params.get("chat") || "").trim();
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    messageId: String(params.get("message") || "").trim(),
    workspaceName: String(params.get("workspace") || "").trim(),
    workspacePath: String(params.get("workspacePath") || "").trim(),
  };
}

function scrollSharedMessageIntoView(messageId: string) {
  const target = document.getElementById(`message-${messageId}`);
  if (!target) {
    return false;
  }
  target.scrollIntoView({ block: "center" });
  target.classList.add("shared-chat-target");
  window.setTimeout(() => target.classList.remove("shared-chat-target"), 1800);
  return true;
}

export function AppContent() {
  const { state, dispatch } = useAppState();
  const viewScope = JSON.stringify([state.sessionId, state.clientId, state.workspacePath, state.conversationViewRevision]);
  const currentViewScope = useRef(viewScope);
  const latestState = useRef(state);
  currentViewScope.current = viewScope;
  latestState.current = state;
  const restartRequest = useRef<object | null>(null);
  const restartAction = useAsyncAction(viewScope);
  useEffect(() => () => { restartRequest.current = null; }, [viewScope]);
  const sharedChatRestoreStartedRef = useRef(false);
  const sharedChatScrolledRef = useRef(false);
  const sharedChatRequest = useRef<object | null>(null);
  useEffect(() => () => { sharedChatRequest.current = null; }, []);
  useBackendSession();
  useWorkspaceData();
  useEffect(() => {
    if (!isDevBuild) {
      return;
    }
    void fetch("/api/visit", { method: "POST", keepalive: true }).catch(() => {});
  }, []);
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "o") {
        return;
      }
      event.preventDefault();
      if (latestState.current.sessionId && latestState.current.restartingSessionId === latestState.current.sessionId) return;
      void restartAction.run(async () => {
        const request = {};
        restartRequest.current = request;
        const isCurrent = () => restartRequest.current === request && currentViewScope.current === viewScope;
        const source = latestState.current;
        if (source.sessionId) dispatch({ type: "begin_runtime_restart", sessionId: source.sessionId });
        try {
          const session = await restartSession({
            sessionId: source.sessionId,
            clientId: source.clientId,
            cwd: source.workspacePath || undefined,
            ...runtimePreferencesFromState(source),
          });
          if (!isCurrent()) {
            if (!adoptRestartForCurrentView(session.sessionId, source, latestState.current, dispatch)) {
              discardUnclaimedSession(session.sessionId, source.clientId, latestState.current.sessionId);
            }
            return;
          }
          dispatch({ type: "session_replaced", sessionId: session.sessionId, workspace: session.workspace });
        } catch (error: unknown) {
          if (!isCurrent()) return;
          dispatch({
            type: "open_modal",
            modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          if (source.sessionId) dispatch({ type: "finish_runtime_restart", sessionId: source.sessionId });
        }
      });
    }
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [dispatch, viewScope]);
  useEffect(() => {
    const link = sharedChatLinkParams();
    if (!link || sharedChatRestoreStartedRef.current || !state.sessionId || !state.clientId) {
      return;
    }
    const activeHistoryId = state.activeHistoryId || state.sessionId;
    if (link.chatId === activeHistoryId || link.chatId === state.pendingHistoryId) {
      return;
    }
    const targetLink = link;
    const linkedWorkspace = targetLink.workspacePath
      || state.workspaces.find((workspace) => workspace.name === targetLink.workspaceName)?.path
      || state.workspacePath;
    sharedChatRestoreStartedRef.current = true;
    const request = {};
    sharedChatRequest.current = request;
    const expectedViewRevision = state.conversationViewRevision + 1;
    let expectedSessionId = state.sessionId;
    let expectedWorkspacePath = state.workspacePath;
    let createdSessionId = "";
    const isCurrent = () => sharedChatRequest.current === request
      && latestState.current.conversationViewRevision === expectedViewRevision
      && latestState.current.sessionId === expectedSessionId
      && latestState.current.clientId === state.clientId
      && latestState.current.restoringHistory
      && latestState.current.workspacePath === expectedWorkspacePath;
    window.dispatchEvent(new Event("myharness:saveMessageScroll"));
    dispatch({ type: "begin_history_restore", sessionId: link.chatId });
    async function restoreSharedChat() {
      let targetSessionId = state.sessionId || "";
      const liveSessions = await listLiveSessions({
        clientId: state.clientId,
        workspacePath: linkedWorkspace || undefined,
      });
      if (!isCurrent()) return;
      const liveSession = liveSessions.sessions.find((item) => (
        item.savedSessionId === targetLink.chatId || item.sessionId === targetLink.chatId
      ));
      if (liveSession) {
        expectedSessionId = liveSession.sessionId;
        dispatch({
          type: "session_started",
          sessionId: liveSession.sessionId,
          clientId: state.clientId,
          busy: liveSession.busy,
        });
        if (liveSession.workspace) {
          expectedWorkspacePath = liveSession.workspace.path;
          dispatch({ type: "set_workspace", workspace: liveSession.workspace });
        }
        if (liveSession.busy) {
          dispatch({ type: "finish_history_restore" });
          return;
        }
        targetSessionId = liveSession.sessionId;
      } else if (state.busy || (state.restartingSessionId === state.sessionId && !liveSessions.sessions.some((session) => session.sessionId === state.sessionId))
        || Boolean(linkedWorkspace && linkedWorkspace !== state.workspacePath)) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: linkedWorkspace || undefined,
          ...runtimePreferencesFromState(state),
        });
        createdSessionId = session.sessionId;
        if (!isCurrent()) {
          discardUnclaimedSession(session.sessionId, state.clientId, latestState.current.sessionId);
          return;
        }
        targetSessionId = session.sessionId;
        expectedSessionId = session.sessionId;
        dispatch({ type: "session_started", sessionId: session.sessionId, clientId: state.clientId });
        if (session.workspace) {
          expectedWorkspacePath = session.workspace.path;
          dispatch({ type: "set_workspace", workspace: session.workspace });
        } else if (linkedWorkspace) {
          expectedWorkspacePath = linkedWorkspace;
          dispatch({ type: "set_workspace", workspace: {
            path: linkedWorkspace,
            name: targetLink.workspaceName || state.workspaces.find((workspace) => workspace.path === linkedWorkspace)?.name || state.workspaceName,
          } });
        }
      }
      await sendBackendRequest(targetSessionId, state.clientId, {
        type: "apply_select_command",
        command: "resume",
        value: targetLink.chatId,
      });
    }
    void restoreSharedChat().catch((error: unknown) => {
      if (!isCurrent()) return;
      dispatch({ type: "session_started", sessionId: state.sessionId || "", clientId: state.clientId, replay: true, savedSessionId: state.activeHistoryId || undefined, busy: state.busy });
      if (createdSessionId) discardUnclaimedSession(createdSessionId, state.clientId, state.sessionId);
      if (state.workspacePath) {
        dispatch({ type: "set_workspace", workspace: { path: state.workspacePath, name: state.workspaceName } });
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      dispatch({ type: "finish_history_restore" });
    });
  }, [
    dispatch,
    state.activeHistoryId,
    state.busy,
    state.clientId,
    state.pendingHistoryId,
    state.sessionId,
    state.workspaces,
    state.workspacePath,
  ]);
  useEffect(() => {
    const link = sharedChatLinkParams();
    if (!link?.messageId || sharedChatScrolledRef.current) {
      return;
    }
    if (scrollSharedMessageIntoView(link.messageId)) {
      sharedChatScrolledRef.current = true;
    }
  }, [state.messages]);
  return <AppShell />;
}

export default function App() {
  useFullscreenShortcut();
  return (
    <AppStateProvider>
      <EntryGate>
        <AppContent />
      </EntryGate>
    </AppStateProvider>
  );
}
