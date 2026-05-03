import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../state/app-state";
import type { WorkflowEvent } from "../types/ui";

function statusLabel(status: string) {
  if (status === "running") return "진행 중";
  if (status === "done") return "완료";
  if (status === "error") return "오류";
  if (status === "warning") return "확인 필요";
  return status;
}

function compactDetail(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function formatElapsed(seconds: number) {
  if (seconds < 60) {
    return `${seconds}초 경과`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}분 ${remainder}초 경과` : `${minutes}분 경과`;
}

function estimateTextTokens(text: string) {
  const value = String(text || "");
  if (!value) {
    return 0;
  }
  let total = 0;
  for (const segment of value.matchAll(/[\uAC00-\uD7A3]+|[A-Za-z0-9]+|\s+|./gu)) {
    const part = segment[0] || "";
    if (/^[\uAC00-\uD7A3]+$/u.test(part)) {
      total += part.length;
    } else if (/^[A-Za-z0-9]+$/u.test(part)) {
      total += Math.ceil(part.length / 4);
    } else if (/^\s+$/u.test(part)) {
      total += part.includes("\n") ? 1 : 0;
    } else {
      total += 1;
    }
  }
  return Math.max(1, total);
}

function formatWorkflowTokenCount(tokens: number) {
  return `${Math.max(0, Math.round(tokens || 0)).toLocaleString()} 토큰`;
}

function workflowPreviewFileName(path: string) {
  const normalized = String(path || "").trim().replace(/[\\/]+$/g, "");
  return normalized.split(/[\\/]+/).pop() || normalized;
}

function workflowInputValue(input: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string") {
      return { found: true, value };
    }
  }
  return { found: false, value: "" };
}

function splitWorkflowPreviewLines(value: string) {
  const normalized = String(value || "").replace(/\r\n/g, "\n");
  return normalized ? normalized.split("\n") : [""];
}

function formatWorkflowEditBlock(oldValue: string, newValue: string, index = 1, total = 1) {
  const lines: string[] = [];
  if (total > 1) {
    lines.push(`@@ 변경 ${index} @@`);
  }
  for (const line of splitWorkflowPreviewLines(oldValue)) {
    lines.push(`-- ${line}`);
  }
  for (const line of splitWorkflowPreviewLines(newValue)) {
    lines.push(`++ ${line}`);
  }
  return lines.join("\n");
}

function formatWorkflowEditPreview(input: Record<string, unknown> = {}) {
  const inputEdits = Array.isArray(input.edits) && input.edits.length ? input.edits : [input];
  const edits: Array<{ oldValue: string; newValue: string }> = [];
  for (const entry of inputEdits) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const oldValue = workflowInputValue(record, ["old_str", "old_string", "old_text", "oldText"]);
    const newValue = workflowInputValue(record, ["new_str", "new_string", "new_text", "newText"]);
    if (!oldValue.found && !newValue.found) {
      continue;
    }
    edits.push({ oldValue: oldValue.value, newValue: newValue.value });
  }
  return edits
    .map((edit, index) => formatWorkflowEditBlock(edit.oldValue, edit.newValue, index + 1, edits.length))
    .join("\n");
}

function workflowPreviewSource(event: WorkflowEvent) {
  const lower = event.toolName.toLowerCase();
  const input = event.toolInput || {};
  const path = workflowInputValue(input, ["file_path", "path"]).value;
  if (lower.includes("edit")) {
    const diff = formatWorkflowEditPreview(input);
    if (diff) {
      return {
        path,
        kind: "diff" as const,
        content: diff,
      };
    }
  }
  const content = workflowInputValue(input, ["content", "new_string", "new_source"]);
  if (content.found) {
    return { path, kind: "content" as const, content: content.value };
  }
  return null;
}

type WorkflowPreviewSource = NonNullable<ReturnType<typeof workflowPreviewSource>>;

function workflowDiffLineClassName(line: string) {
  if (line.startsWith("++ ")) {
    return "workflow-diff-line added";
  }
  if (line.startsWith("-- ")) {
    return "workflow-diff-line removed";
  }
  if (line.startsWith("@@")) {
    return "workflow-diff-line hunk";
  }
  return "workflow-diff-line";
}

function isWorkflowOutputTool(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower !== "todo_write" && lower !== "todowrite" && (lower.includes("write") || lower.includes("edit"));
}

function WorkflowOutputPreview({ event, source }: { event: WorkflowEvent; source: WorkflowPreviewSource }) {
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const done = event.status !== "running";
  const fileName = workflowPreviewFileName(source.path);
  const prefix = source.kind === "diff"
    ? done ? "수정 완료" : "수정 미리보기"
    : done ? "작성 완료" : "작성 중인 결과물";
  const changedLines = source.kind === "diff"
    ? source.content.split(/\r?\n/).filter((line) => line.startsWith("++ ") || line.startsWith("-- ")).length
    : 0;
  const count = source.kind === "diff"
    ? `${formatWorkflowTokenCount(estimateTextTokens(source.content))} (${changedLines.toLocaleString()}줄)`
    : formatWorkflowTokenCount(estimateTextTokens(source.content));

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || event.status !== "running") {
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [event.status, source.content]);

  return (
    <div className="workflow-output-preview">
      <div className="workflow-output-title">
        <span className="workflow-output-label">{fileName ? `${prefix} - ${fileName}` : prefix}</span>
        <span className="workflow-output-line-count">{count}</span>
      </div>
      <pre ref={bodyRef} className={`workflow-output-body${source.kind === "diff" ? " diff" : ""}`}>{source.kind === "diff"
        ? source.content.split(/\r?\n/).map((line, index) => (
          <span className={workflowDiffLineClassName(line)} key={`${index}:${line}`}>
            {line || " "}
          </span>
        ))
        : source.content}</pre>
    </div>
  );
}

export function WorkflowPanel({ events: eventOverride }: { events?: WorkflowEvent[] } = {}) {
  const { state } = useAppState();
  const events = eventOverride || state.workflowEvents;
  const [now, setNow] = useState(() => Date.now());
  const runningSinceRef = useRef<Record<string, number>>({});

  const runningCount = events.filter((event) => event.status === "running").length;

  useEffect(() => {
    const runningIds = new Set(events.filter((event) => event.status === "running").map((event) => event.id));
    const since = runningSinceRef.current;
    for (const id of runningIds) {
      since[id] = since[id] || Date.now();
    }
    for (const id of Object.keys(since)) {
      if (!runningIds.has(id)) {
        delete since[id];
      }
    }
    if (!runningIds.size) {
      return undefined;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [events]);

  function eventDetail(event: WorkflowEvent) {
    const detail = compactDetail(event.detail);
    if (event.status !== "running") {
      return detail;
    }
    const startedAt = runningSinceRef.current[event.id];
    const elapsed = startedAt ? Math.max(1, Math.floor((now - startedAt) / 1000)) : 0;
    const elapsedText = elapsed ? formatElapsed(elapsed) : "";
    return [detail, elapsedText].filter(Boolean).join(" · ");
  }

  const outputPreviewEvents = useMemo(
    () => events
      .map((event) => ({ event, source: isWorkflowOutputTool(event.toolName) ? workflowPreviewSource(event) : null }))
      .filter((item): item is { event: WorkflowEvent; source: WorkflowPreviewSource } => Boolean(item.source)),
    [events],
  );
  const hasOutputPreview = outputPreviewEvents.length > 0;

  if (!events.length) {
    return null;
  }

  return (
    <article className="message assistant workflow-message" aria-label="도구 진행 상황">
      <details className="workflow-card" open={!eventOverride && state.busy || runningCount > 0 || hasOutputPreview}>
        <summary>
          <span className="workflow-title">작업 진행</span>
          <span className="workflow-count">
            {runningCount ? `${runningCount}개 실행 중` : `${events.length}개 기록`}
          </span>
        </summary>
        <div className="workflow-body">
          <div className="workflow-list">
            {events.map((event) => (
              <div className={`workflow-step ${event.level || "child"} ${event.status}`} key={event.id}>
                <span className="workflow-dot" aria-hidden="true" />
                <span className="workflow-copy">
                  <strong>{event.title}</strong>
                  <small>
                    {statusLabel(event.status)}
                    {eventDetail(event) ? ` · ${eventDetail(event)}` : ""}
                  </small>
                </span>
              </div>
            ))}
          </div>
          {outputPreviewEvents.length ? (
            <div className="workflow-output-list">
              {outputPreviewEvents.map(({ event, source }) => (
                <WorkflowOutputPreview event={event} source={source} key={event.id} />
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </article>
  );
}
