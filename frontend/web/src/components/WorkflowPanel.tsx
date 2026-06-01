import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import type { WorkflowEvent } from "../types/ui";
import {
  artifactDisplayName,
  artifactKind,
  artifactLabelForPath,
  artifactName,
  isKnownArtifactPath,
  normalizeArtifactPath,
} from "../utils/artifacts";
import { Icon } from "./ArtifactIcons";

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

function detailIncludesElapsed(value: string) {
  return /(?:\d+분(?: \d+초)?|\d+초) 경과/.test(value);
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

function workflowDiffLineChangeKind(line: string) {
  if (line.startsWith("++ ") || /^\+(?!\+\+|\s*$)/.test(line)) {
    return "added";
  }
  if (line.startsWith("-- ") || /^-(?!--|\s*$)/.test(line)) {
    return "removed";
  }
  return null;
}

function workflowDiffLineText(line: string) {
  if (line.startsWith("++ ") || line.startsWith("-- ")) {
    return line.slice(3);
  }
  if (/^[+-](?![+-]|\s*$)/.test(line)) {
    return line.slice(1);
  }
  return line;
}

function formatWorkflowDiffCount(text: string) {
  const stats = {
    removed: { lines: 0, text: [] as string[] },
    added: { lines: 0, text: [] as string[] },
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const kind = workflowDiffLineChangeKind(line);
    if (!kind) {
      continue;
    }
    stats[kind].lines += 1;
    stats[kind].text.push(workflowDiffLineText(line));
  }
  const removedTokens = estimateTextTokens(stats.removed.text.join("\n"));
  const addedTokens = estimateTextTokens(stats.added.text.join("\n"));
  return [
    `삭제 ${formatWorkflowTokenCount(removedTokens)} (${stats.removed.lines.toLocaleString()}줄)`,
    `추가 ${formatWorkflowTokenCount(addedTokens)} (${stats.added.lines.toLocaleString()}줄)`,
  ].join(", ");
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
  if (!longReportWorkflowUiEnabled) {
    return false;
  }
  return toolName.toLowerCase() === "write_long_report";
}

const longReportWorkflowUiEnabled = false;

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
  if (path && event.status === "running" && lower.includes("write")) {
    return { path, kind: "content" as const, content: "파일 내용을 읽는 중입니다..." };
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
    if (event.status === "running") {
      return compactDetail(detail) || "장문 보고서 생성 중";
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

function chooseWorkflowOutputTimelineEvent(previous: WorkflowEvent, next: WorkflowEvent) {
  if (next.status !== previous.status) {
    if (next.status !== "running") {
      return mergeWorkflowOutputEvents(previous, next);
    }
    if (previous.status === "running") {
      return mergeWorkflowOutputEvents(previous, next);
    }
    return previous;
  }
  return mergeWorkflowOutputEvents(previous, next);
}

function workflowOutputTimelineDedupeKey(event: WorkflowEvent) {
  const source = isWorkflowOutputTool(event.toolName) ? workflowPreviewSource(event) : null;
  const pathKey = source?.kind === "content" ? workflowOutputPathKey(source.path) : "";
  return pathKey ? `${event.toolName.toLowerCase()}:${pathKey}` : "";
}

function dedupeWorkflowOutputEvents(events: WorkflowEvent[]) {
  const indexesByKey = new Map<string, number>();
  const nextEvents: WorkflowEvent[] = [];
  for (const event of events) {
    const key = workflowOutputTimelineDedupeKey(event);
    if (key) {
      const existingIndex = indexesByKey.get(key);
      if (existingIndex !== undefined) {
        nextEvents[existingIndex] = chooseWorkflowOutputTimelineEvent(nextEvents[existingIndex], event);
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
const workflowRunningPreviewFullRenderMaxChars = 80_000;
const workflowRunningPreviewTailChars = 48_000;
const workflowPreviewOutputBufferMs = 128;

function workflowPreviewArtifact(source: WorkflowPreviewSource, done: boolean): ArtifactSummary | null {
  const path = normalizeArtifactPath(source.path);
  const kind = artifactKind(path);
  if (!done || source.kind !== "content" || kind !== "html" || !isKnownArtifactPath(path)) {
    return null;
  }
  return {
    path,
    name: artifactName(path),
    kind,
    label: artifactLabelForPath(path, kind),
  };
}

function useSmoothWorkflowPreviewText(targetText: string, running: boolean, revealDurationMs: number) {
  const [visibleText, setVisibleText] = useState(targetText);
  const visibleTextRef = useRef(targetText);
  const pendingTextRef = useRef("");
  const bufferTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameFallbackTimerRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const revealBudgetRef = useRef(0);
  const revealDurationMsRef = useRef(revealDurationMs);

  function clearBufferTimer() {
    if (bufferTimerRef.current !== null) {
      window.clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
  }

  function clearFrameFallbackTimer() {
    if (frameFallbackTimerRef.current !== null) {
      window.clearTimeout(frameFallbackTimerRef.current);
      frameFallbackTimerRef.current = null;
    }
  }

  function clearRevealTimers() {
    clearBufferTimer();
    clearFrameFallbackTimer();
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastFrameAtRef.current = null;
    revealBudgetRef.current = 0;
  }

  function previewRevealRate(pendingLength: number) {
    const duration = Math.max(80, Math.min(2000, revealDurationMsRef.current));
    const baseCharsPerMs = Math.max(0.018, Math.min(0.12, 34 / duration));
    const backlogBoost = 1 + Math.min(2.4, pendingLength / 900);
    return baseCharsPerMs * backlogBoost;
  }

  function smoothPreviewRevealCount(pendingText: string, desiredCount: number) {
    const pendingChars = Array.from(pendingText);
    if (!pendingChars.length) {
      return 0;
    }
    const maxTickChars = pendingChars.length >= 1400 ? 8 : pendingChars.length >= 700 ? 6 : pendingChars.length >= 220 ? 4 : pendingChars.length >= 80 ? 2 : 1;
    return Math.min(pendingChars.length, Math.max(1, Math.min(maxTickChars, desiredCount)));
  }

  function flushPreviewText(timestamp = performance.now()) {
    animationFrameRef.current = null;
    clearFrameFallbackTimer();
    const pendingText = pendingTextRef.current;
    if (!pendingText) {
      lastFrameAtRef.current = null;
      revealBudgetRef.current = 0;
      return;
    }
    const elapsedMs =
      lastFrameAtRef.current === null ? 16 : Math.max(8, Math.min(64, timestamp - lastFrameAtRef.current));
    lastFrameAtRef.current = timestamp;
    revealBudgetRef.current += elapsedMs * previewRevealRate(Array.from(pendingText).length);
    if (revealBudgetRef.current < 1) {
      schedulePreviewRevealFrame();
      return;
    }
    const pendingChars = Array.from(pendingText);
    const revealCount = smoothPreviewRevealCount(pendingText, Math.floor(revealBudgetRef.current));
    revealBudgetRef.current = Math.max(0, revealBudgetRef.current - revealCount);
    const nextText = pendingChars.slice(0, revealCount).join("");
    pendingTextRef.current = pendingChars.slice(revealCount).join("");
    visibleTextRef.current = `${visibleTextRef.current}${nextText}`;
    setVisibleText(visibleTextRef.current);
    if (pendingTextRef.current) {
      schedulePreviewRevealFrame();
    } else {
      lastFrameAtRef.current = null;
      revealBudgetRef.current = 0;
    }
  }

  function schedulePreviewRevealFrame() {
    if (animationFrameRef.current !== null || frameFallbackTimerRef.current !== null) {
      return;
    }
    animationFrameRef.current = window.requestAnimationFrame((timestamp) => {
      flushPreviewText(timestamp);
    });
    frameFallbackTimerRef.current = window.setTimeout(() => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      flushPreviewText(performance.now());
    }, 34);
  }

  function schedulePreviewBuffer() {
    if (
      bufferTimerRef.current !== null ||
      animationFrameRef.current !== null ||
      frameFallbackTimerRef.current !== null
    ) {
      return;
    }
    bufferTimerRef.current = window.setTimeout(() => {
      bufferTimerRef.current = null;
      schedulePreviewRevealFrame();
    }, workflowPreviewOutputBufferMs);
  }

  useEffect(() => () => clearRevealTimers(), []);

  useEffect(() => {
    revealDurationMsRef.current = revealDurationMs;
    if (pendingTextRef.current) {
      clearBufferTimer();
      schedulePreviewBuffer();
    }
  }, [revealDurationMs]);

  useEffect(() => {
    if (!running || revealDurationMs <= 0) {
      clearRevealTimers();
      pendingTextRef.current = "";
      visibleTextRef.current = targetText;
      setVisibleText(targetText);
      return;
    }

    const visibleText = visibleTextRef.current;
    const queuedText = `${visibleText}${pendingTextRef.current}`;
    if (queuedText === targetText) {
      return;
    }
    if (targetText.startsWith(queuedText)) {
      pendingTextRef.current = `${pendingTextRef.current}${targetText.slice(queuedText.length)}`;
      schedulePreviewBuffer();
      return;
    }
    if (targetText.startsWith(visibleText)) {
      pendingTextRef.current = targetText.slice(visibleText.length);
      schedulePreviewBuffer();
      return;
    }

    clearRevealTimers();
    pendingTextRef.current = "";
    visibleTextRef.current = targetText;
    setVisibleText(targetText);
  }, [targetText, running, revealDurationMs]);

  return visibleText;
}

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

const failedWorkflowSourceFaviconOrigins = new Set<string>();

function faviconUrlForSourceUrl(url: string) {
  try {
    const origin = new URL(url).origin;
    return failedWorkflowSourceFaviconOrigins.has(origin) ? "" : `${origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function sourceOriginForUrl(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function sourceInitialForSource(source: WebInvestigationSource) {
  const text = (source.domain || source.label || source.url).trim().replace(/^www\./i, "");
  return Array.from(text)[0]?.toUpperCase() || "";
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
  const changeKind = workflowDiffLineChangeKind(line);
  if (changeKind === "added") {
    return "workflow-diff-line added";
  }
  if (changeKind === "removed") {
    return "workflow-diff-line removed";
  }
  if (line.startsWith("@@") || line.startsWith("*** ")) {
    return "workflow-diff-line hunk";
  }
  return "workflow-diff-line";
}

function workflowVisiblePreviewContent(event: WorkflowEvent, content: string) {
  if (event.status !== "running" || content.length <= workflowRunningPreviewFullRenderMaxChars) {
    return content;
  }
  const start = Math.max(0, content.length - workflowRunningPreviewTailChars);
  const nextLineStart = content.indexOf("\n", start);
  if (nextLineStart >= 0 && nextLineStart < content.length - 1) {
    return content.slice(nextLineStart + 1);
  }
  return content.slice(start);
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

function WorkflowOutputPreview({
  event,
  source,
  revealDurationMs,
}: {
  event: WorkflowEvent;
  source: WorkflowPreviewSource;
  revealDurationMs: number;
}) {
  const { state, dispatch } = useAppState();
  const [openingPath, setOpeningPath] = useState("");
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const done = event.status !== "running";
  const succeeded = event.status === "done";
  const displayContent = workflowVisiblePreviewContent(event, source.content);
  const visibleDisplayContent = useSmoothWorkflowPreviewText(displayContent, !done, revealDurationMs);
  const bodyClassName = [
    "workflow-output-body",
    source.kind === "diff" ? "diff" : "",
    source.kind !== "diff" && !done ? "running-fill" : "",
  ].filter(Boolean).join(" ");
  const fileName = workflowPreviewFileName(source.path);
  const prefix = source.kind === "diff"
    ? event.status === "error" ? "수정 실패" : done ? "수정 완료" : "수정 미리보기"
    : event.status === "error" ? "작성 실패" : done ? "작성 완료" : "작성 중인 결과물";
  const count = source.kind === "diff"
    ? formatWorkflowDiffCount(source.content)
    : isLongReportWorkflowTool(event.toolName)
      ? formatWorkflowLongReportCount(event, source.content)
      : formatWorkflowContentCount(source.content);
  const artifact = workflowPreviewArtifact(source, succeeded);
  const artifactDisplay = artifact ? artifactDisplayName(artifact) : fileName;

  async function openWorkflowArtifact() {
    if (!artifact) {
      return;
    }
    const displayArtifact = { ...artifact, name: artifactDisplayName(artifact) };
    dispatch({ type: "open_artifact", artifact: displayArtifact });
    setOpeningPath(displayArtifact.path);
    try {
      const payload = await readArtifact({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: displayArtifact.workspace?.path || state.workspacePath,
        workspaceName: displayArtifact.workspace?.name || state.workspaceName,
        path: displayArtifact.path,
      });
      dispatch({ type: "open_artifact", artifact: { ...displayArtifact, workspace: payload.workspace || displayArtifact.workspace }, payload });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setOpeningPath("");
    }
  }

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [event.status, visibleDisplayContent]);

  return (
    <div className="workflow-output-preview">
      <div className="workflow-output-title">
        <span className="workflow-output-label">{fileName ? `${prefix} - ${fileName}` : prefix}</span>
        <span className="workflow-output-actions">
          <span className="workflow-output-line-count">{count}</span>
          {artifact ? (
            <button
              className="workflow-output-open"
              type="button"
              aria-label={`${artifactDisplay} 미리보기 열기`}
              data-tooltip={openingPath === artifact.path ? "불러오는 중" : "미리보기 열기"}
              disabled={openingPath === artifact.path}
              onClick={() => void openWorkflowArtifact()}
            >
              <Icon name="preview" />
            </button>
          ) : null}
        </span>
      </div>
      <pre ref={bodyRef} className={bodyClassName}>{source.kind === "diff"
        ? visibleDisplayContent.split(/\r?\n/).map((line, index) => (
          <span className={workflowDiffLineClassName(line)} key={`${index}:${line}`}>
            {line || " "}
          </span>
        ))
        : visibleDisplayContent}</pre>
    </div>
  );
}

type LongReportOutlineSection = {
  title: string;
  intent: string;
  keyPoints: string[];
  analysisAngle: string;
};

type LongReportIntermediateFile = {
  label: string;
  path: string;
  sizeBytes: number;
  lineCount: number;
};

function workflowLongReportNumber(input: Record<string, unknown> | null | undefined, key: string) {
  const value = input?.[key];
  if (typeof value === "boolean") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function workflowLongReportString(input: Record<string, unknown> | null | undefined, key: string) {
  const value = input?.[key];
  return typeof value === "string" ? compactDetail(value) : "";
}

function workflowLongReportOutlineSections(input: Record<string, unknown> | null | undefined): LongReportOutlineSection[] {
  const raw = input?.outline_sections;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const title = typeof record.title === "string" ? compactDetail(record.title) : "";
      const intent = typeof record.intent === "string" ? compactDetail(record.intent) : "";
      const analysisAngle = typeof record.analysis_angle === "string" ? compactDetail(record.analysis_angle) : "";
      const keyPoints = Array.isArray(record.key_points)
        ? record.key_points
            .map((point) => (typeof point === "string" ? compactDetail(point) : ""))
            .filter(Boolean)
            .slice(0, 3)
        : typeof record.key_points === "string" && compactDetail(record.key_points)
          ? [compactDetail(record.key_points)]
          : [];
      return { title, intent, keyPoints, analysisAngle };
    })
    .filter((item) => item.title)
    .slice(0, 30);
}

function workflowLongReportIntermediateFiles(input: Record<string, unknown> | null | undefined): LongReportIntermediateFile[] {
  const raw = input?.intermediate_files;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const path = typeof record.path === "string" ? compactDetail(record.path) : "";
      const label = typeof record.label === "string" ? compactDetail(record.label) : "";
      const sizeBytes = typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes)
        ? Math.max(0, Math.round(record.size_bytes))
        : 0;
      const lineCount = typeof record.line_count === "number" && Number.isFinite(record.line_count)
        ? Math.max(0, Math.round(record.line_count))
        : 0;
      return { label, path, sizeBytes, lineCount };
    })
    .filter((item) => item.path);
}

function formatWorkflowFileSize(bytes: number) {
  if (!bytes) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes.toLocaleString()}B`;
  }
  return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)}KB`;
}

function workflowLongReportSectionSummary(section: LongReportOutlineSection) {
  return [
    section.intent,
    section.keyPoints.length ? section.keyPoints.join(", ") : "",
    section.analysisAngle,
  ].filter(Boolean).join(" · ");
}

const workflowLongReportProcessSteps = [
  { key: "plan", label: "계획", detail: "범위와 출력 형식 정리" },
  { key: "outline", label: "목차", detail: "섹션 구조 설계" },
  { key: "section", label: "섹션 작성", detail: "본문을 항목별로 작성" },
  { key: "revision", label: "보강/수정", detail: "이어쓰기와 문체 정리" },
  { key: "review", label: "검토", detail: "품질 점검과 요약" },
  { key: "merge", label: "병합/저장", detail: "최종 보고서 저장" },
] as const;

function workflowLongReportActiveProcessIndex(phase: string, eventStatus: WorkflowEvent["status"]) {
  if (eventStatus === "done") {
    return workflowLongReportProcessSteps.length - 1;
  }
  switch (phase) {
    case "outline":
    case "outline_ready":
      return 1;
    case "section":
    case "continuation":
      return 2;
    case "style_audit":
    case "style_revision":
    case "style_audit_done":
      return 3;
    case "review":
      return 4;
    case "merge":
    case "done":
      return 5;
    default:
      return eventStatus === "running" ? 1 : 0;
  }
}

function workflowLongReportPhaseFromDetail(detail: string) {
  const value = compactDetail(detail);
  if (/검토|점검/.test(value)) {
    return "review";
  }
  if (/병합|저장|완료/.test(value)) {
    return "merge";
  }
  if (/수정|보강|문체|구조/.test(value)) {
    return "style_revision";
  }
  if (/이어쓰기/.test(value)) {
    return "continuation";
  }
  if (/섹션\s*작성|본문/.test(value)) {
    return "section";
  }
  return "";
}

function workflowLongReportFallbackPhaseLabel(phase: string, event: WorkflowEvent) {
  switch (phase) {
    case "section":
      return "섹션 본문 작성 중";
    case "continuation":
      return "섹션 이어쓰기 중";
    case "style_audit":
      return "문체와 구조 일관성 점검 중";
    case "style_revision":
      return "섹션 문체와 구조 수정 중";
    case "review":
      return "검토 요약 작성 중";
    case "merge":
      return "최종 보고서 병합 중";
    default:
      return event.status === "running" ? "보고서 뼈대 생성 중" : "보고서 생성 완료";
  }
}

function workflowLongReportLiveDetail(event: WorkflowEvent, phaseLabel: string) {
  const detail = compactToolDetail(event.detail);
  if (!detail) {
    return "응답 수신 상태를 확인하는 중";
  }
  if (detail.includes(phaseLabel)) {
    return detail;
  }
  return detail.replace(/^진행 중\s*·\s*/i, "");
}

function workflowLongReportPreviewText(content: string) {
  return compactDetail(
    content
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&"),
  );
}

function workflowLongReportArtifactDetails(input: Record<string, unknown>) {
  const content = typeof input.content === "string" ? input.content : "";
  const path = workflowLongReportString(input, "output_path")
    || workflowLongReportString(input, "path")
    || workflowLongReportString(input, "file_path");
  const fileName = workflowPreviewFileName(path);
  const details: string[] = [];
  if (fileName) {
    details.push(`산출물 ${fileName}`);
  }
  if (content) {
    const lineCount = countWorkflowPreviewLines(content);
    const charCount = Array.from(content).length;
    details.push(`실제 파일 ${lineCount.toLocaleString()}줄 · ${charCount.toLocaleString()}자`);
    const previewText = workflowLongReportPreviewText(content);
    if (previewText) {
      details.push(`최근 내용: ${previewText.slice(-140)}`);
    }
  }
  const intermediateFiles = workflowLongReportIntermediateFiles(input);
  if (intermediateFiles.length) {
    const latest = intermediateFiles[0];
    details.push(`중간 산출물 ${intermediateFiles.length.toLocaleString()}개 · ${workflowPreviewFileName(latest.path)}`);
  }
  return details;
}

function WorkflowLongReportOutline({ event }: { event: WorkflowEvent }) {
  const input = event.toolInput || {};
  const sections = workflowLongReportOutlineSections(input);
  const intermediateFiles = workflowLongReportIntermediateFiles(input);
  const sectionIndex = workflowLongReportNumber(input, "section_index");
  const sectionTotal = workflowLongReportNumber(input, "section_total") || sections.length;
  const continuationIndex = workflowLongReportNumber(input, "continuation_index");
  const writtenTokens = workflowLongReportNumber(input, "document_written_tokens");
  const targetTokens = workflowLongReportNumber(input, "target_tokens");
  const phase = workflowLongReportString(input, "phase") || workflowLongReportPhaseFromDetail(event.detail);
  const phaseLabel = workflowLongReportString(input, "phase_label")
    || workflowLongReportFallbackPhaseLabel(phase, event);
  const activeProcessIndex = workflowLongReportActiveProcessIndex(phase, event.status);
  const currentSectionTitle = workflowLongReportString(input, "section_title")
    || (sectionIndex > 0 ? sections[sectionIndex - 1]?.title || "" : "");
  const currentSectionSummary = workflowLongReportString(input, "section_summary")
    || (sectionIndex > 0 ? workflowLongReportSectionSummary(sections[sectionIndex - 1]) : "");
  const artifactDetails = workflowLongReportArtifactDetails(input);
  const currentDetails = [
    currentSectionTitle
      ? `${sectionIndex && sectionTotal ? `${sectionIndex}/${sectionTotal} ` : ""}${currentSectionTitle}`
      : "",
    continuationIndex ? `이어쓰기 ${continuationIndex}회차` : "",
    currentSectionSummary,
    ...artifactDetails,
  ].filter(Boolean);
  const liveDetails = currentDetails.length
    ? currentDetails
    : event.status === "running"
      ? [workflowLongReportLiveDetail(event, phaseLabel)]
      : [];
  const meta = [
    sectionIndex && sectionTotal ? `${sectionIndex}/${sectionTotal} 섹션` : "",
    !sectionIndex && sectionTotal ? `${sectionTotal}개 섹션` : "",
    !sectionIndex && !sectionTotal && sections.length ? `${sections.length}개 섹션` : "",
    writtenTokens ? `작성 ${formatWorkflowTokenCount(writtenTokens)}` : "",
    targetTokens ? `목표 ${formatWorkflowTokenCount(targetTokens)}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="workflow-long-report-outline" aria-label="작성할 보고서 흐름">
      <div className="workflow-long-report-head">
        <span>작성할 보고서 흐름</span>
        <small>{[phaseLabel, meta].filter(Boolean).join(" · ")}</small>
      </div>
      <ol className="workflow-long-report-process" aria-label="장문 보고서 작업 단계">
        {workflowLongReportProcessSteps.map((step, index) => {
          const active = event.status === "running" && index === activeProcessIndex;
          const done = event.status !== "running" || index < activeProcessIndex;
          return (
            <li
              className={[
                "workflow-long-report-process-step",
                active ? "active" : "",
                active && !currentDetails.length ? "waiting" : "",
                done ? "done" : "",
              ].filter(Boolean).join(" ")}
              key={step.key}
            >
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </li>
          );
        })}
      </ol>
      {liveDetails.length ? (
        <div className="workflow-long-report-current">
          <span className="workflow-long-report-live-dot" aria-hidden="true" />
          <strong>{phaseLabel}</strong>
          {liveDetails.map((detail) => (
            <span key={detail}>{detail}</span>
          ))}
        </div>
      ) : null}
      {sections.length ? (
        <ol className="workflow-long-report-sections">
          {sections.map((section, index) => {
            const step = index + 1;
            const active = sectionIndex === step;
            const done = sectionIndex > step || event.status !== "running";
            const summary = workflowLongReportSectionSummary(section);
            return (
              <li
                className={[
                  "workflow-long-report-section",
                  active ? "active" : "",
                  done ? "done" : "",
                ].filter(Boolean).join(" ")}
                key={`${step}:${section.title}`}
              >
                <span className="workflow-long-report-index">{step}</span>
                <span className="workflow-long-report-section-copy">
                  <strong>{section.title}</strong>
                  {summary ? <small>{summary}</small> : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {intermediateFiles.length ? (
        <div className="workflow-long-report-files" aria-label="작성 중인 중간 산출물">
          <div className="workflow-long-report-files-head">
            <strong>중간 산출물</strong>
            <span>{intermediateFiles.length.toLocaleString()}개 파일 갱신 중</span>
          </div>
          <ol>
            {intermediateFiles.map((file) => {
              const fileName = workflowPreviewFileName(file.path);
              const meta = [
                file.lineCount ? `${file.lineCount.toLocaleString()}줄` : "",
                formatWorkflowFileSize(file.sizeBytes),
                file.label,
              ].filter(Boolean).join(" · ");
              return (
                <li key={`${file.label}:${file.path}`}>
                  <span className="workflow-long-report-file-name">{fileName}</span>
                  {meta ? <small>{meta}</small> : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
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

function isWorkflowActivityEvent(event: WorkflowEvent) {
  return event.role === "activity";
}

function latestWorkflowActivityStatusEvent(visibleEvents: WorkflowEvent[], allEvents: WorkflowEvent[] = visibleEvents) {
  const activityIndex = visibleEvents.map((event, index) => ({ event, index }))
    .reverse()
    .find(({ event }) => isWorkflowActivityEvent(event))?.index ?? -1;
  if (activityIndex === -1) {
    return null;
  }
  const activityEvent = visibleEvents[activityIndex];
  const activityIndexInAll = allEvents.findIndex((event) => event.id === activityEvent.id);
  const laterEvents = activityIndexInAll === -1 ? [] : allEvents.slice(activityIndexInAll + 1);
  const finalStarted = laterEvents.some((event) => event.role === "final");
  if (finalStarted) {
    return null;
  }
  const laterWorkRunning = laterEvents.some((event) => event.status === "running" && !isWorkflowActivityEvent(event) && event.role !== "purpose");
  if (laterWorkRunning) {
    return null;
  }
  const otherWorkRunning = allEvents.some((event) => event.id !== activityEvent.id && event.status === "running" && !isWorkflowActivityEvent(event));
  if (activityEvent.status === "done" && otherWorkRunning) {
    return null;
  }
  return activityEvent;
}

function isContextCompactionEvent(event: WorkflowEvent) {
  return event.toolName === "context_compaction";
}

function isCompactOnlyScaffoldEvent(event: WorkflowEvent) {
  return !event.toolName && (event.title === "요청 이해" || event.role === "planning");
}

function contextCompactionLabel(event: WorkflowEvent) {
  if (event.status === "error") return "컨텍스트 자동 압축 실패";
  if (event.status === "done") return "컨텍스트 자동 압축 완료";
  return "컨텍스트 자동 압축 중";
}

function ContextCompactionDivider({ event }: { event: WorkflowEvent }) {
  return (
    <div
      className={`workflow-context-compact-divider ${event.status}`}
      aria-live={event.status === "running" ? "polite" : undefined}
    >
      <span>{contextCompactionLabel(event)}</span>
    </div>
  );
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
  const visibleGeneratedDetail = isGeneratedWorkflowDetail(visibleDetail);
  const parentStep = event.level !== "child" && !event.toolName;
  const keepGeneratedParentDetail = event.title === "요청 이해" || event.role === "planning";
  const renderedDetail = parentStep && visibleGeneratedDetail && !keepGeneratedParentDetail ? "" : visibleDetail;
  const statusDetailText = showNarration
    ? narration || ""
    : showCompactToolDetail || showQuietParentDetail
      ? renderedDetail
      : `${statusLabel(event.status)}${renderedDetail ? ` · ${renderedDetail}` : ""}`;
  const showParentStatusOnly = parentStep && !renderedDetail && !showNarration;
  const shouldShowStatusDetail = showStatusDetail && !showParentStatusOnly;

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
        {shouldShowStatusDetail ? (
          <small className={showToolDetailLine ? "workflow-tool-detail" : "workflow-status-detail"}>
            {statusDetailText}
          </small>
        ) : null}
      </span>
    </div>
  );
}

function WorkflowActivityStatus({
  event,
  detail,
  rawDetail,
  narration,
}: {
  event: WorkflowEvent;
  detail: string;
  rawDetail?: string;
  narration?: string;
}) {
  const baseDetail = compactToolDetail(rawDetail ?? detail);
  const visibleDetail = compactWorkflowOutputDetail(event, baseDetail);
  const renderedDetail = isGeneratedWorkflowDetail(visibleDetail) ? "" : visibleDetail;
  const statusDetailText = narration || renderedDetail || statusLabel(event.status);
  const title = event.status === "done" && (!event.title || event.title === "다음 단계 검토 중")
    ? "다음 단계 결정 완료"
    : event.title || "다음 단계 검토 중";

  return (
    <div
      className={`workflow-activity-status ${event.status}`}
      data-workflow-role={event.role}
      aria-live={event.status === "running" ? "polite" : undefined}
    >
      <span className="workflow-activity-spinner" aria-hidden="true" />
      <span className="workflow-activity-copy">
        <strong>{title}</strong>
        <small>{statusDetailText}</small>
      </span>
    </div>
  );
}

function compactToolDetail(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isGeneratedWorkflowDetail(value: string) {
  const detail = compactDetail(value);
  if (!detail) {
    return false;
  }
  return new Set([
    "요청 확인",
    "사용자 요청을 확인했습니다.",
    "필요한 자료와 맥락을 확인하고 있습니다.",
    "필요한 정보를 확인했습니다.",
    "필요한 맥락과 진행 방향을 정리합니다.",
    "진행 방향을 정했습니다.",
    "결과를 확인하고 있습니다.",
    "결과를 확인했습니다.",
    "필요한 변경이나 명령을 실행하고 있습니다.",
    "작업 실행을 마쳤습니다.",
    "도구 결과를 읽고 다음 작업이나 최종 답변을 결정하고 있습니다.",
    "작업 중 문제가 발생했습니다.",
    "일부 자료 확인에 실패했지만, 가능한 정보로 계속 진행합니다.",
    "일부 단계에서 확인이 필요합니다.",
    "최종 답변을 작성했습니다.",
  ]).has(detail) || detail.startsWith("요청 확인 · ");
}

function activeWorkflowCount(events: WorkflowEvent[]) {
  return events.filter((event) => event.status === "running" && event.role !== "purpose").length;
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
  if (source.kind === "diff") {
    return "";
  }
  const pathKey = workflowOutputPathKey(source.path);
  if (!pathKey) {
    return "";
  }
  return `write:${pathKey}`;
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
            {sources.map((source, index) => {
              const faviconUrl = faviconUrlForSourceUrl(source.url);
              return (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    <span className="workflow-web-source-markers" aria-hidden="true">
                      <span className="workflow-web-source-favicon">
                        {sourceInitialForSource(source)}
                        {faviconUrl ? (
                          <img
                            src={faviconUrl}
                            alt=""
                            loading="lazy"
                            onError={(event) => {
                              const origin = sourceOriginForUrl(source.url);
                              if (origin) {
                                failedWorkflowSourceFaviconOrigins.add(origin);
                              }
                              event.currentTarget.remove();
                            }}
                          />
                        ) : null}
                      </span>
                      <span className="workflow-web-source-index">{index + 1}</span>
                    </span>
                    <span className="workflow-web-source-label">{source.label}</span>
                  </a>
                </li>
              );
            })}
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
  const events = useMemo(() => dedupeWorkflowOutputEvents(rawEvents), [rawEvents]);
  const isActiveWorkflow = !eventOverride || eventOverride === state.workflowEvents;
  const animateActiveWorkflow = state.busy && !state.restoringHistory && isActiveWorkflow;
  const visibleEvents = useStaggeredWorkflowEvents(events, animateActiveWorkflow);
  const totalDurationSeconds = durationSeconds ?? (!eventOverride ? state.workflowDurationSeconds : null);
  const [now, setNow] = useState(() => Date.now());
  const [liveTotalDurationSeconds, setLiveTotalDurationSeconds] = useState<number | null>(null);
  const runningSinceRef = useRef<Record<string, number>>({});
  const onVisibleProgressChangeRef = useRef(onVisibleProgressChange);

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
    if (detailIncludesElapsed(detail)) {
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
  const longReportOutlineEvent = useMemo(
    () => [...events]
      .reverse()
      .find((event) => isLongReportWorkflowTool(event.toolName) && (
        event.status === "running"
        || workflowLongReportOutlineSections(event.toolInput).length
        || workflowLongReportString(event.toolInput, "phase")
        || workflowLongReportString(event.toolInput, "phase_label")
      )),
    [events],
  );
  const visibleTimelineEvents = useMemo(
    () => visibleEvents.filter((event) => !isWorkflowActivityEvent(event) && !isContextCompactionEvent(event)),
    [visibleEvents],
  );
  const cardEvents = useMemo(
    () => events.filter((event) => !isContextCompactionEvent(event)),
    [events],
  );
  const compactProgressEvent = events.find((event) => isContextCompactionEvent(event) && event.status === "running");
  const hasCompactProgressEvent = events.some(isContextCompactionEvent);
  const latestVisibleActivityEvent = useMemo(
    () => latestWorkflowActivityStatusEvent(visibleEvents, events),
    [events, visibleEvents],
  );
  const rows = useMemo(() => workflowRows(visibleTimelineEvents), [visibleTimelineEvents]);
  const hasOutputPreview = outputPreviewEvents.length > 0;
  const hasLongReportOutline = Boolean(longReportOutlineEvent);
  const displayedDurationSeconds = totalDurationSeconds ?? liveTotalDurationSeconds;
  const latestVisibleEventId = visibleTimelineEvents.at(-1)?.id || "";
  const cardRunningCount = activeWorkflowCount(cardEvents);
  const hasMeaningfulCardEvents = cardEvents.some((event) => !isCompactOnlyScaffoldEvent(event));
  const showWorkflowCard = (rows.length > 0 || Boolean(latestVisibleActivityEvent))
    && (hasMeaningfulCardEvents || !hasCompactProgressEvent);
  const countLabel = [
    `${cardEvents.length}개 기록`,
    displayedDurationSeconds !== null ? `(${formatDuration(displayedDurationSeconds)})` : "",
    cardRunningCount ? `· ${cardRunningCount}개 실행 중` : "",
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
    hasLongReportOutline,
    hasOutputPreview,
    latestVisibleEventId,
    rows.length,
    cardRunningCount,
    visibleEvents.length,
  ]);

  if (!events.length) {
    return null;
  }

  if (!compactProgressEvent && !showWorkflowCard && !hasOutputPreview && !hasLongReportOutline) {
    return null;
  }

  return (
    <article
      className={`message assistant workflow-message${compactProgressEvent ? " context-compact-message" : ""}`}
      aria-label="도구 진행 상황"
    >
      {compactProgressEvent ? <ContextCompactionDivider event={compactProgressEvent} /> : null}
      {showWorkflowCard || hasOutputPreview || hasLongReportOutline ? (
        <details className="workflow-card" open={!eventOverride && state.busy || cardRunningCount > 0 || hasOutputPreview || hasLongReportOutline}>
          <summary>
            <span className="workflow-title">작업 진행</span>
            <span className="workflow-count">
              {countLabel}
            </span>
          </summary>
          <div className="workflow-body">
            {showWorkflowCard ? (
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
                      />
                    )}
                  </Fragment>
                ))}
                {latestVisibleActivityEvent ? (
                  <WorkflowActivityStatus
                    event={latestVisibleActivityEvent}
                    detail={eventDetail(latestVisibleActivityEvent)}
                    rawDetail={latestVisibleActivityEvent.detail}
                  />
                ) : null}
              </div>
            ) : null}
            {longReportOutlineEvent ? <WorkflowLongReportOutline event={longReportOutlineEvent} /> : null}
            {outputPreviewEvents.length ? (
              <div className="workflow-output-list">
                {outputPreviewEvents.map(({ event, source }) => (
                  <WorkflowOutputPreview
                    event={event}
                    source={source}
                    revealDurationMs={state.appSettings.streamRevealDurationMs}
                    key={event.id}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}
