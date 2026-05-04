import type { HistoryItem } from "../types/backend";

export function isLiveOnlyHistoryItem(item: HistoryItem, sessionId: string | null = null) {
  const value = String(item.value || "").trim();
  const liveSessionId = String(item.liveSessionId || "").trim();
  if (item.live !== true || !value || !liveSessionId) {
    return false;
  }
  return value === liveSessionId && (!sessionId || liveSessionId === sessionId);
}
