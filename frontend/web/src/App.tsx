import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { sendBackendRequest } from "./api/messages";
import { listLiveSessions, restartSession, startSession } from "./api/session";
import { AppShell } from "./components/AppShell";
import { useBackendSession } from "./hooks/useBackendSession";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { AppStateProvider } from "./state/app-state";
import { useAppState } from "./state/app-state";
import { runtimePreferencesFromState } from "./utils/runtimePreferences";

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

function AppContent() {
  const { state, dispatch } = useAppState();
  const sharedChatRestoreStartedRef = useRef(false);
  const sharedChatScrolledRef = useRef(false);
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
      void restartSession({
        sessionId: state.sessionId,
        clientId: state.clientId,
        cwd: state.workspacePath || undefined,
        ...runtimePreferencesFromState(state),
      }).then((session) => {
        dispatch({ type: "session_replaced", sessionId: session.sessionId, workspace: session.workspace });
      }).catch((error: unknown) => {
        dispatch({
          type: "open_modal",
          modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
        });
      });
    }
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [dispatch, state.clientId, state.sessionId, state.workspacePath]);
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
    window.dispatchEvent(new Event("myharness:saveMessageScroll"));
    dispatch({ type: "begin_history_restore", sessionId: link.chatId });
    async function restoreSharedChat() {
      let targetSessionId = state.sessionId || "";
      const liveSessions = await listLiveSessions({
        clientId: state.clientId,
        workspacePath: linkedWorkspace || undefined,
      });
      const liveSession = liveSessions.sessions.find((item) => (
        item.savedSessionId === targetLink.chatId || item.sessionId === targetLink.chatId
      ));
      if (liveSession) {
        dispatch({
          type: "session_started",
          sessionId: liveSession.sessionId,
          clientId: state.clientId,
          busy: liveSession.busy,
        });
        if (liveSession.workspace) {
          dispatch({ type: "set_workspace", workspace: liveSession.workspace });
        }
        if (liveSession.busy) {
          dispatch({ type: "finish_history_restore" });
          return;
        }
        targetSessionId = liveSession.sessionId;
      } else if (state.busy) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: linkedWorkspace || undefined,
          ...runtimePreferencesFromState(state),
        });
        targetSessionId = session.sessionId;
        dispatch({ type: "session_started", sessionId: session.sessionId, clientId: state.clientId });
        if (session.workspace) {
          dispatch({ type: "set_workspace", workspace: session.workspace });
        }
      }
      await sendBackendRequest(targetSessionId, state.clientId, {
        type: "apply_select_command",
        command: "resume",
        value: targetLink.chatId,
      });
    }
    void restoreSharedChat().catch((error: unknown) => {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      dispatch({ type: "set_busy", value: false });
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
  return (
    <AppStateProvider>
      <EntryGate>
        <AppContent />
      </EntryGate>
    </AppStateProvider>
  );
}
