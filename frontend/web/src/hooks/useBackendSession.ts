import { useEffect, useRef, useState } from "react";
import { openBackendEvents } from "../api/events";
import { loadHistorySnapshot } from "../api/history";
import { sendBackendRequest } from "../api/messages";
import { capacityQueueStatusEvent, listLiveSessions, startSession } from "../api/session";
import { useAppState } from "../state/app-state";
import type { SessionResponse } from "../types/backend";
import { loadRuntimePreferences } from "../utils/runtimePreferences";
import { createWorkflowEventCoalescer } from "./workflowEventCoalescer";

const activeBackendSessionKey = "myharness:activeBackendSessionId";
const lastConversationKey = "myharness:lastConversation";

function loadLastConversation() {
  try {
    const value = JSON.parse(localStorage.getItem(lastConversationKey) || "null");
    return value && typeof value.sessionId === "string" && value.sessionId
      && typeof value.workspacePath === "string" && typeof value.workspaceName === "string"
      ? value as { sessionId: string; workspacePath: string; workspaceName: string }
      : null;
  } catch {
    return null;
  }
}
const pendingSessionStarts = new Map<string, Promise<SessionResponse>>();
const busySessionPollMs = 3000;

function startSharedSession(clientId: string, cwd?: string) {
  const preferences = loadRuntimePreferences();
  const payload = { clientId, ...preferences, ...(cwd ? { cwd } : {}) };
  const key = JSON.stringify(payload);
  let pending = pendingSessionStarts.get(key);
  if (!pending) {
    pending = startSession(payload).finally(() => {
      pendingSessionStarts.delete(key);
    });
    pendingSessionStarts.set(key, pending);
  }
  return pending;
}

function loadActiveBackendSessionId() {
  try {
    return sessionStorage.getItem(activeBackendSessionKey) || "";
  } catch {
    return "";
  }
}

function saveActiveBackendSessionId(sessionId: string) {
  try {
    sessionStorage.setItem(activeBackendSessionKey, sessionId);
  } catch {
    // Embedded/private contexts may block sessionStorage.
  }
}

