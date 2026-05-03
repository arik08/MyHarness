import { useEffect, useRef } from "react";
import { openBackendEvents } from "../api/events";
import { startSession } from "../api/session";
import { useAppState } from "../state/app-state";
import type { SessionResponse } from "../types/backend";

let pendingSessionStart: Promise<SessionResponse> | null = null;

function startSharedSession(clientId: string) {
  pendingSessionStart ||= startSession({ clientId }).finally(() => {
    pendingSessionStart = null;
  });
  return pendingSessionStart;
}

export function useBackendSession() {
  const { state, dispatch } = useAppState();
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (state.sessionId) {
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

    sourceRef.current = openBackendEvents(params, {
      onEvent: (event) => dispatch({ type: "backend_event", event }),
      onError: () => dispatch({ type: "backend_event", event: { type: "error", message: "이벤트 연결 오류" } }),
    });

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [dispatch, state.clientId, state.sessionId]);
}
