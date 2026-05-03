import { postJson } from "./http";

export type SendMessagePayload = {
  sessionId: string;
  clientId: string;
  line: string;
  attachments?: unknown[];
  mode?: "queue" | "queued" | "steer";
  suppressUserTranscript?: boolean;
  systemPrompt?: string;
};

export function sendMessage(payload: SendMessagePayload) {
  return postJson<Record<string, unknown>>("/api/message", payload);
}

export function sendBackendRequest(sessionId: string, clientId: string, payload: Record<string, unknown>) {
  return postJson<{ ok: boolean }>("/api/respond", { sessionId, clientId, payload });
}

export function cancelMessage(sessionId: string, clientId: string) {
  return postJson<{ ok: boolean }>("/api/cancel", { sessionId, clientId });
}
