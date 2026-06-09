export type WorkspaceScope = {
  mode: "shared" | "ip" | string;
  name: string;
  root: string;
};

export type Workspace = {
  name: string;
  path: string;
  scope?: WorkspaceScope;
};

export type Attachment = {
  media_type: string;
  data: string;
  name: string;
};

export type BackendStateSnapshot = {
  provider?: string;
  active_profile?: string;
  provider_label?: string;
  model?: string;
  subagent_model?: string;
  subagent_effort?: string;
  effort?: string;
  permission_mode?: string;
  cwd?: string;
  workspace?: Workspace;
  session_usage?: UsageCostSummary | null;
};

export type UsageCostSummary = {
  provider?: string;
  model?: string;
  input_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_hit_ratio?: number;
  estimated_cost_usd?: number | null;
  estimated_cache_savings_usd?: number | null;
  estimated_uncached_input_cost_usd?: number | null;
  estimated_cached_input_cost_usd?: number | null;
  estimated_output_cost_usd?: number | null;
  cost_supported?: boolean;
  cost_note?: string;
  model_breakdown?: UsageCostSummary[];
};

export type TranscriptItem = {
  role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
  text: string;
  kind?: "steering" | "queued" | "question_answer" | null;
  tool_name?: string | null;
  tool_input?: Record<string, unknown> | null;
  is_error?: boolean | null;
};

export type CompactProgressPhase =
  | "hooks_start"
  | "context_collapse_start"
  | "context_collapse_end"
  | "session_memory_start"
  | "session_memory_end"
  | "compact_start"
  | "compact_retry"
  | "compact_end"
  | "compact_failed";

export type CompactProgressTrigger = "auto" | "manual" | "reactive";

export type SwarmTeammateSnapshot = {
  id?: string;
  agent_id?: string;
  name?: string;
  role?: string;
  model?: string;
  modelSource?: string;
  model_source?: string;
  prompt?: string;
  status?: "running" | "idle" | "completed" | "failed" | "killed" | "done" | "error" | string;
  task?: string;
  startedAt?: number | string | null;
  started_at?: number | string | null;
  endedAt?: number | string | null;
  ended_at?: number | string | null;
  lastOutput?: string;
  last_output?: string;
  taskId?: string;
  task_id?: string;
};

export type SwarmNotificationSnapshot = {
  id?: string;
  from?: string;
  message?: string;
  timestamp?: number | string | null;
  level?: "info" | "warning" | "error" | string;
};

export type BackendEvent =
  | { type: "ready"; state?: BackendStateSnapshot; commands?: unknown[]; skills?: unknown[]; plugins?: unknown[]; tasks?: unknown[]; mcp_servers?: unknown[]; session_usage?: UsageCostSummary | null }
  | { type: "state_snapshot"; state?: BackendStateSnapshot; plugins?: unknown[]; mcp_servers?: unknown[]; session_usage?: UsageCostSummary | null }
  | { type: "skills_snapshot"; skills?: unknown[] }
  | { type: "transcript_item"; item?: TranscriptItem }
  | { type: "assistant_delta"; message?: string | null; value?: string | null }
  | { type: "assistant_complete"; message?: string | null; has_tool_uses?: boolean | null; artifacts?: ArtifactSummary[] | null; usage?: UsageCostSummary | null; session_usage?: UsageCostSummary | null }
  | { type: "compact_progress"; compact_phase?: CompactProgressPhase | string | null; compact_trigger?: CompactProgressTrigger | string | null; attempt?: number | null; compact_checkpoint?: string | null; compact_metadata?: Record<string, unknown> | null; message?: string | null }
  | { type: "session_title"; message?: string | null; value?: string | null }
  | { type: "tool_started"; tool_name?: string; tool_call_id?: string | null; tool_call_index?: number | null; tool_input?: Record<string, unknown> | null }
  | { type: "tool_input_delta"; tool_name?: string; tool_call_index?: number; arguments_delta?: string }
  | { type: "tool_progress"; tool_name?: string; tool_call_id?: string | null; tool_call_index?: number | null; message?: string; tool_input?: Record<string, unknown> | null }
  | { type: "tool_completed"; tool_name?: string; tool_call_id?: string | null; tool_call_index?: number | null; output?: string; is_error?: boolean | null }
  | { type: "line_complete"; quiet?: boolean; compact_metadata?: Record<string, unknown> | null }
  | { type: "modal_request"; modal?: Record<string, unknown> | null }
  | { type: "select_request"; modal?: Record<string, unknown> | null; select_options?: Array<Record<string, unknown>> | null; message?: string | null }
  | { type: "todo_update"; todo_markdown?: string | null }
  | { type: "swarm_status"; swarm_teammates?: SwarmTeammateSnapshot[] | null; swarm_notifications?: SwarmNotificationSnapshot[] | null }
  | { type: "plan_mode_change"; plan_mode?: string | null }
  | { type: "active_session"; value?: string | null }
  | { type: "history_snapshot"; value?: string | null; message?: string | null; history_events?: Array<Record<string, unknown>> | null; compact_metadata?: Record<string, unknown> | null }
  | { type: "status"; message?: string | null; value?: string | null; quiet?: boolean | null }
  | { type: "error"; message?: string | null }
  | { type: "shutdown"; message?: string | null }
  | { type: string; session_usage?: UsageCostSummary | null; [key: string]: unknown };

export type SessionResponse = {
  sessionId: string;
  clientId?: string;
  frontendId?: string;
  workspace?: Workspace;
};

export type LiveSessionItem = {
  sessionId: string;
  savedSessionId: string;
  title?: string;
  workspace?: Workspace;
  busy: boolean;
  createdAt: number;
};

export type LiveSessionsResponse = {
  sessions: LiveSessionItem[];
};

export type HistoryItem = {
  value: string;
  label: string;
  description?: string;
  workspace?: Workspace | null;
  hidden?: boolean;
  live?: boolean;
  liveSessionId?: string;
  busy?: boolean;
  pinned?: boolean;
  pending?: boolean;
  lastAssistantAt?: number;
};

export type ArtifactSummary = {
  path: string;
  name?: string;
  kind: string;
  workspace?: Workspace;
  category?: string;
  label?: string;
  mime?: string;
  size?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
};

export type CommandItem = {
  name: string;
  description: string;
};

export type SkillItem = {
  name: string;
  description: string;
  source?: string;
  enabled?: boolean;
  usage_count?: number;
};

export type PluginItem = {
  name: string;
  description: string;
  enabled?: boolean;
  skill_count?: number;
  skills?: SkillItem[];
  command_count?: number;
  mcp_server_count?: number;
};

export type McpServerItem = {
  name: string;
  state: string;
  detail?: string;
  description?: string;
  transport?: string;
  tool_count?: number;
  resource_count?: number;
};
