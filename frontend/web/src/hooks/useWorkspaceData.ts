import { useEffect } from "react";
import { listProjectFiles } from "../api/artifacts";
import { historyPageSize, listHistory } from "../api/history";
import { listLiveSessions } from "../api/session";
import { listWorkspaces } from "../api/workspaces";
import { useAppState } from "../state/app-state";
import type { HistoryItem, LiveSessionItem } from "../types/backend";

const backgroundLiveSessionPollMs = 3000;

function mergeLiveSessions(history: HistoryItem[], sessions: LiveSessionItem[], currentSessionId: string | null): HistoryItem[] {
  const liveSessionIds = new Set(sessions.map((session) => session.sessionId));
  const mergedHistory = history.flatMap<HistoryItem>((item) => {
    if (
      item.live !== true
      || !item.liveSessionId
      || item.liveSessionId === currentSessionId
      || liveSessionIds.has(item.liveSessionId)
    ) {
      return [{ ...item }];
    }
    if (item.value === item.liveSessionId) {
      return [];
    }
    const { live: _live, liveSessionId: _liveSessionId, busy: _busy, ...savedItem } = item;
    return [savedItem];
  });
  const seen = new Set(mergedHistory.map((item) => item.value).filter(Boolean));
  const liveItems: HistoryItem[] = [];
  for (const session of sessions) {
    if (session.sessionId === currentSessionId) {
      continue;
    }
    const value = session.savedSessionId || session.sessionId;
    if (!value) {
      continue;
    }
    const liveItemIndex = mergedHistory.findIndex((item) => (
      item.liveSessionId === session.sessionId
      || (session.savedSessionId && item.value === session.savedSessionId)
    ));
    if (liveItemIndex >= 0) {
      mergedHistory[liveItemIndex] = {
        ...mergedHistory[liveItemIndex],
        workspace: mergedHistory[liveItemIndex].workspace || session.workspace || null,
        live: true,
        liveSessionId: session.sessionId,
        busy: session.busy,
      };
      seen.add(value);
      continue;
    }
    if (!session.busy && !String(session.title || "").trim()) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    liveItems.push({
      value,
      label: "진행 중인 채팅",
      description: session.title || (session.busy ? "진행 중인 응답" : "열려 있는 세션"),
      workspace: session.workspace || null,
      live: true,
      liveSessionId: session.sessionId,
      busy: session.busy,
    });
  }
  return [...liveItems, ...mergedHistory];
}

export function useWorkspaceData() {
  const { state, dispatch } = useAppState();
  const backgroundBusySessionIds = state.history
    .filter((item) => (
      item.live === true
      && item.busy === true
      && item.liveSessionId
      && item.liveSessionId !== state.sessionId
    ))
    .map((item) => item.liveSessionId)
    .sort()
    .join("|");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const data = await listWorkspaces();
      if (cancelled) return;
      dispatch({ type: "set_workspaces", workspaces: data.workspaces, scope: data.scope });
      if (!state.workspaceName) {
        const selected = data.workspaces.find((workspace) => workspace.name === "Default") || data.workspaces[0];
        if (selected) {
          dispatch({ type: "set_workspace", workspace: selected });
        }
      }
    }

    void load().catch((error) => {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.workspaceName]);

  useEffect(() => {
    let cancelled = false;
    if (!state.workspaceName && !state.workspacePath) {
      dispatch({ type: "set_history_loading", value: false });
      return () => {
        cancelled = true;
      };
    }
    if ((state.historyReadOnly && state.history.length > 0) || (state.restoringHistory && state.pendingHistoryId)) {
      dispatch({ type: "set_history_loading", value: false });
      return () => {
        cancelled = true;
      };
    }

    dispatch({ type: "set_history_loading", value: true });
    void Promise.all([
      listHistory({ workspacePath: state.workspacePath, workspaceName: state.workspaceName, limit: historyPageSize, offset: 0 }),
      state.clientId
        ? listLiveSessions({
          clientId: state.clientId,
          workspacePath: state.workspacePath || undefined,
        })
        : Promise.resolve({ sessions: [] }),
    ])
      .then(([data, liveData]) => {
        if (!cancelled) {
          const history = Array.isArray(data.options) ? data.options : [];
          const liveSessions = Array.isArray(liveData.sessions) ? liveData.sessions : [];
          dispatch({
            type: "set_history",
            history: mergeLiveSessions(history, liveSessions, state.sessionId),
            hasMore: data.hasMore === true,
            nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : history.length,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          dispatch({ type: "set_history", history: [], hasMore: false, nextOffset: 0 });
          dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    dispatch,
    state.clientId,
    state.historyReadOnly,
    state.historyRefreshKey,
    state.pendingHistoryId,
    state.restoringHistory,
    state.workspaceName,
    state.workspacePath,
  ]);

  useEffect(() => {
    if (
      !backgroundBusySessionIds
      || !state.clientId
      || state.historyReadOnly
      || (state.restoringHistory && state.pendingHistoryId)
    ) {
      return;
    }

    let cancelled = false;

    async function refreshBackgroundSessions() {
      try {
        const data = await listLiveSessions({
          clientId: state.clientId,
          workspacePath: state.workspacePath || undefined,
        });
        if (cancelled) return;
        dispatch({
          type: "set_history",
          history: mergeLiveSessions(
            state.history,
            Array.isArray(data.sessions) ? data.sessions : [],
            state.sessionId,
          ),
          hasMore: state.historyHasMore,
          nextOffset: state.historyNextOffset,
        });
      } catch {
        // The active chat event stream remains authoritative. Retry background status later.
      }
    }

    let timer = window.setTimeout(async function poll() {
      await refreshBackgroundSessions();
      if (!cancelled) {
        timer = window.setTimeout(poll, backgroundLiveSessionPollMs);
      }
    }, backgroundLiveSessionPollMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    backgroundBusySessionIds,
    dispatch,
    state.clientId,
    state.history,
    state.historyHasMore,
    state.historyNextOffset,
    state.historyReadOnly,
    state.pendingHistoryId,
    state.restoringHistory,
    state.sessionId,
    state.workspacePath,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!state.clientId || (!state.sessionId && !state.workspacePath && !state.workspaceName)) {
      return () => {
        cancelled = true;
      };
    }

    const request = listProjectFiles({
      sessionId: state.sessionId || undefined,
      clientId: state.clientId,
      workspacePath: state.workspacePath,
      workspaceName: state.workspaceName,
    });

    void request
      .then((data) => {
        if (!cancelled) {
          dispatch({ type: "set_artifacts", artifacts: Array.isArray(data.files) ? data.files : [] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: "set_artifacts", artifacts: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.artifactRefreshKey, state.clientId, state.sessionId, state.workspaceName, state.workspacePath]);
}
