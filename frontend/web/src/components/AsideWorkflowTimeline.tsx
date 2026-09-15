import { Children, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { SwarmTeammateSnapshot } from "../types/backend";
import type { WorkflowEvent } from "../types/ui";
import { toolDisplayName, workflowGroupStatus } from "../utils/toolPresentation";
import { InlineMarkdown } from "./MarkdownMessage";
import { Icon, type IconName } from "./ArtifactIcons";
import "./aside-workflow.css";

type TimelineRow = { kind: "note"; event: WorkflowEvent } | { kind: "actions"; events: WorkflowEvent[]; index: number };

// Provider summaries can contain a short Markdown heading before the body.
// Hide those headings (including heading-only items), keeping the body intact.
export function reasoningSummaryBody(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*|__[^_]+__)\s*$/.test(line)).join("\n").trim();
}

// Walk the recorded order. Purpose labels are mutable summaries, not call parents:
// collecting all their children first would move later calls across a progress note.
export function asideTimelineRows(events: WorkflowEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const calls = new Map<string, WorkflowEvent>();
  const canonical: WorkflowEvent[] = [];
  for (const event of events) {
    const key = event.toolName ? event.toolCallId || event.id : event.id;
    const previous = calls.get(key);
    if (previous) Object.assign(previous, event);
    else { const copy = { ...event }; calls.set(key, copy); canonical.push(copy); }
  }
  for (const event of canonical) {
    if (event.noteSource === "provider-summary" && !reasoningSummaryBody(event.detail)) continue;
    if (event.role === "reasoning" || event.role === "waiting" || event.role === "agents" || event.toolName === "context_compaction") {
      rows.push({ kind: "note", event });
    } else if (event.toolName && event.role !== "purpose") {
      const last = rows.at(-1);
      if (last?.kind === "actions") last.events.push(event);
      else rows.push({ kind: "actions", events: [event], index: rows.length });
    }
  }
  // Short answers may only have lifecycle records, without tools or summaries.
  // Keep those recorded steps available instead of dropping the whole history.
  if (!rows.length) {
    for (const event of canonical) {
      if (event.noteSource !== "provider-summary" && (event.title || event.detail)) {
        rows.push({ kind: "note", event });
      }
    }
  }
  return rows;
}

const shellTools = new Set(["bash", "cmd", "shell", "shell_command", "exec_command", "powershell"]);
const agentTools = new Set(["agent", "spawn_agent", "team_create", "send_message", "wait", "task", "task_output"]);
const fileTools = new Set(["read_file", "write_file", "edit_file", "apply_patch", "notebook_edit", "glob", "grep", "save_skill"]);
function category(event: WorkflowEvent): { key: string; label: string; icon: IconName } {
  const name = event.toolName.toLowerCase();
  if (name === "skill") return { key: "skill", label: "스킬 사용", icon: "sparkles" };
  if (name === "web_search" || name === "web_fetch") return { key: "web", label: "웹 탐색", icon: "network" };
  if (shellTools.has(name)) return { key: "shell", label: "명령 실행", icon: "terminal" };
  if (agentTools.has(name)) return { key: "agent", label: "에이전트 작업", icon: "ai" };
  if (fileTools.has(name)) return { key: "file", label: "파일 작업", icon: "source" };
  if (name.startsWith("mcp__")) {
    const server = event.toolName.slice(5).split("__")[0];
    return { key: `mcp:${server}`, label: `${server} 사용`, icon: "plug" };
  }
  return { key: name, label: `${toolDisplayName(event.toolName) || event.title || event.toolName} 사용`, icon: "network" };
}

export function asideActivitySummary(events: WorkflowEvent[]) {
  const categories = [...new Map(events.map((event) => { const item = category(event); return [item.key, item]; })).values()];
  const labels = categories.map((item) => item.key === "skill"
    ? `스킬 ${events.filter((event) => event.toolName === "skill").length}개 사용` : item.label);
  return labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` 외 ${labels.length - 3}개` : "");
}

export function workflowSafeText(value: unknown): string {
  // Display boundary protection for known credential fields, including JSON output.
  const secret = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|client[_-]?secret|service[_-]?key|cookie)$/i;
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) => secret.test(key) ? "[가림]" : item, 2);
  return (text || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [가림]")
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|service[_-]?key|secret|cookie)["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&}\n]+)/gi, "$1[가림]")
    ;
}

