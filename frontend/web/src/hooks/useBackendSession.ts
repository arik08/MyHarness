import { useEffect, useRef } from "react";
import { openBackendEvents } from "../api/events";
import { listLiveSessions, startSession } from "../api/session";
import { useAppState } from "../state/app-state";
import type { SessionResponse } from "../types/backend";
import { loadRuntimePreferences } from "../utils/runtimePreferences";

const activeBackendSessionKey = "myharness:activeBackendSessionId";
const pendingSessionStarts = new Map<string, Promise<SessionResponse>>();
const busySessionPollMs = 3000;

function startSharedSession(clientId: string) {
  const preferences = loadRuntimePreferences();
  const payload = { clientId, ...preferences };
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
      const liveSessions = await listLiveSessions({ clientId: state.clientId });
      const liveSession = liveSessions.sessions.find((item) => item.sessionId === previousSessionId)
        ?? liveSessions.sessions.at(-1);

      if (liveSession) {
        if (cancelled) {
          return;
        }

        dispatch({
          type: "session_started",
          sessionId: liveSession.sessionId,
          clientId: state.clientId,
          busy: liveSession.busy,
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

      const session = await startSharedSession(state.clientId);

      if (cancelled) {
        return;
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
    sourceRef.current = openBackendEvents(params, {
      onEvent: (event) => dispatch({ type: "backend_event", event, sessionId }),
      onError: () => dispatch({ type: "backend_event", event: { type: "error", message: "이벤트 연결 오류" }, sessionId }),
    });

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [dispatch, state.clientId, state.sessionId]);

  useEffect(() => {
    if (!state.busy || !state.sessionId || !state.clientId) {
      return;
    }

    let cancelled = false;
    const sessionId = state.sessionId;

    async function reconcileBusyState() {
      try {
        const liveSessions = await listLiveSessions({
          clientId: state.clientId,
          workspacePath: state.workspacePath || undefined,
        });
        if (cancelled) {
          return;
        }
        const liveSession = liveSessions.sessions.find((item) => item.sessionId === sessionId);
        if (liveSession && liveSession.busy === false) {
          dispatch({
            type: "backend_event",
            sessionId,
            event: { type: "line_complete" },
          });
        }
      } catch {
        // The EventSource path remains authoritative; this poll only repairs missed completion events.
      }
    }

    const timer = window.setInterval(() => {
      void reconcileBusyState();
    }, busySessionPollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dispatch, state.busy, state.clientId, state.sessionId, state.workspacePath]);
}
