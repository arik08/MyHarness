import { getJson, postJson } from "./http";

export function readYoloModeSettings() {
  return getJson<{ enabled: boolean }>("/api/settings/yolo-mode");
}

export function changeYoloMode(enabled: boolean) {
  return postJson<{ enabled: boolean }>("/api/settings/yolo-mode", { enabled });
}

export function readShellSettings() {
  return getJson<{ shell: string }>("/api/settings/shell");
}

export function changeShellPreference(shell: string) {
  return postJson<{ shell: string }>("/api/settings/shell", { shell });
}

export function readWorkspaceScopeSettings() {
  return getJson<{ mode: "shared" | "ip" | string; scope?: unknown }>("/api/settings/workspace-scope");
}

export function changeWorkspaceScope(mode: "shared" | "ip") {
  return postJson<{ mode: "shared" | "ip" | string; scope?: unknown }>("/api/settings/workspace-scope", { mode });
}

export function readLearnedSkillsSettings() {
  return getJson<{ mode: "use" | "hide" | "off" | string }>("/api/settings/learned-skills");
}

export function changeLearnedSkillsMode(mode: "use" | "hide" | "off") {
  return postJson<{ mode: "use" | "hide" | "off" | string }>("/api/settings/learned-skills", { mode });
}

export type PgptSettings = {
  apiKeyConfigured?: boolean;
  apiKeyMasked?: string;
  employeeNo?: string;
  companyCode?: string;
};

export function readPgptSettings() {
  return getJson<PgptSettings>("/api/settings/pgpt");
}

export function savePgptSettings(payload: { apiKey?: string; employeeNo?: string; companyCode?: string }) {
  return postJson<PgptSettings>("/api/settings/pgpt", payload);
}

export type FolderDialogResult = {
  canceled?: boolean;
  folderPath?: string;
};

export function openFolderDialog(initialPath: string) {
  return postJson<FolderDialogResult>("/api/dialog/folder", { initialPath });
}

export type UserStats = {
  dailyActiveIpCount?: number;
  todayVisitCount?: number;
  totalVisitCount?: number;
  viewerIp?: string;
  currentIpTodayVisitCount?: number;
  conversationCount?: number;
  activeSessionCount?: number;
  activeIpSessionCount?: number;
  currentWorkspaceConversationCount?: number;
  currentWorkspaceName?: string;
  ipBreakdown?: Array<{ ip?: string; visitCount?: number; todayVisitCount?: number; activeSessionCount?: number; lastSeenAt?: number }>;
  dailyBreakdown?: Array<{ date?: string; activeIpCount?: number; visitCount?: number }>;
};

export function readUserStats(params: { clientId: string; workspaceName: string; workspacePath: string }) {
  const query = new URLSearchParams(params);
  return getJson<UserStats>(`/api/user-stats?${query.toString()}`);
}
