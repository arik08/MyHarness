import type { HistoryItem } from "../types/backend";

function normalizeHistoryKeyPart(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function historyVisibilityKey(sessionId: string, workspacePath = "", workspaceName = "") {
  const cleanSessionId = normalizeHistoryKeyPart(sessionId);
  if (!cleanSessionId) {
    return "";
  }
  const cleanPath = normalizeHistoryKeyPart(workspacePath);
  const cleanName = normalizeHistoryKeyPart(workspaceName);
  const workspaceKey = cleanPath ? `path:${cleanPath}` : cleanName ? `name:${cleanName}` : "workspace:";
  return `${workspaceKey}|session:${cleanSessionId}`;
}

export function historyItemVisibilityKey(item: HistoryItem, workspacePath = "", workspaceName = "") {
  const workspace = item.workspace || null;
  return historyVisibilityKey(
    item.value,
    workspace?.path || workspacePath,
    workspace?.name || workspaceName,
  );
}

export function isHistoryItemHidden(
  item: HistoryItem,
  hiddenHistoryKeys: string[],
  workspacePath = "",
  workspaceName = "",
) {
  const key = historyItemVisibilityKey(item, workspacePath, workspaceName);
  return Boolean(key && hiddenHistoryKeys.includes(key));
}

export function isLiveOnlyHistoryItem(item: HistoryItem, sessionId: string | null = null) {
  const value = String(item.value || "").trim();
  const liveSessionId = String(item.liveSessionId || "").trim();
  if (item.live !== true || !value || !liveSessionId) {
    return false;
  }
  return value === liveSessionId && (!sessionId || liveSessionId === sessionId);
}
