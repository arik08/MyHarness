import { postJson } from "./http";
import type { SessionResponse } from "../types/backend";

export function startSession(payload: Record<string, unknown>) {
  return postJson<SessionResponse>("/api/session", payload);
}

export function restartSession(payload: Record<string, unknown>) {
  return postJson<SessionResponse>("/api/session/restart", payload);
}

export function shutdownSession(sessionId: string, clientId: string) {
  return postJson<{ ok: boolean }>("/api/shutdown", { sessionId, clientId });
}