function inputText(event: WorkflowEvent, ...keys: string[]) {
  for (const key of keys) if (typeof event.toolInput?.[key] === "string" && event.toolInput[key]) return workflowSafeText(event.toolInput[key]);
  return "";
}

export function asideCallTitle(event: WorkflowEvent) {
  if (shellTools.has(event.toolName.toLowerCase())) return inputText(event, "command", "cmd", "script") || event.title || event.toolName;
  if (event.toolName === "skill") return `${inputText(event, "name", "skill_name") || "스킬"} 사용`;
  return inputText(event, "progress_message", "description", "task")
    || [({ read_file: "파일 읽기", write_file: "파일 작성", edit_file: "파일 수정", apply_patch: "파일 수정", glob: "파일 찾기", grep: "내용 검색", notebook_edit: "노트북 수정", save_skill: "스킬 저장" } as Record<string, string>)[event.toolName] || toolDisplayName(event.toolName) || event.title || event.toolName, inputText(event, "path", "file_path", "query", "url")].filter(Boolean).join(" · ");
}

function Chevron() {
  return <svg className="aside-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}

// Only disclosure booleans are persisted. Never put tool inputs or outputs here.
function Disclosure({ storageKey, label, children, defaultOpen = false, className = "", ariaLabel }: {
  storageKey: string; label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string; ariaLabel?: string;
}) {
  const id = useId();
  const read = () => { try { const stored = sessionStorage.getItem(storageKey); return stored === null ? defaultOpen : stored === "1"; } catch { return defaultOpen; } };
  const [open, setOpen] = useState(read);
  useEffect(() => setOpen(read()), [storageKey]);
  return <section className={`aside-disclosure ${className}`}>
    <button type="button" className="aside-toggle" aria-label={ariaLabel} aria-expanded={open} aria-controls={id}
      onClick={() => { const next = !open; setOpen(next); try { sessionStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* storage can be disabled */ } }}>
      {label}<Chevron />
    </button>
    <div id={id} hidden={!open}>{open ? children : null}</div>
  </section>;
}

function Output({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const limit = 16000;
  return <><pre className="aside-output" tabIndex={0}>{full ? text : text.slice(0, limit)}</pre>
    {text.length > limit ? <button className="aside-show-output" type="button" onClick={() => setFull(!full)}>{full ? "출력 줄이기" : `전체 출력 보기 (${text.length.toLocaleString()}자)`}</button> : null}</>;
}

function CallDetail({ event, preview }: { event: WorkflowEvent; preview?: ReactNode }) {
  const output = workflowSafeText(event.output);
  const detail = workflowSafeText(event.detail);
  const elapsed = event.startedAtMs && event.finishedAtMs ? Math.max(0, (event.finishedAtMs - event.startedAtMs) / 1000) : null;
  return <div className="aside-call-detail">
    <dl className="aside-call-meta"><dt>도구</dt><dd>{event.toolName}</dd>
      {event.toolCallId ? <><dt>호출 ID</dt><dd>{event.toolCallId}</dd></> : null}
      <dt>상태</dt><dd>{statusLabel(event.status)}{elapsed !== null ? ` · ${elapsed.toFixed(1)}초` : ""}</dd>
      {typeof event.executionMetadata?.cwd === "string" ? <><dt>작업 경로</dt><dd>{workflowSafeText(event.executionMetadata.cwd)}</dd></> : null}
      {typeof event.executionMetadata?.returncode === "number" ? <><dt>종료 코드</dt><dd>{event.executionMetadata.returncode}</dd></> : null}
    </dl>
    {event.toolInput ? <><h4>입력</h4><Output text={workflowSafeText(event.toolInput)} /></> : null}
    {preview}
    {output ? <><h4>출력</h4><Output text={output} /></> : null}
    {detail && detail !== output ? <><h4>{event.status === "running" ? "현재 진행" : "실행 기록"}</h4><Output text={detail} /></> : null}
    {event.detailLog?.length ? <><h4>진행 기록</h4><Output text={workflowSafeText(event.detailLog.join("\n"))} /></> : null}
    {!event.toolInput && !output && !detail ? <p>상세 출력 없음</p> : null}
  </div>;
}

function statusLabel(status: string) {
  return ({ running: "실행 중", done: "완료", completed: "완료", error: "실패", failed: "실패", killed: "중단", idle: "대기", warning: "확인 필요" } as Record<string, string>)[status] || status;
}

export function compactionUsageLabel(event: WorkflowEvent): string {
  const metadata = event.executionMetadata || {};
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const window = metadata.context_window_tokens;
  const format = (value: unknown) => {
    if (!valid(value)) return "미제공";
    const percent = valid(window) && window > 0
      ? ` (${(value / window * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%)` : "";
    return `${value.toLocaleString("ko-KR", { maximumFractionDigits: 0 })} 토큰${percent}`;
  };
  const before = metadata.pre_compact_tokens;
  const after = metadata.post_compact_tokens;
  if (!valid(before) && !valid(after)) return "전·후 사용량 미제공";
  const suffix = event.status === "running" ? "압축 중" : event.status === "error" ? "확인 불가" : format(after);
  return `${metadata.tokens_estimated !== false && metadata.source !== "provider" ? "약 " : ""}${format(before)} → ${suffix}`;
}

function ActivityStatus({ status }: { status: string }) {
  return <span className={`aside-status ${status}`}>
    {status === "running" ? <span className="aside-running-spinner" aria-hidden="true" /> : null}
    {statusLabel(status)}
  </span>;
}

function agentTime(value: number | string | null | undefined) {
  if (value == null) return "";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Call({ event, scope, preview, expanded = false }: { event: WorkflowEvent; scope: string; preview?: ReactNode; expanded?: boolean }) {
  const item = category(event);
  return <><Disclosure storageKey={`${scope}:detail`} defaultOpen={expanded} className={`aside-call ${event.status}`} ariaLabel={`${asideCallTitle(event)} 상세 실행 기록`}
    label={<><span className="aside-activity-icon"><Icon name={item.icon} /></span><span className={`aside-call-title${item.key === "skill" ? " aside-skill-name" : ""}`}>{asideCallTitle(event)}</span>
      <ActivityStatus status={event.status} /></>}>
    <CallDetail event={event} />
  </Disclosure>{preview}</>;
}

function AgentTree({ agents, scope }: { agents: SwarmTeammateSnapshot[]; scope: string }) {
  if (!agents.length) return null;
  return <Disclosure storageKey={`${scope}:agents`} className="aside-agents" label={<><span className="aside-activity-icon"><Icon name="ai" /></span><span>서브에이전트 {agents.length}개 사용</span></>}>
    <div className="aside-children">{agents.map((agent, index) => {
      const id = agent.id || agent.agent_id || String(index);
      const output = workflowSafeText(agent.lastOutput || agent.last_output || "");
      return <Disclosure key={id} storageKey={`${scope}:agent:${id}`} className="aside-agent" label={<>
        <span className={`aside-agent-icon color-${index % 3}`}><Icon name="ai" /></span>
        <span className="aside-agent-copy"><span>{agent.task || agent.name || agent.role || id}</span><small>{output || agent.prompt || ""}</small></span>
        <span className="aside-agent-meta">{agent.model}<small>{statusLabel(agent.status || "")}</small><small>{agentTime(agent.endedAt ?? agent.ended_at ?? agent.startedAt ?? agent.started_at)}</small></span>
      </>}><div className="aside-call-detail">
        {agent.prompt ? <><h4>작업 요청</h4><Output text={workflowSafeText(agent.prompt)} /></> : null}
        {output ? <><h4>최근 실행 결과</h4><Output text={output} /></> : <p>아직 수신한 실행 결과가 없습니다.</p>}
      </div></Disclosure>;
    })}</div>
  </Disclosure>;
}

export function AsideWorkflowTimeline({ events, scope, duration, busy, agents = [], renderPreview, expanded = false }: {
  events: WorkflowEvent[]; scope: string; duration: number | null; busy: boolean; agents?: SwarmTeammateSnapshot[]; renderPreview?: (event: WorkflowEvent) => ReactNode; expanded?: boolean;
}) {
  const timelineRows = useMemo(() => asideTimelineRows(events), [events]);
  // Writing panes must remain visible as content arrives, outside both levels
  // of tool-detail disclosure. Keep their recorded position among other calls.
  const rows = timelineRows.flatMap((row): TimelineRow[] => {
    if (row.kind !== "actions" || !row.events.some((event) => Children.toArray(renderPreview?.(event)).length > 0)) return [row];
    return row.events.map((event) => ({ kind: "actions", events: [event], index: row.index }));
  });
  if (!events.length && !busy) return null;
  const minutes = duration !== null ? Math.floor(duration / 60) : 0;
  const time = duration !== null ? `${minutes ? `${minutes}분 ` : ""}${Math.floor(duration % 60)}초 동안 작업${busy ? " 중" : "함"}` : busy ? "작업 중" : "작업 과정";
  return <article className="message assistant aside-workflow" aria-label="도구 진행 상황">
    <Disclosure storageKey={`${scope}:all`} className="aside-work" defaultOpen ariaLabel="작업 과정 펼침/접기" label={<span>{time}</span>}>
      <div className="aside-timeline">{!rows.length && !busy ? <p className="aside-progress-prose">이 답변에 기록된 상세 진행 내용이 없습니다.</p> : null}{rows.map((row, index) => {
        if (row.kind === "note") {
          const event = row.event;
          if (event.role === "waiting") return <div className="aside-note-detail" key={event.id}><span>{event.title}</span><div>{event.detail}</div></div>;
          if (event.role === "agents") return <AgentTree key={event.id} agents={event.agents || []} scope={`${scope}:agents:${index}`} />;
          if (event.noteSource === "progress") return <p key={event.id} className="aside-progress-prose" data-workflow-role="progress"><InlineMarkdown text={event.detail} /></p>;
          if (event.toolName === "context_compaction") return <div className="aside-system-event" key={event.id}>{event.title} · {statusLabel(event.status)} · {compactionUsageLabel(event)}</div>;
          return <Disclosure key={event.id} storageKey={`${scope}:note:${index}`} className="aside-reasoning" label={<><span className="aside-activity-icon"><Icon name="ai" /></span><span>{event.noteSource === "provider-summary" ? "추론 요약" : "진행 기록"}</span></>}>
            <div className="aside-note-detail">{event.noteSource === "provider-summary"
              ? reasoningSummaryBody(event.detail).split(/\n\s*\n/).map((paragraph, index) => <p key={index}><InlineMarkdown text={paragraph} /></p>)
              : <InlineMarkdown text={(event.detail || event.title).split(/\r?\n/).filter(Boolean).join(" · ")} />}</div>
          </Disclosure>;
        }
        const first = row.events[0];
        const groupScope = `${scope}:actions:${first.toolCallId || row.index}`;
        const callScope = (event: WorkflowEvent, callIndex: number) => `${scope}:call:${event.toolCallId || `${row.index}:${callIndex}`}`;
        if (row.events.length === 1) return <div className="aside-activity" key={first.id}><Call event={first} expanded={expanded} scope={callScope(first, 0)} preview={renderPreview?.(first)} /></div>;
        let firstCallOpen = false;
        try { firstCallOpen = sessionStorage.getItem(`${callScope(first, 0)}:detail`) === "1"; } catch { /* optional storage */ }
        const status = workflowGroupStatus(row.events);
        return <Disclosure key={first.id} storageKey={groupScope} defaultOpen={expanded || firstCallOpen} className={`aside-activity ${status}`} label={<>
          <span className="aside-activity-icon"><Icon name={category(first).icon} /></span><span className="aside-activity-summary">{asideActivitySummary(row.events)} ({row.events.length}건)</span>
          {status === "running" || status === "error" || status === "warning" ? <ActivityStatus status={status} /> : null}
        </>}><div className="aside-children">{row.events.map((event, callIndex) => <Call key={event.toolCallId || event.id} expanded={expanded} event={event} scope={callScope(event, callIndex)} preview={renderPreview?.(event)} />)}</div></Disclosure>;
      })}{!events.some((event) => event.role === "agents") ? <AgentTree agents={agents} scope={scope} /> : null}
      </div>
    </Disclosure>
  </article>;
}
