import { deleteJson, getJson, postJson } from "./http";
import type { BackendEvent, HistoryItem, Workspace } from "../types/backend";

export const historyPageSize = 25;

export type HistoryListResponse = {
  workspace?: Workspace | null;
  options: HistoryItem[];
  hasMore?: boolean;
  nextOffset?: number;
};

export type HistorySnapshotResponse = Extract<BackendEvent, { type: "history_snapshot" }>;

const historySnapshotRequests = new Map<string, Promise<HistorySnapshotResponse>>();

export function listHistory(params: { workspacePath?: string; workspaceName?: string; limit?: number; offset?: number; search?: string } = {}) {
  const query = new URLSearchParams();
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (typeof params.offset === "number") query.set("offset", String(params.offset));
  if (params.search) query.set("search", params.search);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson<HistoryListResponse>(`/api/history${suffix}`);
}

export function loadHistorySnapshot(params: { sessionId: string; workspacePath?: string; workspaceName?: string }) {
  const query = new URLSearchParams({ sessionId: params.sessionId });
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  const key = query.toString();
  const existing = historySnapshotRequests.get(key);
  if (existing) return existing;
  const request = getJson<HistorySnapshotResponse>(`/api/history/snapshot?${key}`)
    .catch((error) => {
      historySnapshotRequests.delete(key);
      throw error;
    });
  historySnapshotRequests.set(key, request);
  return request;
}

export function deleteHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return deleteJson<{ deleted: boolean }>("/api/history", { sessionId, workspacePath, workspaceName });
}

export function hideHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return postJson<{ hidden: boolean }>("/api/history/hide", { sessionId, workspacePath, workspaceName });
}

export function restoreHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return postJson<{ restored: boolean }>("/api/history/restore", { sessionId, workspacePath, workspaceName });
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

export function toggleHistoryLike(sessionId: string, liked: boolean, workspacePath: string, workspaceName: string) {
  return postJson<{ ok: true; liked: boolean; sessionId: string }>("/api/history/like", {
    sessionId,
    liked,
    workspacePath,
    workspaceName,
  });
}

export function moveHistory(
  sessionId: string,
  workspacePath: string,
  workspaceName: string,
  targetWorkspacePath: string,
  targetWorkspaceName: string,
) {
  return postJson<{ ok: true; sessionId: string; sourceWorkspace: Workspace; workspace: Workspace }>("/api/history/move", {
    sessionId,
    workspacePath,
    workspaceName,
    targetWorkspacePath,
    targetWorkspaceName,
  });
}
