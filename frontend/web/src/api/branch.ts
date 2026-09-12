import { postJson } from "./http";
import type { Workspace } from "../types/backend";

export function branchHistory(payload: {
  sessionId: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
  answerIndex: number;
  answerText: string;
}) {
  return postJson<{ sessionId: string; title: string; workspace: Workspace }>("/api/history/branch", payload);
}
