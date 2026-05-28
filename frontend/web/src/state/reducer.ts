import type { ArtifactSummary, BackendEvent, CommandItem, HistoryItem, PluginItem, SkillItem, SwarmNotificationSnapshot, SwarmTeammateSnapshot, Workspace, WorkspaceScope } from "../types/backend";
import type { AppSettings, AppState, ArtifactPayload, ChatMessage, LiveSessionView, ModalState, SidebarCollapseReason, ThemeId, WorkflowEvent, WorkflowEventStatus } from "../types/ui";
import { artifactKind, artifactLabelForPath, artifactName, isKnownArtifactPath, normalizeArtifactPath } from "../utils/artifacts";
import { historyVisibilityKey, isHistoryItemHidden, isLiveOnlyHistoryItem } from "../utils/history";
import { sidebarDefaultWidthPx } from "../layout/sidebarLayout";

const clientSessionKey = "myharness:clientSessionId";
const appSettingsKey = "myharness:appSettings";
const adminModeStorageKey = "myharness:adminMode";
const hiddenHistoryKeysStorageKey = "myharness:hiddenHistoryKeys";

const defaultAppSettings: AppSettings = {
  streamScrollDurationMs: 2000,
  streamStartBufferMs: 180,
  streamFollowLeadPx: 140,
  streamRevealDurationMs: 420,
  downloadMode: "browser",
  downloadFolderPath: "",
  shell: "auto",
};

export type AppAction =
  | { type: "backend_event"; event: BackendEvent; sessionId?: string }
  | { type: "append_message"; message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "createdAt">>; skipHistory?: boolean }
  | { type: "session_started"; sessionId: string; clientId?: string; busy?: boolean }
  | { type: "session_replaced"; sessionId: string; workspace?: Workspace }
  | { type: "set_theme"; themeId: ThemeId }
  | { type: "set_sidebar_collapsed"; value: boolean; source?: Exclude<SidebarCollapseReason, null> }
  | { type: "release_sidebar_manual_open" }
  | { type: "set_sidebar_width"; value: number }
  | { type: "set_sidebar_resizing"; value: boolean }
  | { type: "set_draft"; value: string }
  | { type: "set_busy"; value: boolean }
  | { type: "set_permission_mode"; value: string }
  | { type: "set_chat_title"; value: string }
  | { type: "set_system_prompt"; value: string }
  | { type: "set_app_settings"; value: Partial<AppSettings> }
  | { type: "set_admin_mode"; value: boolean }
  | { type: "clear_composer" }
  | { type: "add_attachment"; attachment: { media_type: string; data: string; name: string } }
  | { type: "remove_attachment"; index: number }
  | { type: "add_pasted_text"; text: string }
  | { type: "remove_pasted_text"; index: number }
  | { type: "set_workspaces"; workspaces: Workspace[]; scope?: WorkspaceScope }
  | { type: "set_workspace"; workspace: Workspace }
  | { type: "set_history"; history: HistoryItem[] }
  | { type: "hide_history_local"; sessionId: string; workspacePath?: string; workspaceName?: string }
  | { type: "delete_history_local"; sessionId: string; workspacePath?: string; workspaceName?: string }
  | { type: "set_history_loading"; value: boolean }
  | { type: "begin_new_chat"; sessionId?: string }
  | { type: "begin_history_restore"; sessionId: string }
  | { type: "finish_history_restore" }
  | { type: "set_artifacts"; artifacts: ArtifactSummary[] }
  | { type: "refresh_artifacts" }
  | { type: "set_artifact_panel_width"; value: number | null }
  | { type: "set_artifact_resizing"; value: boolean }
  | { type: "open_artifact_list" }
  | { type: "open_artifact"; artifact: ArtifactSummary; payload?: ArtifactPayload | null }
  | { type: "set_artifact_payload"; payload: ArtifactPayload }
  | { type: "close_artifact" }
  | { type: "open_modal"; modal: ModalState }
  | { type: "close_modal" }
  | { type: "open_runtime_picker" }
  | { type: "close_runtime_picker" }
  | { type: "set_runtime_picker_error"; message: string }
  | { type: "select_runtime_provider"; value: string }
  | { type: "select_runtime_agent_scope"; value: "main" | "sub" }
  | { type: "select_runtime_model"; value: string }
  | { type: "select_runtime_effort"; value: string }
  | { type: "toggle_todo_collapsed" }
  | { type: "dismiss_todo" }
  | { type: "set_swarm_popup_open"; value: boolean }
  | { type: "clear_workflow" }
  | { type: "clear_messages" };

function loadClientSessionId() {
  try {
    return sessionStorage.getItem(clientSessionKey) || "";
  } catch {
    return "";
  }
}

function saveClientSessionId(value: string) {
  try {
    sessionStorage.setItem(clientSessionKey, value);
  } catch {
    // Embedded/private contexts may block web storage.
  }
}

function loadLocalStorageValue(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function isNarrowViewport() {
  try {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;
  } catch {
    return false;
  }
}

function initialSidebarCollapsed() {
  const stored = loadLocalStorageValue("myharness:sidebarCollapsed");
  if (stored) {
    return stored === "1";
  }
  return isNarrowViewport();
}

function initialSidebarCollapseReason(collapsed: boolean): SidebarCollapseReason {
  if (!collapsed) {
    return null;
  }
  return loadLocalStorageValue("myharness:sidebarCollapsed") === "1" ? "manual" : "auto";
}

function initialSidebarWidth() {
  const value = Number(loadLocalStorageValue("myharness:sidebarWidth") || 0);
  return Number.isFinite(value) && value >= sidebarDefaultWidthPx ? Math.min(value, 520) : sidebarDefaultWidthPx;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numberValue) ? numberValue : fallback));
}

function normalizeAppSettings(value: Partial<AppSettings> = {}): AppSettings {
  return {
    streamScrollDurationMs: clampNumber(value.streamScrollDurationMs, defaultAppSettings.streamScrollDurationMs, 0, 5000),
    streamStartBufferMs: clampNumber(value.streamStartBufferMs, defaultAppSettings.streamStartBufferMs, 0, 2000),
    streamFollowLeadPx: clampNumber(value.streamFollowLeadPx, defaultAppSettings.streamFollowLeadPx, 0, 360),
    streamRevealDurationMs: clampNumber(value.streamRevealDurationMs, defaultAppSettings.streamRevealDurationMs, 0, 2000),
    downloadMode: value.downloadMode === "folder" || value.downloadMode === "ask" ? value.downloadMode : "browser",
    downloadFolderPath: String(value.downloadFolderPath || ""),
    shell: value.shell === "powershell" || value.shell === "git-bash" || value.shell === "cmd" ? value.shell : "auto",
  };
}

function loadAppSettings(): AppSettings {
  try {
    return normalizeAppSettings(JSON.parse(localStorage.getItem(appSettingsKey) || "{}") as Partial<AppSettings>);
  } catch {
    return { ...defaultAppSettings };
  }
}

