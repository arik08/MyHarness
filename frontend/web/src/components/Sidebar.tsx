import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import { useAppState } from "../state/app-state";
import { deleteHistory, hideHistory, historyPageSize, listHistory, loadHistorySnapshot, moveHistory, restoreHistory, toggleHistoryLike, toggleHistoryPin, updateHistoryTitle } from "../api/history";
import { isUnknownSessionError } from "../api/http";
import { listLiveSessions, restartSession, shutdownSession, startSession } from "../api/session";
import { sendBackendRequest, sendMessage } from "../api/messages";
import { currentConversationHistoryTitle, currentConversationTitle, isConversationResponseVisiblyBusy, isResponseVisiblyBusy } from "../state/selectors";
import type { HistoryItem, Workspace } from "../types/backend";
import { ModelAvailabilityMenu } from "./ModelAvailabilityMenu";
import type { ThemeId } from "../types/ui";
import { clampSidebarWidth, sidebarDefaultWidthPx } from "../layout/sidebarLayout";
import { frontendHelpText } from "../utils/helpText";
import { historyVisibilityKey, isHistoryItemHidden, isLiveOnlyHistoryItem, uniqueHistoryItems } from "../utils/history";
import { runtimePreferencesFromState } from "../utils/runtimePreferences";
import { writeLocalStorage } from "../utils/storage";

const themeOptions: Array<{ id: ThemeId; label: string }> = [
  { id: "light", label: "Light" },
  { id: "claude", label: "Claude" },
  { id: "dark", label: "Dark-Blue" },
  { id: "mono", label: "MonoChrome-Green" },
  { id: "mono-orange", label: "MonoChrome-Orange" },
];

const historyTitleMaxLength = 26;
const historyPreviewHeadStartMs = 500;
const historyRestoreSpinnerDelayMs = 300;
const historyTitleCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
const sidebarMinWidth = sidebarDefaultWidthPx;

type HistoryMenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
};

function HistoryPinIcon({ className }: { className?: string }) {
  const classes = ["history-pin-icon", className].filter(Boolean).join(" ");
  return (
    <svg className={classes} aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10.1221 3.13715C10.7326 1.91616 12.3599 1.65208 13.3251 2.61737L17.382 6.67419C18.3472 7.63947 18.0832 9.26676 16.8622 9.87726L13.4037 11.6065C13.0751 11.7708 12.8183 12.0499 12.6818 12.391L11.2459 15.981C10.9792 16.6476 10.1179 16.8244 9.61027 16.3167L7 13.7064L3.70711 16.9993H3V16.2922L6.29289 12.9993L3.68262 10.3891C3.17498 9.88142 3.35177 9.02011 4.01834 8.75348L7.60829 7.3175C7.94939 7.18106 8.22855 6.92419 8.39285 6.5956L10.1221 3.13715ZM12.618 3.32447C12.1354 2.84183 11.3217 2.97387 11.0165 3.58437L9.28727 7.04282C9.01345 7.59046 8.54818 8.01858 7.97968 8.24598L4.38973 9.68196L10.3174 15.6096L11.7534 12.0197C11.9808 11.4512 12.4089 10.9859 12.9565 10.7121L16.415 8.98283C17.0255 8.67758 17.1575 7.86394 16.6749 7.3813L12.618 3.32447Z" />
    </svg>
  );
}

function HistoryListChecksIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M13 5h8" />
      <path d="M13 12h8" />
      <path d="M13 19h8" />
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
    </svg>
  );
}

