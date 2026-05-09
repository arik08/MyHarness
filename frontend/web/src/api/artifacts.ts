import { deleteJson, getJson, postJson, putJson } from "./http";
import type { ArtifactSummary } from "../types/backend";
import type { ArtifactAiEditComment, ArtifactPayload } from "../types/ui";

export function listArtifacts(sessionId: string, clientId: string) {
  const query = new URLSearchParams({ session: sessionId, clientId });
  return getJson<{ files: ArtifactSummary[] }>(`/api/artifacts?${query.toString()}`);
}

export function listProjectFiles(params: {
  sessionId?: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
  scope?: "default" | "all";
}) {
  const query = new URLSearchParams({
    clientId: params.clientId,
    scope: params.scope || "default",
  });
  if (params.sessionId) query.set("session", params.sessionId);
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  return getJson<{ files: ArtifactSummary[]; scope: string }>(`/api/project-files?${query.toString()}`);
}

export function organizeProjectFiles(params: {
  paths: string[];
  sessionId?: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
}) {
  return postJson<{ files: ArtifactSummary[] }>("/api/project-files/organize", {
    paths: params.paths,
    session: params.sessionId || "",
    clientId: params.clientId,
    workspacePath: params.workspacePath || "",
    workspaceName: params.workspaceName || "",
  });
}

export function readArtifact(params: { sessionId?: string; clientId: string; path: string; workspacePath?: string; workspaceName?: string }) {
  const query = new URLSearchParams({
    clientId: params.clientId,
    path: params.path,
  });
  if (params.sessionId) query.set("session", params.sessionId);
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  return getJson<ArtifactPayload>(`/api/artifact?${query.toString()}`);
}

export function resolveArtifact(params: { sessionId?: string; clientId: string; path: string; workspacePath?: string; workspaceName?: string }) {
  const query = new URLSearchParams({
    clientId: params.clientId,
    path: params.path,
  });
  if (params.sessionId) query.set("session", params.sessionId);
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  if (params.workspaceName) query.set("workspaceName", params.workspaceName);
  return getJson<ArtifactSummary>(`/api/artifact/resolve?${query.toString()}`);
}

export function saveArtifact(path: string, content: string, sessionId: string, clientId: string) {
  return postJson<{ artifact?: ArtifactSummary }>("/api/artifact/save", { path, content, session: sessionId, clientId });
}

export function overwriteArtifact(params: {
  path: string;
  content: string;
  sessionId?: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
}) {
  return putJson<{ artifact: ArtifactSummary; payload: ArtifactPayload }>("/api/artifact", {
    path: params.path,
    content: params.content,
    session: params.sessionId || "",
    clientId: params.clientId,
    workspacePath: params.workspacePath || "",
    workspaceName: params.workspaceName || "",
  });
}

export function renameArtifact(params: {
  path: string;
  name: string;
  sessionId?: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
}) {
  return postJson<{ artifact: ArtifactSummary; payload: ArtifactPayload }>("/api/artifact/rename", {
    path: params.path,
    name: params.name,
    session: params.sessionId || "",
    clientId: params.clientId,
    workspacePath: params.workspacePath || "",
    workspaceName: params.workspaceName || "",
  });
}

export function aiEditArtifact(params: {
  path: string;
  comments: ArtifactAiEditComment[];
  sessionId?: string;
  clientId: string;
  workspacePath?: string;
  workspaceName?: string;
}) {
  return postJson<{ ok: boolean; sourcePath: string; targetPath: string }>("/api/artifact/ai-edit", {
    path: params.path,
    comments: params.comments,
    session: params.sessionId || "",
    clientId: params.clientId,
    workspacePath: params.workspacePath || "",
    workspaceName: params.workspaceName || "",
  });
}

export function deleteArtifact(params: { path: string; sessionId?: string; clientId: string; workspacePath?: string; workspaceName?: string }) {
  return deleteJson<{ deleted: boolean }>("/api/artifact", {
    path: params.path,
    session: params.sessionId || "",
    clientId: params.clientId,
    workspacePath: params.workspacePath || "",
    workspaceName: params.workspaceName || "",
  });
}
