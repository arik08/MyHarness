import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings } from "../types/ui";
import type { PromptTokenReferences } from "../utils/promptTokens";
import {
  countInlineSourceLinksInMarkdown,
  inlineSourceNumberingForMarkdown,
  isInlineSourceOnlyMarkdown,
  isStandaloneHtmlDocument,
  MarkdownMessage,
} from "./MarkdownMessage";
import type { SourceEvidenceByUrl, SourceNumberByKey } from "./MarkdownMessage";

const StableMarkdownMessage = memo(MarkdownMessage);

function useStreamingText(
  targetText: string,
  visuallyStreaming: boolean,
  startBufferMs: number,
  revealDurationMs: number,
) {
  const [visibleText, setVisibleText] = useState(() => (
    visuallyStreaming && Math.max(0, startBufferMs) > 0 ? "" : targetText
  ));
  const visibleTextRef = useRef(visibleText);
  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameFallbackTimerRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const revealBudgetRef = useRef(0);
  const displayStartedRef = useRef(false);
  const startBufferMsRef = useRef(startBufferMs);
  const revealDurationMsRef = useRef(revealDurationMs);

  useEffect(() => {
    visibleTextRef.current = visibleText;
  }, [visibleText]);

  function clearFlushTimer() {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }

  function clearFrameFallbackTimer() {
    if (frameFallbackTimerRef.current !== null) {
      window.clearTimeout(frameFallbackTimerRef.current);
      frameFallbackTimerRef.current = null;
    }
  }

  function clearAnimationFrame() {
    clearFrameFallbackTimer();
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastFrameAtRef.current = null;
    revealBudgetRef.current = 0;
  }

  function resetRevealLoop() {
    clearFlushTimer();
    clearAnimationFrame();
    pendingTextRef.current = "";
    displayStartedRef.current = false;
  }

  function normalizedStartBufferMs() {
    return Math.max(0, Math.min(2000, startBufferMsRef.current));
  }

  function normalizedRevealDurationMs() {
    return Math.max(0, Math.min(2000, revealDurationMsRef.current));
  }

  function normalizedRefillBufferMs() {
    const initialBufferMs = normalizedStartBufferMs();
    if (initialBufferMs <= 0) {
      return 0;
    }
    return Math.max(32, Math.min(120, Math.round(initialBufferMs * 0.45)));
  }

  function streamingRevealRate(pendingLength: number) {
    const duration = Math.max(80, normalizedRevealDurationMs());
    const baseCharsPerMs = Math.max(0.018, Math.min(0.12, 34 / duration));
    const backlogBoost = 1 + Math.min(1.8, pendingLength / 720);
    return baseCharsPerMs * backlogBoost;
  }

  function smoothRevealCount(pendingText: string, desiredCount: number) {
    const pendingChars = Array.from(pendingText);
    if (!pendingChars.length || desiredCount <= 0) {
      return 0;
    }
    return 1;
  }

  function scheduleFlush() {
    if (
      flushTimerRef.current !== null ||
      animationFrameRef.current !== null ||
      frameFallbackTimerRef.current !== null
    ) {
      return;
    }
    if (displayStartedRef.current) {
      const delay = normalizedRefillBufferMs();
      if (delay <= 0) {
        scheduleRevealFrame();
        return;
      }
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        scheduleRevealFrame();
      }, delay);
      return;
    }
    const delay = normalizedStartBufferMs();
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      scheduleRevealFrame();
    }, delay);
  }

  function scheduleRevealFrame() {
    if (animationFrameRef.current !== null || frameFallbackTimerRef.current !== null) {
      return;
    }
    if (normalizedRevealDurationMs() <= 0) {
      flushAllPendingText();
      return;
    }
    animationFrameRef.current = window.requestAnimationFrame((timestamp) => {
      animationFrameRef.current = null;
      clearFrameFallbackTimer();
      flushStreamingText(timestamp);
    });
    frameFallbackTimerRef.current = window.setTimeout(() => {
      frameFallbackTimerRef.current = null;
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      flushStreamingText(performance.now());
    }, 34);
  }

  function flushAllPendingText() {
    clearAnimationFrame();
    clearFlushTimer();
    if (!pendingTextRef.current) {
      return;
    }
    displayStartedRef.current = true;
    visibleTextRef.current = `${visibleTextRef.current}${pendingTextRef.current}`;
    pendingTextRef.current = "";
    revealBudgetRef.current = 0;
    lastFrameAtRef.current = null;
    setVisibleText(visibleTextRef.current);
  }

  function flushStreamingText(timestamp = performance.now()) {
    animationFrameRef.current = null;
    clearFrameFallbackTimer();
    const pendingText = pendingTextRef.current;
    if (!pendingText) {
      lastFrameAtRef.current = null;
      revealBudgetRef.current = 0;
      return;
    }
    displayStartedRef.current = true;
    const elapsedMs =
      lastFrameAtRef.current === null ? 16 : Math.max(8, Math.min(64, timestamp - lastFrameAtRef.current));
    lastFrameAtRef.current = timestamp;
    revealBudgetRef.current += elapsedMs * streamingRevealRate(Array.from(pendingText).length);
    if (revealBudgetRef.current < 1) {
      scheduleRevealFrame();
      return;
    }
    const pendingChars = Array.from(pendingText);
    const revealCount = smoothRevealCount(pendingText, Math.floor(revealBudgetRef.current));
    if (revealCount <= 0) {
      scheduleRevealFrame();
      return;
    }
    revealBudgetRef.current = Math.max(0, revealBudgetRef.current - revealCount);
    const nextText = pendingChars.slice(0, revealCount).join("");
    pendingTextRef.current = pendingChars.slice(revealCount).join("");
    visibleTextRef.current = `${visibleTextRef.current}${nextText}`;
    setVisibleText(visibleTextRef.current);
    if (pendingTextRef.current) {
      scheduleRevealFrame();
    } else {
      lastFrameAtRef.current = null;
      revealBudgetRef.current = 0;
    }
  }

  useEffect(() => () => {
    clearFlushTimer();
    clearAnimationFrame();
  }, []);

  useEffect(() => {
    startBufferMsRef.current = startBufferMs;
    revealDurationMsRef.current = revealDurationMs;
    if (!pendingTextRef.current) {
      return;
    }
    clearFlushTimer();
    clearAnimationFrame();
    scheduleFlush();
  }, [startBufferMs, revealDurationMs]);

  useEffect(() => {
    if (!visuallyStreaming) {
      const visibleText = visibleTextRef.current;
      const queuedText = `${visibleText}${pendingTextRef.current}`;
      if (queuedText === targetText) {
        if (pendingTextRef.current) {
          scheduleFlush();
        }
        return;
      }
      if (targetText.startsWith(visibleText) && visibleText !== targetText) {
        pendingTextRef.current = targetText.slice(visibleText.length);
        scheduleFlush();
        return;
      }
      resetRevealLoop();
      if (visibleTextRef.current !== targetText) {
        visibleTextRef.current = targetText;
        setVisibleText(targetText);
      }
      return;
    }

    const visibleText = visibleTextRef.current;
    const queuedText = `${visibleText}${pendingTextRef.current}`;
    if (queuedText === targetText) {
      return;
    }

    if (targetText.startsWith(queuedText)) {
      pendingTextRef.current = `${pendingTextRef.current}${targetText.slice(queuedText.length)}`;
      scheduleFlush();
      return;
    }

    if (targetText.startsWith(visibleText)) {
      pendingTextRef.current = targetText.slice(visibleText.length);
      scheduleFlush();
      return;
    }

    resetRevealLoop();
    visibleTextRef.current = targetText;
    setVisibleText(targetText);
  }, [targetText, visuallyStreaming, startBufferMs, revealDurationMs]);

  const snapCompletedReplacement = !visuallyStreaming
    && visibleText !== targetText
    && !targetText.startsWith(visibleText);

  return {
    visibleText: snapCompletedReplacement ? targetText : visibleText,
    revealing: !snapCompletedReplacement && (visuallyStreaming || visibleText !== targetText || Boolean(pendingTextRef.current)),
  };
}

