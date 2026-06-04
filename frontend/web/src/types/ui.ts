import type { ArtifactSummary, Attachment, CommandItem, HistoryItem, McpServerItem, PluginItem, SkillItem, SwarmNotificationSnapshot, SwarmTeammateSnapshot, TranscriptItem, UsageCostSummary, Workspace, WorkspaceScope } from "./backend";

export type StatusKind =
  | "connecting"
  | "startingBackend"
  | "ready"
  | "thinking"
  | "sending"
  | "processing"
  | "restoring"
  | "error"
  | "stopped"
  | "startFailed"
  | "connectionError";

export type ChatMessage = {
  id: string;
  role: TranscriptItem["role"];
  text: string;
  createdAt?: number;
  kind?: TranscriptItem["kind"];
  toolName?: string;
  isError?: boolean;
  isComplete?: boolean;
  suppressActions?: boolean;
  usage?: UsageCostSummary;
  sessionUsage?: UsageCostSummary | null;
  terminal?: {
    command: string;
    output?: string;
    status?: "running" | "done" | "error";
  };
  artifacts?: ArtifactSummary[];
};

export type LiveSessionView = {
  activeHistoryId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  workflowAnchorMessageId: string | null;
  workflowEventsByMessageId: Record<string, WorkflowEvent[]>;
  workflowDurationSecondsByMessageId: Record<string, number>;
  workflowInputBuffers: Record<string, string>;
  workflowEvents: WorkflowEvent[];
  workflowDurationSeconds: number | null;
  workflowStartedAtMs: number | null;
  todoMarkdown: string;
  todoSessionId: string | null;
  todoCollapsed: boolean;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  sessionUsage?: UsageCostSummary | null;
};

export type WorkflowEventStatus = "running" | "done" | "error" | "warning";

export type WorkflowEvent = {
  id: string;
  toolName: string;
  title: string;
  detail: string;
  detailLog?: string[];
  status: WorkflowEventStatus;
  level?: "parent" | "child";
  role?: "planning" | "purpose" | "activity" | "final" | "waiting";
  purpose?: "info" | "action" | "verification";
  groupId?: string;
  toolCallId?: string | null;
  toolCallIndex?: number | null;
  toolInput?: Record<string, unknown> | null;
  output?: string;
};

export type ThemeId = "light" | "claude" | "dark" | "mono" | "mono-orange";
export type SidebarCollapseReason = "auto" | "manual" | null;

export type ComposerState = {
  draft: string;
  attachments: Attachment[];
  pastedTexts: string[];
  token: string | null;
};

export type AppState = {
  sessionId: string | null;
  clientId: string;
  ready: boolean;
  busy: boolean;
  status: StatusKind;
  statusText: string;
  provider: string;
  activeProfile: string;
  providerLabel: string;
  model: string;
  subagentModel: string;
  subagentEffort: string;
  effort: string;
  permissionMode: string;
  chatTitle: string;
  systemPrompt: string;
  appSettings: AppSettings;
  adminMode: boolean;
  themeId: ThemeId;
  sidebarCollapsed: boolean;
  sidebarCollapseReason: SidebarCollapseReason;
  sidebarWidth: number;
  sidebarResizing: boolean;
  commands: CommandItem[];
  skills: SkillItem[];
  plugins: PluginItem[];
  mcpServers: McpServerItem[];
  workspaceName: string;
  workspacePath: string;
  workspaceScope: WorkspaceScope;
  workspaces: Workspace[];
  history: HistoryItem[];
  hiddenHistoryKeys: string[];
  historyLoading: boolean;
  historyLoadingMore: boolean;
  historyHasMore: boolean;
  historyNextOffset: number;
  historyRefreshKey: number;
  activeHistoryId: string | null;
  pendingHistoryId: string | null;
  restoringHistory: boolean;
  historyReadOnly: boolean;
  pendingFreshChat: boolean;
  preserveMessagesOnNextClearTranscript: boolean;
  artifacts: ArtifactSummary[];
  artifactPanelOpen: boolean;
  activeArtifact: ArtifactSummary | null;
  activeArtifactPayload: ArtifactPayload | null;
  artifactRefreshKey: number;
  artifactPanelWidth: number | null;
  artifactPanelListWidth: number | null;
  artifactPanelPreviewWidth: number | null;
  artifactResizing: boolean;
  modal: ModalState | null;
  backendModalsBySessionId: Record<string, Extract<ModalState, { kind: "backend" }>>;
  liveSessionViewsBySessionId: Record<string, LiveSessionView>;
  messages: ChatMessage[];
  workflowAnchorMessageId: string | null;
  workflowEventsByMessageId: Record<string, WorkflowEvent[]>;
  workflowDurationSecondsByMessageId: Record<string, number>;
  workflowInputBuffers: Record<string, string>;
  todoMarkdown: string;
  todoSessionId: string | null;
  todoCollapsed: boolean;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  sessionUsage?: UsageCostSummary | null;
  swarmPopupOpen: boolean;
  workflowEvents: WorkflowEvent[];
  workflowDurationSeconds: number | null;
  workflowStartedAtMs: number | null;
  composer: ComposerState;
  runtimePicker: RuntimePickerState;
};

export type AppSettings = {
  streamScrollDurationMs: number;
  streamStartBufferMs: number;
  streamFollowLeadPx: number;
  streamRevealDurationMs: number;
  downloadMode: "browser" | "ask" | "folder";
  downloadFolderPath: string;
  shell: "auto" | "powershell" | "git-bash" | "cmd";
};

export type RuntimePickerOption = {
  value: string;
  label: string;
  description?: string;
  active?: boolean;
};

export type RuntimePickerState = {
  open: boolean;
  loading: boolean;
  error: string;
  providers: RuntimePickerOption[];
  modelsByProvider: Record<string, RuntimePickerOption[]>;
  models: RuntimePickerOption[];
  efforts: RuntimePickerOption[];
  selectedProvider: string;
  agentScope: "main" | "sub";
  modelOpen: boolean;
  effortOpen: boolean;
};

export type ArtifactPayload = {
  path?: string;
  name?: string;
  kind?: string;
  workspace?: Workspace;
  mime?: string;
  size?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
  content?: string;
  dataUrl?: string;
  assetBaseUrl?: string;
};

export type ArtifactAiEditSelection = {
  text: string;
  start: number;
  end: number;
  before: string;
  after: string;
  html?: string;
  htmlSnapshot?: string;
  scope?: "selection" | "document";
};

export type ArtifactAiEditComment = ArtifactAiEditSelection & {
  id: string;
  instruction: string;
};

export type ModalState =
  | { kind: "settings" }
  | { kind: "modelSettings" }
  | { kind: "workspace" }
  | { kind: "imagePreview"; src: string; name?: string; alt?: string }
  | { kind: "error"; message: string }
  | { kind: "backend"; payload?: Record<string, unknown> };