function saveAppSettings(settings: AppSettings) {
  try {
    localStorage.setItem(appSettingsKey, JSON.stringify(settings));
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

export function loadAdminModePreference() {
  return loadLocalStorageValue(adminModeStorageKey) === "1";
}

function saveAdminModePreference(value: boolean) {
  try {
    localStorage.setItem(adminModeStorageKey, value ? "1" : "0");
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

function normalizeHiddenHistoryKeys(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )).slice(-500);
}

export function loadHiddenHistoryKeys() {
  try {
    return normalizeHiddenHistoryKeys(JSON.parse(localStorage.getItem(hiddenHistoryKeysStorageKey) || "[]"));
  } catch {
    return [];
  }
}

function saveHiddenHistoryKeys(keys: string[]) {
  try {
    localStorage.setItem(hiddenHistoryKeysStorageKey, JSON.stringify(normalizeHiddenHistoryKeys(keys)));
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

function isSlashCommandMessage(text: string) {
  return /^\/\S*/.test(String(text || "").trim());
}

function normalizeThemeId(value: string): ThemeId {
  if (value === "nexus" || value === "posco") {
    return "light";
  }
  return value === "claude" || value === "dark" || value === "mono" || value === "mono-orange" ? value : "light";
}

function initialThemeId(): ThemeId {
  return normalizeThemeId(loadLocalStorageValue("myharness:theme"));
}

function storedArtifactPanelWidth(key: string) {
  const value = Number(loadLocalStorageValue(key) || 0);
  return Number.isFinite(value) && value >= 320 ? value : null;
}

function initialArtifactPanelListWidth() {
  const stored = storedArtifactPanelWidth("myharness:artifactPanelListWidth")
    ?? storedArtifactPanelWidth("myharness:artifactPanelWidth");
  return stored ? Math.min(stored, 500) : 500;
}

function initialArtifactPanelPreviewWidth() {
  return storedArtifactPanelWidth("myharness:artifactPanelPreviewWidth")
    ?? storedArtifactPanelWidth("myharness:artifactPanelWidth");
}

const issuedIds = new Set<string>();
let idCollisionSerial = 0;

function nextId() {
  const base = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!issuedIds.has(base)) {
    issuedIds.add(base);
    return base;
  }
  let next = base;
  do {
    idCollisionSerial += 1;
    next = `${base}-${idCollisionSerial}`;
  } while (issuedIds.has(next));
  issuedIds.add(next);
  return next;
}

function createClientSessionId() {
  return nextId();
}

function initialClientSessionId() {
  const existing = loadClientSessionId();
  if (existing) {
    return existing;
  }
  const next = createClientSessionId();
  saveClientSessionId(next);
  return next;
}

const initialSidebarCollapsedValue = initialSidebarCollapsed();

export const initialAppState: AppState = {
  sessionId: null,
  clientId: initialClientSessionId(),
  ready: false,
  busy: false,
  status: "connecting",
  statusText: "연결 중",
  provider: "-",
  activeProfile: "-",
  providerLabel: "-",
  model: "-",
  subagentModel: "-",
  subagentEffort: "-",
  effort: "-",
  permissionMode: "-",
  chatTitle: "MyHarness",
  systemPrompt: loadLocalStorageValue("myharness:systemPrompt"),
  appSettings: loadAppSettings(),
  adminMode: loadAdminModePreference(),
  themeId: initialThemeId(),
  sidebarCollapsed: initialSidebarCollapsedValue,
  sidebarCollapseReason: initialSidebarCollapseReason(initialSidebarCollapsedValue),
  sidebarWidth: initialSidebarWidth(),
  sidebarResizing: false,
  commands: [],
  skills: [],
  plugins: [],
  mcpServers: [],
  workspaceName: "",
  workspacePath: "",
  workspaceScope: { mode: "shared", name: "shared", root: "" },
  workspaces: [],
  history: [],
  hiddenHistoryKeys: loadHiddenHistoryKeys(),
  historyLoading: false,
  historyRefreshKey: 0,
  activeHistoryId: null,
  pendingHistoryId: null,
  restoringHistory: false,
  historyReadOnly: false,
  pendingFreshChat: false,
  preserveMessagesOnNextClearTranscript: false,
  artifacts: [],
  artifactPanelOpen: false,
  activeArtifact: null,
  activeArtifactPayload: null,
  artifactRefreshKey: 0,
  artifactPanelWidth: initialArtifactPanelListWidth(),
  artifactPanelListWidth: initialArtifactPanelListWidth(),
  artifactPanelPreviewWidth: initialArtifactPanelPreviewWidth(),
  artifactResizing: false,
  modal: null,
  backendModalsBySessionId: {},
  liveSessionViewsBySessionId: {},
  messages: [],
  workflowAnchorMessageId: null,
  workflowEventsByMessageId: {},
  workflowDurationSecondsByMessageId: {},
  workflowInputBuffers: {},
  todoMarkdown: "",
  todoSessionId: null,
  todoCollapsed: false,
  swarmTeammates: [],
  swarmNotifications: [],
  swarmPopupOpen: false,
  workflowEvents: [],
  workflowDurationSeconds: null,
  workflowStartedAtMs: null,
  runtimePicker: {
    open: false,
    loading: false,
    error: "",
    providers: [],
    modelsByProvider: {},
    models: [],
    efforts: [],
    selectedProvider: "",
    agentScope: "main",
    modelOpen: false,
    effortOpen: false,
  },
  composer: {
    draft: "",
    attachments: [],
    pastedTexts: [],
    token: null,
  },
};

function createMessage(message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "createdAt">>): ChatMessage {
  return { id: nextId(), ...message };
}

function appendMessage(messages: ChatMessage[], message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "createdAt">>): ChatMessage[] {
  return [...messages, createMessage(message)];
}

function normalizeAssistantArtifacts(value: unknown): ArtifactSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const artifacts: ArtifactSummary[] = [];
  for (const item of value) {
    const raw: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : { path: item };
    const path = normalizeArtifactPath(String(raw.path || raw.file || ""));
    const key = path.toLowerCase();
    if (!path || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const kind = String(raw.kind || artifactKind(path));
    const name = String(raw.name || artifactName(path));
    const label = String(raw.label || artifactLabelForPath(path, kind));
    const size = Number(raw.size);
    artifacts.push({
      path,
      name,
      kind,
      label,
      size: Number.isFinite(size) && size >= 0 ? size : undefined,
    });
  }
  return artifacts;
}

function mergeAssistantArtifacts(existing: ArtifactSummary[] | undefined, next: ArtifactSummary[]) {
  const merged = normalizeAssistantArtifacts([...(existing || []), ...next]);
  return merged.length ? merged : undefined;
}

function artifactPathSignature(artifacts: ArtifactSummary[] | undefined) {
  return (artifacts || [])
    .map((artifact) => normalizeArtifactPath(artifact.path || "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function isDuplicateAssistantCompletion(
  message: ChatMessage | undefined,
  text: string,
  artifacts: ArtifactSummary[],
) {
  if (message?.role !== "assistant" || message.isComplete !== true) {
    return false;
  }
  const previousText = normalizeVisibleText(message.text).trim();
  const nextText = normalizeVisibleText(text).trim();
  if (previousText !== nextText) {
    return false;
  }
  return artifactPathSignature(message.artifacts) === artifactPathSignature(artifacts);
}

function workflowOutputArtifactPath(input?: Record<string, unknown> | null) {
  const patch = workflowStringInput(input, ["patch", "diff"]).value;
  const path = workflowStringInput(input, ["path", "file_path", "output_path"]).value || workflowPatchPath(patch);
  return normalizeArtifactPath(path);
}

function workflowEventArtifactCandidates(events: WorkflowEvent[]) {
  return normalizeAssistantArtifacts(events
    .filter((event) => {
      const toolName = event.toolName.toLowerCase();
      return event.status !== "error" && (toolName === "write_file" || toolName === "write_long_report");
    })
    .map((event) => workflowOutputArtifactPath(event.toolInput))
    .filter((path) => path && isKnownArtifactPath(path)));
}

const staleSessionMessage = "세션 연결이 끊겼습니다. 페이지를 새로고침하거나 새 세션을 시작한 뒤 다시 시도해주세요.";
const brainstormingBrowserPrompt =
  "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)";
const localizedBrainstormingBrowserPrompt =
  "브라우저로 간단한 목업, 다이어그램, 비교 화면 같은 시각 자료를 함께 보여드리면 더 설명하기 쉬울 수 있습니다. 이 기능은 아직 새 기능이라 토큰을 조금 더 쓸 수 있습니다. 사용해볼까요? (로컬 URL을 여는 과정이 필요합니다)";

function normalizeVisibleText(message: string) {
  const text = String(message || "");
  if (text.trim() === "Unknown session") {
    return staleSessionMessage;
  }
  return text.replace(brainstormingBrowserPrompt, localizedBrainstormingBrowserPrompt);
}

function assistantCompletionText(streamedText: string, completedText: string) {
  if (!streamedText || !completedText) {
    return completedText || streamedText;
  }
  if (completedText === streamedText || completedText.startsWith(streamedText)) {
    return completedText;
  }
  if (streamedText.endsWith(completedText) || streamedText.includes(completedText)) {
    return streamedText;
  }
  return completedText;
}

function assistantStreamingText(currentText: string, nextChunkOrSnapshot: string) {
  if (!currentText || !nextChunkOrSnapshot) {
    return currentText || nextChunkOrSnapshot;
  }
  if (nextChunkOrSnapshot === currentText || nextChunkOrSnapshot.startsWith(currentText)) {
    return nextChunkOrSnapshot;
  }
  return `${currentText}${nextChunkOrSnapshot}`;
}

function completePendingAssistantMessage(messages: ChatMessage[], completedText = "", suppressActions = false, artifacts: ArtifactSummary[] = []): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.isComplete !== true) {
    const text = assistantCompletionText(last.text, completedText);
    if (!text.trim()) {
      return messages.slice(0, -1);
    }
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        text,
        isComplete: true,
        suppressActions: suppressActions || last.suppressActions,
        createdAt: Date.now(),
        artifacts: mergeAssistantArtifacts(last.artifacts, artifacts),
      },
    ];
  }
  return messages;
}

function appendErrorMessage(messages: ChatMessage[], message: string): ChatMessage[] {
  const text = normalizeVisibleText(message).trim() || "응답 생성 중 오류가 발생했습니다.";
  const last = messages[messages.length - 1];
  if (last?.isError && last.text === text) {
    return messages;
  }
  return appendMessage(messages, { role: "system", text, isError: true });
}

function isShellTool(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower === "cmd" || lower === "bash" || lower.includes("shell_command");
}

function compactWorkflowDetail(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateWorkflowDetail(value: string, maxLength = 160) {
  const compact = compactWorkflowDetail(value);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function workflowRequestDetail(requestText = "") {
  const detail = truncateWorkflowDetail(requestText, 140);
  return detail ? `요청 확인 · ${detail}` : "사용자 요청을 확인했습니다.";
}

function commandFromToolInput(input?: Record<string, unknown> | null) {
  for (const key of ["command", "cmd", "script"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) {
      return compactWorkflowDetail(value);
    }
  }
  return "";
}

function updateLatestTerminalMessage(
  messages: ChatMessage[],
  command: string,
  patch: NonNullable<ChatMessage["terminal"]>,
) {
  const index = [...messages].reverse().findIndex((message) => {
    if (!message.terminal) return false;
    if (message.terminal.status !== "running") return false;
    return !command || message.terminal.command === command;
  });
  if (index < 0) {
    return null;
  }
  const realIndex = messages.length - 1 - index;
  return messages.map((message, currentIndex) => (
    currentIndex === realIndex
      ? {
          ...message,
          text: patch.output ?? message.text,
          isError: patch.status === "error",
          terminal: { ...message.terminal, ...patch },
        }
      : message
  ));
}

function isNonConversationTranscriptItem(item: { role?: string; text?: string }) {
  const role = item.role || "";
  const text = String(item.text || "").trim();
  if (!text) return true;
  if (role === "user" && isPlanModeCommandText(text)) return true;
  if (role === "system" && text === "Conversation cleared.") return true;
  if (
    role === "system"
    && ["Plan mode enabled.", "Plan mode disabled.", "계획 모드를 켰습니다.", "계획 모드를 껐습니다."].includes(text)
  ) return true;
  if (role === "system" && text.startsWith("Session restored")) return true;
  return false;
}

function canonicalUserTranscriptText(text: string) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function timestampMsFromRecord(record: Record<string, unknown>) {
  const raw = record.createdAt ?? record.created_at ?? record.timestamp;
  if (raw === null || raw === undefined || raw === "") {
    return undefined;
  }
  const value = typeof raw === "string" ? Date.parse(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function isPlanModeCommandText(text: string) {
  return /^\/plan(?:\s|$)/i.test(String(text || "").trim());
}

function isDuplicateActiveUserTranscript(state: AppState, text: string) {
  const canonicalText = canonicalUserTranscriptText(text);
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "user" && canonicalUserTranscriptText(last.text) === canonicalText && !last.kind) {
    return true;
  }
  if (!state.busy || !state.workflowAnchorMessageId) {
    return false;
  }
  const anchor = state.messages.find((message) => message.id === state.workflowAnchorMessageId);
  return anchor?.role === "user" && !anchor.kind && canonicalUserTranscriptText(anchor.text) === canonicalText;
}

function isDuplicateKindedUserTranscript(state: AppState, text: string, kind: ChatMessage["kind"]) {
  if (!kind) {
    return false;
  }
  const canonicalText = canonicalUserTranscriptText(text);
  const last = state.messages[state.messages.length - 1];
  return last?.role === "user" && canonicalUserTranscriptText(last.text) === canonicalText && last.kind === kind;
}

function isFinalRestoredAssistantAnswer(historyEvents: Array<Record<string, unknown>>, index: number) {
  const current = historyEvents[index];
  if (!String(current?.text || "").trim() && !normalizeAssistantArtifacts(current?.artifacts).length) {
    return false;
  }
  for (const next of historyEvents.slice(index + 1)) {
    const type = String(next?.type || "");
    if (type === "user") {
      return true;
    }
    if (type === "assistant" && (String(next?.text || "").trim() || normalizeAssistantArtifacts(next?.artifacts).length)) {
      return false;
    }
    if (["tool_started", "tool_completed", "tool_progress", "tool_input_delta"].includes(type)) {
      return false;
    }
  }
  return true;
}

function initialWorkflowEvents(requestText = ""): WorkflowEvent[] {
  return [
    {
      id: nextId(),
      toolName: "",
      title: "요청 이해",
      detail: workflowRequestDetail(requestText),
      status: "done",
      level: "parent",
    },
    {
      id: nextId(),
      toolName: "",
      title: "작업 계획 수립",
      detail: "필요한 맥락과 진행 방향을 정리합니다.",
      status: "running",
      level: "parent",
      role: "planning",
    },
  ];
}

function hasRestorableWorkflowEvents(events: WorkflowEvent[]) {
  return events.some((event) => (
    Boolean(event.toolName)
    || event.role === "purpose"
    || event.role === "activity"
    || event.role === "final"
  ));
}

function workflowTitle(toolName: string) {
  const lower = toolName.toLowerCase();
  if (!toolName) return "도구 실행";
  if (isTodoTool(toolName)) return "작업 목록 정리";
  if (lower === "cmd" || lower.includes("shell") || lower.includes("bash") || lower.includes("powershell")) return "명령 실행";
  if (lower.includes("apply_patch")) return "파일 수정";
  if (lower.includes("read") || lower.includes("open")) return "파일 확인";
  return toolName;
}

function isTodoTool(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower === "todo_write" || lower === "todowrite";
}

function compactToolStatus(toolName: string, fallback = "처리 중") {
  const lower = toolName.toLowerCase();
  if (lower === "skill") return "스킬 확인 중";
  if (isTodoTool(toolName)) return "작업 목록 정리 중";
  if (lower.includes("bash") || lower.includes("shell") || lower === "cmd") return "명령 실행 중";
  if (lower.includes("web_fetch")) return "웹 페이지 확인 중";
  if (lower.includes("web_search")) return "웹 검색 중";
  if (lower.includes("grep")) return "텍스트 검색 중";
  if (lower.includes("glob")) return "파일 목록 확인 중";
  if (lower.includes("read")) return "파일 읽는 중";
  if (lower.includes("write") || lower.includes("edit") || lower.includes("notebook") || lower.includes("patch")) return "파일 작업 중";
  return fallback;
}

function workflowDetailFromInput(input?: Record<string, unknown> | null) {
  if (!input) return "";
  const candidates = ["command", "cmd", "script", "path", "file_path", "output_path", "file", "cwd", "query", "pattern"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return compactWorkflowDetail(value);
    }
  }
  return "";
}

function workflowOutputFirstLine(output: string, fallback: string) {
  return output.split(/\r?\n/).find((line) => line.trim()) || fallback;
}

function workflowOutputCompactLine(output: string, fallback: string) {
  return output.replace(/\s+/g, " ").trim() || fallback;
}

function todoFailureDetail(output: string) {
  const firstLine = workflowOutputFirstLine(output, "작업 목록 정리에 실패했습니다.").trim();
  return firstLine.replace(/^Invalid input for (?:todo_write|TodoWrite):\s*/i, "입력 형식 오류: ");
}

function skillNameFromInput(input?: Record<string, unknown> | null) {
  const value = input?.name;
  return typeof value === "string" ? value.trim() : "";
}

function skillNameFromOutput(output: string) {
  return output.match(/^Skill:\s*(.+)$/m)?.[1]?.trim() || "";
}

function skillDescriptionFromOutput(output: string) {
  return output.match(/^Description:\s*(.+)$/m)?.[1]?.trim() || "";
}

function workflowSkillDetail(skills: SkillItem[], input?: Record<string, unknown> | null, output = "") {
  const requestedName = skillNameFromInput(input);
  const outputName = skillNameFromOutput(output);
  const name = requestedName || outputName;
  if (!name) {
    return "";
  }
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  const displayName = skill?.name || name;
  const description = skill?.description || skillDescriptionFromOutput(output);
  return description ? `${displayName} · ${description}` : displayName;
}

function workflowToolDetail(
  skills: SkillItem[],
  toolName: string,
  input?: Record<string, unknown> | null,
  output = "",
  fallback = "",
  isError = false,
) {
  if (isTodoTool(toolName)) {
    if (isError) {
      return todoFailureDetail(output);
    }
    return output ? "작업 목록을 정리했습니다." : "할 일을 정리하고 있습니다.";
  }
  if (toolName.toLowerCase() === "skill") {
    const skillDetail = workflowSkillDetail(skills, input, output);
    if (skillDetail) {
      return skillDetail;
    }
  }
  if (toolName.toLowerCase() === "cmd") {
    const command = commandFromToolInput(input);
    if (command) {
      return command;
    }
  }
  if (output) {
    return workflowOutputCompactLine(output, `${toolName || "도구"} 완료`);
  }
  return workflowDetailFromInput(input) || fallback;
}

function splitWorkflowPreviewLines(value: string) {
  const normalized = String(value || "").replace(/\r\n/g, "\n");
  return normalized ? normalized.split("\n") : [""];
}

function formatWorkflowEditBlock(oldValue: string, newValue: string) {
  return [
    ...splitWorkflowPreviewLines(oldValue).map((line) => `-- ${line}`),
    ...splitWorkflowPreviewLines(newValue).map((line) => `++ ${line}`),
  ].join("\n");
}

function decodeJsonStringFragment(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      break;
    }
    index += 1;
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else if (next === "b") result += "\b";
    else if (next === "f") result += "\f";
    else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      result += next;
    }
  }
  return result;
}

function extractPartialJsonStringField(source: string, key: string) {
  const marker = `"${key}"`;
  const keyIndex = source.indexOf(marker);
  if (keyIndex < 0) return { found: false, value: "" };
  const colonIndex = source.indexOf(":", keyIndex + marker.length);
  if (colonIndex < 0) return { found: false, value: "" };
  let quoteIndex = colonIndex + 1;
  while (quoteIndex < source.length && /\s/.test(source[quoteIndex])) {
    quoteIndex += 1;
  }
  if (source[quoteIndex] !== "\"") return { found: false, value: "" };
  let cursor = quoteIndex + 1;
  let escaped = false;
  let raw = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (!escaped && char === "\"") break;
    raw += char;
    escaped = !escaped && char === "\\";
    if (char !== "\\") escaped = false;
    cursor += 1;
  }
  return { found: true, value: decodeJsonStringFragment(raw) };
}

function firstPartialJsonStringField(source: string, keys: string[]) {
  for (const key of keys) {
    const field = extractPartialJsonStringField(source, key);
    if (field.found) return field;
  }
  return { found: false, value: "" };
}

function isWorkflowOutputTool(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower.includes("write") || lower.includes("edit") || lower.includes("patch");
}

function workflowStringInput(input: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string") {
      return { found: true, value };
    }
  }
  return { found: false, value: "" };
}

function workflowOutputInputPath(input?: Record<string, unknown> | null) {
  const patch = workflowStringInput(input, ["patch", "diff"]).value;
  const path = workflowStringInput(input, ["path", "file_path", "output_path"]).value || workflowPatchPath(patch);
  return normalizeArtifactPath(path).toLowerCase();
}

function workflowPatchPath(patch: string) {
  const value = String(patch || "");
  const match = value.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/m)
    || value.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)
    || value.match(/^---\s+(?:a\/)?(.+)$/m);
  return match?.[1]?.trim() || "";
}

function workflowInputBufferIndex(event: Extract<BackendEvent, { type: "tool_input_delta" }>) {
  const rawIndex = Number(event.tool_call_index);
  return Number.isFinite(rawIndex) ? rawIndex : 0;
}

function workflowInputBufferKey(event: Extract<BackendEvent, { type: "tool_input_delta" }>) {
  return `call:${workflowInputBufferIndex(event)}`;
}

function clearWorkflowInputBuffer(buffers: Record<string, string>, toolCallIndex: number | null) {
  const index = toolCallIndex ?? 0;
  const next = { ...buffers };
  delete next[`call:${index}`];
  return next;
}

