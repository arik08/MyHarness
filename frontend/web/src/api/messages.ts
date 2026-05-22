import { postJson } from "./http";

export type ClientAttachmentRef = {
  id: string;
  name: string;
  path: string;
  size: number;
  media_type?: string;
};

export type ComposeOptions = {
  output_surface?: "chat" | "artifact";
  artifact_action?: "auto" | "create" | "edit";
  target_output_tokens?: number;
  length_preset?: "default" | "long" | "very_long" | "extended" | "extra_long";
  active_artifact_path?: string;
};

export type SendMessagePayload = {
  sessionId: string;
  clientId: string;
  line: string;
  attachments?: unknown[];
  attachmentRefs?: ClientAttachmentRef[];
  composeOptions?: ComposeOptions;
  mode?: "queue" | "queued" | "steer";
  suppressUserTranscript?: boolean;
  systemPrompt?: string;
};

export function sendMessage(payload: SendMessagePayload) {
  return postJson<Record<string, unknown>>("/api/message", payload);
}

export async function uploadClientAttachments(payload: {
  sessionId?: string | null;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
  files: File[];
}) {
  const form = new FormData();
  if (payload.sessionId) form.set("session", payload.sessionId);
  form.set("clientId", payload.clientId);
  if (payload.workspacePath) form.set("workspacePath", payload.workspacePath);
  if (payload.workspaceName) form.set("workspaceName", payload.workspaceName);
  for (const file of payload.files) {
    form.append("files", file, file.name);
  }
  const response = await fetch("/api/client-attachments", {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body || `HTTP ${response.status}`;
    try {
      const data = body ? JSON.parse(body) : null;
      if (data?.error) message = String(data.error);
    } catch {
      // Keep raw response text.
    }
    throw new Error(message);
  }
  return response.json() as Promise<{ attachments: ClientAttachmentRef[] }>;
}

export function sendBackendRequest(sessionId: string, clientId: string, payload: Record<string, unknown>) {
  return postJson<{ ok: boolean }>("/api/respond", { sessionId, clientId, payload });
}

export function cancelMessage(sessionId: string, clientId: string) {
  return postJson<{ ok: boolean }>("/api/cancel", { sessionId, clientId });
}
