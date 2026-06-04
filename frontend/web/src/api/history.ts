import { deleteJson, getJson, postJson } from "./http";
import type { HistoryItem, Workspace } from "../types/backend";

export const historyPageSize = 25;

export type HistoryListResponse = {
  workspace?: Workspace | null;
  options: HistoryItem[];
  hasMore?: boolean;
  nextOffset?: number;
};

export function listHistory(params: { workspacePath?: string; workspaceName?: string; limit?: number; offset?: number } = {}) {
  const query = new URLSearchParams();
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (typeof params.offset === "number") query.set("offset", String(params.offset));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson<HistoryListResponse>(`/api/history${suffix}`);
}

export function deleteHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return deleteJson<{ deleted: boolean }>("/api/history", { sessionId, workspacePath, workspaceName });
}

export function hideHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return postJson<{ hidden: boolean }>("/api/history/hide", { sessionId, workspacePath, workspaceName });
}

export function updateHistoryTitle(sessionId: string, title: string, workspacePath: string, workspaceName: string) {
  return postJson<{ ok: true; title: string }>("/api/history/title", { sessionId, title, workspacePath, workspaceName });
}

export function toggleHistoryPin(sessionId: string, pinned: boolean, workspacePath: string, workspaceName: string) {
  return postJson<{ ok: true; pinned: boolean; sessionId: string }>("/api/history/pin", {
    sessionId,
    pinned,
    workspacePath,
    workspaceName,
  });
}
