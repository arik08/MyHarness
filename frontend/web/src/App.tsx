import { useEffect, useRef } from "react";
import { sendBackendRequest } from "./api/messages";
import { listLiveSessions, restartSession, startSession } from "./api/session";
import { AppShell } from "./components/AppShell";
import { useBackendSession } from "./hooks/useBackendSession";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { AppStateProvider } from "./state/app-state";
import { useAppState } from "./state/app-state";
import { runtimePreferencesFromState } from "./utils/runtimePreferences";

const isDevBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

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
      <AppContent />
    </AppStateProvider>
  );
}
