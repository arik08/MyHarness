import { AsideWorkflowTimeline, workflowSafeText } from "./AsideWorkflowTimeline";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import { isResponseVisiblyBusy } from "../state/selectors";
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

type WorkflowContentCount = {
  tokens: number;
  lines: number;
};

function workflowContentCount(text: string): WorkflowContentCount {
  return {
    tokens: estimateTextTokens(text),
    lines: countWorkflowPreviewLines(text),
  };
}

function formatWorkflowContentCountValue(count: WorkflowContentCount) {
  return `${formatWorkflowTokenCount(count.tokens)} (${Math.max(0, Math.round(count.lines || 0)).toLocaleString()}줄)`;
}

function formatWorkflowContentCount(text: string) {
  return formatWorkflowContentCountValue(workflowContentCount(text));
}

function workflowContentCountForVisibleProgress(
  target: WorkflowContentCount,
  fullText: string,
  visibleText: string,
  enabled: boolean,
): WorkflowContentCount {
  if (!enabled) {
    return target;
  }
  const fullLength = Math.max(0, fullText.length);
  if (!fullLength) {
    return target;
  }
  const visibleLength = Math.max(0, Math.min(fullLength, visibleText.length));
  if (!visibleLength) {
    return { tokens: 0, lines: 0 };
  }
  const progress = Math.min(1, visibleLength / fullLength);
  return {
    tokens: Math.max(1, Math.min(target.tokens, Math.round(target.tokens * progress))),
    lines: Math.max(1, Math.min(target.lines, Math.round(target.lines * progress))),
  };
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

function isSaveSkillTool(toolName: string) {
  return toolName.toLowerCase() === "save_skill";
}

function workflowSkillPreview(input: Record<string, unknown>) {
  const name = workflowInputValue(input, ["name"]).value;
  const description = workflowInputValue(input, ["description"]).value;
  const instructions = workflowInputValue(input, ["instructions"]).value;
  const existingContent = workflowInputValue(input, ["content"]);
  if (!instructions && !existingContent.found) {
    return null;
  }
  const yamlValue = (value: string) => (
    value.trim() === value && value && !/[\n\r:#]/.test(value) ? value : JSON.stringify(value)
  );
  return {
    path: name ? `.skills/POSCO_Skill/${name}/SKILL.md` : "SKILL.md",
    content: instructions ? [
      "---",
      `name: ${yamlValue(name)}`,
      `description: ${yamlValue(description)}`,
      "---",
      "",
      instructions,
    ].join("\n") : existingContent.value,
  };
}

function workflowSkillSupportingPreviews(input: Record<string, unknown>) {
  const name = workflowInputValue(input, ["name"]).value;
  const files = Array.isArray(input.supporting_files) ? input.supporting_files : [];
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") {
      return [];
    }
    const record = file as Record<string, unknown>;
    const path = workflowInputValue(record, ["path"]).value.trim().replace(/\\/g, "/");
    const content = workflowInputValue(record, ["content"]);
    if (!path || !content.found) {
      return [];
    }
    return [{
      path: name ? `.skills/POSCO_Skill/${name}/${path}` : path,
      kind: "content" as const,
      content: content.value,
    }];
  });
}