export function useBackendSession() {
  const { state, dispatch } = useAppState();
  const sourceRef = useRef<EventSource | null>(null);
  const startupRestoreIdRef = useRef<string | null>(null);
  const [eventStreamGeneration, setEventStreamGeneration] = useState(0);
  const streamCursorRef = useRef({ scope: "", id: "", receivedAt: 0, revision: 0 });

  useEffect(() => {
    if (!state.activeHistoryId || state.restoringHistory || state.pendingHistoryId) return;
    try {
      localStorage.setItem(lastConversationKey, JSON.stringify({
        sessionId: state.activeHistoryId,
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
      }));
    } catch {
      // Storage may be unavailable in embedded/private contexts.
    }
  }, [state.activeHistoryId, state.restoringHistory, state.pendingHistoryId, state.workspacePath, state.workspaceName]);

  useEffect(() => {
    function handleCapacityQueueStatus(event: Event) {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      dispatch({
        type: "backend_event",
        event: {
          type: "capacity_queue_status",
          kind: String(detail.kind || "session"),
          status: String(detail.status || "waiting"),
          position: Number(detail.position || 0),
          message: String(detail.message || ""),
        },
      });
    }
    window.addEventListener(capacityQueueStatusEvent, handleCapacityQueueStatus);
    return () => window.removeEventListener(capacityQueueStatusEvent, handleCapacityQueueStatus);
  }, [dispatch]);

  useEffect(() => {
    if (state.sessionId) {
      saveActiveBackendSessionId(state.sessionId);
    }
  }, [state.sessionId]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (state.sessionId) {
        return;
      }

      const previousSessionId = loadActiveBackendSessionId();
      let lastConversation = loadLastConversation();
      const liveSessions = await listLiveSessions({ clientId: state.clientId });
      const savedSessionId = lastConversation?.sessionId;
      const liveSession = lastConversation
        ? liveSessions.sessions.find((item) => item.savedSessionId === savedSessionId)
        : liveSessions.sessions.find((item) => item.sessionId === previousSessionId) ?? liveSessions.sessions.at(-1);

      if (liveSession) {
        if (cancelled) {
          return;
        }

        dispatch({
          type: "session_started",
          sessionId: liveSession.sessionId,
          clientId: state.clientId,
          busy: liveSession.busy,
          replay: true,
          savedSessionId: liveSession.savedSessionId,
        });

        if (liveSession.workspace) {
          dispatch({
            type: "backend_event",
            event: {
              type: "state_snapshot",
              state: { workspace: liveSession.workspace },
            },
          });
        }

        return;
      }

      if (lastConversation) {
        try {
          await loadHistorySnapshot(lastConversation);
        } catch {
          // A removed or unavailable conversation must not prevent opening the app.
          lastConversation = null;
        }
      }
      if (cancelled) return;
      const session = await startSharedSession(state.clientId, lastConversation?.workspacePath);

      if (cancelled) {
        return;
      }

      await sendBackendRequest(session.sessionId, state.clientId, lastConversation
        ? { type: "apply_select_command", command: "resume", value: lastConversation.sessionId }
        : { type: "start_new_session" });
      if (cancelled) return;
      if (lastConversation) {
        startupRestoreIdRef.current = lastConversation.sessionId;
        dispatch({ type: "begin_history_restore", sessionId: lastConversation.sessionId });
      }

      dispatch({
        type: "session_started",
        sessionId: session.sessionId,
        clientId: state.clientId,
      });

      if (session.workspace) {
        dispatch({
          type: "backend_event",
          event: {
            type: "state_snapshot",
            state: { workspace: session.workspace },
          },
        });
      }
    }

    void boot().catch((error) => {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.clientId, state.sessionId]);

  useEffect(() => {
    if (!state.sessionId || sourceRef.current) {
      return;
    }

    const params = new URLSearchParams({
      session: state.sessionId,
      clientId: state.clientId,
    });

    const sessionId = state.sessionId;
    const scope = JSON.stringify([sessionId, state.clientId, state.sessionReplayKey]);
    if (streamCursorRef.current.scope !== scope) {
      streamCursorRef.current = { scope, id: "", receivedAt: Date.now(), revision: 0 };
    }
    if (streamCursorRef.current.id) params.set("lastEventId", streamCursorRef.current.id);
    streamCursorRef.current.receivedAt = Date.now();
    let active = true;
    const coalescer = createWorkflowEventCoalescer((event) => {
      if (active) dispatch({ type: "backend_event", event, sessionId });
    });
    sourceRef.current = openBackendEvents(params, {
      onEvent: (event) => {
        if (!active) return;
        streamCursorRef.current.receivedAt = Date.now();
        streamCursorRef.current.revision += 1;
        coalescer.push(event);
        if (startupRestoreIdRef.current && (
          (event.type === "history_snapshot" && event.value === startupRestoreIdRef.current)
          || event.type === "error"
        )) {
          coalescer.flush();
          startupRestoreIdRef.current = null;
          dispatch({ type: "finish_history_restore" });
        }
      },
      onCursor: (id) => {
        if (!active) return;
        streamCursorRef.current.id = id;
        streamCursorRef.current.receivedAt = Date.now();
        streamCursorRef.current.revision += 1;
      },
      onError: () => {
        coalescer.flush();
        // EventSource reconnects automatically. Keep the current work state until
        // the backend sends an explicit error/completion event or polling repairs it.
      },
    });

    return () => {
      coalescer.flush();
      active = false;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [dispatch, eventStreamGeneration, state.clientId, state.sessionId, state.sessionReplayKey]);

  useEffect(() => {
    if (!state.sessionId || !state.clientId) {
      return;
    }

    let cancelled = false;
    const sessionId = state.sessionId;

    async function reconcileBusyState() {
      try {
        const revision = streamCursorRef.current.revision;
        const liveSessions = await listLiveSessions({
          clientId: state.clientId,
          workspacePath: state.workspacePath || undefined,
        });
        if (cancelled || revision !== streamCursorRef.current.revision) {
          return;
        }
        const liveSession = liveSessions.sessions.find((item) => item.sessionId === sessionId);
        const cursor = streamCursorRef.current;
        const hasServerCursor = Number.isSafeInteger(liveSession?.latestEventId);
        const behind = hasServerCursor && (!cursor.id || Number(cursor.id) < liveSession!.latestEventId!);
        if (behind) {
          // Also recover half-open streams while the backend is still working.
          // Do not complete a turn until its missing events have been delivered.
          if (Date.now() - cursor.receivedAt >= busySessionPollMs * 2) {
            cursor.receivedAt = Date.now();
            setEventStreamGeneration((value) => value + 1);
          }
          return;
        }
        // An idle HTTP snapshot can precede acceptance of a new question.
        // With cursor support, only the ordered stream completes a turn.
        if (hasServerCursor) return;
        if (state.busy && (!liveSession || liveSession.busy === false)) {
          dispatch({
            type: "backend_event",
            sessionId,
            event: liveSession ? { type: "line_complete" } : {
              type: "error", message: "작업 세션과의 연결이 종료되었습니다. 다시 전송해 주세요.",
            },
          });
          if (liveSession && !hasServerCursor) {
            setEventStreamGeneration((value) => value + 1);
          }
        }
      } catch {
        // Keep the last known state when the status endpoint is unavailable.
      }
    }

    const pollMs = state.busy ? busySessionPollMs : busySessionPollMs * 5;
    let timer = window.setTimeout(async function poll() {
      await reconcileBusyState();
      if (!cancelled) {
        timer = window.setTimeout(poll, pollMs);
      }
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dispatch, state.busy, state.clientId, state.sessionId, state.workspacePath]);
}
