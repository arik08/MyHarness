import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

function formatDuration(seconds: number) {
  return formatElapsed(seconds).replace(/\s*경과$/, "");
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

function parseWorkflowTokenNumber(value: string | undefined | null) {
  const normalized = String(value || "").replace(/,/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function workflowLongReportUsageTokens(output: string | undefined) {
  const value = String(output || "");
  const match = value.match(/작성 사용량\s*합계\s*([0-9][0-9,]*)\s*tokens?/iu)
    || value.match(/문서 작성 사용량\s*합계\s*([0-9][0-9,]*)\s*tokens?/iu);
  return parseWorkflowTokenNumber(match?.[1]);
}

function workflowLongReportInputUsageTokens(input: Record<string, unknown> | null | undefined) {
  return parseWorkflowTokenNumber(String(input?.document_written_tokens ?? ""));
}

function workflowLongReportDocumentTokens(output: string | undefined) {
  const value = String(output || "");
  const match = value.match(/문서 약\s*([0-9][0-9,]*)\s*tokens?/iu)
    || value.match(/약\s*([0-9][0-9,]*)\s*tokens?/iu);
  return parseWorkflowTokenNumber(match?.[1]);
}

function countWorkflowPreviewLines(text: string) {
  const value = String(text || "");
  return value ? value.replace(/\r\n/g, "\n").split("\n").length : 0;
}

function formatWorkflowContentCount(text: string) {
  const lines = countWorkflowPreviewLines(text);
  return `${formatWorkflowTokenCount(estimateTextTokens(text))} (${lines.toLocaleString()}줄)`;
}

function formatWorkflowLongReportCount(event: WorkflowEvent, fallbackText: string) {
  const runningUsageTokens = workflowLongReportInputUsageTokens(event.toolInput);
  if (runningUsageTokens !== null && runningUsageTokens > 0) {
    return `작성 사용량 ${formatWorkflowTokenCount(runningUsageTokens)}`;
  }
  if (event.status !== "running") {
    const usageTokens = workflowLongReportUsageTokens(event.output);
    if (usageTokens !== null) {
      return `작성 사용량 ${formatWorkflowTokenCount(usageTokens)}`;
    }
    const documentTokens = workflowLongReportDocumentTokens(event.output);
    if (documentTokens !== null) {
      return `문서 ${formatWorkflowTokenCount(documentTokens)}`;
    }
  }
  return formatWorkflowContentCount(fallbackText);
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

function isLongReportWorkflowTool(toolName: string) {
  return toolName.toLowerCase() === "write_long_report";
}

function slugifyWorkflowReportTitle(title: unknown) {
  const cleaned = String(title || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned || "long_report";
}

function workflowLongReportOutputPath(input: Record<string, unknown> | null | undefined) {
  const explicit = workflowInputValue(input, ["output_path"]).value.trim();
  if (explicit) {
    return explicit;
  }
  const suffix = workflowInputValue(input, ["output_format"]).value.trim().toLowerCase() === "html" ? ".html" : ".md";
  return `outputs/${slugifyWorkflowReportTitle(input?.title)}_report${suffix}`;
}

function workflowElapsedDetail(detail: string) {
  return String(detail || "").match(/(?:\d+분(?: \d+초)?|\d+초) 경과/)?.[0] || "";
}

function workflowLongReportProcessLines(done: boolean) {
  const marker = done ? "완료" : "진행";
  return [
    `1. 목차 설계 - ${marker}`,
    `2. 섹션별 본문 작성 - ${marker}`,
    `3. 짧거나 잘린 섹션 이어쓰기 - ${marker}`,
    `4. 검토 요약 및 최종 병합 - ${marker}`,
  ];
}

function workflowLongReportPreviewContent(event: WorkflowEvent, input: Record<string, unknown>) {
  const target = typeof input.target_tokens === "number" && Number.isFinite(input.target_tokens)
    ? `목표 분량: ${input.target_tokens.toLocaleString()} tokens`
    : "";
  const elapsed = event.status === "running" ? workflowElapsedDetail(event.detail) : "";
  const stateLine = [
    event.status === "running" ? "상태: 섹션 단위 생성 중" : "상태: 생성 완료",
    elapsed,
  ].filter(Boolean).join(" · ");
  return [
    event.status === "running"
      ? "장문 보고서를 한 번에 쓰지 않고, 목차와 섹션 단위로 나눠 작성한 뒤 최종 파일로 합칩니다."
      : "장문 보고서를 섹션별 작성물과 검토 요약으로 합쳤습니다.",
    target,
    stateLine,
    ...workflowLongReportProcessLines(event.status !== "running"),
    compactDetail(event.output || "").replace(/^장문 보고서를 생성했습니다:\s*/u, "결과: "),
  ].filter(Boolean).join("\n");
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

function workflowPatchPreview(input: Record<string, unknown> = {}) {
  return workflowInputValue(input, ["patch", "diff"]).value;
}

function workflowPatchPath(patch: string) {
  const match = String(patch || "").match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/m)
    || String(patch || "").match(/^\+\+\+\s+(?:b\/)?(.+)$/m)
    || String(patch || "").match(/^---\s+(?:a\/)?(.+)$/m);
  return match?.[1]?.trim() || "";
}

function workflowPreviewSource(event: WorkflowEvent) {
  const lower = event.toolName.toLowerCase();
  const input = event.toolInput || {};
  const patch = workflowPatchPreview(input);
  const path = workflowInputValue(input, ["file_path", "path", "output_path"]).value
    || workflowPatchPath(patch)
    || (isLongReportWorkflowTool(event.toolName) ? workflowLongReportOutputPath(input) : "");
  if (lower.includes("edit") || lower.includes("patch")) {
    const diff = formatWorkflowEditPreview(input);
    if (diff) {
      return {
        path,
        kind: "diff" as const,
        content: diff,
      };
    }
    if (patch) {
      return {
        path,
        kind: "diff" as const,
        content: patch,
      };
    }
  }
  const content = workflowInputValue(input, ["content", "new_string", "new_source"]);
  if (content.found) {
    return { path, kind: "content" as const, content: content.value };
  }
  if (isLongReportWorkflowTool(event.toolName)) {
    return { path, kind: "content" as const, content: workflowLongReportPreviewContent(event, input) };
  }
  return null;
}

function workflowDetailPathCandidates(event: WorkflowEvent) {
  const input = event.toolInput || {};
  const patch = workflowPatchPreview(input);
  return [
    workflowInputValue(input, ["file_path", "path", "output_path", "file"]).value,
    workflowPatchPath(patch),
    isLongReportWorkflowTool(event.toolName) ? workflowLongReportOutputPath(input) : "",
    workflowPreviewSource(event)?.path || "",
  ].filter((path, index, paths) => path && paths.indexOf(path) === index);
}

function replaceLiteral(value: string, search: string, replacement: string) {
  if (!search || search === replacement) {
    return value;
  }
  return value.split(search).join(replacement);
}

function compactWorkflowOutputDetail(event: WorkflowEvent, detail: string) {
  if (isLongReportWorkflowTool(event.toolName)) {
    const elapsed = workflowElapsedDetail(detail);
    if (event.status === "running") {
      return ["섹션별 작성/이어쓰기/검토 후 병합 중", elapsed].filter(Boolean).join(" · ");
    }
    return compactDetail(detail)
      .replace(/^장문 보고서를 생성했습니다:\s*/u, "생성 완료 · ")
      .replace(/\s+/g, " ");
  }
  if (!isWorkflowOutputTool(event.toolName)) {
    return detail;
  }
  let next = detail;
  for (const path of workflowDetailPathCandidates(event)) {
    const fileName = workflowPreviewFileName(path);
    next = replaceLiteral(next, path, fileName);
    next = replaceLiteral(next, path.replace(/\\/g, "/"), fileName);
    next = replaceLiteral(next, path.replace(/\//g, "\\"), fileName);
  }
  return next
    .replace(/^Wrote\s+/i, "파일 작업 완료 · ")
    .replace(/^Updated\s+/i, "파일 수정 완료 · ")
    .replace(/^Created\s+/i, "파일 작성 완료 · ");
}

function workflowOutputPathKey(path: string) {
  return String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function workflowEventOutputPathKey(event: WorkflowEvent) {
  const input = event.toolInput || {};
  const patch = workflowPatchPreview(input);
  return workflowOutputPathKey(workflowInputValue(input, ["file_path", "path"]).value || workflowPatchPath(patch));
}

function mergeWorkflowOutputEvents(previous: WorkflowEvent, next: WorkflowEvent) {
  return {
    ...previous,
    ...next,
    id: previous.id,
    toolInput: previous.toolInput && next.toolInput
      ? { ...previous.toolInput, ...next.toolInput }
      : next.toolInput || previous.toolInput,
  };
}

function dedupeRunningWorkflowOutputEvents(events: WorkflowEvent[]) {
  const indexesByKey = new Map<string, number>();
  const nextEvents: WorkflowEvent[] = [];
  for (const event of events) {
    const pathKey = event.status === "running" && isWorkflowOutputTool(event.toolName)
      ? workflowEventOutputPathKey(event)
      : "";
    const key = pathKey ? `${event.toolName.toLowerCase()}:${pathKey}` : "";
    if (key) {
      const existingIndex = indexesByKey.get(key);
      if (existingIndex !== undefined) {
        nextEvents[existingIndex] = mergeWorkflowOutputEvents(nextEvents[existingIndex], event);
        continue;
      }
      indexesByKey.set(key, nextEvents.length);
    }
    nextEvents.push(event);
  }
  return nextEvents;
}

type WorkflowPreviewSource = NonNullable<ReturnType<typeof workflowPreviewSource>>;
type WorkflowPreviewEvent = { event: WorkflowEvent; source: WorkflowPreviewSource };
type WorkflowRow =
  | { type: "event"; event: WorkflowEvent }
  | { type: "group"; parent: WorkflowEvent; children: WorkflowEvent[] };

const workflowEventStaggerMs = 90;
const workflowPlanningStaggerMs = 220;

type WebInvestigationSource = {
  url: string;
  label: string;
  domain: string;
  path: string;
};

function stringInputValue(input: Record<string, unknown> | null | undefined, key: string) {
  const value = input?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSourceUrl(value: string) {
  const cleaned = String(value || "").trim().replace(/^<|>$/g, "").replace(/[),.;]+$/g, "");
  if (!/^https?:\/\//i.test(cleaned)) {
    return "";
  }
  try {
    return new URL(cleaned).href;
  } catch {
    return cleaned;
  }
}

function labelForSourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = decodedUrlText(`${parsed.pathname}${parsed.search}`.replace(/\/$/g, "") || "/");
    return `${parsed.hostname}${path === "/" ? "" : path}` || url;
  } catch {
    return decodedUrlText(url.replace(/^https?:\/\//i, ""));
  }
}

function decodedUrlText(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sourcePartsForUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      domain: parsed.hostname.replace(/^www\./i, ""),
      path: decodedUrlText(`${parsed.pathname}${parsed.search}`.replace(/\/$/g, "") || "/"),
    };
  } catch {
    return { domain: labelForSourceUrl(url), path: "" };
  }
}

function outputUrls(output = "") {
  const urls: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\bURL:\s*(https?:\/\/\S+)/i);
    if (match?.[1]) {
      urls.push(match[1]);
    }
  }
  return urls;
}

export function webInvestigationSummary(events: WorkflowEvent[]) {
  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>();
  const sources: WebInvestigationSource[] = [];
  const queries: string[] = [];

  function addUrl(value: string) {
    const url = normalizeSourceUrl(value);
    if (!url || seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    sources.push({ url, label: labelForSourceUrl(url), ...sourcePartsForUrl(url) });
  }

  function addQuery(value: string) {
    const query = value.trim();
    if (!query || seenQueries.has(query)) {
      return;
    }
    seenQueries.add(query);
    queries.push(query);
  }

  for (const event of events) {
    const lower = event.toolName.toLowerCase();
    if (!lower.includes("web_search") && !lower.includes("web_fetch")) {
      continue;
    }
    const input = event.toolInput || {};
    if (lower.includes("web_search")) {
      addQuery(stringInputValue(input, "query"));
      for (const url of outputUrls(event.output || "")) {
        addUrl(url);
      }
    }
    if (lower.includes("web_fetch")) {
      addUrl(stringInputValue(input, "url"));
      for (const url of outputUrls(event.output || "")) {
        addUrl(url);
      }
    }
  }

  return { sources, queries };
}

function workflowDiffLineClassName(line: string) {
  if (line.startsWith("++ ") || /^\+(?!\+\+|\s*$)/.test(line)) {
    return "workflow-diff-line added";
  }
  if (line.startsWith("-- ") || /^-(?!--|\s*$)/.test(line)) {
    return "workflow-diff-line removed";
  }
  if (line.startsWith("@@") || line.startsWith("*** ")) {
    return "workflow-diff-line hunk";
  }
  return "workflow-diff-line";
}

function isWorkflowOutputTool(toolName: string) {
  const lower = toolName.toLowerCase();
  return lower !== "todo_write" && lower !== "todowrite" && (lower.includes("write") || lower.includes("edit") || lower.includes("patch"));
}

function isTodoWorkflowTool(toolName: string, title = "") {
  const lowerToolName = toolName.toLowerCase();
  const lowerTitle = title.toLowerCase();
  return lowerToolName === "todo_write" || lowerToolName === "todowrite" || lowerTitle === "todo_write" || lowerTitle === "todowrite";
}

function todoWorkflowDetail(status: WorkflowEvent["status"], detail: string) {
  const elapsed = detail.match(/(?:\d+분(?: \d+초)?|\d+초) 경과/)?.[0] || "";
  if (status === "running") {
    return ["할 일을 정리하고 있습니다.", elapsed].filter(Boolean).join(" · ");
  }
  if (status === "error") {
    const reason = detail
      .replace(/(?:\d+분(?: \d+초)?|\d+초) 경과/g, "")
      .replace(/^Invalid input for (?:todo_write|TodoWrite):\s*/i, "입력 형식 오류: ")
      .replace(/[·\s]+$/g, "")
      .trim();
    return ["할 일 정리에 실패했습니다.", reason].filter(Boolean).join(" · ");
  }
  if (status === "warning") {
    return "할 일 정리를 확인해야 합니다.";
  }
  return "할 일을 정리했습니다.";
}

function workflowStepTitle(event: WorkflowEvent) {
  if (isTodoWorkflowTool(event.toolName, event.title)) {
    return "작업 목록 정리";
  }
  if (isLongReportWorkflowTool(event.toolName)) {
    return "장문 보고서 생성";
  }
  if (!isWorkflowOutputTool(event.toolName)) {
    return event.title;
  }
  const lowerToolName = event.toolName.toLowerCase();
  const lowerTitle = event.title.toLowerCase();
  if (event.title && lowerTitle !== lowerToolName) {
    return event.title;
  }
  if (lowerToolName.includes("write")) {
    return "파일 작성";
  }
  if (lowerToolName.includes("edit") || lowerToolName.includes("patch") || lowerToolName.includes("notebook")) {
    return "파일 수정";
  }
  return "파일 작업";
}

function WorkflowOutputPreview({ event, source }: { event: WorkflowEvent; source: WorkflowPreviewSource }) {
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const done = event.status !== "running";
  const displayContent = source.content;
  const fileName = workflowPreviewFileName(source.path);
  const prefix = source.kind === "diff"
    ? done ? "수정 완료" : "수정 미리보기"
    : done ? "작성 완료" : "작성 중인 결과물";
  const changedLines = source.kind === "diff"
    ? source.content.split(/\r?\n/).filter((line) => workflowDiffLineClassName(line).includes("added") || workflowDiffLineClassName(line).includes("removed")).length
    : 0;
  const count = source.kind === "diff"
    ? `${formatWorkflowTokenCount(estimateTextTokens(source.content))} (${changedLines.toLocaleString()}줄)`
    : isLongReportWorkflowTool(event.toolName)
      ? formatWorkflowLongReportCount(event, source.content)
      : formatWorkflowContentCount(source.content);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || event.status !== "running") {
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [event.status, displayContent]);

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
        : displayContent}</pre>
    </div>
  );
}

function workflowRows(events: WorkflowEvent[]): WorkflowRow[] {
  const purposeGroupIds = new Set(
    events
      .filter((event) => event.role === "purpose" && event.groupId)
      .map((event) => event.groupId as string),
  );
  const childrenByGroupId = new Map<string, WorkflowEvent[]>();
  for (const event of events) {
    if (!event.groupId || event.role === "purpose" || !purposeGroupIds.has(event.groupId)) {
      continue;
    }
    const children = childrenByGroupId.get(event.groupId) || [];
    children.push(event);
    childrenByGroupId.set(event.groupId, children);
  }

  const rows: WorkflowRow[] = [];
  for (const event of events) {
    if (event.role === "purpose" && event.groupId) {
      rows.push({ type: "group", parent: event, children: childrenByGroupId.get(event.groupId) || [] });
      continue;
    }
    if (event.groupId && purposeGroupIds.has(event.groupId)) {
      continue;
    }
    rows.push({ type: "event", event });
  }
  return rows;
}

function WorkflowStep({
  event,
  detail,
  rawDetail,
  animate,
  quietDone,
  narration,
}: {
  event: WorkflowEvent;
  detail: string;
  rawDetail?: string;
  animate: boolean;
  quietDone?: boolean;
  narration?: string;
}) {
  const [entering, setEntering] = useState(animate);
  const showToolDetailLine = Boolean(detail) && (event.level === "child" || Boolean(event.toolName));
  const showCompactToolDetail = quietDone && event.status === "done" && Boolean(detail) && (event.level === "child" || Boolean(event.toolName));
  const showQuietParentDetail = quietDone && event.status === "done" && Boolean(detail) && event.level !== "child" && !event.toolName;
  const showNarration = Boolean(narration);
  const showStatusDetail = showNarration || showCompactToolDetail || showQuietParentDetail || !(quietDone && event.status === "done");
  const todoTool = isTodoWorkflowTool(event.toolName, event.title);
  const title = workflowStepTitle(event);
  const baseDetail = showCompactToolDetail ? compactToolDetail(rawDetail ?? detail) : detail;
  const visibleDetail = todoTool
    ? todoWorkflowDetail(event.status, detail)
    : compactWorkflowOutputDetail(event, baseDetail);

  useLayoutEffect(() => {
    if (!animate) {
      setEntering(false);
      return undefined;
    }
    setEntering(true);
    const frame = window.requestAnimationFrame(() => setEntering(false));
    return () => window.cancelAnimationFrame(frame);
  }, [animate, event.id]);

  return (
    <div
      className={`workflow-step ${event.level || "child"} ${event.status}${entering ? " entering" : ""}`}
      data-workflow-role={event.role}
      data-workflow-group-id={event.groupId}
      aria-level={event.level === "child" ? 2 : 1}
    >
      <span className="workflow-dot" aria-hidden="true" />
      <span className="workflow-copy">
        <strong>{title}</strong>
        {showStatusDetail ? (
          <small className={showToolDetailLine ? "workflow-tool-detail" : undefined}>
            {showNarration ? narration : showCompactToolDetail || showQuietParentDetail ? visibleDetail : (
              <>
                {statusLabel(event.status)}
                {visibleDetail ? ` · ${visibleDetail}` : ""}
              </>
            )}
          </small>
        ) : null}
      </span>
    </div>
  );
}

function compactToolDetail(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function activeWorkflowCount(events: WorkflowEvent[]) {
  return events.filter((event) => event.status === "running" && event.role !== "purpose").length;
}

function workflowPurposeNarrationDetail(event: WorkflowEvent) {
  const detail = compactDetail(event.detail);
  const genericDetails = new Set([
    "필요한 자료와 맥락을 확인하고 있습니다.",
    "필요한 정보를 확인했습니다.",
    "결과를 확인하고 있습니다.",
    "결과를 확인했습니다.",
    "필요한 변경이나 명령을 실행하고 있습니다.",
    "작업 실행을 마쳤습니다.",
    "작업 중 문제가 발생했습니다.",
    "일부 자료 확인에 실패했지만, 가능한 정보로 계속 진행합니다.",
    "일부 단계에서 확인이 필요합니다.",
  ]);
  return detail && !genericDetails.has(detail) ? detail : "";
}

function workflowNarrationForEvent(event: WorkflowEvent) {
  if (event.role === "final") {
    return event.status === "running"
      ? "이제 작업 결과를 정리하고 있습니다. 무엇을 바꿨고 어떻게 확인했는지 짧게 묶어드리겠습니다."
      : "";
  }
  if (event.role === "activity") {
    return "도구 결과를 읽고 다음 단계를 판단하고 있습니다. 바로 마무리할 수 있는지, 추가 확인이 필요한지 가볍게 점검하는 중입니다.";
  }
  if (event.role === "planning") {
    return "요청을 기준으로 필요한 맥락과 검증 기준을 정리하고 있습니다. 먼저 어디를 확인해야 할지 잡아보겠습니다.";
  }
  if (event.role !== "purpose") {
    return "";
  }

  const detailNarration = workflowPurposeNarrationDetail(event);
  if (detailNarration) {
    return detailNarration;
  }

  const purpose = event.purpose;

  if (purpose === "info") {
    return "필요한 파일과 실행 결과를 훑으면서 판단 근거를 모으고 있습니다. 아직 변경은 적용하지 않고, 어디를 건드려야 하는지 확인하는 중입니다.";
  }
  if (purpose === "verification") {
    return "변경 결과가 의도대로 동작하는지 확인하고 있습니다. 오류나 깨진 화면이 없는지 검증한 뒤 마무리하겠습니다.";
  }
  return "확인한 맥락을 바탕으로 실제 작업을 진행하고 있습니다. 범위가 벗어나지 않도록 관련 부분만 좁게 손보는 중입니다.";
}

function quietCompletedStep(event: WorkflowEvent, latestVisibleEventId: string) {
  return event.status === "done" && event.id !== latestVisibleEventId;
}

function isImmediateWorkflowEvent(event: WorkflowEvent) {
  return !event.toolName && event.role !== "purpose" && event.role !== "planning";
}

function visibleStaggeredWorkflowEvents(events: WorkflowEvent[], staggeredCount: number) {
  let remaining = staggeredCount;
  return events.filter((event) => {
    if (isImmediateWorkflowEvent(event)) {
      return true;
    }
    if (remaining <= 0) {
      return false;
    }
    remaining -= 1;
    return true;
  });
}

function nextWorkflowRevealDelay(events: WorkflowEvent[], visibleCount: number) {
  let remaining = visibleCount;
  for (const event of events) {
    if (isImmediateWorkflowEvent(event)) {
      continue;
    }
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    return event.role === "planning" ? workflowPlanningStaggerMs : workflowEventStaggerMs;
  }
  return workflowEventStaggerMs;
}

function useStaggeredWorkflowEvents(events: WorkflowEvent[], enabled: boolean) {
  const initialStaggeredCount = () => {
    if (!enabled) {
      return events.filter((event) => !isImmediateWorkflowEvent(event)).length;
    }
    return events.some(isImmediateWorkflowEvent) ? 0 : Math.min(1, events.length);
  };
  const [visibleCount, setVisibleCount] = useState(initialStaggeredCount);
  const visibleCountRef = useRef(visibleCount);
  const firstEventIdRef = useRef(events[0]?.id || "");

  useEffect(() => {
    visibleCountRef.current = visibleCount;
  }, [visibleCount]);

  useEffect(() => {
    const firstEventId = events[0]?.id || "";
    const staggeredEventCount = events.filter((event) => !isImmediateWorkflowEvent(event)).length;
    if (!enabled) {
      firstEventIdRef.current = firstEventId;
      setVisibleCount(staggeredEventCount);
      return undefined;
    }
    if (firstEventIdRef.current !== firstEventId) {
      firstEventIdRef.current = firstEventId;
      const initialCount = events.some(isImmediateWorkflowEvent) ? 0 : Math.min(1, staggeredEventCount);
      visibleCountRef.current = initialCount;
      setVisibleCount(initialCount);
    } else if (visibleCountRef.current > staggeredEventCount) {
      visibleCountRef.current = staggeredEventCount;
      setVisibleCount(staggeredEventCount);
    } else if (visibleCountRef.current === 0 && staggeredEventCount > 0 && !events.some(isImmediateWorkflowEvent)) {
      visibleCountRef.current = 1;
      setVisibleCount(1);
    }
    if (visibleCountRef.current >= staggeredEventCount) {
      return undefined;
    }
    let cancelled = false;
    let timer = 0;
    const scheduleNext = (currentCount: number) => {
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        let scheduledCount = currentCount;
        setVisibleCount((current) => {
          const next = Math.min(staggeredEventCount, current + 1);
          visibleCountRef.current = next;
          scheduledCount = next;
          return next;
        });
        if (scheduledCount < staggeredEventCount) {
          scheduleNext(scheduledCount);
        }
      }, nextWorkflowRevealDelay(events, currentCount));
    };
    scheduleNext(visibleCountRef.current);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, events]);

  return enabled ? visibleStaggeredWorkflowEvents(events, visibleCount) : events;
}

function workflowPreviewDedupeKey(event: WorkflowEvent, source: WorkflowPreviewSource) {
  const pathKey = workflowOutputPathKey(source.path);
  if (!pathKey) {
    return "";
  }
  const toolKey = event.toolName.toLowerCase().includes("edit") || source.kind === "diff" ? "edit" : "write";
  return `${toolKey}:${pathKey}`;
}

function chooseWorkflowPreviewEvent(previous: WorkflowPreviewEvent, next: WorkflowPreviewEvent) {
  if (next.event.status !== previous.event.status) {
    if (next.event.status !== "running") {
      return next;
    }
    if (previous.event.status === "running") {
      return next;
    }
    return previous;
  }
  return next;
}

function dedupeWorkflowOutputPreviews(items: WorkflowPreviewEvent[]) {
  const indexesByKey = new Map<string, number>();
  const nextItems: WorkflowPreviewEvent[] = [];
  for (const item of items) {
    const key = workflowPreviewDedupeKey(item.event, item.source);
    if (!key) {
      nextItems.push(item);
      continue;
    }
    const existingIndex = indexesByKey.get(key);
    if (existingIndex !== undefined) {
      nextItems[existingIndex] = chooseWorkflowPreviewEvent(nextItems[existingIndex], item);
      continue;
    }
    indexesByKey.set(key, nextItems.length);
    nextItems.push(item);
  }
  return nextItems;
}

export function WebInvestigationSources({ sources, queries }: { sources: WebInvestigationSource[]; queries: string[] }) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      const details = detailsRef.current;
      if (!details?.open) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && details.contains(target)) {
        return;
      }
      details.open = false;
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  if (!sources.length && !queries.length) {
    return null;
  }

  const sourceCount = sources.length;
  const queryCount = queries.length;
  return (
    <details className="answer-web-sources" ref={detailsRef}>
      <summary>
        <span className="answer-web-sources-title">출처</span>
        <small>
          {sourceCount ? `${sourceCount.toLocaleString()}개 사이트` : "검색어만 기록"}
          {queryCount ? ` · 검색어 ${queryCount.toLocaleString()}개` : ""}
        </small>
      </summary>
      <div className="workflow-web-source-body">
        {queries.length ? (
          <div className="workflow-web-query-group" aria-label="검색어">
            <span className="workflow-web-query-label">검색어</span>
            <div className="workflow-web-query-list">
              {queries.map((query) => (
                <span className="workflow-web-query" key={query}>{query}</span>
              ))}
            </div>
          </div>
        ) : null}
        {sources.length ? (
          <ul className="workflow-web-source-list">
            {sources.map((source, index) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  <span className="workflow-web-source-index" aria-hidden="true">{index + 1}</span>
                  <span className="workflow-web-source-copy">
                    <span className="workflow-web-source-domain">{source.domain}</span>
                    {source.path ? <span className="workflow-web-source-path">{source.path}</span> : null}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

export function WorkflowPanel({
  events: eventOverride,
  durationSeconds,
  onVisibleProgressChange,
}: {
  events?: WorkflowEvent[];
  durationSeconds?: number | null;
  onVisibleProgressChange?: () => void;
} = {}) {
  const { state } = useAppState();
  const rawEvents = eventOverride || state.workflowEvents;
  const events = useMemo(() => dedupeRunningWorkflowOutputEvents(rawEvents), [rawEvents]);
  const isActiveWorkflow = !eventOverride || eventOverride === state.workflowEvents;
  const animateActiveWorkflow = state.busy && !state.restoringHistory && isActiveWorkflow;
  const visibleEvents = useStaggeredWorkflowEvents(events, animateActiveWorkflow);
  const totalDurationSeconds = durationSeconds ?? (!eventOverride ? state.workflowDurationSeconds : null);
  const [now, setNow] = useState(() => Date.now());
  const [liveTotalDurationSeconds, setLiveTotalDurationSeconds] = useState<number | null>(null);
  const runningSinceRef = useRef<Record<string, number>>({});
  const onVisibleProgressChangeRef = useRef(onVisibleProgressChange);

  const runningCount = activeWorkflowCount(events);

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

  useEffect(() => {
    if (!animateActiveWorkflow || totalDurationSeconds || state.workflowStartedAtMs === null) {
      return undefined;
    }
    const updateDuration = () => {
      setLiveTotalDurationSeconds(Math.max(0, Math.floor((Date.now() - state.workflowStartedAtMs!) / 1000)));
    };
    updateDuration();
    const interval = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(interval);
  }, [animateActiveWorkflow, state.workflowStartedAtMs, totalDurationSeconds]);

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
    () => dedupeWorkflowOutputPreviews(
      events
        .map((event) => ({ event, source: isWorkflowOutputTool(event.toolName) ? workflowPreviewSource(event) : null }))
        .filter((item): item is WorkflowPreviewEvent => Boolean(item.source)),
    ),
    [events],
  );
  const rows = useMemo(() => workflowRows(visibleEvents), [visibleEvents]);
  const narrationByEventId = useMemo(() => {
    const next: Record<string, string> = {};
    for (const row of rows) {
      const event = row.type === "group" ? row.parent : row.event;
      const narration = workflowNarrationForEvent(event);
      if (!narration) {
        continue;
      }
      next[event.id] = narration;
    }
    return next;
  }, [rows]);
  const hasOutputPreview = outputPreviewEvents.length > 0;
  const displayedDurationSeconds = totalDurationSeconds ?? liveTotalDurationSeconds;
  const latestVisibleEventId = visibleEvents.at(-1)?.id || "";
  const countLabel = [
    `${events.length}개 기록`,
    displayedDurationSeconds !== null ? `(${formatDuration(displayedDurationSeconds)})` : "",
    runningCount ? `· ${runningCount}개 실행 중` : "",
  ].filter(Boolean).join(" ");

  useLayoutEffect(() => {
    onVisibleProgressChangeRef.current = onVisibleProgressChange;
  });

  useLayoutEffect(() => {
    if (!animateActiveWorkflow || !visibleEvents.length) {
      return;
    }
    onVisibleProgressChangeRef.current?.();
  }, [
    animateActiveWorkflow,
    displayedDurationSeconds,
    hasOutputPreview,
    latestVisibleEventId,
    rows.length,
    runningCount,
    visibleEvents.length,
  ]);

  if (!events.length) {
    return null;
  }

  return (
    <article className="message assistant workflow-message" aria-label="도구 진행 상황">
      <details className="workflow-card" open={!eventOverride && state.busy || runningCount > 0 || hasOutputPreview}>
        <summary>
          <span className="workflow-title">작업 진행</span>
          <span className="workflow-count">
            {countLabel}
          </span>
        </summary>
        <div className="workflow-body">
          <div className="workflow-list">
            {rows.map((row) => (
              <Fragment key={row.type === "group" ? row.parent.id : row.event.id}>
                {row.type === "group" ? (
                  <div
                    className={`workflow-group ${row.parent.status}`}
                    data-workflow-group-id={row.parent.groupId}
                  >
                    <WorkflowStep
                      event={row.parent}
                      detail={eventDetail(row.parent)}
                      rawDetail={row.parent.detail}
                      animate={animateActiveWorkflow}
                      quietDone={quietCompletedStep(row.parent, latestVisibleEventId)}
                      narration={narrationByEventId[row.parent.id]}
                    />
                    {row.children.length ? (
                      <div className="workflow-children" role="group" aria-label={`${row.parent.title} 하위 단계`}>
                        {row.children.map((child) => (
                          <WorkflowStep
                            event={child}
                            detail={eventDetail(child)}
                            rawDetail={child.detail}
                            animate={animateActiveWorkflow}
                            quietDone={quietCompletedStep(child, latestVisibleEventId)}
                            key={child.id}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <WorkflowStep
                    event={row.event}
                    detail={eventDetail(row.event)}
                    rawDetail={row.event.detail}
                    animate={animateActiveWorkflow}
                    quietDone={quietCompletedStep(row.event, latestVisibleEventId)}
                    narration={narrationByEventId[row.event.id]}
                  />
                )}
              </Fragment>
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