function splitStableMarkdownChunks(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (isStandaloneHtmlDocument(source)) {
    return [source.trimEnd()];
  }
  const chunks: string[] = [];
  const lines = source.split("\n");
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const pushCurrent = () => {
    const chunk = current.join("\n").trimEnd();
    if (chunk.trim()) {
      if (chunks.length && isInlineSourceOnlyMarkdown(chunk)) {
        chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${chunk}`;
      } else {
        chunks.push(chunk);
      }
    }
    current = [];
  };

  for (const line of lines) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      current.push(line);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        pushCurrent();
      }
      continue;
    }

    if (!inFence && line.trim() === "") {
      pushCurrent();
      continue;
    }

    current.push(line);
  }

  pushCurrent();
  return chunks;
}

function splitStreamingMarkdown(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  let stableBoundary = 0;
  let position = 0;
  let inFence = false;
  let fenceMarker = "";

  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const rawLine = match[0];
    if (!rawLine) {
      break;
    }
    const lineEnd = position + rawLine.length;
    const lineText = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    const fence = lineText.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        stableBoundary = lineEnd;
      }
    } else if (!inFence && lineText.trim() === "") {
      stableBoundary = lineEnd;
    }

    position = lineEnd;
  }

  return {
    prefix: source.slice(0, stableBoundary).trimEnd(),
    liveTail: source.slice(stableBoundary),
  };
}

function stableChunkHash(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

function StreamingPlainText({ text }: { text: string }) {
  return <p>{text}</p>;
}

function incompleteFenceLanguage(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n").trimStart();
  const lines = source.split("\n");
  const firstLine = lines[0] || "";
  const fence = firstLine.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?/);
  if (!fence) {
    return "";
  }
  const marker = fence[1];
  const closed = lines.slice(1).some((line) => {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    return Boolean(close && close[1][0] === marker[0] && close[1].length >= marker.length);
  });
  return closed ? "" : String(fence[2] || "").toLowerCase();
}

function hasIncompleteFence(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n").trimStart();
  const lines = source.split("\n");
  const firstLine = lines[0] || "";
  const fence = firstLine.match(/^(`{3,}|~{3,})/);
  if (!fence) {
    return false;
  }
  const marker = fence[1];
  return !lines.slice(1).some((line) => {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    return Boolean(close && close[1][0] === marker[0] && close[1].length >= marker.length);
  });
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return [];
  }
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some(Boolean);
}

