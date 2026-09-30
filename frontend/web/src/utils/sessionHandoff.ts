import type { Dispatch } from "react";
import { shutdownSession } from "../api/session";
import type { AppAction } from "../state/reducer";
import type { AppState } from "../types/ui";

// Only call this for a fresh runtime created by the caller, never a reused live session.
export function discardUnclaimedSession(sessionId: string, clientId: string, currentSessionId: string | null) {
  if (sessionId === currentSessionId) return;
  void Promise.resolve(shutdownSession(sessionId, clientId)).catch(() => {});
}

// Restart already terminated the source runtime. Keep a newer view usable without clearing it.
export function adoptRestartForCurrentView(sessionId: string, source: AppState, current: AppState, dispatch: Dispatch<AppAction>) {
  if (!source.sessionId || (current.sessionId !== source.sessionId
    && !(current.sessionId === null && current.restartingSessionId === source.sessionId)) || current.clientId !== source.clientId
    || current.workspacePath !== source.workspacePath || current.restoringHistory || current.pendingHistoryId) return false;
  if (current.conversationViewRevision === source.conversationViewRevision && current.activeHistoryId === source.activeHistoryId) {
    dispatch({ type: "session_replaced", sessionId, workspace: source.workspacePath ? { path: source.workspacePath, name: source.workspaceName } : undefined });
  } else {
    dispatch({ type: "session_started", sessionId, clientId: current.clientId });
  }
  return true;
}
