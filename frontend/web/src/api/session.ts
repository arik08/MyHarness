import { getJson, postJson } from "./http";
import type { LiveSessionsResponse, SessionResponse } from "../types/backend";

export const capacityQueueStatusEvent = "myharness:capacity-queue-status";

type QueuedSessionStart = {
  status: "waiting";
  queueId: string;
  position: number;
  message?: string;
};

type SessionQueueStatus = QueuedSessionStart | (SessionResponse & { status: "ready" });

function announceSessionQueue(status: "waiting" | "started", position = 0, message = "") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(capacityQueueStatusEvent, {
    detail: { kind: "session", status, position, message },
  }));
}

function waitForQueuePoll() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 500));
}

async function requestSession(url: string, payload: Record<string, unknown>) {
  const initial = await postJson<SessionResponse | QueuedSessionStart>(url, payload);
  if ("sessionId" in initial) return initial;

  const clientId = String(payload.clientId || "").trim();
  let queued = initial;
  while (queued.status === "waiting") {
    announceSessionQueue("waiting", queued.position, queued.message || "");
    await waitForQueuePoll();
    const query = new URLSearchParams({ queueId: queued.queueId, clientId });
    const next = await getJson<SessionQueueStatus>(`/api/session/queue?${query.toString()}`);
    if (next.status === "ready") {
      announceSessionQueue("started", 0, "대기 순서가 되어 작업 세션을 시작합니다.");
      return next;
    }
    queued = next;
  }
  throw new Error("Could not start queued session");
}

export function startSession(payload: Record<string, unknown>) {
  return requestSession("/api/session", payload);
}

export function restartSession(payload: Record<string, unknown>) {
  return requestSession("/api/session/restart", payload);
}

export function shutdownSession(sessionId: string, clientId: string) {
  return postJson<{ ok: boolean }>("/api/shutdown", { sessionId, clientId });
}

export function listLiveSessions(params: { clientId: string; workspacePath?: string }) {
  const query = new URLSearchParams();
  if (params.clientId) query.set("clientId", params.clientId);
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson<LiveSessionsResponse>(`/api/live-sessions${suffix}`);
}