function createSavedSessionId() {
  const randomUuid = globalThis.crypto?.randomUUID?.().replace(/-/g, "").toLowerCase();
  if (randomUuid && randomUuid.length >= 12) {
    return randomUuid.slice(0, 12);
  }
  const bytes = new Uint8Array(6);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 12).padEnd(12, "0");
}

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const runtimeFooterRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [editingHistoryId, setEditingHistoryId] = useState("");
  const [editingHistoryTitle, setEditingHistoryTitle] = useState("");
  const [deletingHistoryId, setDeletingHistoryId] = useState("");
  const [historyMenuId, setHistoryMenuId] = useState("");
  const [historyMenuPosition, setHistoryMenuPosition] = useState<HistoryMenuPosition | null>(null);
  const [historyMoveMenuOpen, setHistoryMoveMenuOpen] = useState(false);
  const [historyDeleteArmedId, setHistoryDeleteArmedId] = useState("");
  const [historyActionBusyId, setHistoryActionBusyId] = useState("");
  const [historyBulkMode, setHistoryBulkMode] = useState(false);
  const [historyBulkIds, setHistoryBulkIds] = useState<Set<string>>(new Set());
  const [historyBulkMoveOpen, setHistoryBulkMoveOpen] = useState(false);
  const [historyBulkDeleteArmed, setHistoryBulkDeleteArmed] = useState(false);
  const [historyBulkBusy, setHistoryBulkBusy] = useState(false);
  const historyBulkDragRef = useRef<{ pointerId: number; selecting: boolean; visitedIds: Set<string> } | null>(null);
  const historyBulkSuppressClickRef = useRef(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historySearchResults, setHistorySearchResults] = useState<HistoryItem[]>([]);
  const [historySearchLoading, setHistorySearchLoading] = useState(false);
  const [historySearchHasMore, setHistorySearchHasMore] = useState(false);
  const [historySearchNextOffset, setHistorySearchNextOffset] = useState(0);
  const [likedHistoryOnly, setLikedHistoryOnly] = useState(false);
  const [optimisticallyHiddenHistoryIds, setOptimisticallyHiddenHistoryIds] = useState<Set<string>>(new Set());
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const historyRestoreRequestRef = useRef<object | null>(null);
  const [visibleRestoreSpinnerId, setVisibleRestoreSpinnerId] = useState("");
  useEffect(() => {
    setVisibleRestoreSpinnerId("");
    const pendingHistoryId = state.pendingHistoryId;
    if (!pendingHistoryId) return;
    const timer = window.setTimeout(() => {
      setVisibleRestoreSpinnerId(pendingHistoryId);
    }, historyRestoreSpinnerDelayMs);
    return () => window.clearTimeout(timer);
  }, [state.pendingHistoryId]);
  const newChatInFlightRef = useRef(false);
  const historyScope = `${state.workspacePath}\u0000${state.workspaceName}`;
  const historyScopeRef = useRef(historyScope);
  const previousHistoryScopeRef = useRef(historyScope);
  const historyOrderRef = useRef<{ scope: string; ids: string[] }>({ scope: historyScope, ids: [] });
  const historyLoadingMoreRequestRef = useRef<object | null>(null);
  const historySearchRequestRef = useRef<object | null>(null);
  historyScopeRef.current = historyScope;


  useEffect(() => {
    if (previousHistoryScopeRef.current === historyScope) {
      return;
    }
    previousHistoryScopeRef.current = historyScope;
    historyLoadingMoreRequestRef.current = null;
    historySearchRequestRef.current = null;
    dispatch({ type: "set_history_loading_more", value: false });
    setHistorySearchResults([]);
    setHistorySearchLoading(false);
    setHistorySearchHasMore(false);
    setHistorySearchNextOffset(0);
    setHistoryBulkMode(false);
    setHistoryBulkIds(new Set());
    setHistoryBulkMoveOpen(false);
    setOptimisticallyHiddenHistoryIds(new Set());
    closeHistoryMenu();
  }, [dispatch, historyScope]);

  useEffect(() => {
    if (!historyMenuId && !historyBulkMoveOpen) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".history-options-menu, .history-more, .history-bulk-actions")) return;
      closeHistoryMenu();
      setHistoryBulkMoveOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeHistoryMenu();
      setHistoryBulkMoveOpen(false);
    };
    const closeOnResize = () => closeHistoryMenu();
    const closeOnScroll = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".history-options-menu")) return;
      closeHistoryMenu();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [historyBulkMoveOpen, historyMenuId]);

  useEffect(() => {
    if (!historyBulkMode) {
      historyBulkDragRef.current = null;
      historyBulkSuppressClickRef.current = false;
      return undefined;
    }
    const finishHistoryBulkDrag = () => {
      historyBulkDragRef.current = null;
      window.setTimeout(() => {
        historyBulkSuppressClickRef.current = false;
      }, 0);
    };
    window.addEventListener("pointerup", finishHistoryBulkDrag);
    window.addEventListener("pointercancel", finishHistoryBulkDrag);
    return () => {
      window.removeEventListener("pointerup", finishHistoryBulkDrag);
      window.removeEventListener("pointercancel", finishHistoryBulkDrag);
    };
  }, [historyBulkMode]);

  async function startFreshChat(workspace?: Workspace) {
    if (newChatInFlightRef.current) return;
    if (!workspace) {
      setLikedHistoryOnly(false);
      setHistorySearchQuery("");
      historySearchRequestRef.current = null;
      const unusedChat = sortedRenderedHistory.slice(0, 1).find((item) => {
        if (item.messageCount !== 0 || item.busy || item.hidden || optimisticallyHiddenHistoryIds.has(item.value)) return false;
        if (item.workspace?.path && item.workspace.path !== state.workspacePath) return false;
        if (item.value === (state.activeHistoryId || state.sessionId)
          && (state.busy || state.messages.some((message) => message.role === "user"))) return false;
        return !Object.values(state.liveSessionViewsBySessionId).some((view) => (
          view.activeHistoryId === item.value && view.messages.some((message) => message.role === "user")
        ));
      });
      if (unusedChat) {
        await openHistory(unusedChat);
        return;
      }
    }
    newChatInFlightRef.current = true;
    try {
      await createFreshChat(workspace);
    } finally {
      newChatInFlightRef.current = false;
    }
  }

  async function createFreshChat(workspace?: Workspace) {
    const creationRequest = {};
    historyRestoreRequestRef.current = creationRequest;
    const nextWorkspace = workspace || (state.workspacePath ? { name: state.workspaceName, path: state.workspacePath } : undefined);
    const nextSessionId = createSavedSessionId();
    setLikedHistoryOnly(false);
    setHistorySearchQuery("");
    historySearchRequestRef.current = null;
    dispatch({ type: "add_new_chat_history", sessionId: nextSessionId, workspace: nextWorkspace });
    const finishNewSession = async (session: Awaited<ReturnType<typeof startSession>>) => {
      await sendBackendRequest(session.sessionId, state.clientId, {
        type: "start_new_session",
        value: nextSessionId,
      });
      if (historyRestoreRequestRef.current !== creationRequest) return;
      dispatch({
        type: "session_replaced",
        sessionId: session.sessionId,
        savedSessionId: nextSessionId,
        workspace: session.workspace || nextWorkspace,
      });
    };
    if (!workspace && state.sessionId && !state.busy && !state.historyReadOnly && !state.restoringHistory) {
      window.dispatchEvent(new Event("myharness:saveMessageScroll"));
      dispatch({ type: "begin_new_chat", sessionId: nextSessionId });
      try {
        await sendBackendRequest(state.sessionId, state.clientId, {
          type: "start_new_session",
          value: nextSessionId,
        });
      } catch (error) {
        if (isUnknownSessionError(error)) {
          try {
            const session = await startSession({
              clientId: state.clientId,
              cwd: nextWorkspace?.path || undefined,
              ...runtimePreferencesFromState(state),
            });
            await finishNewSession(session);
            return;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        dispatch({
          type: "open_modal",
          modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }
    try {
      if (state.busy || !state.sessionId || state.historyReadOnly || state.restoringHistory) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: nextWorkspace?.path || undefined,
          ...runtimePreferencesFromState(state),
        });
        await finishNewSession(session);
        return;
      }
      const session = await restartSession({
        sessionId: state.sessionId,
        clientId: state.clientId,
        cwd: nextWorkspace?.path || undefined,
        ...runtimePreferencesFromState(state),
      });
      await finishNewSession(session);
    } catch (error) {
      if (isUnknownSessionError(error)) {
        try {
          const session = await startSession({
            clientId: state.clientId,
            cwd: nextWorkspace?.path || undefined,
            ...runtimePreferencesFromState(state),
          });
          await finishNewSession(session);
          return;
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function restartActiveSession() {
    historyRestoreRequestRef.current = null;
    const nextWorkspace = state.workspacePath ? { name: state.workspaceName, path: state.workspacePath } : undefined;
    try {
      if (!state.sessionId) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: nextWorkspace?.path || undefined,
          ...runtimePreferencesFromState(state),
        });
        dispatch({ type: "session_replaced", sessionId: session.sessionId, workspace: session.workspace || nextWorkspace });
        return;
      }
      const session = await restartSession({
        sessionId: state.sessionId,
        clientId: state.clientId,
        cwd: nextWorkspace?.path || undefined,
        ...runtimePreferencesFromState(state),
      });
      dispatch({ type: "session_replaced", sessionId: session.sessionId, workspace: session.workspace || nextWorkspace });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function switchWorkspace(path: string) {
    const workspace = state.workspaces.find((item) => item.path === path);
    if (!workspace) return;
    dispatch({ type: "set_workspace", workspace });
    writeLocalStorage("myharness:workspaceName", workspace.name);
    setWorkspaceDropdownOpen(false);
    await startFreshChat(workspace);
  }

  async function openHistory(item: HistoryItem) {
    const nextHistoryId = String(item.value || "").trim();
    if (!state.sessionId || !nextHistoryId) {
      return;
    }
    closeHistoryMenu();
    const activeHistoryId = state.activeHistoryId || state.sessionId;
    if (nextHistoryId === state.pendingHistoryId || (!state.pendingHistoryId && nextHistoryId === activeHistoryId)) {
      return;
    }
    window.dispatchEvent(new Event("myharness:saveMessageScroll"));
    const restoreRequest = {};
    historyRestoreRequestRef.current = restoreRequest;
    const isCurrentRequest = () => historyRestoreRequestRef.current === restoreRequest;
    let acceptPreview = true;
    dispatch({ type: "begin_history_restore", sessionId: nextHistoryId });
    const previewRequest = loadHistorySnapshot({
      sessionId: nextHistoryId,
      workspacePath: item.workspace?.path || state.workspacePath || undefined,
      workspaceName: item.workspace?.name || state.workspaceName || undefined,
    }).then((event) => {
      if (isCurrentRequest() && acceptPreview) {
        dispatch({ type: "backend_event", event });
        dispatch({ type: "finish_history_restore" });
      }
      return true;
    }).catch(() => {
      // The backend resume path below remains authoritative and reports failures.
      return false;
    });
    const previewLoaded = await Promise.race([
      previewRequest,
      new Promise<false>((resolve) => window.setTimeout(() => resolve(false), historyPreviewHeadStartMs)),
    ]);
    if (!isCurrentRequest()) return;
    try {
      let targetSessionId = state.sessionId;
      const findLiveSession = (sessions: Awaited<ReturnType<typeof listLiveSessions>>["sessions"]) => (
        sessions.find((session) => (
          session.savedSessionId === nextHistoryId
          || session.sessionId === nextHistoryId
        ))
      );
      const liveSessions = await listLiveSessions({
        clientId: state.clientId,
        workspacePath: state.workspacePath || undefined,
      });
      if (!isCurrentRequest()) return;
      let liveSession = findLiveSession(liveSessions.sessions);
      if (!liveSession && state.workspacePath) {
        const allLiveSessions = await listLiveSessions({ clientId: state.clientId });
        if (!isCurrentRequest()) return;
        liveSession = findLiveSession(allLiveSessions.sessions);
      }
      if (liveSession) {
        acceptPreview = false;
        dispatch({
          type: "session_started",
          sessionId: liveSession.sessionId,
          clientId: state.clientId,
          busy: liveSession.busy,
          replay: true,
          savedSessionId: liveSession.savedSessionId,
        });
        if (liveSession.workspace) {
          dispatch({ type: "set_workspace", workspace: liveSession.workspace });
        }
        dispatch({ type: "finish_history_restore" });
        return;
      }
      if (previewLoaded) return;
      acceptPreview = false;
      if (state.busy) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: state.workspacePath || undefined,
          ...runtimePreferencesFromState(state),
        });
        if (!isCurrentRequest()) return;
        targetSessionId = session.sessionId;
        dispatch({
          type: "session_started",
          sessionId: session.sessionId,
          clientId: state.clientId,
        });
        if (session.workspace) {
          dispatch({ type: "set_workspace", workspace: session.workspace });
        }
      }
      await sendBackendRequest(targetSessionId, state.clientId, {
        type: "apply_select_command",
        command: "resume",
        value: nextHistoryId,
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (isUnknownSessionError(error)) {
        try {
          const session = await startSession({
            clientId: state.clientId,
            cwd: state.workspacePath || undefined,
            ...runtimePreferencesFromState(state),
          });
          if (!isCurrentRequest()) return;
          dispatch({
            type: "session_started",
            sessionId: session.sessionId,
            clientId: state.clientId,
          });
          if (session.workspace) {
            dispatch({ type: "set_workspace", workspace: session.workspace });
          }
          await sendBackendRequest(session.sessionId, state.clientId, {
            type: "apply_select_command",
            command: "resume",
            value: nextHistoryId,
          });
          return;
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      dispatch({ type: "set_busy", value: false });
      dispatch({ type: "finish_history_restore" });
    }
  }

  function preloadHistory(item: HistoryItem) {
    if (isLiveOnlyHistoryItem(item)) return;
    void loadHistorySnapshot({
      sessionId: item.value,
      workspacePath: item.workspace?.path || state.workspacePath || undefined,
      workspaceName: item.workspace?.name || state.workspaceName || undefined,
    }).catch(() => {
      // Selection still has the authoritative backend restore path.
    });
  }

  async function removeHistory(item: HistoryItem): Promise<boolean> {
    const sessionId = item.value;
    if (!sessionId) return false;
    const shouldOptimisticallyHide = !state.adminMode && !item.live;
    if (shouldOptimisticallyHide) {
      setOptimisticallyHiddenHistoryIds((current) => new Set(current).add(sessionId));
    }
    closeHistoryMenu();
    setDeletingHistoryId(sessionId);
    try {
      const workspace = item.workspace || null;
      const workspacePath = workspace?.path || state.workspacePath;
      const workspaceName = workspace?.name || state.workspaceName;
      if (item.live && item.liveSessionId) {
        await shutdownSession(item.liveSessionId, state.clientId);
        dispatch({ type: "delete_history_local", sessionId, workspacePath, workspaceName });
      } else if (item.pending && state.sessionId) {
        if (state.adminMode) {
          await sendBackendRequest(state.sessionId, state.clientId, {
            type: "delete_session",
            value: sessionId,
          });
          dispatch({ type: "delete_history_local", sessionId, workspacePath, workspaceName });
        } else {
          await hideHistory(sessionId, workspacePath, workspaceName);
          dispatch({ type: "hide_history_local", sessionId, workspacePath, workspaceName });
        }
      } else if (state.adminMode) {
        await deleteHistory(sessionId, workspacePath, workspaceName);
        dispatch({ type: "delete_history_local", sessionId, workspacePath, workspaceName });
      } else {
        await hideHistory(sessionId, workspacePath, workspaceName);
        dispatch({ type: "hide_history_local", sessionId, workspacePath, workspaceName });
      }
      setHistorySearchResults((current) => current.filter((historyItem) => historyItem.value !== sessionId));
      return true;
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      return false;
    } finally {
      if (shouldOptimisticallyHide) {
        setOptimisticallyHiddenHistoryIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
      setDeletingHistoryId("");
    }
  }

  async function pinHistory(item: HistoryItem) {
    const sessionId = item.value;
    if (!sessionId || isLiveOnlyHistoryItem(item)) return;
    const nextPinned = item.pinned !== true;
    const workspace = item.workspace || null;
    try {
      const data = await toggleHistoryPin(
        sessionId,
        nextPinned,
        workspace?.path || state.workspacePath,
        workspace?.name || state.workspaceName,
      );
      dispatch({
        type: "set_history",
        history: state.history.map((historyItem) =>
          historyItem.value === sessionId ? { ...historyItem, pinned: data.pinned } : historyItem,
        ),
      });
      setHistorySearchResults((current) => current.map((historyItem) =>
        historyItem.value === sessionId ? { ...historyItem, pinned: data.pinned } : historyItem,
      ));
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function restoreHiddenHistory(item: HistoryItem) {
    if (!state.adminMode || !item.value) return;
    const workspace = item.workspace || null;
    const workspacePath = workspace?.path || state.workspacePath;
    const workspaceName = workspace?.name || state.workspaceName;
    setHistoryActionBusyId(item.value);
    try {
      await restoreHistory(item.value, workspacePath, workspaceName);
      dispatch({ type: "restore_history_local", sessionId: item.value, workspacePath, workspaceName });
      setHistorySearchResults((current) => current.map((historyItem) =>
        historyItem.value === item.value ? { ...historyItem, hidden: false } : historyItem,
      ));
      closeHistoryMenu();
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setHistoryActionBusyId("");
    }
  }

  async function moveHistoryToWorkspace(item: HistoryItem, targetWorkspace: Workspace): Promise<boolean> {
    const sourceWorkspace = item.workspace || {
      name: state.workspaceName,
      path: state.workspacePath,
    };
    if (!item.value || !sourceWorkspace.path || sourceWorkspace.path === targetWorkspace.path) return false;
    setHistoryActionBusyId(item.value);
    try {
      await moveHistory(
        item.value,
        sourceWorkspace.path,
        sourceWorkspace.name,
        targetWorkspace.path,
        targetWorkspace.name,
      );
      dispatch({
        type: "delete_history_local",
        sessionId: item.value,
        workspacePath: sourceWorkspace.path,
        workspaceName: sourceWorkspace.name,
      });
      setHistorySearchResults((current) => current.filter((historyItem) => historyItem.value !== item.value));
      return true;
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      return false;
    } finally {
      setHistoryActionBusyId("");
    }
  }

  async function likeHistory(item: HistoryItem) {
    const sessionId = item.value;
    if (!sessionId || item.pending || isLiveOnlyHistoryItem(item)) return;
    const nextLiked = item.liked !== true;
    const workspace = item.workspace || null;
    try {
      const data = await toggleHistoryLike(
        sessionId,
        nextLiked,
        workspace?.path || state.workspacePath,
        workspace?.name || state.workspaceName,
      );
      dispatch({
        type: "set_history",
        history: state.history.map((historyItem) =>
          historyItem.value === sessionId ? { ...historyItem, liked: data.liked } : historyItem,
        ),
      });
      setHistorySearchResults((current) => current.map((historyItem) =>
        historyItem.value === sessionId ? { ...historyItem, liked: data.liked } : historyItem,
      ));
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function renameHistory(sessionId: string) {
    const title = editingHistoryTitle.trim();
    if (!sessionId || !title) {
      setEditingHistoryId("");
      setEditingHistoryTitle("");
      return;
    }
    try {
      const data = await updateHistoryTitle(sessionId, title, state.workspacePath, state.workspaceName);
      dispatch({
        type: "set_history",
        history: state.history.map((item) =>
          item.value === sessionId ? { ...item, description: data.title || title } : item,
        ),
      });
      setHistorySearchResults((current) => current.map((item) =>
        item.value === sessionId ? { ...item, description: data.title || title } : item,
      ));
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setEditingHistoryId("");
      setEditingHistoryTitle("");
    }
  }

  async function loadMoreHistory() {
    if (likedHistoryOnly) return;
    if (!state.historyHasMore || state.historyLoading || state.historyLoadingMore || historyLoadingMoreRequestRef.current) {
      return;
    }
    const request = {};
    const requestScope = historyScope;
    historyLoadingMoreRequestRef.current = request;
    dispatch({ type: "set_history_loading_more", value: true });
    try {
      const data = await listHistory({
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        limit: historyPageSize,
        offset: state.historyNextOffset,
      });
      if (historyLoadingMoreRequestRef.current !== request || historyScopeRef.current !== requestScope) {
        return;
      }
      const history = Array.isArray(data.options) ? data.options : [];
      historyLoadingMoreRequestRef.current = null;
      dispatch({
        type: "append_history",
        history,
        hasMore: data.hasMore === true,
        nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : state.historyNextOffset + history.length,
      });
    } catch (error) {
      if (historyLoadingMoreRequestRef.current !== request || historyScopeRef.current !== requestScope) {
        return;
      }
      historyLoadingMoreRequestRef.current = null;
      dispatch({ type: "set_history_loading_more", value: false });
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (historyLoadingMoreRequestRef.current === request) {
        historyLoadingMoreRequestRef.current = null;
        dispatch({ type: "set_history_loading_more", value: false });
      }
    }
  }

  async function loadMoreHistorySearch() {
    if (likedHistoryOnly) return;
    if (!historySearch || !historySearchHasMore || historySearchLoading || historySearchRequestRef.current) {
      return;
    }
    const request = {};
    const requestScope = historyScope;
    const requestSearch = historySearch;
    historySearchRequestRef.current = request;
    setHistorySearchLoading(true);
    try {
      const data = await listHistory({
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        limit: historyPageSize,
        offset: historySearchNextOffset,
        search: requestSearch,
      });
      if (historySearchRequestRef.current !== request || historyScopeRef.current !== requestScope) {
        return;
      }
      const history = Array.isArray(data.options) ? data.options : [];
      setHistorySearchResults((current) => appendUniqueHistoryItems(current, history));
      setHistorySearchHasMore(data.hasMore === true);
      setHistorySearchNextOffset(
        typeof data.nextOffset === "number" ? data.nextOffset : historySearchNextOffset + history.length,
      );
    } catch (error) {
      if (historySearchRequestRef.current !== request || historyScopeRef.current !== requestScope) {
        return;
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (historySearchRequestRef.current === request) {
        historySearchRequestRef.current = null;
        setHistorySearchLoading(false);
      }
    }
  }

  function handleHistoryScroll(event: ReactUIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceToBottom <= 24) {
      void (historySearch ? loadMoreHistorySearch() : loadMoreHistory());
    }
  }

  function startHistoryRename(sessionId: string, title: string) {
    closeHistoryMenu();
    setEditingHistoryId(sessionId);
    setEditingHistoryTitle(title);
  }

  function closeHistoryMenu() {
    setHistoryMenuId("");
    setHistoryMenuPosition(null);
    setHistoryMoveMenuOpen(false);
    setHistoryDeleteArmedId("");
  }

  function openHistoryMenu(sessionId: string, trigger: HTMLButtonElement) {
    if (historyMenuId === sessionId) {
      closeHistoryMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 208;
    const viewportMargin = 8;
    const opensAbove = window.innerHeight - rect.bottom < 250 && rect.top > window.innerHeight - rect.bottom;
    setHistoryMenuPosition({
      left: Math.max(viewportMargin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportMargin)),
      ...(opensAbove
        ? { bottom: Math.max(viewportMargin, window.innerHeight - rect.top + 1) }
        : { top: Math.min(rect.bottom + 1, window.innerHeight - viewportMargin) }),
    });
    setHistoryMoveMenuOpen(false);
    setHistoryDeleteArmedId("");
    setHistoryMenuId(sessionId);
  }

  function finishHistoryBulk(succeededIds: string[]) {
    const succeeded = new Set(succeededIds);
    const remaining = new Set([...historyBulkIds].filter((id) => !succeeded.has(id)));
    setHistoryBulkIds(remaining);
    if (remaining.size === 0) {
      setHistoryBulkMode(false);
      setHistoryBulkMoveOpen(false);
    }
  }

  function setHistoryBulkSelection(sessionId: string, selecting: boolean) {
    setHistoryBulkDeleteArmed(false);
    setHistoryBulkIds((current) => {
      if (current.has(sessionId) === selecting) return current;
      const next = new Set(current);
      if (selecting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function startHistoryBulkDrag(event: ReactPointerEvent<HTMLButtonElement>, sessionId: string, selected: boolean) {
    if (event.button !== 0 || event.pointerType === "touch" || event.currentTarget.disabled) return;
    historyBulkSuppressClickRef.current = true;
    historyBulkDragRef.current = {
      pointerId: event.pointerId,
      selecting: !selected,
      visitedIds: new Set([sessionId]),
    };
    setHistoryBulkSelection(sessionId, !selected);
  }

  function continueHistoryBulkDrag(event: ReactPointerEvent<HTMLButtonElement>, sessionId: string) {
    const drag = historyBulkDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !(event.buttons & 1) || event.currentTarget.disabled) return;
    if (drag.visitedIds.has(sessionId)) return;
    drag.visitedIds.add(sessionId);
    setHistoryBulkSelection(sessionId, drag.selecting);
  }

  async function moveSelectedHistory(targetWorkspace: Workspace) {
    if (historyBulkBusy || historyBulkIds.size === 0 || !historyBulkCanMove) return;
    setHistoryBulkBusy(true);
    const succeeded: string[] = [];
    try {
      for (const item of filteredRenderedHistory) {
        if (historyBulkIds.has(item.value) && await moveHistoryToWorkspace(item, targetWorkspace)) {
          succeeded.push(item.value);
        }
      }
      finishHistoryBulk(succeeded);
    } finally {
      setHistoryBulkBusy(false);
      setHistoryBulkMoveOpen(false);
    }
  }

  async function deleteSelectedHistory() {
    if (historyBulkBusy || historyBulkIds.size === 0) return;
    if (!historyBulkDeleteArmed) {
      setHistoryBulkDeleteArmed(true);
      return;
    }
    setHistoryBulkBusy(true);
    const succeeded: string[] = [];
    try {
      for (const item of filteredRenderedHistory) {
        if (historyBulkIds.has(item.value) && await removeHistory(item)) {
          succeeded.push(item.value);
        }
      }
      finishHistoryBulk(succeeded);
    } finally {
      setHistoryBulkBusy(false);
      setHistoryBulkDeleteArmed(false);
    }
  }

  function cycleTheme() {
    const currentIndex = Math.max(0, themeOptions.findIndex((item) => item.id === state.themeId));
    const next = themeOptions[(currentIndex + 1) % themeOptions.length];
    dispatch({ type: "set_theme", themeId: next.id });
  }

  async function runCommand(command: string) {
    if (/^\/help(?:\s|$)/i.test(command.trim())) {
      dispatch({
        type: "open_modal",
        modal: {
          kind: "backend",
          payload: {
            kind: "command_help",
            title: "명령어",
            text: frontendHelpText(state),
          },
        },
      });
      return;
    }
    if (!state.sessionId) return;
    dispatch({ type: "set_busy", value: true });
    try {
      await sendMessage({ sessionId: state.sessionId, clientId: state.clientId, line: command, attachments: [] });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
      dispatch({ type: "set_busy", value: false });
    }
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = state.sidebarWidth || sidebarMinWidth;
    dispatch({ type: "set_sidebar_resizing", value: true });
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some test/browser paths do not support pointer capture for this event.
    }
    let finished = false;
    const finishResize = () => {
      if (finished) return;
      finished = true;
      dispatch({ type: "set_sidebar_resizing", value: false });
      try {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Pointer capture may already be gone if the browser canceled the pointer.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("mouseup", finishResize);
      window.removeEventListener("blur", finishResize);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        finishResize();
        return;
      }
      const next = clampSidebarWidth(startWidth + moveEvent.clientX - startX, window.innerWidth);
      dispatch({ type: "set_sidebar_width", value: Math.round(next) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("mouseup", finishResize);
    window.addEventListener("blur", finishResize);
  }

  function toggleRuntimePicker() {
    if (!state.adminMode) return;
    dispatch({ type: state.runtimePicker.open ? "close_runtime_picker" : "open_runtime_picker" });
  }

  useEffect(() => {
    if (!workspaceDropdownOpen) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (target && projectMenuRef.current?.contains(target)) {
        return;
      }
      setWorkspaceDropdownOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setWorkspaceDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspaceDropdownOpen]);

  const currentTheme = themeOptions.find((item) => item.id === state.themeId) || themeOptions[0];
  const sidebarLabel = state.sidebarCollapsed ? "사이드바 열기" : "사이드바 닫기";
  const activeHistoryValue = state.activeHistoryId || state.sessionId || "";
  const activeHistoryHiddenKey = historyVisibilityKey(activeHistoryValue, state.workspacePath, state.workspaceName);
  const activeHistoryDeleted = Boolean(!state.adminMode && activeHistoryHiddenKey && state.hiddenHistoryKeys.includes(activeHistoryHiddenKey));
  const visibleHistory = uniqueHistoryItems(state.history).filter((item) => (
    !isCurrentLiveHistoryItem(item, state.sessionId)
    && !optimisticallyHiddenHistoryIds.has(item.value)
  ));
  const hasActiveHistoryItem = Boolean(activeHistoryValue && visibleHistory.some((item) => isActiveHistoryItem(item, activeHistoryValue, state.sessionId)));
  const conversationTitle = currentConversationTitle(state);
  const activeHistoryDescription = currentConversationHistoryTitle(state);
  const showRuntimePicker = state.adminMode && state.runtimePicker.open && !state.sidebarCollapsed;
  const responseVisiblyBusy = isResponseVisiblyBusy(state);
  // Startup emits an unsaved bootstrap ID before the real conversation ID.
  // An ID alone is not enough to add a row alongside fetched saved history.
  const shouldRenderActiveHistory = Boolean(
    state.pendingFreshChat
    || state.busy
    || activeHistoryDescription,
  );
  const renderedHistory = !state.pendingHistoryId && activeHistoryValue && !activeHistoryDeleted && !hasActiveHistoryItem && shouldRenderActiveHistory
    ? [
        {
          value: activeHistoryValue,
          label: "진행 중",
          description: activeHistoryDescription || (state.busy ? "진행 중인 대화" : "새 대화"),
          workspace: state.workspacePath || state.workspaceName
            ? { name: state.workspaceName, path: state.workspacePath }
            : null,
          live: state.pendingFreshChat ? true : undefined,
          liveSessionId: state.pendingFreshChat ? activeHistoryValue : undefined,
          pending: !activeHistoryDescription && !state.busy,
        },
        ...visibleHistory,
      ]
    : visibleHistory;
  const busySessionIds = new Set(state.history
    .filter((item) => item.live === true && item.busy === true && (
      item.liveSessionId !== state.sessionId || state.busy || state.restoringHistory || state.historyReadOnly
    ))
    .map((item) => item.liveSessionId || item.value));
  if (state.busy && state.sessionId) busySessionIds.add(state.sessionId);
  const historyOrderId = (item: HistoryItem) => item.liveSessionId
    || (isActiveHistoryItem(item, activeHistoryValue, state.sessionId) ? state.sessionId : null)
    || item.value;
  const previousOrder = historyOrderRef.current.scope === historyScope ? historyOrderRef.current.ids : [];
  // Rebuilding the active live row and refreshing history must not move chats
  // under the pointer while the user switches between concurrent responses.
  const stableHistory = busySessionIds.size >= 2
    ? [...renderedHistory].sort((left, right) => (
        previousOrder.indexOf(historyOrderId(left)) - previousOrder.indexOf(historyOrderId(right))
      ))
    : renderedHistory;
  const sortedRenderedHistory = sortPinnedHistory(stableHistory);
  useLayoutEffect(() => {
    const ids = sortedRenderedHistory.map(historyOrderId);
    historyOrderRef.current = {
      scope: historyScope,
      ids: busySessionIds.size >= 2
        ? [...ids.filter((id) => !previousOrder.includes(id)), ...previousOrder]
        : ids,
    };
  });
  const historySearch = historySearchQuery.trim();
  const hasHistorySearch = Boolean(historySearch);
  const historyRequestSearch = likedHistoryOnly ? "" : historySearch;
  const hasHistoryFilter = hasHistorySearch || likedHistoryOnly;
  const titleForHistoryItem = (item: HistoryItem) => {
    const isActive = isActiveHistoryItem(item, activeHistoryValue, state.sessionId);
    return isActive && conversationTitle !== "MyHarness"
      ? activeHistoryDescription
      : item.description || item.label;
  };
  const renderedHistorySource = likedHistoryOnly
    ? sortPinnedHistory(appendUniqueHistoryItems(historySearchResults, sortedRenderedHistory))
    : hasHistorySearch
    ? appendUniqueHistoryItems(sortedRenderedHistory, historySearchResults)
    : sortedRenderedHistory;
  const filteredRenderedHistory = renderedHistorySource.filter((item) => (
    !optimisticallyHiddenHistoryIds.has(item.value)
    && (!likedHistoryOnly || item.liked === true)
    && (!hasHistorySearch || historyTitleMatches(titleForHistoryItem(item), historySearch))
  ));
  const historyMovableItems = filteredRenderedHistory.filter((item) => (
    !item.pending
    && !item.live
    && !item.busy
    && !isLiveOnlyHistoryItem(item)
    && !isActiveHistoryItem(item, activeHistoryValue, state.sessionId)
  ));
  const historyMovableIds = new Set(historyMovableItems.map((item) => item.value));
  const historyBulkCanMove = [...historyBulkIds].every((id) => historyMovableIds.has(id));
  const historyBulkSelectableItems = filteredRenderedHistory.filter((item) => (
    !isCurrentLiveHistoryItem(item, state.sessionId)
    && item.value !== state.pendingHistoryId
    && !(isActiveHistoryItem(item, activeHistoryValue, state.sessionId) && responseVisiblyBusy)
    && !(item.live && item.busy && !isActiveHistoryItem(item, activeHistoryValue, state.sessionId)
      && (item.liveSessionId && state.liveSessionViewsBySessionId[item.liveSessionId]?.messages
        ? isConversationResponseVisiblyBusy(true, state.liveSessionViewsBySessionId[item.liveSessionId].messages)
        : true))
  ));
  const historyBulkSelectableIds = new Set(historyBulkSelectableItems.map((item) => item.value));
  const historyBulkSelectableKey = [...historyBulkSelectableIds].join("\u0000");
  const openHistoryMenuItem = historyMenuId
    ? filteredRenderedHistory.find((item) => item.value === historyMenuId)
    : undefined;
  const openHistoryMenuItemHidden = openHistoryMenuItem
    ? isHistoryItemHidden(openHistoryMenuItem, state.hiddenHistoryKeys, state.workspacePath, state.workspaceName)
    : false;

  useEffect(() => {
    const request = {};
    historySearchRequestRef.current = request;
    setHistorySearchResults([]);
    setHistorySearchHasMore(false);
    setHistorySearchNextOffset(0);
    if (!historyRequestSearch && !likedHistoryOnly) {
      setHistorySearchLoading(false);
      return () => {
        if (historySearchRequestRef.current === request) historySearchRequestRef.current = null;
      };
    }

    setHistorySearchLoading(true);
    const requestScope = historyScope;
    const timeout = window.setTimeout(() => {
      void listHistory({
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        ...(likedHistoryOnly ? { likedOnly: true } : { limit: historyPageSize, offset: 0, search: historyRequestSearch }),
      }).then((data) => {
        if (historySearchRequestRef.current !== request || historyScopeRef.current !== requestScope) return;
        const history = Array.isArray(data.options) ? data.options : [];
        setHistorySearchResults(history);
        setHistorySearchHasMore(data.hasMore === true);
        setHistorySearchNextOffset(typeof data.nextOffset === "number" ? data.nextOffset : history.length);
      }).catch((error) => {
        if (historySearchRequestRef.current !== request || historyScopeRef.current !== requestScope) return;
        dispatch({
          type: "open_modal",
          modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
        });
      }).finally(() => {
        if (historySearchRequestRef.current === request) {
          historySearchRequestRef.current = null;
          setHistorySearchLoading(false);
        }
      });
    }, likedHistoryOnly ? 0 : 250);

    return () => {
      window.clearTimeout(timeout);
      if (historySearchRequestRef.current === request) historySearchRequestRef.current = null;
    };
  }, [dispatch, likedHistoryOnly, historyScope, historyRequestSearch, state.workspaceName, state.workspacePath]);

  useEffect(() => {
    const selectableIds = new Set(historyBulkSelectableKey ? historyBulkSelectableKey.split("\u0000") : []);
    setHistoryBulkIds((current) => {
      const retained = [...current].filter((id) => selectableIds.has(id));
      return retained.length === current.size ? current : new Set(retained);
    });
    if (historyMenuId && !openHistoryMenuItem) closeHistoryMenu();
  }, [historyBulkSelectableKey, historyMenuId, openHistoryMenuItem]);

  useEffect(() => {
    const historyList = historyListRef.current;
    const hasMore = hasHistorySearch ? historySearchHasMore : state.historyHasMore;
    const loading = hasHistorySearch
      ? historySearchLoading || Boolean(historySearchRequestRef.current)
      : state.historyLoading || state.historyLoadingMore || Boolean(historyLoadingMoreRequestRef.current);
    if (
      !historyList
      || historyList.clientHeight <= 0
      || likedHistoryOnly
      || !hasMore
      || loading
    ) {
      return;
    }
    const distanceToBottom = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight;
    if (distanceToBottom <= 24) {
      void (hasHistorySearch ? loadMoreHistorySearch() : loadMoreHistory());
    }
  }, [
    filteredRenderedHistory.length,
    hasHistorySearch,
    historySearch,
    historySearchHasMore,
    historySearchLoading,
    historySearchNextOffset,
    likedHistoryOnly,
    state.historyHasMore,
    state.historyLoading,
    state.historyLoadingMore,
    state.historyNextOffset,
    state.workspaceName,
    state.workspacePath,
  ]);

  return (
    <aside
      className="sidebar"
      aria-label="채팅 탐색"
      onClick={() => {
        if (state.sidebarCollapsed) {
          dispatch({ type: "set_sidebar_collapsed", value: false, source: "manual" });
        }
      }}
    >
      <div className="brand-row">
        <a className="brand" href="#" aria-label="MyHarness 채팅 홈">
          <span className="brand-name">MyHarness</span>
        </a>
        <a
          className="marketplace-command"
          href="http://172.30.86.138:3334"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="스킬 내용 조회"
          data-tooltip="스킬 내용 조회"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M3 9l1.5-5h15L21 9" />
            <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
            <path d="M5 12v8h14v-8" />
            <path d="M9 20v-5h6v5" />
          </svg>
        </a>
        <button className="settings-command" type="button" aria-label="설정" data-tooltip="설정" onClick={() => dispatch({ type: "open_modal", modal: { kind: "settings" } })}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.15 2.15 0 0 1-3.04 3.04l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21.4a2.15 2.15 0 0 1-4.3 0v-.06a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.04.04a2.15 2.15 0 1 1-3.04-3.04l.04-.04A1.8 1.8 0 0 0 3.6 15a1.8 1.8 0 0 0-1.66-1.1H1.9a2.15 2.15 0 0 1 0-4.3h.06A1.8 1.8 0 0 0 3.6 8a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.15 2.15 0 1 1 3.04-3.04l.04.04A1.8 1.8 0 0 0 8.26 3.34 1.8 1.8 0 0 0 9.36 1.68V1.6a2.15 2.15 0 0 1 4.3 0v.06a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.04-.04a2.15 2.15 0 1 1 3.04 3.04l-.04.04A1.8 1.8 0 0 0 19.4 8a1.8 1.8 0 0 0 1.66 1.1h.06a2.15 2.15 0 0 1 0 4.3h-.06A1.8 1.8 0 0 0 19.4 15Z" />
          </svg>
        </button>
        <button
          className="theme-command"
          type="button"
          aria-label={`테마 전환: ${currentTheme.label}`}
          data-tooltip={`테마: ${currentTheme.label}`}
          onClick={cycleTheme}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 3v2.2" />
            <path d="M12 18.8V21" />
            <path d="M4.2 4.2l1.55 1.55" />
            <path d="M18.25 18.25l1.55 1.55" />
            <path d="M3 12h2.2" />
            <path d="M18.8 12H21" />
            <path d="M4.2 19.8l1.55-1.55" />
            <path d="M18.25 5.75l1.55-1.55" />
            <circle cx="12" cy="12" r="4.25" />
          </svg>
        </button>
        <button className="brand-command" type="button" aria-label="명령어" data-tooltip="명령어" onClick={() => void runCommand("/help")}>
          <span className="command-key" aria-hidden="true">/</span>
        </button>
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={sidebarLabel}
          aria-expanded={!state.sidebarCollapsed}
          data-tooltip={sidebarLabel}
          onClick={(event) => {
            event.stopPropagation();
            dispatch({ type: "set_sidebar_collapsed", value: !state.sidebarCollapsed, source: "manual" });
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </div>

      <div className="sidebar-project-menu" ref={projectMenuRef}>
        <button
          className="sidebar-project"
          type="button"
          aria-label="프로젝트 선택"
          aria-expanded={workspaceDropdownOpen}
          data-tooltip="프로젝트 폴더 선택"
          data-tooltip-placement="right"
          onClick={() => setWorkspaceDropdownOpen((value) => !value)}
        >
          <span className="sidebar-project-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2.5h6.5A2.5 2.5 0 0 1 21 9v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z" />
            </svg>
          </span>
          <strong>{state.workspaceName || "Default"}</strong>
          <svg className="sidebar-project-chevron" aria-hidden="true" viewBox="0 0 24 24">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        <div
          className={`sidebar-project-dropdown${workspaceDropdownOpen ? "" : " hidden"}`}
          role="menu"
          aria-label="프로젝트 목록"
        >
          {state.workspaces.length ? state.workspaces.map((workspace) => (
            <button
              className={`sidebar-project-option${workspace.path === state.workspacePath ? " active" : ""}`}
              type="button"
              role="menuitem"
              key={workspace.path}
              onClick={() => void switchWorkspace(workspace.path)}
            >
              {workspace.name}
            </button>
          )) : <p className="sidebar-project-empty">프로젝트 폴더가 없습니다.</p>}
          <button
            className="sidebar-project-manage"
            type="button"
            role="menuitem"
            onClick={() => {
              setWorkspaceDropdownOpen(false);
              dispatch({ type: "open_modal", modal: { kind: "workspace" } });
            }}
          >
            프로젝트 추가/관리
          </button>
        </div>
      </div>

      <button className="new-chat" type="button" aria-label="새 대화" data-tooltip="새 대화" data-tooltip-placement="right" onClick={() => void startFreshChat()}>
        <span aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 3H5.5A2.5 2.5 0 0 0 3 5.5v13A2.5 2.5 0 0 0 5.5 21h13A2.5 2.5 0 0 0 21 18.5V12" />
            <path d="M14.5 5.5 18.5 9.5" />
            <path d="M13 11 19.2 4.8a1.6 1.6 0 0 1 2.3 2.3L15.3 13.3 12 14Z" />
          </svg>
        </span>
        새 대화
      </button>

      <section className="history-panel" aria-label="대화 기록">
        <div className="history-heading">
          <span className="section-label">
            {historyBulkMode ? `${likedHistoryOnly ? "좋아요 · " : ""}${historyBulkIds.size}개 선택` : "대화 기록"}
          </span>
          {historyBulkMode ? (
            <div className="history-bulk-actions">
              <button
                type="button"
                aria-label="선택한 세션 워크스페이스 변경"
                data-tooltip="이동"
                disabled={!historyBulkIds.size || historyBulkBusy || !historyBulkCanMove || state.workspaces.length < 2}
                onClick={() => setHistoryBulkMoveOpen((open) => !open)}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3Z" /><path d="m14 13 2 2 4-4" /></svg>
              </button>
              <button
                className={historyBulkDeleteArmed ? "danger armed" : "danger"}
                type="button"
                aria-label={historyBulkDeleteArmed ? "선택한 세션 삭제 확인, 한 번 더 누르면 삭제" : "선택한 세션 삭제"}
                data-tooltip={historyBulkDeleteArmed ? "삭제 확인" : state.adminMode ? "완전 삭제" : "목록에서 숨김"}
                disabled={!historyBulkIds.size || historyBulkBusy}
                onClick={() => void deleteSelectedHistory()}
              >
                {historyBulkBusy ? <span className="history-action-spinner" aria-hidden="true" /> : (
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    {historyBulkDeleteArmed ? <path d="M12 8v5m0 3h.01M10.3 4.6 3.4 17a2 2 0 0 0 1.75 3h13.7a2 2 0 0 0 1.75-3L13.7 4.6a2 2 0 0 0-3.4 0Z" /> : <><path d="M4 7h16" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>}
                  </svg>
                )}
              </button>
              <button
                type="button"
                aria-label={historyBulkIds.size === historyBulkSelectableItems.length ? "모든 세션 선택 해제" : "모든 세션 선택"}
                data-tooltip={historyBulkIds.size === historyBulkSelectableItems.length ? "선택 해제" : "전체 선택"}
                disabled={!historyBulkSelectableItems.length || historyBulkBusy}
                onClick={() => {
                  setHistoryBulkDeleteArmed(false);
                  setHistoryBulkIds((current) => current.size === historyBulkSelectableItems.length
                    ? new Set()
                    : new Set(historyBulkSelectableItems.map((item) => item.value)));
                }}
              >
                <HistoryListChecksIcon />
              </button>
              <button
                type="button"
                aria-label="세션 관리 닫기"
                data-tooltip="닫기"
                disabled={historyBulkBusy}
                onClick={() => {
                  setHistoryBulkMode(false);
                  setHistoryBulkIds(new Set());
                  setHistoryBulkMoveOpen(false);
                  setHistoryBulkDeleteArmed(false);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
              {historyBulkMoveOpen ? (
                <div className="history-bulk-workspaces" role="menu" aria-label="이동할 워크스페이스">
                  {state.workspaces.filter((workspace) => workspace.path !== state.workspacePath).map((workspace) => (
                    <button type="button" role="menuitem" key={workspace.path} disabled={historyBulkBusy} onClick={() => void moveSelectedHistory(workspace)}>
                      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3Z" /></svg>
                      <span>{workspace.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="history-heading-actions">
              <button
                className={`history-search-toggle${historySearchOpen ? " active" : ""}`}
                type="button"
                aria-label="제목 검색"
                aria-pressed={historySearchOpen}
                data-tooltip="제목 검색"
                onClick={() => {
                  closeHistoryMenu();
                  setHistorySearchOpen((open) => {
                    if (open) setHistorySearchQuery("");
                    return !open;
                  });
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle cx="10.5" cy="10.5" r="5.5" />
                  <path d="m15 15 4 4" />
                </svg>
              </button>
              <button
                className={`history-liked-filter${likedHistoryOnly ? " active" : ""}`}
                type="button"
                aria-label={likedHistoryOnly ? "전체 보기" : "좋아요만 보기"}
                aria-pressed={likedHistoryOnly}
                data-tooltip={likedHistoryOnly ? "전체 보기" : "좋아요만"}
                onClick={() => {
                  closeHistoryMenu();
                  setLikedHistoryOnly((active) => !active);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 3.7l2.5 5.05 5.58.82-4.04 3.93.95 5.55L12 16.43l-4.99 2.62.95-5.55-4.04-3.93 5.58-.82Z" />
                </svg>
              </button>
              <button
                className="history-manage"
                type="button"
                aria-label="채팅 세션 관리"
                data-tooltip="항목 관리"
                disabled={!historyBulkSelectableItems.length}
                onClick={() => {
                  closeHistoryMenu();
                  setHistoryBulkMode(true);
                  setHistoryBulkIds(new Set());
                }}
              >
                <HistoryListChecksIcon />
              </button>
              <button
                className="history-refresh"
                type="button"
                aria-label="재시작"
                data-tooltip="재시작"
                onClick={() => void restartActiveSession()}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              </button>
            </div>
          )}
        </div>
        {historySearchOpen ? (
          <label className="history-search">
            <span aria-hidden="true" className="history-search-icon">
              <svg viewBox="0 0 24 24">
                <circle cx="10.5" cy="10.5" r="5.5" />
                <path d="m15 15 4 4" />
              </svg>
            </span>
            <input
              autoFocus
              aria-label="채팅 세션 제목 검색"
              type="search"
              value={historySearchQuery}
              placeholder="제목 검색"
              onChange={(event) => setHistorySearchQuery(event.currentTarget.value)}
            />
            {historySearchQuery ? (
              <button
                className="history-search-clear"
                type="button"
                aria-label="채팅 세션 제목 검색 지우기"
                onClick={() => setHistorySearchQuery("")}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M7 7l10 10" />
                  <path d="M17 7 7 17" />
                </svg>
              </button>
            ) : null}
          </label>
        ) : null}
        <div
          ref={historyListRef}
          className="history-list"
          aria-busy={(state.historyLoading || state.historyLoadingMore || historySearchLoading) ? "true" : "false"}
          onScroll={handleHistoryScroll}
        >
          {hasHistoryFilter && historySearchLoading && !filteredRenderedHistory.length ? (
            <p className="empty">{likedHistoryOnly ? "좋아요한 채팅을 불러오는 중..." : "제목을 검색하는 중..."}</p>
          ) : (state.historyLoading || (!state.workspaceName && !state.workspacePath && state.status === "connecting")) && !renderedHistory.length ? (
            <div className="history-skeleton" role="status" aria-label="대화 내역을 불러오는 중">
              <span /><span /><span /><span />
            </div>
          ) : filteredRenderedHistory.length ? (
            filteredRenderedHistory.map((item) => {
              const editing = editingHistoryId === item.value;
              const isActive = isActiveHistoryItem(item, activeHistoryValue, state.sessionId);
              const label = titleForHistoryItem(item);
              const displayLabel = formatHistoryTitle(label);
              const detailLabel = item.description ? compactHistoryTitle(item.label) : "";
              const isPendingRestore = state.pendingHistoryId === item.value;
              const cachedLiveMessages = item.liveSessionId
                ? state.liveSessionViewsBySessionId[item.liveSessionId]?.messages
                : undefined;
              const liveResponseVisiblyBusy = item.busy === true && (
                cachedLiveMessages
                  ? isConversationResponseVisiblyBusy(true, cachedLiveMessages)
                  : true
              );
              const isActiveBusy = isActive && responseVisiblyBusy && (!state.pendingHistoryId || isPendingRestore);
              const isBusy = isActiveBusy || isPendingRestore || (item.live === true && liveResponseVisiblyBusy && !isActive);
              const showBusySpinner = isActiveBusy
                || (isPendingRestore && visibleRestoreSpinnerId === item.value)
                || (item.live === true && liveResponseVisiblyBusy && !isActive);
              const isDeleting = deletingHistoryId === item.value;
              const canLike = !item.pending && !isLiveOnlyHistoryItem(item);
              const canPin = !item.pending && !isLiveOnlyHistoryItem(item);
              const canDelete = !isCurrentLiveHistoryItem(item, state.sessionId);
              const canBulkSelect = historyBulkSelectableIds.has(item.value);
              const isHidden = isHistoryItemHidden(item, state.hiddenHistoryKeys, state.workspacePath, state.workspaceName);
              const showActions = !historyBulkMode && !isBusy && !isDeleting && (canDelete || canPin);
              return (
                <div
                  className={`history-item${isActive && !historyBulkMode ? " active" : ""}${isBusy ? " busy" : ""}${isDeleting ? " deleting" : ""}${item.pinned ? " pinned" : ""}${isHidden ? " hidden-history" : ""}${historyBulkMode ? " bulk-mode" : ""}${historyBulkIds.has(item.value) ? " bulk-selected" : ""}`}
                  key={item.value}
                >
                  {historyBulkMode ? (
                    <button
                      className="history-bulk-row"
                      type="button"
                      aria-label={`${label} 선택`}
                      aria-pressed={historyBulkIds.has(item.value)}
                      disabled={!canBulkSelect || historyBulkBusy}
                      onPointerDown={(event) => startHistoryBulkDrag(event, item.value, historyBulkIds.has(item.value))}
                      onPointerOver={(event) => continueHistoryBulkDrag(event, item.value)}
                      onClick={() => {
                        if (historyBulkSuppressClickRef.current) {
                          historyBulkSuppressClickRef.current = false;
                          return;
                        }
                        setHistoryBulkDeleteArmed(false);
                        setHistoryBulkIds((current) => {
                          const next = new Set(current);
                          if (next.has(item.value)) next.delete(item.value);
                          else next.add(item.value);
                          return next;
                        });
                      }}
                    >
                      <span className={`history-bulk-checkbox${historyBulkIds.has(item.value) ? " checked" : ""}`} aria-hidden="true">
                        {historyBulkIds.has(item.value) ? <svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10" /></svg> : null}
                      </span>
                      <span className="history-title">{displayLabel}</span>
                    </button>
                  ) : (
                    <>
                      {showBusySpinner ? (
                        <span className="history-busy-spinner" aria-hidden="true" />
                      ) : (
                        <button
                          className={`history-like${item.pinned ? " pinned" : item.liked ? " liked" : ""}`}
                          type="button"
                          aria-label={`${label} ${item.pinned ? "상단 고정 해제" : item.liked ? "좋아요 취소" : canLike ? "좋아요" : "좋아요는 저장 후 사용 가능"}`}
                          aria-pressed={item.pinned === true || item.liked === true}
                          data-tooltip={item.pinned ? "상단 고정 해제" : item.liked ? "좋아요 취소" : canLike ? "좋아요" : "대화 저장 후 좋아요 가능"}
                          disabled={item.pinned ? !canPin : !canLike}
                          onClick={() => void (item.pinned ? pinHistory(item) : likeHistory(item))}
                        >
                          {item.pinned ? (
                            <HistoryPinIcon className="history-pinned-pin" />
                          ) : item.liked ? (
                            <svg className="history-liked-star" aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 1 1.597-1.16Z" />
                            </svg>
                          ) : (
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
                            </svg>
                          )}
                        </button>
                      )}
                      {editing ? (
                        <form
                          className="history-title-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void renameHistory(item.value);
                          }}
                        >
                          <input
                            value={editingHistoryTitle}
                            aria-label="대화 제목"
                            autoFocus
                            onChange={(event) => setEditingHistoryTitle(event.currentTarget.value)}
                            onBlur={() => void renameHistory(item.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setEditingHistoryId("");
                                setEditingHistoryTitle("");
                              }
                            }}
                          />
                        </form>
                      ) : (
                        <button
                          className="history-open"
                          type="button"
                          aria-label={label}
                          onClick={() => void openHistory(item)}
                          onPointerEnter={() => preloadHistory(item)}
                          onFocus={() => preloadHistory(item)}
                        >
                          <span className="history-title">{displayLabel}</span>
                          {detailLabel ? <small>{detailLabel}</small> : null}
                        </button>
                      )}
                      {showActions ? (
                        <button
                          className="history-more"
                          type="button"
                          aria-label={`${label} 작업 더보기`}
                          aria-expanded={historyMenuId === item.value}
                          data-tooltip="작업 더보기"
                          onClick={(event) => {
                            event.stopPropagation();
                            openHistoryMenu(item.value, event.currentTarget);
                          }}
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })
          ) : likedHistoryOnly ? (
            <p className="empty">좋아요한 채팅이 없습니다.</p>
          ) : hasHistorySearch ? (
            <p className="empty">검색 결과가 없습니다.</p>
          ) : (
            <p className="empty">저장된 세션이 아직 없습니다.</p>
          )}
          {state.historyLoadingMore || (hasHistorySearch && historySearchLoading && filteredRenderedHistory.length)
            ? <p className="history-loading-more">{hasHistorySearch ? "검색 결과 불러오는 중..." : "이전 대화 불러오는 중..."}</p>
            : null}
        </div>
      </section>

      {openHistoryMenuItem && historyMenuPosition ? createPortal(
        <div
          className="history-options-menu"
          role="menu"
          aria-label={`${titleForHistoryItem(openHistoryMenuItem)} 세션 작업`}
          style={historyMenuPosition as CSSProperties}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={historyActionBusyId === openHistoryMenuItem.value || isLiveOnlyHistoryItem(openHistoryMenuItem)} onClick={() => {
            closeHistoryMenu();
            void pinHistory(openHistoryMenuItem);
          }}>
            <HistoryPinIcon />
            <span>{openHistoryMenuItem.pinned ? "상단 고정 해제" : "상단 고정"}</span>
          </button>
          <button type="button" role="menuitem" disabled={historyActionBusyId === openHistoryMenuItem.value || openHistoryMenuItem.pending || isLiveOnlyHistoryItem(openHistoryMenuItem)} onClick={() => {
            closeHistoryMenu();
            void likeHistory(openHistoryMenuItem);
          }}>
            <svg className={openHistoryMenuItem.liked ? "filled-star" : ""} aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3.7l2.5 5.05 5.58.82-4.04 3.93.95 5.55L12 16.43l-4.99 2.62.95-5.55-4.04-3.93 5.58-.82Z" /></svg>
            <span>{openHistoryMenuItem.liked ? "좋아요 취소" : "좋아요"}</span>
          </button>
          <button type="button" role="menuitem" disabled={historyActionBusyId === openHistoryMenuItem.value || openHistoryMenuItem.pending || isLiveOnlyHistoryItem(openHistoryMenuItem)} onClick={() => startHistoryRename(openHistoryMenuItem.value, titleForHistoryItem(openHistoryMenuItem))}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>
            <span>세션명 변경</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-expanded={historyMoveMenuOpen}
            disabled={!historyMovableIds.has(openHistoryMenuItem.value) || state.workspaces.filter((workspace) => workspace.path !== (openHistoryMenuItem.workspace?.path || state.workspacePath)).length === 0}
            onClick={() => {
              setHistoryDeleteArmedId("");
              setHistoryMoveMenuOpen((open) => !open);
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3Z" /><path d="m14 13 2 2 4-4" /></svg>
            <span>워크스페이스 변경</span>
          </button>
          {historyMoveMenuOpen ? (
            <div className="history-options-workspaces" role="menu" aria-label="이동할 워크스페이스">
              {state.workspaces
                .filter((workspace) => workspace.path !== (openHistoryMenuItem.workspace?.path || state.workspacePath))
                .map((workspace) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={workspace.path}
                    disabled={historyActionBusyId === openHistoryMenuItem.value}
                    onClick={async () => {
                      if (await moveHistoryToWorkspace(openHistoryMenuItem, workspace)) closeHistoryMenu();
                    }}
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3Z" /></svg>
                    <span>{workspace.name}</span>
                  </button>
                ))}
            </div>
          ) : null}
          {state.adminMode && openHistoryMenuItemHidden ? (
            <button
              type="button"
              role="menuitem"
              disabled={historyActionBusyId === openHistoryMenuItem.value}
              onClick={() => void restoreHiddenHistory(openHistoryMenuItem)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>목록에 복원</span>
            </button>
          ) : null}
          <button
            className={`danger${historyDeleteArmedId === openHistoryMenuItem.value ? " armed" : ""}`}
            type="button"
            role="menuitem"
            disabled={historyActionBusyId === openHistoryMenuItem.value}
            onClick={async () => {
              if (historyDeleteArmedId !== openHistoryMenuItem.value) {
                setHistoryMoveMenuOpen(false);
                setHistoryDeleteArmedId(openHistoryMenuItem.value);
                return;
              }
              setHistoryActionBusyId(openHistoryMenuItem.value);
              try {
                await removeHistory(openHistoryMenuItem);
              } finally {
                setHistoryActionBusyId("");
                setHistoryDeleteArmedId("");
              }
            }}
          >
            {historyActionBusyId === openHistoryMenuItem.value ? <span className="history-action-spinner" aria-hidden="true" /> : (
              <svg aria-hidden="true" viewBox="0 0 24 24">
                {historyDeleteArmedId === openHistoryMenuItem.value ? <path d="M12 8v5m0 3h.01M10.3 4.6 3.4 17a2 2 0 0 0 1.75 3h13.7a2 2 0 0 0 1.75-3L13.7 4.6a2 2 0 0 0-3.4 0Z" /> : <><path d="M4 7h16" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>}
              </svg>
            )}
            <span>{historyDeleteArmedId === openHistoryMenuItem.value ? "삭제 확인" : openHistoryMenuItem.live ? "세션 닫기" : state.adminMode ? "삭제" : "목록에서 숨기기"}</span>
          </button>
        </div>,
        document.body,
      ) : null}

      {showRuntimePicker ? (
        <ModelAvailabilityMenu anchorRef={runtimeFooterRef} onClose={() => dispatch({ type: "close_runtime_picker" })} />
      ) : null}

      <button
        ref={runtimeFooterRef}
        className="sidebar-footer"
        type="button"
        aria-label="사용 가능한 모델 관리"
        disabled={!state.adminMode}
        aria-haspopup="dialog"
        aria-expanded={state.runtimePicker.open}
        data-tooltip={state.adminMode ? "사용 가능한 모델 관리" : "모델 허용 목록은 ADMIN 모드에서 관리합니다."}
        data-tooltip-placement="right"
        onClick={() => void toggleRuntimePicker()}
      >
        <span className="profile-mark" aria-hidden="true">
          MH
        </span>
        <div className="runtime-copy">
          <strong>Provider: {state.providerLabel || state.provider}</strong>
          <small>Model: {state.model} · Effort: {state.effort || "none"}</small>
        </div>
      </button>
      {!state.sidebarCollapsed ? (
        <button
          className="sidebar-resize-handle"
          type="button"
          aria-label="사이드바 너비 조절"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={beginSidebarResize}
        />
      ) : null}
    </aside>
  );
}

function formatHistoryTitle(label: string) {
  const withoutPrefix = String(label || "")
    .replace(/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s+\d+\s*msg\s*/i, "")
    .replace(/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*/i, "")
    .trim();
  return compactHistoryTitle(withoutPrefix || "저장된 대화");
}

function compactHistoryTitle(title: string) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= historyTitleMaxLength) {
    return normalized;
  }
  return `${normalized.slice(0, historyTitleMaxLength).trimEnd()}…`;
}

function historyTitleForSort(item: HistoryItem) {
  return (item.description || item.label || item.value || "").trim();
}

function normalizeHistorySearchText(value: string) {
  return String(value || "").toLocaleLowerCase("ko").replace(/\s+/g, "");
}

function historyTitleMatches(title: string, query: string) {
  const normalizedQuery = normalizeHistorySearchText(query);
  if (!normalizedQuery) {
    return true;
  }
  return normalizeHistorySearchText(title).includes(normalizedQuery);
}

function appendUniqueHistoryItems(current: HistoryItem[], incoming: HistoryItem[]) {
  return uniqueHistoryItems([...current, ...incoming]);
}

function compareHistoryTitle(left: HistoryItem, right: HistoryItem) {
  return (
    historyTitleCollator.compare(historyTitleForSort(left), historyTitleForSort(right))
    || left.value.localeCompare(right.value, "ko")
  );
}

function sortPinnedHistory(items: HistoryItem[]) {
  return [...items].sort((left, right) => {
    const byPinned = Number(right.pinned === true) - Number(left.pinned === true);
    if (byPinned) return byPinned;
    if (left.pinned === true && right.pinned === true) {
      return compareHistoryTitle(left, right);
    }
    return 0;
  });
}

function isActiveHistoryItem(item: HistoryItem, activeHistoryValue: string, sessionId: string | null) {
  if (!item.value) {
    return false;
  }
  return item.value === activeHistoryValue || (!!sessionId && item.value === sessionId);
}

function isCurrentLiveHistoryItem(item: HistoryItem, sessionId: string | null) {
  return isLiveOnlyHistoryItem(item, sessionId);
}