function isMarkdownTableDivider(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isPossibleStreamingTableContinuation(line: string) {
  const trimmed = String(line || "").trim();
  return Boolean(trimmed && trimmed.includes("|"));
}

function hasStreamingMarkdownTable(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    if (!isMarkdownTableRow(lines[index - 1]) || !isMarkdownTableDivider(lines[index])) {
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) {
      cursor += 1;
    }
    const trailingLines = lines.slice(cursor);
    const hasOnlyTrailingBlankLines = trailingLines.every((line) => line.trim() === "");
    return cursor >= lines.length
      || hasOnlyTrailingBlankLines
      || isPossibleStreamingTableContinuation(lines[cursor] || "");
  }
  return false;
}

function incompleteInlineSourceLinkStart(text: string) {
  const source = String(text || "");
  const linkStart = source.search(/\[(?:출처|참고)\s*:[^\]]*$/);
  const completeLinkStart = Math.max(source.lastIndexOf("[출처:"), source.lastIndexOf("[참고:"));
  if (linkStart >= 0) {
    return linkStart;
  }
  if (completeLinkStart < 0) {
    return -1;
  }
  const tail = source.slice(completeLinkStart);
  if (!/^\[(?:출처|참고)\s*:/i.test(tail)) {
    return -1;
  }
  const closeLabel = tail.indexOf("]");
  if (closeLabel < 0) {
    return completeLinkStart;
  }
  const afterLabel = tail.slice(closeLabel + 1);
  if (!afterLabel.startsWith("(")) {
    return -1;
  }
  let escaped = false;
  let quoted = "";
  for (let index = 1; index < afterLabel.length; index += 1) {
    const char = afterLabel[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quoted) {
      if (char === quoted) {
        quoted = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quoted = char;
      continue;
    }
    if (char === ")") {
      return -1;
    }
  }
  return completeLinkStart;
}

function pendingHtmlSourceLength(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n").trimStart();
  const lines = source.split("\n");
  return Math.max(0, lines.slice(1).join("\n").length);
}

function HtmlStreamPending({ text }: { text: string }) {
  const sourceLength = pendingHtmlSourceLength(text);
  const label = sourceLength > 0 ? "차트 미리보기 준비 중" : "차트 미리보기 대기 중";
  return (
    <div className="markdown-body react-markdown stream-live-text">
      <div className="workflow-output-preview html-stream-preview" data-html-preview-pending="true">
        <div className="workflow-output-title">
          <span className="workflow-output-label">{label}</span>
          <span className="workflow-output-line-count">{sourceLength.toLocaleString()}자</span>
        </div>
        <div className="workflow-output-body html-preview-pending-body">
          <span className="html-preview-spinner" aria-hidden="true"></span>
          <span>소스를 받은 뒤 바로 렌더링합니다.</span>
        </div>
      </div>
    </div>
  );
}

function usePendingDots(enabled: boolean) {
  const [dotCount, setDotCount] = useState(() => (enabled ? 1 : 3));

  useEffect(() => {
    if (!enabled) {
      setDotCount(3);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setDotCount((current) => (current >= 3 ? 1 : current + 1));
    }, 700);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return ".".repeat(dotCount);
}

function PendingStatusBox({
  className,
  label,
  animatedDots = false,
  icon,
}: {
  className: string;
  label: string;
  animatedDots?: boolean;
  icon: ReactNode;
}) {
  const dots = usePendingDots(animatedDots);
  return (
    <div className={`markdown-body react-markdown stream-live-text ${className}`} role="status">
      <div className="stream-pending-box mermaid-stream-pending-box">
        <span className="stream-pending-icon mermaid-stream-pending-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{label}{dots}</span>
      </div>
    </div>
  );
}

function MermaidStreamPending() {
  return (
    <PendingStatusBox
      className="mermaid-stream-pending"
      label="다이어그램 작성 중"
      animatedDots
      icon={(
        <svg viewBox="0 0 24 24">
          <path d="M4 7h6"></path>
          <path d="M14 7h6"></path>
          <path d="M10 7h4"></path>
          <path d="M7 7v5"></path>
          <path d="M17 7v5"></path>
          <path d="M7 12h10"></path>
          <path d="M12 12v5"></path>
          <path d="M9 17h6"></path>
        </svg>
      )}
    />
  );
}

function TableStreamPending() {
  return (
    <PendingStatusBox
      className="markdown-table-stream-pending"
      label="표 작성 중"
      animatedDots
      icon={(
        <svg viewBox="0 0 24 24">
          <path d="M4 6h16"></path>
          <path d="M4 12h16"></path>
          <path d="M4 18h16"></path>
          <path d="M8 6v12"></path>
          <path d="M15 6v12"></path>
        </svg>
      )}
    />
  );
}

function InlineSourceStreamPending() {
  const dots = usePendingDots(true);
  return (
    <span className="inline-source-stream-pending" role="status">
      <span className="markdown-inline-source-favicon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93"></path>
          <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07"></path>
        </svg>
      </span>
      <span>출처 정리 중{dots}</span>
    </span>
  );
}

function StreamingMarkdownMessage({
  text,
  complete = false,
  sourceEvidenceByUrl,
  promptTokenReferences,
}: {
  text: string;
  complete?: boolean;
  sourceEvidenceByUrl?: SourceEvidenceByUrl;
  promptTokenReferences?: PromptTokenReferences;
}) {
  const normalizedText = String(text || "").replace(/\r\n/g, "\n");
  const { prefix, liveTail } = useMemo(() => {
    if (complete) {
      return { prefix: normalizedText.trimEnd(), liveTail: "" };
    }
    return splitStreamingMarkdown(normalizedText);
  }, [complete, normalizedText]);
  const liveTailFenceLanguage = incompleteFenceLanguage(liveTail);
  const liveTailHasIncompleteFence = hasIncompleteFence(liveTail);
  const liveTailHasStreamingTable = hasStreamingMarkdownTable(liveTail);
  const incompleteSourceLinkStart = incompleteInlineSourceLinkStart(liveTail);
  const liveTailBeforeIncompleteSourceLink = incompleteSourceLinkStart >= 0
    ? liveTail.slice(0, incompleteSourceLinkStart).trimEnd()
    : "";
  const prefixChunks = useMemo(() => splitStableMarkdownChunks(prefix), [prefix]);
  const prefixSourceNumbering = useMemo(() => {
    let sourceNumberByKey: SourceNumberByKey = {};
    const chunkNumberByKey = prefixChunks.map((chunk) => {
      const numberByKey = countInlineSourceLinksInMarkdown(chunk) ? { ...sourceNumberByKey } : undefined;
      sourceNumberByKey = inlineSourceNumberingForMarkdown(chunk, sourceNumberByKey);
      return numberByKey;
    });
    return { chunkNumberByKey, sourceNumberByKey };
  }, [prefixChunks]);
  let chunkCursor = 0;
  const chunkOccurrences = new Map<string, number>();

  return (
    <div className="assistant-markdown-flow">
      {prefixChunks.map((chunk, index) => {
        const chunkStart = prefix.indexOf(chunk, chunkCursor);
        chunkCursor = chunkStart >= 0 ? chunkStart + chunk.length : chunkCursor + chunk.length;
        const chunkHash = stableChunkHash(chunk);
        const chunkOccurrence = chunkOccurrences.get(chunkHash) || 0;
        chunkOccurrences.set(chunkHash, chunkOccurrence + 1);
        return (
          <StableMarkdownMessage
            key={`${chunkHash}:${chunkOccurrence}`}
            text={chunk}
            sourceEvidenceByUrl={sourceEvidenceByUrl}
            sourceNumberByKey={prefixSourceNumbering.chunkNumberByKey[index]}
            promptTokenReferences={promptTokenReferences}
          />
        );
      })}
      {liveTailFenceLanguage === "html" || liveTailFenceLanguage === "htm" ? (
        <HtmlStreamPending text={liveTail} />
      ) : liveTailFenceLanguage === "mermaid" || liveTailFenceLanguage === "mmd" ? (
        <MermaidStreamPending />
      ) : liveTailHasStreamingTable ? (
        <TableStreamPending />
      ) : incompleteSourceLinkStart >= 0 ? (
        <>
          {liveTailBeforeIncompleteSourceLink ? (
            <StableMarkdownMessage
              text={liveTailBeforeIncompleteSourceLink}
              deferIncompleteTables
              className="stream-live-text inline-source-pending-prefix"
              sourceEvidenceByUrl={sourceEvidenceByUrl}
              sourceNumberByKey={countInlineSourceLinksInMarkdown(liveTailBeforeIncompleteSourceLink) ? prefixSourceNumbering.sourceNumberByKey : undefined}
              promptTokenReferences={promptTokenReferences}
            />
          ) : null}
          <InlineSourceStreamPending />
        </>
      ) : liveTailHasIncompleteFence ? (
        <div className="markdown-body react-markdown stream-live-text">
          <StreamingPlainText text={liveTail} />
        </div>
      ) : liveTail ? (
        <StableMarkdownMessage
          text={liveTail}
          deferIncompleteTables
          className="stream-live-text"
          sourceEvidenceByUrl={sourceEvidenceByUrl}
          sourceNumberByKey={countInlineSourceLinksInMarkdown(liveTail) ? prefixSourceNumbering.sourceNumberByKey : undefined}
          promptTokenReferences={promptTokenReferences}
        />
      ) : null}
    </div>
  );
}

export function StreamingTextRenderer({
  text,
  settings,
  streaming,
  onVisibleTextChange,
  sourceEvidenceByUrl,
  promptTokenReferences,
}: {
  text: string;
  settings: Pick<AppSettings, "streamStartBufferMs" | "streamRevealDurationMs">;
  streaming: boolean;
  onVisibleTextChange?: () => void;
  sourceEvidenceByUrl?: SourceEvidenceByUrl;
  promptTokenReferences?: PromptTokenReferences;
}) {
  const { visibleText, revealing } = useStreamingText(
    text,
    streaming,
    settings.streamStartBufferMs,
    settings.streamRevealDurationMs,
  );

  useEffect(() => {
    if (revealing && visibleText) {
      onVisibleTextChange?.();
    }
  }, [revealing, onVisibleTextChange, visibleText]);

  return (
    <div className={revealing ? "react-streaming-text streaming-text" : undefined}>
      <StreamingMarkdownMessage
        text={revealing ? visibleText : text}
        complete={!revealing}
        sourceEvidenceByUrl={sourceEvidenceByUrl}
        promptTokenReferences={promptTokenReferences}
      />
    </div>
  );
}