function workflowPreviewSource(event: WorkflowEvent) {
  const lower = event.toolName.toLowerCase();
  const input = event.toolInput || {};
  if (isSaveSkillTool(event.toolName)) {
    const preview = workflowSkillPreview(input);
    if (preview) {
      return { ...preview, kind: "content" as const };
    }
  }
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

function workflowPreviewSources(event: WorkflowEvent) {
  const primary = workflowPreviewSource(event);
  if (!isSaveSkillTool(event.toolName)) {
    return primary ? [primary] : [];
  }
  return [
    ...(primary ? [primary] : []),
    ...workflowSkillSupportingPreviews(event.toolInput || {}),
  ];
}

type WorkflowPreviewSource = NonNullable<ReturnType<typeof workflowPreviewSource>>;
const workflowRunningPreviewFullRenderMaxChars = 80_000;
const workflowRunningPreviewTailChars = 48_000;
const workflowPreviewOutputBufferMs = 50;
const workflowPreviewFrameIntervalMs = 50;
const workflowPreviewChunkPacerSampleSize = 3;
const workflowPreviewChunkPacerMinIntervalMs = 24;
const workflowPreviewChunkPacerMaxIntervalMs = 600;
const workflowPreviewChunkPacerMinRate = 1 / 96;
const workflowPreviewChunkPacerMaxRate = 0.5;
const workflowPreviewHiddenFrameFallbackMs = 120;

type WorkflowPreviewChunkSample = {
  chars: number;
  intervalMs: number;
};

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
  const recentChunkSamplesRef = useRef<WorkflowPreviewChunkSample[]>([]);
  const lastChunkAtRef = useRef<number | null>(null);

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
    recentChunkSamplesRef.current = [];
    lastChunkAtRef.current = null;
  }

  function recordPreviewChunk(chunkText: string) {
    const chars = Array.from(chunkText).length;
    if (!chars) {
      return;
    }
    const now = performance.now();
    const previousChunkAt = lastChunkAtRef.current;
    lastChunkAtRef.current = now;
    if (previousChunkAt === null) {
      return;
    }
    const intervalMs = Math.max(
      workflowPreviewChunkPacerMinIntervalMs,
      Math.min(workflowPreviewChunkPacerMaxIntervalMs, now - previousChunkAt),
    );
    recentChunkSamplesRef.current = [
      ...recentChunkSamplesRef.current,
      { chars, intervalMs },
    ].slice(-workflowPreviewChunkPacerSampleSize);
  }

  function recentPreviewChunkRevealRate(pendingLength: number) {
    const samples = recentChunkSamplesRef.current;
    if (!samples.length) {
      return null;
    }
    const totalChars = samples.reduce((total, sample) => total + sample.chars, 0);
    const totalIntervalMs = samples.reduce((total, sample) => total + sample.intervalMs, 0);
    if (totalChars <= 0 || totalIntervalMs <= 0) {
      return null;
    }
    const averageChars = totalChars / samples.length;
    const baseRate = totalChars / totalIntervalMs;
    const backlogBoost = 1 + Math.min(2.5, Math.max(0, pendingLength - averageChars * 2) / Math.max(averageChars * 4, 1));
    return Math.max(
      workflowPreviewChunkPacerMinRate,
      Math.min(workflowPreviewChunkPacerMaxRate, baseRate * 0.9 * backlogBoost),
    );
  }

  function previewRevealRate(pendingLength: number) {
    const recentRate = recentPreviewChunkRevealRate(pendingLength);
    if (recentRate !== null) {
      return recentRate;
    }
    const duration = Math.max(80, Math.min(2000, revealDurationMsRef.current));
    const baseCharsPerMs = Math.max(0.018, Math.min(0.12, 34 / duration));
    const backlogBoost = 1 + Math.min(2.4, pendingLength / 900);
    return baseCharsPerMs * backlogBoost;
  }

  function smoothPreviewRevealCount(pendingLength: number, desiredCount: number) {
    if (!pendingLength) {
      return 0;
    }
    const maxTickChars = pendingLength >= 1400 ? 8 : pendingLength >= 700 ? 6 : pendingLength >= 220 ? 4 : pendingLength >= 20 ? 2 : 1;
    return Math.min(pendingLength, Math.max(1, Math.min(maxTickChars, desiredCount)));
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
    revealBudgetRef.current += elapsedMs * previewRevealRate(pendingText.length);
    if (revealBudgetRef.current < 1) {
      schedulePreviewRevealFrame();
      return;
    }
    const pendingChars = Array.from(pendingText);
    const revealCount = smoothPreviewRevealCount(pendingChars.length, Math.floor(revealBudgetRef.current));
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

  function schedulePreviewRevealFrame(delayMs = workflowPreviewFrameIntervalMs) {
    if (animationFrameRef.current !== null || frameFallbackTimerRef.current !== null) {
      return;
    }
    frameFallbackTimerRef.current = window.setTimeout(() => {
      frameFallbackTimerRef.current = null;
      if (document.hidden) {
        flushPreviewText(performance.now());
        return;
      }
      animationFrameRef.current = window.requestAnimationFrame((timestamp) => {
        flushPreviewText(timestamp);
      });
      frameFallbackTimerRef.current = window.setTimeout(() => {
        frameFallbackTimerRef.current = null;
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        flushPreviewText(performance.now());
      }, workflowPreviewHiddenFrameFallbackMs);
    }, delayMs);
  }

  function schedulePreviewBuffer() {
    if (
      bufferTimerRef.current !== null ||
      animationFrameRef.current !== null ||
      frameFallbackTimerRef.current !== null
    ) {
      return;
    }
    if (visibleTextRef.current) {
      schedulePreviewRevealFrame();
      return;
    }
    bufferTimerRef.current = window.setTimeout(() => {
      bufferTimerRef.current = null;
      schedulePreviewRevealFrame(0);
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
      const nextChunk = targetText.slice(queuedText.length);
      pendingTextRef.current = `${pendingTextRef.current}${nextChunk}`;
      recordPreviewChunk(nextChunk);
      schedulePreviewBuffer();
      return;
    }
    if (targetText.startsWith(visibleText)) {
      const nextChunk = targetText.slice(visibleText.length);
      pendingTextRef.current = nextChunk;
      recordPreviewChunk(nextChunk);
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
  return lower !== "todo_write" && lower !== "todowrite" && (lower === "save_skill" || lower.includes("write") || lower.includes("edit") || lower.includes("patch"));
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
  const longReportTool = isLongReportWorkflowTool(event.toolName);
  const contentCountTarget = useMemo(() => workflowContentCount(source.content), [source.content]);
  const visibleContentCount = workflowContentCountForVisibleProgress(
    contentCountTarget,
    displayContent,
    visibleDisplayContent,
    source.kind !== "diff" && !longReportTool && event.status === "running" && displayContent.length === source.content.length,
  );
  const staticCount = useMemo(
    () => source.kind === "diff"
      ? formatWorkflowDiffCount(source.content)
      : longReportTool
        ? formatWorkflowLongReportCount(event, source.content)
        : "",
    [event.output, event.status, event.toolInput, longReportTool, source.content, source.kind],
  );
  const count = source.kind !== "diff" && !longReportTool
    ? formatWorkflowContentCountValue(visibleContentCount)
    : staticCount;
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
                      <span className="workflow-web-source-index">{index + 1}</span>
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
                    </span>
                    <span className="workflow-web-source-label">
                      <span className="workflow-web-source-domain">{source.domain || source.label}</span>
                      {source.path && source.path !== "/" ? (
                        <span className="workflow-web-source-path">{source.path}</span>
                      ) : null}
                    </span>
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
  persistenceKey,
  expanded = false,
  busy: busyOverride,
}: {
  events?: WorkflowEvent[];
  durationSeconds?: number | null;
  onVisibleProgressChange?: () => void;
  persistenceKey?: string;
  expanded?: boolean;
  busy?: boolean;
} = {}) {
  const { state } = useAppState();
  const events = eventOverride || state.workflowEvents;
  const active = !eventOverride || eventOverride === state.workflowEvents;
  const busy = busyOverride ?? (active && isResponseVisiblyBusy(state));
  const [now, setNow] = useState(Date.now);
  const progressCallback = useRef(onVisibleProgressChange);
  useLayoutEffect(() => { progressCallback.current = onVisibleProgressChange; });
  const visibleProgress = events.map((event) => `${event.id}:${event.status}:${event.detail}`).join("|");
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useLayoutEffect(() => {
    if (busy && !state.restoringHistory) progressCallback.current?.();
  }, [visibleProgress, busy, state.restoringHistory]);
  const duration = durationSeconds ?? (active ? state.workflowDurationSeconds : null)
    ?? (busy && state.workflowStartedAtMs !== null ? Math.max(0, Math.floor((now - state.workflowStartedAtMs) / 1000)) : null);
  const scope = `myharness:aside:${state.workspacePath}:${state.activeHistoryId || state.sessionId || "draft"}:${persistenceKey || events[0]?.id || "active"}`;
  return <AsideWorkflowTimeline events={events} scope={scope} duration={duration} busy={busy} expanded={expanded} workspacePath={state.workspacePath}
    agents={active ? state.swarmTeammates : []}
    renderPreview={(event) => isWorkflowOutputTool(event.toolName) ? workflowPreviewSources(event).map((source) => (
      <WorkflowOutputPreview key={`${event.id}:${source.path}`} event={event} source={{ ...source, content: workflowSafeText(source.content) }} revealDurationMs={0} />
    )) : null} />;
}
