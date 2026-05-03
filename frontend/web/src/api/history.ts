import { deleteJson, getJson, postJson } from "./http";
import type { HistoryItem } from "../types/backend";

export function listHistory(params: { workspacePath?: string; workspaceName?: string } = {}) {
  const query = new URLSearchParams();
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson<{ options: HistoryItem[] }>(`/api/history${suffix}`);
}

export function deleteHistory(sessionId: string, workspacePath: string, workspaceName: string) {
  return deleteJson<{ deleted: boolean }>("/api/history", { sessionId, workspacePath, workspaceName });
}

export function updateHistoryTitle(sessionId: string, title: string, workspacePath: string, workspaceName: string) {
  return postJson<{ ok: true; title: string }>("/api/history/title", { sessionId, title, workspacePath, workspaceName });
}
