import { useEffect, useRef } from "react";
import { listProjectFiles } from "../api/artifacts";
import { historyPageSize, listHistory } from "../api/history";
import { listLiveSessions } from "../api/session";
import { listWorkspaces } from "../api/workspaces";
import { useAppState } from "../state/app-state";
import type { HistoryItem, LiveSessionItem } from "../types/backend";
import { readRecentData, writeRecentData } from "../utils/recentData";

type WorkspaceData = Awaited<ReturnType<typeof listWorkspaces>>;
type HistoryData = { history: HistoryItem[]; hasMore: boolean; nextOffset: number };
function validWorkspaces(value: unknown): value is WorkspaceData {
  const data = value as WorkspaceData | null;
  return !!data && Array.isArray(data.workspaces)
    && data.workspaces.every((item) => item && typeof item.name === "string" && typeof item.path === "string")
    && !!data.scope && typeof data.scope.root === "string";
}
function validHistory(value: unknown): value is HistoryData {
  const data = value as HistoryData | null;
  return !!data && Array.isArray(data.history)
    && data.history.every((item) => item && typeof item.value === "string" && typeof item.label === "string")
    && typeof data.hasMore === "boolean" && Number.isInteger(data.nextOffset) && data.nextOffset >= 0;
}

const backgroundLiveSessionPollMs = 3000;
const historyPollMs = 7000;

export function mergeLiveSessions(history: HistoryItem[], sessions: LiveSessionItem[], currentSessionId: string | null): HistoryItem[] {
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
    const value = session.savedSessionId || session.sessionId;
    if (!value) {
      continue;
    }
    const matches = mergedHistory.filter((item) => (
      item.value === session.sessionId
      || (session.savedSessionId && item.value === session.savedSessionId)
    ));
    if (matches.length) {
      const preferred = matches.find((item) => item.value === value) || matches[0];
      const liveItemIndex = mergedHistory.indexOf(matches[0]);
      mergedHistory[liveItemIndex] = {
        ...preferred,
        value,
        workspace: preferred.workspace || session.workspace || null,
        live: true,
        liveSessionId: session.sessionId,
        busy: session.busy,
      };
      for (let index = mergedHistory.length - 1; index > liveItemIndex; index -= 1) {
        if (matches.includes(mergedHistory[index])) mergedHistory.splice(index, 1);
      }
      seen.add(value);
      continue;
    }
    if (session.sessionId === currentSessionId) continue;
    const title = String(session.title || "").trim();
    // Saved empty chats are already retained above. Default runtime titles alone
    // are not evidence of an additional conversation missing from saved history.
    if (!session.busy && (!title || title === "새 대화" || title === "MyHarness")) {
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
  const latestState = useRef(state);
  latestState.current = state;
  const currentSessionIdRef = useRef(state.sessionId);
  currentSessionIdRef.current = state.sessionId;
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

    function showWorkspaces(data: WorkspaceData) {
      const current = latestState.current;
      if (JSON.stringify([current.workspaces, current.workspaceScope]) !== JSON.stringify([data.workspaces, data.scope])) {
        dispatch({ type: "set_workspaces", workspaces: data.workspaces, scope: data.scope });
      }
      if (!current.workspaceName) {
        const selected = data.workspaces.find((workspace) => workspace.name === "Default") || data.workspaces[0];
        if (selected) dispatch({ type: "set_workspace", workspace: selected });
      }
    }
    const cached = readRecentData("workspaces", state.clientId, validWorkspaces);
    if (cached && !state.workspaces.length) showWorkspaces(cached);

    async function load() {
      const data = await listWorkspaces();
      if (cancelled) return;
      writeRecentData("workspaces", state.clientId, data);
      showWorkspaces(data);
    }

    void load().catch((error) => {
      if (cancelled) return;
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.clientId]);

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

    const scope = JSON.stringify([state.clientId, state.workspacePath, state.workspaceName]);
    const cached = readRecentData("history", scope, validHistory);
    function showHistory(data: HistoryData) {
      const current = latestState.current;
      if (JSON.stringify([current.history, current.historyHasMore, current.historyNextOffset])
        !== JSON.stringify([data.history, data.hasMore, data.nextOffset])) {
        dispatch({ type: "set_history", ...data });
      } else if (current.historyLoading) {
        dispatch({ type: "set_history_loading", value: false });
      }
    }
    if (cached && !state.history.length) showHistory(cached);
    dispatch({ type: "set_history_loading", value: !cached });
    // History is usable before the optional live-status lookup finishes.
    const liveRequest = (state.clientId
        ? listLiveSessions({
          clientId: state.clientId,
          workspacePath: state.workspacePath || undefined,
        })
        : Promise.resolve({ sessions: [] })).catch(() => ({ sessions: [] }));
    void listHistory({ workspacePath: state.workspacePath, workspaceName: state.workspaceName, limit: historyPageSize, offset: 0 })
      .then(async (data) => {
        const history = Array.isArray(data.options) ? data.options : [];
        const page = { history, hasMore: data.hasMore === true,
          nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : history.length };
        if (!cancelled) {
          writeRecentData("history", scope, page);
          showHistory(page);
        }
        const liveData = await liveRequest;
        if (!cancelled) {
          const liveSessions = Array.isArray(liveData.sessions) ? liveData.sessions : [];
          showHistory({
            history: mergeLiveSessions(history, liveSessions, currentSessionIdRef.current),
            hasMore: data.hasMore === true,
            nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : history.length,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          dispatch({ type: "set_history_loading", value: false });
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
      !state.workspaceName && !state.workspacePath
      || state.historyReadOnly
      || (state.restoringHistory && state.pendingHistoryId)
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    async function refreshHistory() {
      try {
        const data = await listHistory({
          workspacePath: state.workspacePath,
          workspaceName: state.workspaceName,
          limit: historyPageSize,
          offset: 0,
        });
        if (cancelled) return;
        const history = Array.isArray(data.options) ? data.options : [];
        dispatch({
          type: "set_history",
          history,
          hasMore: data.hasMore === true,
          nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : history.length,
        });
      } catch {
        // Keep the current list visible and retry at the next interval.
      } finally {
        if (!cancelled) timer = window.setTimeout(refreshHistory, historyPollMs);
      }
    }

    timer = window.setTimeout(refreshHistory, historyPollMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dispatch, state.historyReadOnly, state.pendingHistoryId, state.restoringHistory, state.workspaceName, state.workspacePath]);

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
