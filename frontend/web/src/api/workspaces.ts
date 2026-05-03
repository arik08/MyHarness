import { deleteJson, getJson, postJson } from "./http";
import type { Workspace, WorkspaceScope } from "../types/backend";

export function listWorkspaces() {
  return getJson<{ root: string; scope: WorkspaceScope; workspaces: Workspace[] }>("/api/workspaces");
}

export function createWorkspace(name: string) {
  return postJson<{ workspace: Workspace; workspaces: Workspace[] }>("/api/workspaces", { name });
}

export function deleteWorkspace(name: string) {
  return deleteJson<{ deleted: Workspace; workspaces: Workspace[] }>("/api/workspaces", { name });
}