function workflowDraftFromBuffer(toolName: string, buffer: string): { toolName: string; toolInput: Record<string, unknown> } | null {
  const oldField = firstPartialJsonStringField(buffer, ["old_str", "old_string"]);
  const newField = firstPartialJsonStringField(buffer, ["new_str", "new_string"]);
  const newSourceField = firstPartialJsonStringField(buffer, ["new_source"]);
  const contentField = firstPartialJsonStringField(buffer, ["content", "new_string"]);
  const patchField = firstPartialJsonStringField(buffer, ["patch", "diff"]);
  let inferredToolName = isWorkflowOutputTool(toolName) ? toolName : "";
  if (!inferredToolName && !toolName.trim()) {
    if (patchField.found) inferredToolName = "apply_patch";
    else if (newSourceField.found) inferredToolName = "notebook_edit";
    else if (oldField.found || newField.found) inferredToolName = "edit_file";
    else if (contentField.found) inferredToolName = "write_file";
  }
  if (!isWorkflowOutputTool(inferredToolName)) {
    return null;
  }
  const path = firstPartialJsonStringField(buffer, ["file_path", "path", "output_path"]);
  const input: Record<string, unknown> = {};
  if (path.found) {
    input.path = path.value;
  }
  if (inferredToolName.toLowerCase().includes("patch") && patchField.found) {
    input.patch = patchField.value;
    if (!input.path) {
      const patchPath = workflowPatchPath(patchField.value);
      if (patchPath) {
        input.path = patchPath;
      }
    }
    return { toolName: inferredToolName, toolInput: input };
  }
  if (inferredToolName.toLowerCase().includes("edit") && (oldField.found || newField.found)) {
    input.old_str = oldField.value;
    input.new_str = newField.value;
    input.content = formatWorkflowEditBlock(oldField.value, newField.value);
    return { toolName: inferredToolName, toolInput: input };
  }
  if (newSourceField.found) {
    input.new_source = newSourceField.value;
    input.content = newSourceField.value;
    return { toolName: inferredToolName, toolInput: input };
  }
  if (!contentField.found) {
    return null;
  }
  input.content = contentField.value;
  return { toolName: inferredToolName, toolInput: input };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function swarmText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function swarmNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeSwarmTeammate(value: SwarmTeammateSnapshot, index: number): SwarmTeammateSnapshot {
  const record = recordOrNull(value) || {};
  const taskId = swarmText(record.taskId) || swarmText(record.task_id);
  const id = swarmText(record.id) || swarmText(record.agent_id) || taskId || `swarm-agent-${index + 1}`;
  return {
    id,
    name: swarmText(record.name) || id,
    role: swarmText(record.role) || swarmText(record.name) || "작업자",
    model: swarmText(record.model),
    modelSource: swarmText(record.modelSource) || swarmText(record.model_source),
    prompt: swarmText(record.prompt),
    status: swarmText(record.status) || "idle",
    task: swarmText(record.task),
    startedAt: swarmNumber(record.startedAt ?? record.started_at),
    endedAt: swarmNumber(record.endedAt ?? record.ended_at),
    lastOutput: swarmText(record.lastOutput) || swarmText(record.last_output),
    taskId,
  };
}

function normalizeSwarmNotification(value: SwarmNotificationSnapshot, index: number): SwarmNotificationSnapshot {
  const record = recordOrNull(value) || {};
  return {
    id: swarmText(record.id) || `swarm-note-${index + 1}`,
    from: swarmText(record.from) || "AI 팀",
    message: swarmText(record.message),
    timestamp: swarmNumber(record.timestamp) ?? Date.now(),
    level: swarmText(record.level) || "info",
  };
}

function backendToolCallId(event: BackendEvent) {
  const value = "tool_call_id" in event ? event.tool_call_id : null;
  return typeof value === "string" && value ? value : null;
}

function backendToolCallIndex(event: BackendEvent) {
  const value = "tool_call_index" in event ? Number(event.tool_call_index) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function appendWorkflowEvent(events: WorkflowEvent[], event: Omit<WorkflowEvent, "id">) {
  return [...events, { id: nextId(), ...event }];
}

function isDefaultPlanningDetail(detail: string) {
  return new Set([
    "필요한 맥락과 진행 방향을 정리합니다.",
    "진행 방향을 정했습니다.",
  ]).has(compactWorkflowDetail(detail));
}

function completePlanning(events: WorkflowEvent[]) {
  return events.map((event) => (
    event.role === "planning"
      ? {
          ...event,
          status: "done" as const,
          detail: isDefaultPlanningDetail(event.detail) ? "진행 방향을 정했습니다." : event.detail,
        }
      : event
  ));
}

function removeWorkflowEventsByRole(events: WorkflowEvent[], role: WorkflowEvent["role"]) {
  return events.filter((event) => event.role !== role);
}

function purposeForTool(toolName: string) {
  const lower = toolName.toLowerCase();
  if (lower.includes("read") || lower.includes("grep") || lower.includes("glob") || lower.includes("web")) {
    return "info" as const;
  }
  if (lower.includes("test") || lower.includes("lint") || lower.includes("typecheck") || lower.includes("playwright")) {
    return "verification" as const;
  }
  return "action" as const;
}

function purposeCopy(purpose: WorkflowEvent["purpose"]) {
  if (purpose === "info") {
    return { title: "정보 수집", running: "필요한 자료와 맥락을 확인하고 있습니다.", done: "필요한 정보를 확인했습니다." };
  }
  if (purpose === "verification") {
    return { title: "결과 검증", running: "결과를 확인하고 있습니다.", done: "결과를 확인했습니다." };
  }
  return { title: "작업 실행", running: "필요한 변경이나 명령을 실행하고 있습니다.", done: "작업 실행을 마쳤습니다." };
}

function providerIdleLabel(detail: string) {
  const cleanDetail = compactWorkflowDetail(detail);
  const match = cleanDetail.match(/^(.+?)\s*응답을 기다리고 있습니다\.?$/);
  return match?.[1]?.trim() || "";
}

function followupWaitingDetail(statusDetail: string, previousDetail: string) {
  const label = providerIdleLabel(statusDetail) || "AI";
  const previous = compactWorkflowDetail(previousDetail);
  const resultState = previous.includes("파일 작성은 완료") || previous.includes("파일 작업은 완료")
    ? "파일 작성은 완료됐고, 결과를 모델에 전달했습니다."
    : "도구 실행은 완료됐고, 결과를 모델에 전달했습니다.";
  return `${label} 응답 대기 중입니다. ${resultState} 추가 도구 호출이나 최종 답변 이벤트를 기다립니다.`;
}

function workflowProgressDetailForTarget(event: WorkflowEvent, detail: string) {
  if (event.role === "activity" && event.status === "running" && providerIdleLabel(detail)) {
    return followupWaitingDetail(detail, event.detail);
  }
  return detail;
}

function statusTextForProgressNote(events: WorkflowEvent[], detail: string, fallback: string) {
  const idleLabel = providerIdleLabel(detail);
  if (!idleLabel) {
    return fallback;
  }
  const waitingForFollowup = events.some((event) => (
    event.role === "activity"
    && event.status === "running"
    && event.title === "후속 응답 대기"
  ));
  return waitingForFollowup ? `${idleLabel} 후속 응답 대기 중` : fallback;
}

function applyWorkflowProgressNote(events: WorkflowEvent[], detail: string) {
  const cleanDetail = truncateWorkflowDetail(detail, 220);
  if (!cleanDetail) {
    return events;
  }
  const runningChild = [...events].reverse().find((event) => (
    event.level === "child" && event.status === "running" && Boolean(event.groupId)
  ));
  if (runningChild?.groupId) {
    const purposeIndex = events.findIndex((event) => event.role === "purpose" && event.groupId === runningChild.groupId);
    if (purposeIndex !== -1) {
      if (compactWorkflowDetail(events[purposeIndex].detail) === cleanDetail) {
        return events;
      }
      return events.map((event, index) => index === purposeIndex ? mergeWorkflowEventPatch(event, { detail: cleanDetail }) : event);
    }
  }
  const targetRoles = new Set(["purpose", "activity", "planning", "final"]);
  const targetIndex = events
    .map((event, index) => ({ event, index }))
    .reverse()
    .find(({ event }) => Boolean(event.role) && targetRoles.has(event.role!) && event.level !== "child")?.index ?? -1;
  if (targetIndex === -1) {
    return events;
  }
  const targetDetail = workflowProgressDetailForTarget(events[targetIndex], cleanDetail);
  if (compactWorkflowDetail(events[targetIndex].detail) === targetDetail) {
    return events;
  }
  return events.map((event, index) => index === targetIndex ? mergeWorkflowEventPatch(event, { detail: targetDetail }) : event);
}

function genericPurposeDetails(purpose: WorkflowEvent["purpose"]) {
  const copy = purposeCopy(purpose);
  return new Set([
    copy.running,
    copy.done,
    "작업 중 문제가 발생했습니다.",
    "일부 자료 확인에 실패했지만, 가능한 정보로 계속 진행합니다.",
    "일부 단계에서 확인이 필요합니다.",
  ]);
}

function isAutoPurposeSummary(detail: string, purpose: WorkflowEvent["purpose"]) {
  const cleanDetail = compactWorkflowDetail(detail);
  if (!cleanDetail || genericPurposeDetails(purpose).has(cleanDetail)) {
    return true;
  }
  return /^(?:.+ 진행 중|.+ 완료|.+ 오류|.+ 확인 필요)(?: · .*)?$/.test(cleanDetail)
    || /^\d+개 작업 완료 · 마지막:/.test(cleanDetail);
}

function purposeFallbackDetail(purpose: WorkflowEvent["purpose"], status: WorkflowEventStatus) {
  const copy = purposeCopy(purpose);
  if (status === "running") return copy.running;
  if (status === "error") return "작업 중 문제가 발생했습니다.";
  if (status === "warning" && purpose === "info") return "일부 자료 확인에 실패했지만, 가능한 정보로 계속 진행합니다.";
  if (status === "warning") return "일부 단계에서 확인이 필요합니다.";
  return copy.done;
}

function isRecoverableToolError(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower.includes("web_search") || lower.includes("web_fetch");
}

function workflowCompletionStatus(toolName: string, isError: boolean): WorkflowEventStatus {
  if (!isError) {
    return "done";
  }
  return isRecoverableToolError(toolName) ? "warning" : "error";
}

function ensurePurposeEvent(events: WorkflowEvent[], toolName: string): { events: WorkflowEvent[]; groupId: string } {
  const purpose = purposeForTool(toolName);
  const latestPurpose = [...events].reverse().find((event) => event.role === "purpose");
  if (latestPurpose?.purpose === purpose && latestPurpose.groupId) {
    const copy = purposeCopy(purpose);
    return {
      events: events.map((event) => event.id === latestPurpose.id ? { ...event, status: "running", detail: copy.running } : event),
      groupId: latestPurpose.groupId,
    };
  }
  const groupId = `purpose-${nextId()}`;
  const copy = purposeCopy(purpose);
  return {
    events: appendWorkflowEvent(events, {
      toolName: "",
      title: copy.title,
      detail: copy.running,
      status: "running",
      level: "parent",
      role: "purpose",
      purpose,
      groupId,
    }),
    groupId,
  };
}

function refreshPurposeEvents(events: WorkflowEvent[]) {
  return events.map((event) => {
    if (event.role !== "purpose" || !event.groupId) return event;
    const children = events.filter((item) => item.groupId === event.groupId && item.role !== "purpose");
    if (!children.length) return event;
    const hasRunning = children.some((item) => item.status === "running");
    const hasError = children.some((item) => item.status === "error");
    const hasWarning = children.some((item) => item.status === "warning");
    const status = hasError ? "error" as const : hasRunning ? "running" as const : hasWarning ? "warning" as const : "done" as const;
    const currentDetail = compactWorkflowDetail(event.detail);
    return {
      ...event,
      status,
      detail: isAutoPurposeSummary(currentDetail, event.purpose)
        ? purposeFallbackDetail(event.purpose, status)
        : currentDetail,
    };
  });
}

function startActivityStep(events: WorkflowEvent[], copy = {
  title: "후속 응답 대기",
  detail: "도구 실행은 완료됐고, 결과를 모델에 전달했습니다. 다음 도구 호출이나 최종 답변 이벤트를 기다립니다.",
}): WorkflowEvent[] {
  if (events.some((event) => event.level === "child" && event.status === "running")) {
    return events;
  }
  const existingActivityIndex = events
    .map((event, index) => ({ event, index }))
    .reverse()
    .find(({ event }) => event.role === "activity")?.index ?? -1;
  if (existingActivityIndex !== -1) {
    return events.map((event, index) => index === existingActivityIndex
      ? mergeWorkflowEventPatch(event, {
          title: copy.title,
          status: "running",
          detail: copy.detail,
        })
      : event);
  }
  return appendWorkflowEvent(events, {
    toolName: "",
    title: copy.title,
    detail: copy.detail,
    status: "running",
    level: "parent",
    role: "activity",
  });
}

function completeActivityStep(events: WorkflowEvent[], detail = "다음 작업을 정했습니다."): WorkflowEvent[] {
  return events.map((event) => (
    event.role === "activity" && event.status === "running"
      ? mergeWorkflowEventPatch(event, {
          title: event.title === "후속 응답 대기" ? "후속 응답 수신" : "다음 단계 결정 완료",
          status: "done",
          detail,
        })
      : event
  ));
}

function followupActivityCopy(toolName: string, isError: boolean) {
  if (isError) {
    return {
      title: "오류 후속 응답 대기",
      detail: "도구 오류를 모델에 전달했습니다. 복구 방향이나 최종 안내 이벤트를 기다립니다.",
      statusText: "오류 후속 응답 대기 중",
    };
  }
  if (isWorkflowOutputTool(toolName)) {
    return {
      title: "후속 응답 대기",
      detail: "파일 작성은 완료됐고, 결과를 모델에 전달했습니다. 최종 안내나 추가 작업 이벤트를 기다립니다.",
      statusText: "후속 응답 대기 중",
    };
  }
  return {
    title: "후속 응답 대기",
    detail: "도구 실행은 완료됐고, 결과를 모델에 전달했습니다. 다음 도구 호출이나 최종 답변 이벤트를 기다립니다.",
    statusText: "후속 응답 대기 중",
  };
}

function answerDraftDetail(characterCount = 0) {
  return characterCount > 0
    ? `답변 본문을 작성하고 있습니다. ${characterCount.toLocaleString()}자 수신 중입니다.`
    : "답변이나 다음 도구 호출 내용을 작성하고 있습니다.";
}

function startFinalAnswerStep(events: WorkflowEvent[], characterCount = 0): WorkflowEvent[] {
  let next = completePlanning(completeActivityStep(events, "최종 답변 작성으로 넘어갑니다."));
  const existing = next.find((event) => event.role === "final");
  if (existing) {
    return next.map((event) => event.role === "final" ? {
      ...event,
      status: "running" as const,
      title: "응답 작성",
      detail: answerDraftDetail(characterCount),
    } : event);
  }
  next = appendWorkflowEvent(next, {
    toolName: "",
    title: "응답 작성",
    detail: answerDraftDetail(characterCount),
    status: "running",
    level: "parent",
    role: "final",
  });
  return refreshPurposeEvents(next);
}

function finishFinalAnswerStep(events: WorkflowEvent[], status: WorkflowEventStatus = "done", detail = "최종 답변을 작성했습니다."): WorkflowEvent[] {
  let next = completePlanning(completeActivityStep(events, "최종 답변 작성으로 넘어갔습니다."));
  const existing = next.find((event) => event.role === "final");
  if (!existing) {
    next = appendWorkflowEvent(next, {
      toolName: "",
      title: "최종 답변",
      detail,
      status,
      level: "parent",
      role: "final",
    });
  } else {
    next = next.map((event) => event.role === "final" ? { ...event, title: "응답 작성", status, detail } : event);
  }
  return refreshPurposeEvents(next);
}

function failRunningWorkflowEvents(events: WorkflowEvent[], detail: string): WorkflowEvent[] {
  const next = events.map((event) => {
    if (event.status !== "running" || event.role === "purpose") {
      return event;
    }
    return { ...event, status: "error" as const, detail };
  });
  return refreshPurposeEvents(next);
}

function rememberWorkflowEventsForAnchor(state: AppState, workflowEvents: WorkflowEvent[]): Record<string, WorkflowEvent[]> {
  if (!state.workflowAnchorMessageId || !workflowEvents.length) {
    return state.workflowEventsByMessageId;
  }
  return {
    ...state.workflowEventsByMessageId,
    [state.workflowAnchorMessageId]: workflowEvents,
  };
}

function updateLatestWorkflowEvent(
  events: WorkflowEvent[],
  toolName: string,
  patch: Partial<Omit<WorkflowEvent, "id" | "toolName">>,
  identity: { toolCallId?: string | null; toolCallIndex?: number | null } = {},
) {
  const callId = identity.toolCallId || null;
  const callIndex = identity.toolCallIndex ?? null;
  const patchPath = workflowOutputInputPath(patch.toolInput);
  const reversed = [...events].reverse();
  let index = callId
    ? reversed.findIndex((event) => event.toolCallId === callId && event.status === "running")
    : -1;
  if (index === -1 && callIndex !== null) {
    index = reversed.findIndex(
      (event) => event.toolName === toolName && event.toolCallIndex === callIndex && event.status === "running",
    );
  }
  if (index === -1 && callIndex !== null && isWorkflowOutputTool(toolName)) {
    index = reversed.findIndex(
      (event) => event.toolCallIndex === callIndex && event.status === "running" && isWorkflowOutputTool(event.toolName),
    );
  }
  if (index === -1 && patchPath && isWorkflowOutputTool(toolName)) {
    index = reversed.findIndex((event) => (
      event.toolName === toolName
      && event.status === "running"
      && workflowOutputInputPath(event.toolInput) === patchPath
    ));
  }
  if (index === -1) {
    index = reversed.findIndex((event) => (
      event.toolName === toolName
      && event.status === "running"
      && !event.toolCallId
      && (callIndex === null || event.toolCallIndex === callIndex || event.toolCallIndex === null)
    ));
  }
  if (index === -1) return null;
  const realIndex = events.length - 1 - index;
  return events.map((event, currentIndex) => (currentIndex === realIndex ? mergeWorkflowEventPatch(event, patch) : event));
}

function mergeWorkflowEventPatch(event: WorkflowEvent, patch: Partial<Omit<WorkflowEvent, "id" | "toolName">>) {
  const detailLog = workflowDetailLogForPatch(event, patch);
  if (patch.toolInput && event.toolInput) {
    return {
      ...event,
      ...patch,
      detailLog,
      toolInput: {
        ...event.toolInput,
        ...patch.toolInput,
      },
    };
  }
  return { ...event, ...patch, detailLog };
}

function workflowDetailLogForPatch(event: WorkflowEvent, patch: Partial<Omit<WorkflowEvent, "id" | "toolName">>) {
  if (typeof patch.detail !== "string") {
    return event.detailLog;
  }
  const previous = compactWorkflowDetail(event.detail);
  const next = compactWorkflowDetail(patch.detail);
  if (!previous || !next || workflowDetailLogKey(previous) === workflowDetailLogKey(next)) {
    return event.detailLog;
  }
  const existing = event.detailLog || [];
  if (existing.some((item) => workflowDetailLogKey(item) === workflowDetailLogKey(previous))) {
    return existing;
  }
  return [...existing, previous].slice(-5);
}

function workflowDetailLogKey(value: string) {
  return compactWorkflowDetail(value)
    .replace(/\b\d+\s*초\s*경과\b/g, "{elapsed}")
    .replace(/\b\d+\s*seconds?\s*elapsed\b/gi, "{elapsed}");
}

function workflowSnapshotMap(state: AppState) {
  if (!state.workflowAnchorMessageId || !state.workflowEvents.length) {
    return state.workflowEventsByMessageId;
  }
  return {
    ...state.workflowEventsByMessageId,
    [state.workflowAnchorMessageId]: state.workflowEvents,
  };
}

function workflowDurationSnapshotMap(state: AppState) {
  const durationSeconds = state.workflowDurationSeconds ?? workflowElapsedDurationSeconds(state);
  if (!state.workflowAnchorMessageId || durationSeconds === null) {
    return state.workflowDurationSecondsByMessageId;
  }
  return {
    ...state.workflowDurationSecondsByMessageId,
    [state.workflowAnchorMessageId]: durationSeconds,
  };
}

function workflowDurationFromMetadata(metadata?: Record<string, unknown> | null) {
  const seconds = Number(metadata?.workflow_duration_seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

function workflowElapsedDurationSeconds(state: AppState) {
  if (state.workflowStartedAtMs === null) {
    return null;
  }
  const seconds = Math.floor((Date.now() - state.workflowStartedAtMs) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

function normalizeCommands(commands: unknown[]): CommandItem[] {
  return commands
    .map((command) => {
      if (typeof command === "string") {
        return { name: command, description: "" };
      }
      if (command && typeof command === "object") {
        const raw = command as Record<string, unknown>;
        return {
          name: String(raw.name || raw.command || "").trim(),
          description: String(raw.description || raw.detail || "").trim(),
        };
      }
      return { name: "", description: "" };
    })
    .filter((command) => command.name);
}

function normalizeSkills(skills: unknown[]): SkillItem[] {
  return skills
    .map((skill) => {
      if (typeof skill === "string") {
        return { name: skill, description: "", enabled: true };
      }
      if (skill && typeof skill === "object") {
        const raw = skill as Record<string, unknown>;
        return {
          name: String(raw.name || "").trim(),
          description: String(raw.description || "").trim(),
          source: String(raw.source || "").trim(),
          enabled: raw.enabled !== false,
        };
      }
      return { name: "", description: "", enabled: true };
    })
    .filter((skill) => skill.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePlugins(plugins: unknown[]): PluginItem[] {
  return plugins
    .map((plugin) => {
      if (typeof plugin === "string") {
        return { name: plugin, description: "", enabled: true };
      }
      if (plugin && typeof plugin === "object") {
        const raw = plugin as Record<string, unknown>;
        const skillCount = Number(raw.skill_count);
        const commandCount = Number(raw.command_count);
        const mcpServerCount = Number(raw.mcp_server_count);
        return {
          name: String(raw.name || "").trim(),
          description: String(raw.description || "").trim(),
          enabled: raw.enabled !== false,
          skill_count: Number.isFinite(skillCount) ? skillCount : undefined,
          skills: normalizeSkills(Array.isArray(raw.skills) ? raw.skills : []),
          command_count: Number.isFinite(commandCount) ? commandCount : undefined,
          mcp_server_count: Number.isFinite(mcpServerCount) ? mcpServerCount : undefined,
        };
      }
      return { name: "", description: "", enabled: true };
    })
    .filter((plugin) => plugin.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeMcpServers(servers: unknown[]): AppState["mcpServers"] {
  return servers
    .map((server) => {
      if (typeof server === "string") {
        return { name: server, state: "configured" };
      }
      if (server && typeof server === "object") {
        const raw = server as Record<string, unknown>;
        const toolCount = Number(raw.tool_count);
        const resourceCount = Number(raw.resource_count);
        return {
          name: String(raw.name || "").trim(),
          state: String(raw.state || "configured").trim(),
          detail: String(raw.detail || "").trim(),
          transport: String(raw.transport || "").trim(),
          tool_count: Number.isFinite(toolCount) ? toolCount : undefined,
          resource_count: Number.isFinite(resourceCount) ? resourceCount : undefined,
        };
      }
      return { name: "", state: "configured" };
    })
    .filter((server) => server.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeChatTitle(value: string) {
  return value.trim() || "MyHarness";
}

function updateCurrentHistoryTitle(history: HistoryItem[], sessionId: string | null, title: string) {
  if (!sessionId) return history;
  return history.map((item) => (
    item.value === sessionId ? { ...item, description: title } : item
  ));
}

function removeLiveHistoryRowsForSession(history: HistoryItem[], sessionId: string | null) {
  const activeSessionId = String(sessionId || "").trim();
  if (!activeSessionId) return history;
  return history.filter((item) => !isLiveOnlyHistoryItem(item, activeSessionId));
}

function historyVisibilityKeyFromAction(action: { sessionId: string; workspacePath?: string; workspaceName?: string }) {
  return historyVisibilityKey(action.sessionId, action.workspacePath || "", action.workspaceName || "");
}

function rememberHiddenHistoryKey(hiddenHistoryKeys: string[], key: string) {
  if (!key || hiddenHistoryKeys.includes(key)) {
    return hiddenHistoryKeys;
  }
  return normalizeHiddenHistoryKeys([...hiddenHistoryKeys, key]);
}

function forgetHiddenHistoryKey(hiddenHistoryKeys: string[], key: string) {
  if (!key || !hiddenHistoryKeys.includes(key)) {
    return hiddenHistoryKeys;
  }
  return hiddenHistoryKeys.filter((item) => item !== key);
}

function removeHiddenHistoryRows(state: AppState, history: HistoryItem[]) {
  if (state.adminMode) {
    return history;
  }
  return history.filter((item) => !isHistoryItemHidden(item, state.hiddenHistoryKeys, state.workspacePath, state.workspaceName));
}

function visibleHistoryRows(state: AppState, history: HistoryItem[]) {
  return removeLiveHistoryRowsForSession(removeHiddenHistoryRows(state, history), state.sessionId);
}

function isCurrentHistoryHidden(state: AppState, sessionId: string) {
  const key = historyVisibilityKey(sessionId, state.workspacePath, state.workspaceName);
  return Boolean(key && state.hiddenHistoryKeys.includes(key));
}

function ensureLiveHistoryItem(state: AppState, userText: string) {
  const sessionId = state.activeHistoryId || state.sessionId;
  if (!sessionId) return state.history;
  if (!state.adminMode && isCurrentHistoryHidden(state, sessionId)) return state.history;
  if (state.history.some((item) => item.value === sessionId)) {
    return state.history;
  }
  const description = state.chatTitle !== "MyHarness"
    ? state.chatTitle
    : userText.trim().replace(/\s+/g, " ").slice(0, 50) || "새 채팅";
  return [
    {
      value: sessionId,
      label: "진행 중인 채팅",
      description,
      workspace: state.workspacePath || state.workspaceName
        ? { name: state.workspaceName, path: state.workspacePath, scope: state.workspaceScope }
        : null,
    },
    ...state.history,
  ];
}

function ensureSavedNewChatHistoryItem(state: AppState, sessionId: string) {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return state.history;
  if (!state.adminMode && isCurrentHistoryHidden(state, cleanSessionId)) return state.history;
  if (state.history.some((item) => item.value === cleanSessionId)) {
    return state.history;
  }
  return [
    {
      value: cleanSessionId,
      label: "진행 중인 채팅",
      description: "새 대화",
      workspace: state.workspacePath || state.workspaceName
        ? { name: state.workspaceName, path: state.workspacePath, scope: state.workspaceScope }
        : null,
      pending: true,
    },
    ...state.history,
  ];
}

function applyStateSnapshot(state: AppState, event: Extract<BackendEvent, { type: "ready" | "state_snapshot" }>): AppState {
  const snapshot = event.state || {};
  const provider = String(snapshot.provider || state.provider);
  const activeProfile = String(snapshot.active_profile || state.activeProfile || provider);
  const providerLabel = String(snapshot.provider_label || state.providerLabel || provider);
  return {
    ...state,
    ready: event.type === "ready" ? true : state.ready,
    status: event.type === "ready" ? "ready" : state.status,
    statusText: event.type === "ready" ? "준비됨" : state.statusText,
    provider,
    activeProfile,
    providerLabel,
    model: String(snapshot.model || state.model),
    subagentModel: String(snapshot.subagent_model || state.subagentModel),
    subagentEffort: String(snapshot.subagent_effort || state.subagentEffort),
    effort: String(snapshot.effort || state.effort),
    permissionMode: String(snapshot.permission_mode || state.permissionMode),
    workspaceName: String(snapshot.workspace?.name || state.workspaceName),
    workspacePath: String(snapshot.workspace?.path || state.workspacePath),
    workspaceScope: snapshot.workspace?.scope || state.workspaceScope,
  };
}

function normalizeRuntimeOption(option: Record<string, unknown>): { value: string; label: string; description?: string; active?: boolean } | null {
  const value = String(option.value || option.name || option.label || "").trim();
  const label = String(option.label || option.name || option.value || "").trim();
  if (!value && !label) return null;
  return {
    value: value || label,
    label: label || value,
    description: typeof option.description === "string" ? option.description : undefined,
    active: option.active === true,
  };
}

function activeRuntimeOptions(options: Array<{ value: string; label: string; description?: string; active?: boolean }>, currentValue: string) {
  const current = String(currentValue || "").trim().toLowerCase();
  const activeIndex = options.findIndex((option) => String(option.value || "").trim().toLowerCase() === current)
    ?? -1;
  const fallbackIndex = activeIndex >= 0 ? activeIndex : options.findIndex((option) => option.active);
  return options.map((option, index) => ({ ...option, active: index === fallbackIndex }));
}

function runtimeModelValueForScope(state: AppState, scope = state.runtimePicker.agentScope) {
  return scope === "sub" ? state.subagentModel : state.model;
}

function runtimeEffortValueForScope(state: AppState, scope = state.runtimePicker.agentScope) {
  return scope === "sub" ? state.subagentEffort : state.effort;
}

function runtimePickerFromOptions(state: AppState, runtimeOptions: Record<string, unknown>) {
  const subagentModel = String(runtimeOptions.subagent_model || state.subagentModel || "").trim() || state.subagentModel;
  const subagentEffort = String(runtimeOptions.subagent_effort || state.subagentEffort || "").trim() || state.subagentEffort;
  const activeProviderProfile = String(state.activeProfile || state.provider || "").trim();
  const providers = activeRuntimeOptions(
    (Array.isArray(runtimeOptions.providers) ? runtimeOptions.providers : [])
      .map((option) => normalizeRuntimeOption(option as Record<string, unknown>))
      .filter((option): option is NonNullable<typeof option> => Boolean(option)),
    activeProviderProfile,
  );
  const rawModels = runtimeOptions.models_by_provider && typeof runtimeOptions.models_by_provider === "object"
    ? runtimeOptions.models_by_provider as Record<string, unknown>
    : {};
  const modelsByProvider = Object.fromEntries(Object.entries(rawModels).map(([provider, options]) => [
    provider,
    activeRuntimeOptions(
      (Array.isArray(options) ? options : [])
        .map((option) => normalizeRuntimeOption(option as Record<string, unknown>))
        .filter((option): option is NonNullable<typeof option> => Boolean(option)),
      state.runtimePicker.agentScope === "sub" ? subagentModel : state.model,
    ),
  ]));
  const selectedProvider = providers.find((option) => option.active)?.value
    || (modelsByProvider[activeProviderProfile] ? activeProviderProfile : "")
    || state.provider
    || providers[0]?.value
    || "";
  const models = modelsByProvider[selectedProvider] || [];
  const efforts = activeRuntimeOptions(
    (Array.isArray(runtimeOptions.efforts) ? runtimeOptions.efforts : [])
      .map((option) => normalizeRuntimeOption(option as Record<string, unknown>))
      .filter((option): option is NonNullable<typeof option> => Boolean(option)),
    runtimeEffortValueForScope({ ...state, subagentEffort }),
  );
  return {
    ...state.runtimePicker,
    open: true,
    loading: false,
    error: "",
    providers,
    modelsByProvider,
    models,
    efforts,
    selectedProvider,
    agentScope: state.runtimePicker.agentScope || "main",
    modelOpen: false,
    effortOpen: false,
  };
}

type BackendModalState = Extract<ModalState, { kind: "backend" }>;

function backendModalKeysForState(state: AppState) {
  return Array.from(new Set([state.sessionId, state.activeHistoryId].filter((value): value is string => Boolean(value))));
}

function currentTodoSessionId(state: AppState) {
  return state.activeHistoryId || state.sessionId || null;
}

function isCompletedTodoMarkdown(markdown: string) {
  const checklistItems = String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[([ xX])\]\s+.+$/)?.[1])
    .filter((mark): mark is string => Boolean(mark));

  return checklistItems.length > 0 && checklistItems.every((mark) => mark.toLowerCase() === "x");
}

function completeTodoMarkdown(markdown: string) {
  return String(markdown || "").replace(/^(\s*[-*]\s+\[)[ xX](\]\s+.+)$/gm, "$1x$2");
}

function rememberCurrentBackendModal(state: AppState) {
  const keys = backendModalKeysForState(state);
  if (!keys.length || state.modal?.kind !== "backend") {
    return state.backendModalsBySessionId;
  }
  return keys.reduce((next, key) => ({ ...next, [key]: state.modal as BackendModalState }), state.backendModalsBySessionId);
}

function forgetCurrentBackendModal(state: AppState) {
  const keys = backendModalKeysForState(state);
  if (!keys.length || state.modal?.kind !== "backend") {
    return state.backendModalsBySessionId;
  }
  const next = { ...state.backendModalsBySessionId };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function rememberBackendModalForActiveSession(state: AppState, modal: BackendModalState) {
  const keys = backendModalKeysForState(state);
  if (!keys.length) {
    return state.backendModalsBySessionId;
  }
  return keys.reduce((next, key) => ({ ...next, [key]: modal }), state.backendModalsBySessionId);
}

function backendModalForSession(
  backendModalsBySessionId: AppState["backendModalsBySessionId"],
  sessionId: string,
) {
  return backendModalsBySessionId[sessionId] || null;
}

function liveSessionViewKeysForState(state: AppState) {
  return Array.from(new Set([state.sessionId, state.activeHistoryId].filter((value): value is string => Boolean(value))));
}

function currentLiveSessionView(state: AppState): LiveSessionView {
  return {
    activeHistoryId: state.activeHistoryId,
    chatTitle: state.chatTitle,
    messages: state.messages,
    workflowAnchorMessageId: state.workflowAnchorMessageId,
    workflowEventsByMessageId: state.workflowEventsByMessageId,
    workflowDurationSecondsByMessageId: state.workflowDurationSecondsByMessageId,
    workflowInputBuffers: state.workflowInputBuffers,
    workflowEvents: state.workflowEvents,
    workflowDurationSeconds: state.workflowDurationSeconds,
    workflowStartedAtMs: state.workflowStartedAtMs,
    todoMarkdown: state.todoMarkdown,
    todoSessionId: state.todoSessionId,
    todoCollapsed: state.todoCollapsed,
    swarmTeammates: state.swarmTeammates,
    swarmNotifications: state.swarmNotifications,
  };
}

function rememberCurrentLiveSessionView(state: AppState) {
  if (!state.sessionId || state.historyReadOnly || (!state.messages.length && !state.workflowEvents.length)) {
    return state.liveSessionViewsBySessionId;
  }
  const view = currentLiveSessionView(state);
  return liveSessionViewKeysForState(state).reduce(
    (next, key) => ({ ...next, [key]: view }),
    state.liveSessionViewsBySessionId,
  );
}

function liveSessionViewForSession(
  liveSessionViewsBySessionId: AppState["liveSessionViewsBySessionId"],
  sessionId: string,
) {
  return liveSessionViewsBySessionId[sessionId] || null;
}

function isResumeSelectModal(modal: ModalState | null) {
  if (modal?.kind !== "backend") {
    return false;
  }
  return String(modal.payload?.command || "").trim().toLowerCase() === "resume";
}

function reduceHistoryRestoreEvent(
  state: AppState,
  event: Extract<BackendEvent, { type: "history_snapshot" }>,
): AppState {
  const historyEvent = event as Extract<BackendEvent, { type: "history_snapshot" }>;
  const messages: ChatMessage[] = [];
  let workflowEvents: WorkflowEvent[] = [];
  let workflowAnchorMessageId: string | null = null;
  const workflowEventsByMessageId: Record<string, WorkflowEvent[]> = {};
  const workflowDurationSecondsByMessageId: Record<string, number> = {};
  let restoredSwarmTeammates = state.swarmTeammates;
  let restoredSwarmNotifications = state.swarmNotifications;
  let workflowInputBuffers: Record<string, string> = {};
  let currentTurnHasAssistant = false;
  const historyEvents = (Array.isArray(historyEvent.history_events) ? historyEvent.history_events : [])
    .map((item) => (item && typeof item === "object" ? item as Record<string, unknown> : {}));
  for (const [index, record] of historyEvents.entries()) {
    const type = String(record.type || "");
    if (type === "swarm_status") {
      restoredSwarmTeammates = Array.isArray(record.swarm_teammates)
        ? record.swarm_teammates.map((item, teammateIndex) => normalizeSwarmTeammate(item as SwarmTeammateSnapshot, teammateIndex))
        : restoredSwarmTeammates;
      restoredSwarmNotifications = Array.isArray(record.swarm_notifications)
        ? record.swarm_notifications.map((item, notificationIndex) => normalizeSwarmNotification(item as SwarmNotificationSnapshot, notificationIndex)).slice(-20)
        : restoredSwarmNotifications;
      continue;
    }
    if (type === "user") {
      if (workflowAnchorMessageId && hasRestorableWorkflowEvents(workflowEvents)) {
        workflowEventsByMessageId[workflowAnchorMessageId] = workflowEvents;
      }
      const message = createMessage({ role: "user", text: String(record.text || ""), createdAt: timestampMsFromRecord(record) });
      messages.push(message);
      workflowAnchorMessageId = message.id;
      workflowEvents = initialWorkflowEvents();
      workflowInputBuffers = {};
      currentTurnHasAssistant = false;
      continue;
    }
    if (type === "assistant") {
      const artifacts = normalizeAssistantArtifacts(record.artifacts);
      const text = String(record.text || "").trim() || (artifacts.length ? "작성 완료했습니다." : "");
      if (text.trim() || artifacts.length) {
        if (isFinalRestoredAssistantAnswer(historyEvents, index)) {
          messages.push(createMessage({
            role: "assistant",
            text,
            isComplete: true,
            createdAt: timestampMsFromRecord(record),
            artifacts: artifacts.length ? artifacts : undefined,
          }));
          currentTurnHasAssistant = true;
        } else {
          workflowEvents = applyWorkflowProgressNote(
            completePlanning(removeWorkflowEventsByRole(workflowEvents.length ? workflowEvents : initialWorkflowEvents(), "final")),
            text,
          );
        }
      }
      continue;
    }
    if (type === "line_complete") {
      const workflowDurationSeconds = workflowDurationFromMetadata(record);
      if (workflowDurationSeconds !== null && workflowAnchorMessageId && currentTurnHasAssistant) {
        workflowEvents = finishFinalAnswerStep(workflowEvents.length ? workflowEvents : initialWorkflowEvents());
        workflowEventsByMessageId[workflowAnchorMessageId] = workflowEvents;
        workflowDurationSecondsByMessageId[workflowAnchorMessageId] = workflowDurationSeconds;
      }
      continue;
    }
    if (type === "tool_started") {
      const toolName = String(record.tool_name || "");
      const toolInput = recordOrNull(record.tool_input);
      const detail = workflowToolDetail(state.skills, toolName, toolInput);
      const toolCallId = typeof record.tool_call_id === "string" && record.tool_call_id ? record.tool_call_id : null;
      const rawToolCallIndex = Number(record.tool_call_index);
      const toolCallIndex = Number.isFinite(rawToolCallIndex) ? rawToolCallIndex : null;
      const purpose = ensurePurposeEvent(completePlanning(workflowEvents.length ? workflowEvents : initialWorkflowEvents()), toolName);
      workflowEvents = updateLatestWorkflowEvent(purpose.events, toolName, {
        detail,
        status: "running",
        toolCallId,
        toolCallIndex,
        toolInput,
      }, { toolCallId, toolCallIndex }) || appendWorkflowEvent(purpose.events, {
        toolName,
        title: workflowTitle(toolName),
        detail,
        status: "running",
        level: "child",
        groupId: purpose.groupId,
        toolCallId,
        toolCallIndex,
        toolInput,
      });
      workflowEvents = refreshPurposeEvents(workflowEvents);
      workflowInputBuffers = clearWorkflowInputBuffer(workflowInputBuffers, toolCallIndex);
      continue;
    }
    if (type === "tool_input_delta") {
      const toolName = String(record.tool_name || "");
      const rawToolCallIndex = Number(record.tool_call_index);
      const toolCallIndex = Number.isFinite(rawToolCallIndex) ? rawToolCallIndex : null;
      const delta = String(record.arguments_delta || "");
      if (!delta) {
        continue;
      }
      const deltaEvent = {
        type: "tool_input_delta",
        tool_name: toolName,
        tool_call_index: toolCallIndex,
        arguments_delta: delta,
      } as Extract<BackendEvent, { type: "tool_input_delta" }>;
      const key = workflowInputBufferKey(deltaEvent);
      const current = workflowInputBuffers[key] || "";
      const nextBuffer = current && /^\s*\{/.test(delta) && /\}\s*$/.test(current) ? delta : `${current}${delta}`;
      workflowInputBuffers = { ...workflowInputBuffers, [key]: nextBuffer };
      const draft = workflowDraftFromBuffer(toolName, nextBuffer);
      if (!draft) {
        continue;
      }
      const { toolName: workflowToolName, toolInput } = draft;
      const detail = workflowDetailFromInput(toolInput) || "작성 내용 수신 중";
      let nextEvents = updateLatestWorkflowEvent(workflowEvents, workflowToolName, {
        detail,
        status: "running",
        toolCallIndex,
        toolInput,
      }, { toolCallIndex });
      if (!nextEvents) {
        const purpose = ensurePurposeEvent(
          completePlanning(completeActivityStep(workflowEvents.length ? workflowEvents : initialWorkflowEvents())),
          workflowToolName,
        );
        nextEvents = appendWorkflowEvent(purpose.events, {
          toolName: workflowToolName,
          title: workflowTitle(workflowToolName),
          detail,
          status: "running",
          level: "child",
          groupId: purpose.groupId,
          toolCallIndex,
          toolInput,
        });
      }
      workflowEvents = refreshPurposeEvents(nextEvents);
      continue;
    }
    if (type === "tool_progress") {
      const toolName = String(record.tool_name || "");
      const toolCallId = typeof record.tool_call_id === "string" && record.tool_call_id ? record.tool_call_id : null;
      const rawToolCallIndex = Number(record.tool_call_index);
      const toolCallIndex = Number.isFinite(rawToolCallIndex) ? rawToolCallIndex : null;
      const toolInput = recordOrNull(record.tool_input);
      const detail = String(record.message || workflowDetailFromInput(toolInput) || "처리 중");
      let nextEvents = updateLatestWorkflowEvent(workflowEvents, toolName, {
        detail,
        status: "running",
        toolCallId,
        toolCallIndex,
        toolInput,
      }, { toolCallId, toolCallIndex });
      if (!nextEvents) {
        const purpose = ensurePurposeEvent(completePlanning(workflowEvents.length ? workflowEvents : initialWorkflowEvents()), toolName);
        nextEvents = appendWorkflowEvent(purpose.events, {
          toolName,
          title: `${workflowTitle(toolName)} 중`,
          detail,
          status: "running",
          level: "child",
          groupId: purpose.groupId,
          toolCallId,
          toolCallIndex,
          toolInput,
        });
      }
      workflowEvents = refreshPurposeEvents(nextEvents);
      continue;
    }
    if (type === "tool_completed") {
      const toolName = String(record.tool_name || "");
      const toolCallId = typeof record.tool_call_id === "string" && record.tool_call_id ? record.tool_call_id : null;
      const rawToolCallIndex = Number(record.tool_call_index);
      const toolCallIndex = Number.isFinite(rawToolCallIndex) ? rawToolCallIndex : null;
      const output = String(record.output || "");
      const isError = record.is_error === true;
      const completionStatus = workflowCompletionStatus(toolName, isError);
      const lastToolInput = [...workflowEvents]
        .reverse()
        .find((workflowEvent) => {
          if (toolCallId) {
            return workflowEvent.toolCallId === toolCallId && workflowEvent.toolInput;
          }
          if (toolCallIndex !== null) {
            return workflowEvent.toolName === toolName && workflowEvent.toolCallIndex === toolCallIndex && workflowEvent.toolInput;
          }
          return workflowEvent.toolName === toolName && workflowEvent.toolInput;
        })?.toolInput || null;
      const detail = workflowToolDetail(state.skills, toolName, lastToolInput, output, `${toolName || "도구"} 완료`, isError);
      let nextEvents = updateLatestWorkflowEvent(workflowEvents, toolName, {
        detail,
        output,
        status: completionStatus,
        toolCallId,
        toolCallIndex,
      }, { toolCallId, toolCallIndex });
      if (!nextEvents) {
        const purpose = ensurePurposeEvent(completePlanning(workflowEvents.length ? workflowEvents : initialWorkflowEvents()), toolName);
        nextEvents = appendWorkflowEvent(purpose.events, {
          toolName,
          title: workflowTitle(toolName),
          detail,
          output,
          status: completionStatus,
          level: "child",
          groupId: purpose.groupId,
          toolCallId,
          toolCallIndex,
        });
      }
      workflowEvents = refreshPurposeEvents(nextEvents);
      workflowInputBuffers = clearWorkflowInputBuffer(workflowInputBuffers, toolCallIndex);
    }
  }
  if (workflowAnchorMessageId && hasRestorableWorkflowEvents(workflowEvents)) {
    workflowEventsByMessageId[workflowAnchorMessageId] = workflowEvents;
    const workflowDurationSeconds = workflowDurationFromMetadata(historyEvent.compact_metadata);
    if (workflowDurationSeconds) {
      workflowDurationSecondsByMessageId[workflowAnchorMessageId] = workflowDurationSeconds;
    }
  } else if (workflowAnchorMessageId && currentTurnHasAssistant) {
    const workflowDurationSeconds = workflowDurationFromMetadata(historyEvent.compact_metadata);
    if (workflowDurationSeconds !== null) {
      workflowEvents = finishFinalAnswerStep(workflowEvents.length ? workflowEvents : initialWorkflowEvents());
      workflowEventsByMessageId[workflowAnchorMessageId] = workflowEvents;
      workflowDurationSecondsByMessageId[workflowAnchorMessageId] = workflowDurationSeconds;
    }
  }
  const restoredWorkflowAnchorMessageId = hasRestorableWorkflowEvents(workflowEvents) ? workflowAnchorMessageId : null;
  const restoredWorkflowEvents = restoredWorkflowAnchorMessageId ? workflowEvents : [];
  const stillRestoring = state.restoringHistory || Boolean(state.pendingHistoryId);
  return {
    ...state,
    activeHistoryId: String(historyEvent.value || state.pendingHistoryId || state.activeHistoryId || "").trim() || null,
    pendingHistoryId: null,
    chatTitle: normalizeChatTitle(String(historyEvent.message || state.chatTitle || "")),
    messages,
    workflowAnchorMessageId: restoredWorkflowAnchorMessageId,
    workflowEventsByMessageId,
    workflowDurationSecondsByMessageId,
    workflowEvents: restoredWorkflowEvents,
    workflowDurationSeconds: restoredWorkflowAnchorMessageId ? workflowDurationSecondsByMessageId[restoredWorkflowAnchorMessageId] ?? null : null,
    workflowStartedAtMs: null,
    swarmTeammates: restoredSwarmTeammates,
    swarmNotifications: restoredSwarmNotifications,
    restoringHistory: true,
    historyReadOnly: true,
    pendingFreshChat: false,
    preserveMessagesOnNextClearTranscript: false,
    busy: false,
    status: stillRestoring ? "processing" : "ready",
    statusText: stillRestoring ? "대화 불러오는 중" : "준비됨",
  };
}

type WorkflowToolBackendEvent = Extract<BackendEvent, {
  type: "tool_started" | "tool_input_delta" | "tool_progress" | "tool_completed";
}>;

function reduceWorkflowToolEvent(state: AppState, event: WorkflowToolBackendEvent): AppState {
  if (event.type === "tool_started") {
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const label = compactToolStatus(toolName, "도구 실행 중");
    const toolInput = recordOrNull(event.tool_input);
    const toolCallId = backendToolCallId(event);
    const toolCallIndex = backendToolCallIndex(event);
    const detail = workflowToolDetail(state.skills, toolName, toolInput);
    const purpose = ensurePurposeEvent(
      completePlanning(completeActivityStep(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents())),
      toolName,
    );
    const command = isShellTool(toolName) ? commandFromToolInput(toolInput) : "";
    const messages = command
      ? updateLatestTerminalMessage(state.messages, command, { command, status: "running" }) || state.messages
      : state.messages;
    const startedWorkflowEvents = updateLatestWorkflowEvent(purpose.events, toolName, {
      detail,
      status: "running",
      toolCallId,
      toolCallIndex,
      toolInput,
    }, { toolCallId, toolCallIndex }) || appendWorkflowEvent(purpose.events, {
      toolName,
      title: workflowTitle(toolName),
      detail,
      status: "running",
      level: "child",
      groupId: purpose.groupId,
      toolCallId,
      toolCallIndex,
      toolInput,
    });
    return {
      ...state,
      busy: true,
      messages,
      status: "processing",
      statusText: label,
      workflowInputBuffers: clearWorkflowInputBuffer(state.workflowInputBuffers, toolCallIndex),
      workflowEvents: refreshPurposeEvents(startedWorkflowEvents),
    };
  }

  if (event.type === "tool_input_delta") {
    const deltaEvent = event as Extract<BackendEvent, { type: "tool_input_delta" }>;
    const toolName = typeof deltaEvent.tool_name === "string" ? deltaEvent.tool_name : "";
    const toolCallIndex = backendToolCallIndex(deltaEvent);
    const delta = String(deltaEvent.arguments_delta || "");
    if (!delta) {
      return state;
    }
    const key = workflowInputBufferKey(deltaEvent);
    const current = state.workflowInputBuffers[key] || "";
    const nextBuffer = current && /^\s*\{/.test(delta) && /\}\s*$/.test(current) ? delta : `${current}${delta}`;
    const draft = workflowDraftFromBuffer(toolName, nextBuffer);
    const workflowInputBuffers = { ...state.workflowInputBuffers, [key]: nextBuffer };
    if (!draft) {
      return { ...state, busy: true, workflowInputBuffers };
    }
    const { toolName: workflowToolName, toolInput } = draft;
    const detail = workflowDetailFromInput(toolInput) || "작성 내용 수신 중";
    let workflowEvents = updateLatestWorkflowEvent(state.workflowEvents, workflowToolName, {
      detail,
      status: "running",
      toolCallIndex,
      toolInput,
    }, { toolCallIndex });
    if (!workflowEvents) {
      const purpose = ensurePurposeEvent(
        completePlanning(completeActivityStep(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents())),
        workflowToolName,
      );
      workflowEvents = appendWorkflowEvent(purpose.events, {
        toolName: workflowToolName,
        title: workflowTitle(workflowToolName),
        detail,
        status: "running",
        level: "child",
        groupId: purpose.groupId,
        toolCallIndex,
        toolInput,
      });
    }
    return {
      ...state,
      busy: true,
      workflowInputBuffers,
      workflowEvents: refreshPurposeEvents(workflowEvents),
      status: "processing",
      statusText: compactToolStatus(workflowToolName, `${workflowTitle(workflowToolName)} 중`),
    };
  }

  if (event.type === "tool_progress") {
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const toolCallId = backendToolCallId(event);
    const toolCallIndex = backendToolCallIndex(event);
    const toolInput = recordOrNull(event.tool_input);
    const detail = String(event.message || workflowDetailFromInput(toolInput) || "처리 중");
    let workflowEvents = updateLatestWorkflowEvent(state.workflowEvents, toolName, {
      detail,
      status: "running",
      toolCallId,
      toolCallIndex,
      toolInput,
    }, { toolCallId, toolCallIndex });
    if (!workflowEvents) {
      const purpose = ensurePurposeEvent(completePlanning(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents()), toolName);
      workflowEvents = appendWorkflowEvent(purpose.events, {
        toolName,
        title: `${workflowTitle(toolName)} 중`,
        detail,
        status: "running",
        level: "child",
        groupId: purpose.groupId,
        toolCallId,
        toolCallIndex,
        toolInput,
      });
    }
    return {
      ...state,
      busy: true,
      workflowEvents: refreshPurposeEvents(workflowEvents),
      status: "processing",
      statusText: compactToolStatus(toolName),
    };
  }

  if (event.type === "tool_completed") {
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const toolCallId = backendToolCallId(event);
    const toolCallIndex = backendToolCallIndex(event);
    const output = String(event.output || "");
    const isError = event.is_error === true;
    const lastToolInput = [...state.workflowEvents]
      .reverse()
      .find((workflowEvent) => {
        if (toolCallId) {
          return workflowEvent.toolCallId === toolCallId && workflowEvent.toolInput;
        }
        if (toolCallIndex !== null) {
          return workflowEvent.toolName === toolName && workflowEvent.toolCallIndex === toolCallIndex && workflowEvent.toolInput;
        }
        return workflowEvent.toolName === toolName && workflowEvent.toolInput;
      })?.toolInput || null;
    const command = isShellTool(toolName) ? commandFromToolInput(lastToolInput) : "";
    const completionStatus = workflowCompletionStatus(toolName, isError);
    const messages = command
      ? updateLatestTerminalMessage(state.messages, command, {
          command,
          output,
          status: isError ? "error" : "done",
        }) || state.messages
      : state.messages;
    const detail = workflowToolDetail(state.skills, toolName, lastToolInput, output, `${toolName || "도구"} 완료`, isError);
    let workflowEvents = updateLatestWorkflowEvent(state.workflowEvents, toolName, {
      detail,
      output,
      status: completionStatus,
      toolCallId,
      toolCallIndex,
    }, { toolCallId, toolCallIndex });
    if (!workflowEvents) {
      const purpose = ensurePurposeEvent(completePlanning(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents()), toolName);
      workflowEvents = appendWorkflowEvent(purpose.events, {
        toolName,
        title: workflowTitle(toolName),
        detail,
        output,
        status: completionStatus,
        level: "child",
        groupId: purpose.groupId,
        toolCallId,
        toolCallIndex,
      });
    }
    const followupCopy = followupActivityCopy(toolName, isError);
    workflowEvents = startActivityStep(refreshPurposeEvents(workflowEvents), followupCopy);
    return {
      ...state,
      busy: true,
      messages,
      workflowEvents,
      workflowInputBuffers: clearWorkflowInputBuffer(state.workflowInputBuffers, toolCallIndex),
      status: "processing",
      statusText: followupCopy.statusText,
    };
  }

  return state;
}

function reduceBackendEvent(state: AppState, action: Extract<AppAction, { type: "backend_event" }>): AppState {
  if (action.sessionId && action.sessionId !== state.sessionId) {
    return state;
  }
  const event = action.event;
  if (state.historyReadOnly && event.type !== "history_snapshot") {
    return state;
  }

  if (event.type === "ready" || event.type === "state_snapshot") {
    const next = applyStateSnapshot(state, event as Extract<BackendEvent, { type: "ready" | "state_snapshot" }>);
    if (event.type === "ready") {
      return {
        ...next,
        commands: normalizeCommands(Array.isArray(event.commands) ? event.commands : []),
        skills: normalizeSkills(Array.isArray(event.skills) ? event.skills : []),
        plugins: normalizePlugins(Array.isArray(event.plugins) ? event.plugins : []),
        mcpServers: normalizeMcpServers(Array.isArray(event.mcp_servers) ? event.mcp_servers : []),
      };
    }
    return {
      ...next,
      ...(Array.isArray(event.plugins) ? { plugins: normalizePlugins(event.plugins) } : {}),
      ...(Array.isArray(event.mcp_servers) ? { mcpServers: normalizeMcpServers(event.mcp_servers) } : {}),
    };
  }

  if (event.type === "skills_snapshot") {
    return {
      ...state,
      skills: normalizeSkills(Array.isArray(event.skills) ? event.skills : []),
    };
  }

  if (event.type === "clear_transcript") {
    if (state.restoringHistory) {
      return {
        ...state,
        preserveMessagesOnNextClearTranscript: false,
      };
    }
    if (state.preserveMessagesOnNextClearTranscript && state.busy && state.messages.length > 0) {
      return {
        ...state,
        preserveMessagesOnNextClearTranscript: false,
      };
    }
    return {
      ...state,
      preserveMessagesOnNextClearTranscript: false,
      messages: [],
      workflowAnchorMessageId: null,
      workflowEventsByMessageId: {},
      workflowDurationSecondsByMessageId: {},
      workflowInputBuffers: {},
      todoMarkdown: "",
      todoSessionId: null,
      workflowEvents: [],
      workflowDurationSeconds: null,
      workflowStartedAtMs: null,
    };
  }

  if (event.type === "history_snapshot") {
    return reduceHistoryRestoreEvent(state, event as Extract<BackendEvent, { type: "history_snapshot" }>);
  }

  if (event.type === "status") {
    const text = String(event.message || event.value || "");
    const workflowEvents = state.workflowAnchorMessageId && state.workflowEvents.length
      ? applyWorkflowProgressNote(state.workflowEvents, text)
      : state.workflowEvents;
    return {
      ...state,
      statusText: text ? statusTextForProgressNote(workflowEvents, text, text) : state.statusText,
      workflowEvents,
    };
  }

  if (event.type === "session_title") {
    const title = normalizeChatTitle(String(event.message ?? event.value ?? ""));
    return {
      ...state,
      chatTitle: title,
      history: updateCurrentHistoryTitle(state.history, state.activeHistoryId || state.sessionId, title),
    };
  }

  if (event.type === "active_session") {
    const activeHistoryId = String(event.value || "").trim() || null;
    if (state.restoringHistory && state.pendingHistoryId && activeHistoryId !== state.pendingHistoryId) {
      return state;
    }
    return {
      ...state,
      activeHistoryId,
      pendingHistoryId: null,
      restoringHistory: false,
      pendingFreshChat: false,
      preserveMessagesOnNextClearTranscript: false,
      status: state.busy ? state.status : "ready",
      statusText: state.busy ? state.statusText : "준비됨",
    };
  }

  if (event.type === "transcript_item" && event.item) {
    const item = event.item as NonNullable<Extract<BackendEvent, { type: "transcript_item" }>["item"]>;
    if (isNonConversationTranscriptItem(item)) {
      return state;
    }
    const text = normalizeVisibleText(item.text);
    if (item.role === "user" && (item.kind === "steering" || item.kind === "queued")) {
      if (isDuplicateKindedUserTranscript(state, text, item.kind)) {
        return state;
      }
    }
    if (item.role === "user" && item.kind !== "steering" && item.kind !== "queued") {
      if (isDuplicateActiveUserTranscript(state, text)) {
        return state;
      }
      const message = createMessage({
        role: item.role,
        text,
        kind: item.kind || undefined,
        toolName: item.tool_name || undefined,
        isError: item.is_error === true,
      });
      if (isSlashCommandMessage(text)) {
        return {
          ...state,
          messages: [...state.messages, message],
        };
      }
      return {
        ...state,
        messages: [...state.messages, message],
        workflowAnchorMessageId: message.id,
        workflowEventsByMessageId: workflowSnapshotMap(state),
        workflowDurationSecondsByMessageId: workflowDurationSnapshotMap(state),
        workflowEvents: initialWorkflowEvents(text),
        workflowDurationSeconds: null,
        workflowStartedAtMs: Date.now(),
      };
    }
    return {
      ...state,
      messages: appendMessage(state.messages, {
        role: item.role,
        text,
        kind: item.kind || undefined,
        toolName: item.tool_name || undefined,
        isError: item.is_error === true,
        isComplete: item.role === "assistant" ? true : undefined,
      }),
    };
  }

  if (event.type === "assistant_delta") {
    const value = String(event.message ?? event.value ?? "");
    const last = state.messages[state.messages.length - 1];
    const shouldAppendToLastAssistant = last?.role === "assistant" && last.isComplete === undefined;
    const characterCount = (shouldAppendToLastAssistant ? last.text.length : 0) + value.length;
    const workflowEvents = startFinalAnswerStep(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents(), characterCount);
    if (shouldAppendToLastAssistant) {
      return {
        ...state,
        busy: true,
        status: "processing",
        statusText: "응답 작성 중",
        workflowEvents,
        messages: [
          ...state.messages.slice(0, -1),
          { ...last, text: assistantStreamingText(last.text, value) },
        ],
      };
    }
    return {
      ...state,
      busy: true,
      status: "processing",
      statusText: "응답 작성 중",
      workflowEvents,
      messages: appendMessage(state.messages, { role: "assistant", text: value }),
    };
  }

  if (event.type === "assistant_complete") {
    const artifacts = normalizeAssistantArtifacts([
      ...workflowEventArtifactCandidates(state.workflowEvents),
      ...normalizeAssistantArtifacts(event.artifacts),
    ]);
    const rawValue = normalizeVisibleText(String(event.message || ""));
    const value = rawValue || (artifacts.length ? "작성 완료했습니다." : "");
    const last = state.messages[state.messages.length - 1];
    const isFinalAnswer = event.has_tool_uses !== true;
    if (isFinalAnswer && isDuplicateAssistantCompletion(last, value, artifacts)) {
      return {
        ...state,
        busy: false,
        status: "ready",
        statusText: "준비됨",
      };
    }
    const shouldCompleteTodo = isFinalAnswer && artifacts.length > 0 && Boolean(state.todoMarkdown.trim());
    const todoMarkdown = shouldCompleteTodo ? completeTodoMarkdown(state.todoMarkdown) : state.todoMarkdown;
    const messages = isFinalAnswer
      ? value
        ? last?.role === "assistant" && last.isComplete !== true
          ? [
              ...state.messages.slice(0, -1),
              {
                ...last,
                text: assistantCompletionText(last.text, value),
                isComplete: true,
                createdAt: Date.now(),
                artifacts: mergeAssistantArtifacts(last.artifacts, artifacts),
              },
            ]
          : appendMessage(state.messages, { role: "assistant", text: value, isComplete: true, createdAt: Date.now(), artifacts })
        : last?.role === "assistant"
          ? [...state.messages.slice(0, -1), { ...last, isComplete: true, createdAt: Date.now(), artifacts: mergeAssistantArtifacts(last.artifacts, artifacts) }]
          : state.messages
      : completePendingAssistantMessage(state.messages, value, true, artifacts);
    return {
      ...state,
      busy: event.has_tool_uses === true,
      messages,
      workflowEvents: isFinalAnswer
        ? finishFinalAnswerStep(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents())
        : value
          ? applyWorkflowProgressNote(
              completePlanning(removeWorkflowEventsByRole(state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents(), "final")),
              value,
            )
          : removeWorkflowEventsByRole(state.workflowEvents, "final"),
      status: event.has_tool_uses === true ? "processing" : "ready",
      statusText: event.has_tool_uses === true ? "도구 실행 준비 중" : "준비됨",
      artifactRefreshKey: isFinalAnswer ? state.artifactRefreshKey + 1 : state.artifactRefreshKey,
      todoMarkdown,
      todoCollapsed: isFinalAnswer && todoMarkdown.trim() ? true : state.todoCollapsed,
    };
  }

  if (
    event.type === "tool_started"
    || event.type === "tool_input_delta"
    || event.type === "tool_progress"
    || event.type === "tool_completed"
  ) {
    return reduceWorkflowToolEvent(state, event as WorkflowToolBackendEvent);
  }

  if (event.type === "todo_update") {
    const todoMarkdown = String(event.todo_markdown || "");
    const hasTodo = Boolean(todoMarkdown.trim());
    return {
      ...state,
      todoMarkdown,
      todoSessionId: hasTodo ? currentTodoSessionId(state) : null,
      todoCollapsed: hasTodo ? state.todoCollapsed || isCompletedTodoMarkdown(todoMarkdown) : false,
    };
  }

  if (event.type === "swarm_status") {
    const teammates = Array.isArray(event.swarm_teammates)
      ? event.swarm_teammates.map(normalizeSwarmTeammate)
      : state.swarmTeammates;
    const notifications = Array.isArray(event.swarm_notifications)
      ? [...state.swarmNotifications, ...event.swarm_notifications.map(normalizeSwarmNotification)].slice(-20)
      : state.swarmNotifications;
    return {
      ...state,
      swarmTeammates: teammates,
      swarmNotifications: notifications,
      swarmPopupOpen: state.swarmPopupOpen,
    };
  }

  if (event.type === "modal_request") {
    const payload = event.modal && typeof event.modal === "object"
      ? event.modal as Record<string, unknown>
      : {};
    const modal: BackendModalState = { kind: "backend", payload };
    return {
      ...state,
      modal,
      backendModalsBySessionId: rememberBackendModalForActiveSession(state, modal),
    };
  }

  if (event.type === "select_request") {
    const modal = event.modal && typeof event.modal === "object" ? event.modal as Record<string, unknown> : {};
    const command = String(modal.command || "").trim().toLowerCase();
    if (command === "resume") {
      const history = Array.isArray(event.select_options)
        ? event.select_options as HistoryItem[]
        : [];
      return {
        ...state,
        history: visibleHistoryRows(state, history),
        historyLoading: false,
        modal: state.modal?.kind === "backend" ? null : state.modal,
      };
    }
    if (state.runtimePicker.open && command === "runtime-picker") {
      const runtimeOptions = modal.runtime_options && typeof modal.runtime_options === "object"
        ? modal.runtime_options as Record<string, unknown>
        : {};
      return {
        ...state,
        runtimePicker: runtimePickerFromOptions(state, runtimeOptions),
      };
    }
    const payload = {
      ...modal,
      select_options: Array.isArray(event.select_options) ? event.select_options : [],
      message: event.message || "",
    };
    const nextModal: BackendModalState = { kind: "backend", payload };
    return {
      ...state,
      modal: nextModal,
      backendModalsBySessionId: rememberBackendModalForActiveSession(state, nextModal),
    };
  }

  if (event.type === "line_complete") {
    const hasRestorableWorkflow = hasRestorableWorkflowEvents(state.workflowEvents);
    const workflowAnchorMessageId = hasRestorableWorkflow ? state.workflowAnchorMessageId : null;
    const workflowEvents = hasRestorableWorkflow
      ? refreshPurposeEvents(completeActivityStep(completePlanning(state.workflowEvents), "작업을 마쳤습니다."))
      : [];
    const workflowDurationSeconds = hasRestorableWorkflow
      ? workflowDurationFromMetadata(recordOrNull(event.compact_metadata)) ?? workflowElapsedDurationSeconds(state)
      : null;
    const workflowDurationSecondsByMessageId = workflowDurationSeconds !== null && workflowAnchorMessageId
      ? {
          ...state.workflowDurationSecondsByMessageId,
          [workflowAnchorMessageId]: workflowDurationSeconds,
        }
      : state.workflowDurationSecondsByMessageId;
    return {
      ...state,
      busy: false,
      status: state.status === "error" ? "error" : "ready",
      statusText: state.status === "error" ? state.statusText : "준비됨",
      artifactRefreshKey: event.type === "line_complete" ? state.artifactRefreshKey + 1 : state.artifactRefreshKey,
      historyRefreshKey: state.historyRefreshKey + 1,
      workflowAnchorMessageId,
      workflowEvents,
      workflowDurationSeconds: hasRestorableWorkflow ? workflowDurationSeconds ?? state.workflowDurationSeconds : null,
      workflowDurationSecondsByMessageId,
      workflowStartedAtMs: null,
    };
  }

  if (event.type === "shutdown") {
    const message = "진행 중이던 세션이 종료되었습니다. 새 세션에 다시 연결한 뒤 이어서 입력해주세요.";
    const workflowEvents = state.busy
      ? finishFinalAnswerStep(
          failRunningWorkflowEvents(
            state.workflowEvents.length ? state.workflowEvents : initialWorkflowEvents(),
            "백엔드가 종료되어 작업을 중단했습니다.",
          ),
          "error",
          message,
        )
      : state.workflowEvents;
    return {
      ...state,
      sessionId: null,
      ready: false,
      busy: false,
      status: "connecting",
      statusText: "세션이 종료되어 새 세션에 다시 연결 중입니다.",
      messages: state.busy ? appendErrorMessage(state.messages, message) : state.messages,
      workflowEvents,
      workflowEventsByMessageId: rememberWorkflowEventsForAnchor(state, workflowEvents),
      workflowDurationSeconds: state.workflowDurationSeconds ?? workflowElapsedDurationSeconds(state),
      workflowStartedAtMs: null,
    };
  }

  if (event.type === "error") {
    const message = normalizeVisibleText(String(event.message || "오류"));
    const workflowEvents = state.workflowEvents.length
      ? finishFinalAnswerStep(
          failRunningWorkflowEvents(state.workflowEvents, "오류로 작업을 중단했습니다."),
          "error",
          message || "응답을 마무리하지 못했습니다.",
        )
      : state.workflowEvents;
    return {
      ...state,
      messages: appendErrorMessage(state.messages, message),
      workflowEvents,
      workflowEventsByMessageId: rememberWorkflowEventsForAnchor(state, workflowEvents),
      busy: false,
      status: "error",
      statusText: message,
      workflowDurationSeconds: state.workflowDurationSeconds ?? workflowElapsedDurationSeconds(state),
      workflowStartedAtMs: null,
    };
  }

  return state;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "session_started":
      {
        const backendModalsBySessionId = rememberCurrentBackendModal(state);
        const liveSessionViewsBySessionId = rememberCurrentLiveSessionView(state);
        const historyBase = removeLiveHistoryRowsForSession(state.history, action.sessionId);
        const pendingFirstUserText = state.pendingFreshChat
          ? state.messages.find((message) => message.role === "user" && !message.kind)?.text || ""
          : "";
        const history = pendingFirstUserText
          ? ensureLiveHistoryItem({
              ...state,
              sessionId: action.sessionId,
              activeHistoryId: null,
              history: historyBase,
            }, pendingFirstUserText)
          : historyBase;
        const busy = action.busy === true;
        const restoredLiveView = busy ? liveSessionViewForSession(liveSessionViewsBySessionId, action.sessionId) : null;
        return {
        ...state,
        sessionId: action.sessionId,
        clientId: action.clientId || state.clientId,
        modal: backendModalForSession(backendModalsBySessionId, action.sessionId),
        backendModalsBySessionId,
        liveSessionViewsBySessionId,
        swarmPopupOpen: false,
        history,
        historyReadOnly: false,
        pendingFreshChat: false,
        preserveMessagesOnNextClearTranscript: restoredLiveView ? true : state.preserveMessagesOnNextClearTranscript,
        activeHistoryId: restoredLiveView?.activeHistoryId ?? state.activeHistoryId,
        chatTitle: restoredLiveView?.chatTitle ?? state.chatTitle,
        messages: restoredLiveView?.messages ?? state.messages,
        workflowAnchorMessageId: restoredLiveView?.workflowAnchorMessageId ?? state.workflowAnchorMessageId,
        workflowEventsByMessageId: restoredLiveView?.workflowEventsByMessageId ?? state.workflowEventsByMessageId,
        workflowDurationSecondsByMessageId: restoredLiveView?.workflowDurationSecondsByMessageId ?? state.workflowDurationSecondsByMessageId,
        workflowInputBuffers: restoredLiveView?.workflowInputBuffers ?? state.workflowInputBuffers,
        workflowEvents: restoredLiveView?.workflowEvents ?? state.workflowEvents,
        workflowDurationSeconds: restoredLiveView?.workflowDurationSeconds ?? state.workflowDurationSeconds,
        workflowStartedAtMs: restoredLiveView?.workflowStartedAtMs ?? state.workflowStartedAtMs,
        todoMarkdown: restoredLiveView?.todoMarkdown ?? state.todoMarkdown,
        todoSessionId: restoredLiveView?.todoSessionId ?? state.todoSessionId,
        todoCollapsed: restoredLiveView?.todoCollapsed ?? state.todoCollapsed,
        swarmTeammates: restoredLiveView?.swarmTeammates ?? state.swarmTeammates,
        swarmNotifications: restoredLiveView?.swarmNotifications ?? state.swarmNotifications,
        busy,
        status: busy ? "processing" : "ready",
        statusText: busy ? "응답 진행 중" : "준비됨",
      };
      }

    case "append_message":
      if (action.message.role === "user" && action.message.kind !== "steering" && action.message.kind !== "queued") {
        const message = createMessage(action.message);
        if (isSlashCommandMessage(action.message.text)) {
          return {
            ...state,
            historyReadOnly: false,
            preserveMessagesOnNextClearTranscript: !/^\/clear(?:\s|$)/i.test(action.message.text.trim()),
            messages: [...state.messages, message],
          };
        }
        const shouldPreserveOnClear = !/^\/clear(?:\s|$)/i.test(action.message.text.trim());
        return {
          ...state,
          historyReadOnly: false,
          preserveMessagesOnNextClearTranscript: shouldPreserveOnClear,
          history: action.skipHistory ? state.history : ensureLiveHistoryItem(state, action.message.text),
          messages: [...state.messages, message],
          workflowAnchorMessageId: message.id,
          workflowEventsByMessageId: workflowSnapshotMap(state),
          workflowDurationSecondsByMessageId: workflowDurationSnapshotMap(state),
          workflowEvents: initialWorkflowEvents(action.message.text),
          workflowDurationSeconds: null,
          workflowStartedAtMs: Date.now(),
        };
      }
      return {
        ...state,
        historyReadOnly: false,
        messages: appendMessage(state.messages, action.message),
      };

    case "session_replaced":
      {
        const backendModalsBySessionId = rememberCurrentBackendModal(state);
        const liveSessionViewsBySessionId = rememberCurrentLiveSessionView(state);
        return {
        ...state,
        sessionId: action.sessionId,
        chatTitle: "MyHarness",
        ready: false,
        busy: false,
        status: "connecting",
        statusText: "연결 중",
        messages: [],
        workflowAnchorMessageId: null,
        workflowEventsByMessageId: {},
        workflowDurationSecondsByMessageId: {},
        workflowInputBuffers: {},
        activeHistoryId: null,
        restoringHistory: false,
        historyReadOnly: false,
        pendingFreshChat: false,
        preserveMessagesOnNextClearTranscript: false,
        artifacts: [],
        artifactPanelOpen: false,
        activeArtifact: null,
        activeArtifactPayload: null,
        artifactRefreshKey: state.artifactRefreshKey + 1,
        modal: backendModalForSession(backendModalsBySessionId, action.sessionId),
        backendModalsBySessionId,
        liveSessionViewsBySessionId,
        swarmPopupOpen: false,
        todoMarkdown: "",
        todoSessionId: null,
        todoCollapsed: false,
        swarmTeammates: [],
        swarmNotifications: [],
        workflowEvents: [],
        workflowDurationSeconds: null,
        workflowStartedAtMs: null,
        history: removeLiveHistoryRowsForSession(state.history, action.sessionId),
        workspaceName: action.workspace?.name || state.workspaceName,
        workspacePath: action.workspace?.path || state.workspacePath,
        workspaceScope: action.workspace?.scope || state.workspaceScope,
      };
      }

    case "set_theme":
      return { ...state, themeId: action.themeId };

    case "set_sidebar_collapsed": {
      const sidebarCollapseReason: SidebarCollapseReason = action.value
        ? action.source || "manual"
        : action.source === "manual"
          ? "manual"
          : null;
      return {
        ...state,
        sidebarCollapsed: action.value,
        sidebarCollapseReason,
        runtimePicker: action.value ? { ...state.runtimePicker, open: false, loading: false, error: "" } : state.runtimePicker,
      };
    }

    case "release_sidebar_manual_open":
      return !state.sidebarCollapsed && state.sidebarCollapseReason === "manual"
        ? { ...state, sidebarCollapseReason: null }
        : state;

    case "set_sidebar_width":
      return { ...state, sidebarWidth: action.value };

    case "set_sidebar_resizing":
      return { ...state, sidebarResizing: action.value };

    case "set_draft":
      return { ...state, composer: { ...state.composer, draft: action.value } };

    case "set_busy":
      return action.value
        ? {
            ...state,
            busy: true,
            status: "processing",
            statusText: state.statusText === "준비됨" || state.statusText === "연결 중" ? "응답 진행 중" : state.statusText,
          }
        : { ...state, busy: false };

    case "set_permission_mode":
      return { ...state, permissionMode: action.value };

    case "set_chat_title": {
      const title = normalizeChatTitle(action.value);
      return {
        ...state,
        chatTitle: title,
        history: updateCurrentHistoryTitle(state.history, state.activeHistoryId || state.sessionId, title),
      };
    }

    case "set_system_prompt": {
      try {
        localStorage.setItem("myharness:systemPrompt", action.value);
      } catch {
        // Embedded/private contexts may block localStorage.
      }
      return { ...state, systemPrompt: action.value };
    }

    case "set_app_settings": {
      const appSettings = normalizeAppSettings({ ...state.appSettings, ...action.value });
      saveAppSettings(appSettings);
      return { ...state, appSettings };
    }

    case "set_admin_mode": {
      const adminMode = action.value === true;
      saveAdminModePreference(adminMode);
      const nextState = { ...state, adminMode };
      return {
        ...nextState,
        history: adminMode ? state.history : visibleHistoryRows(nextState, state.history),
        historyRefreshKey: state.historyRefreshKey + 1,
      };
    }

    case "clear_composer":
      return {
        ...state,
        composer: { draft: "", attachments: [], pastedTexts: [], token: null },
      };

    case "add_attachment":
      return {
        ...state,
        composer: {
          ...state.composer,
          attachments: [...state.composer.attachments, action.attachment],
        },
      };

    case "remove_attachment":
      return {
        ...state,
        composer: {
          ...state.composer,
          attachments: state.composer.attachments.filter((_, index) => index !== action.index),
        },
      };

    case "add_pasted_text":
      return {
        ...state,
        composer: {
          ...state.composer,
          pastedTexts: [...state.composer.pastedTexts, action.text],
        },
      };

    case "remove_pasted_text":
      return {
        ...state,
        composer: {
          ...state.composer,
          pastedTexts: state.composer.pastedTexts.filter((_, index) => index !== action.index),
        },
      };

    case "set_workspaces":
      return {
        ...state,
        workspaces: action.workspaces,
        workspaceScope: action.scope || state.workspaceScope,
      };

    case "set_workspace":
      return {
        ...state,
        workspaceName: action.workspace.name,
        workspacePath: action.workspace.path,
        workspaceScope: action.workspace.scope || state.workspaceScope,
      };

    case "set_history":
      return {
        ...state,
        history: visibleHistoryRows(state, action.history),
        historyLoading: false,
        modal: isResumeSelectModal(state.modal) ? null : state.modal,
      };

    case "hide_history_local": {
      const hiddenKey = historyVisibilityKeyFromAction(action);
      const hiddenHistoryKeys = rememberHiddenHistoryKey(state.hiddenHistoryKeys, hiddenKey);
      if (hiddenHistoryKeys !== state.hiddenHistoryKeys) {
        saveHiddenHistoryKeys(hiddenHistoryKeys);
      }
      const hidesActiveHistory = action.sessionId === state.activeHistoryId;
      const nextState = {
        ...state,
        hiddenHistoryKeys,
        activeHistoryId: hidesActiveHistory ? null : state.activeHistoryId,
        chatTitle: hidesActiveHistory ? "MyHarness" : state.chatTitle,
        pendingFreshChat: hidesActiveHistory ? false : state.pendingFreshChat,
      };
      return {
        ...nextState,
        history: visibleHistoryRows(nextState, state.history),
      };
    }

    case "delete_history_local": {
      const hiddenKey = historyVisibilityKeyFromAction(action);
      const hiddenHistoryKeys = forgetHiddenHistoryKey(state.hiddenHistoryKeys, hiddenKey);
      if (hiddenHistoryKeys !== state.hiddenHistoryKeys) {
        saveHiddenHistoryKeys(hiddenHistoryKeys);
      }
      const deletesActiveHistory = action.sessionId === state.activeHistoryId;
      return {
        ...state,
        hiddenHistoryKeys,
        activeHistoryId: deletesActiveHistory ? null : state.activeHistoryId,
        chatTitle: deletesActiveHistory ? "MyHarness" : state.chatTitle,
        pendingFreshChat: deletesActiveHistory ? false : state.pendingFreshChat,
        history: state.history.filter((item) => item.value !== action.sessionId),
      };
    }

    case "set_history_loading":
      return { ...state, historyLoading: action.value };

    case "begin_new_chat": {
      const savedSessionId = String(action.sessionId || "").trim();
      return {
        ...state,
        liveSessionViewsBySessionId: rememberCurrentLiveSessionView(state),
        chatTitle: "MyHarness",
        busy: false,
        status: state.sessionId ? "ready" : state.status,
        statusText: state.sessionId ? "준비됨" : state.statusText,
        messages: [],
        workflowAnchorMessageId: null,
        workflowEventsByMessageId: {},
        workflowDurationSecondsByMessageId: {},
        workflowInputBuffers: {},
        activeHistoryId: savedSessionId || null,
        pendingHistoryId: null,
        restoringHistory: false,
        historyReadOnly: false,
        pendingFreshChat: Boolean(state.sessionId && !savedSessionId),
        preserveMessagesOnNextClearTranscript: false,
        artifactPanelOpen: false,
        activeArtifact: null,
        activeArtifactPayload: null,
        todoMarkdown: "",
        todoSessionId: null,
        todoCollapsed: false,
        swarmTeammates: [],
        swarmNotifications: [],
        swarmPopupOpen: false,
        workflowEvents: [],
        workflowDurationSeconds: null,
        workflowStartedAtMs: null,
        modal: null,
        backendModalsBySessionId: rememberCurrentBackendModal(state),
        history: savedSessionId ? ensureSavedNewChatHistoryItem(state, savedSessionId) : state.history,
      };
    }

    case "begin_history_restore":
      {
        const backendModalsBySessionId = rememberCurrentBackendModal(state);
        const liveSessionViewsBySessionId = rememberCurrentLiveSessionView(state);
        return {
        ...state,
        liveSessionViewsBySessionId,
        busy: false,
        status: "processing",
        statusText: "대화 불러오는 중",
        pendingHistoryId: action.sessionId,
        restoringHistory: true,
        historyReadOnly: false,
        pendingFreshChat: false,
        preserveMessagesOnNextClearTranscript: false,
        modal: null,
        artifactPanelOpen: false,
        activeArtifact: null,
        activeArtifactPayload: null,
        swarmPopupOpen: false,
        runtimePicker: { ...state.runtimePicker, open: false },
        backendModalsBySessionId,
      };
      }

    case "finish_history_restore":
      return {
        ...state,
        pendingHistoryId: null,
        restoringHistory: false,
        status: state.busy ? state.status : "ready",
        statusText: state.busy ? state.statusText : "준비됨",
      };

    case "set_artifacts":
      return { ...state, artifacts: action.artifacts };

    case "refresh_artifacts":
      return { ...state, artifactRefreshKey: state.artifactRefreshKey + 1 };

    case "set_artifact_panel_width":
      if (state.activeArtifact) {
        return { ...state, artifactPanelWidth: action.value, artifactPanelPreviewWidth: action.value };
      }
      {
        const listWidth = action.value === null ? null : Math.min(action.value, 500);
        return { ...state, artifactPanelWidth: listWidth, artifactPanelListWidth: listWidth };
      }

    case "set_artifact_resizing":
      return { ...state, artifactResizing: action.value };

    case "open_artifact_list":
      return {
        ...state,
        artifactPanelOpen: true,
        activeArtifact: null,
        activeArtifactPayload: null,
        artifactPanelWidth: state.artifactPanelListWidth,
      };

    case "open_artifact":
      return {
        ...state,
        artifactPanelOpen: true,
        activeArtifact: action.artifact,
        activeArtifactPayload: action.payload || null,
        artifactPanelWidth: state.artifactPanelPreviewWidth,
      };

    case "set_artifact_payload":
      return { ...state, activeArtifactPayload: action.payload };

    case "close_artifact":
      return {
        ...state,
        artifactPanelOpen: false,
        activeArtifact: null,
        activeArtifactPayload: null,
      };

    case "open_modal":
      return {
        ...state,
        modal: action.modal,
        backendModalsBySessionId: action.modal.kind === "backend"
          ? rememberBackendModalForActiveSession(state, action.modal)
          : state.backendModalsBySessionId,
      };

    case "close_modal":
      return {
        ...state,
        modal: null,
        backendModalsBySessionId: forgetCurrentBackendModal(state),
      };

    case "open_runtime_picker":
      return {
        ...state,
        modal: state.modal?.kind === "modelSettings" ? null : state.modal,
        runtimePicker: { ...state.runtimePicker, open: true, loading: true, error: "" },
      };

    case "close_runtime_picker":
      return { ...state, runtimePicker: { ...state.runtimePicker, open: false, loading: false, error: "" } };

    case "set_swarm_popup_open":
      return { ...state, swarmPopupOpen: action.value };

    case "set_runtime_picker_error":
      return { ...state, runtimePicker: { ...state.runtimePicker, open: true, loading: false, error: action.message } };

    case "select_runtime_provider": {
      const models = state.runtimePicker.modelsByProvider[action.value] || [];
      const modelValue = runtimeModelValueForScope(state);
      return {
        ...state,
        provider: action.value,
        activeProfile: action.value,
        providerLabel: state.runtimePicker.providers.find((option) => option.value === action.value)?.label || state.providerLabel,
        runtimePicker: {
          ...state.runtimePicker,
          providers: state.runtimePicker.providers.map((option) => ({ ...option, active: option.value === action.value })),
          selectedProvider: action.value,
          models: activeRuntimeOptions(models, modelValue),
          modelOpen: true,
          effortOpen: false,
        },
      };
    }

    case "select_runtime_agent_scope": {
      const models = state.runtimePicker.modelsByProvider[state.runtimePicker.selectedProvider] || state.runtimePicker.models;
      return {
        ...state,
        runtimePicker: {
          ...state.runtimePicker,
          agentScope: action.value,
          models: activeRuntimeOptions(models, action.value === "sub" ? state.subagentModel : state.model),
          efforts: activeRuntimeOptions(state.runtimePicker.efforts, runtimeEffortValueForScope(state, action.value)),
          modelOpen: true,
          effortOpen: false,
        },
      };
    }

    case "select_runtime_model":
      return {
        ...state,
        ...(state.runtimePicker.agentScope === "sub" ? { subagentModel: action.value } : { model: action.value }),
        runtimePicker: {
          ...state.runtimePicker,
          models: state.runtimePicker.models.map((option) => ({ ...option, active: option.value === action.value })),
          efforts: activeRuntimeOptions(state.runtimePicker.efforts, runtimeEffortValueForScope(state)),
          effortOpen: true,
        },
      };

    case "select_runtime_effort":
      return {
        ...state,
        ...(state.runtimePicker.agentScope === "sub" ? { subagentEffort: action.value } : { effort: action.value }),
        runtimePicker: {
          ...state.runtimePicker,
          efforts: state.runtimePicker.efforts.map((option) => ({ ...option, active: option.value === action.value })),
        },
      };

    case "toggle_todo_collapsed":
      return { ...state, todoCollapsed: !state.todoCollapsed };

    case "dismiss_todo":
      return { ...state, todoMarkdown: "", todoSessionId: null, todoCollapsed: false };

    case "clear_workflow":
      return { ...state, workflowEvents: [], workflowEventsByMessageId: {}, workflowDurationSecondsByMessageId: {}, workflowDurationSeconds: null, workflowStartedAtMs: null };

    case "clear_messages":
      return { ...state, messages: [], workflowAnchorMessageId: null, workflowEventsByMessageId: {}, workflowDurationSecondsByMessageId: {}, workflowInputBuffers: {}, todoMarkdown: "", todoSessionId: null, todoCollapsed: false, workflowEvents: [], workflowDurationSeconds: null, workflowStartedAtMs: null };

    case "backend_event":
      return reduceBackendEvent(state, action);

    default:
      return state;
  }
}
