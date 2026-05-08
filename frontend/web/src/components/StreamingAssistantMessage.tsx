import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppSettings, ChatMessage } from "../types/ui";
import { MarkdownMessage } from "./MarkdownMessage";

const StableMarkdownMessage = memo(MarkdownMessage);

function useStreamingText(
  targetText: string,
  visuallyStreaming: boolean,
  startBufferMs: number,
  revealDurationMs: number,
) {
  const [visibleText, setVisibleText] = useState(targetText);
  const [revealFrom, setRevealFrom] = useState<number | null>(null);
  const visibleTextRef = useRef(visibleText);
  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameFallbackTimerRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const revealBudgetRef = useRef(0);
  const displayStartedRef = useRef(false);

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

  function streamingRevealRate(pendingLength: number) {
    const duration = Math.max(120, Math.min(2000, revealDurationMs));
    const baseCharsPerMs = Math.max(0.08, Math.min(0.22, 90 / duration));
    const backlogBoost = 1 + Math.min(2.4, pendingLength / 520);
    return baseCharsPerMs * backlogBoost;
  }

  function smoothRevealCount(pendingText: string, desiredCount: number) {
    const pendingChars = Array.from(pendingText);
    if (!pendingChars.length) {
      return 0;
    }
    const maxFrameChars = Math.max(3, Math.min(18, 4 + Math.floor(pendingChars.length / 90)));
    const limit = Math.min(pendingChars.length, Math.max(1, Math.min(maxFrameChars, desiredCount)));
    if (pendingChars.length <= limit) {
      return pendingChars.length;
    }
    const lookahead = Math.min(pendingChars.length, limit + 3);
    let bestBoundary = 0;
    for (let index = 1; index <= lookahead; index += 1) {
      if (/[\s,.;:!?)]/u.test(pendingChars[index - 1] || "")) {
        bestBoundary = index;
      }
    }
    return bestBoundary || limit;
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
      scheduleRevealFrame();
      return;
    }
    const delay = Math.max(0, Math.min(2000, startBufferMs));
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      scheduleRevealFrame();
    }, delay);
  }

  function scheduleRevealFrame() {
    if (animationFrameRef.current !== null || frameFallbackTimerRef.current !== null) {
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
      scheduleFlush();
      return;
    }
    const pendingChars = Array.from(pendingText);
    const revealCount = smoothRevealCount(pendingText, Math.floor(revealBudgetRef.current));
    if (revealCount <= 0) {
      scheduleFlush();
      return;
    }
    revealBudgetRef.current = Math.max(0, revealBudgetRef.current - revealCount);
    const nextText = pendingChars.slice(0, revealCount).join("");
    pendingTextRef.current = pendingChars.slice(revealCount).join("");
    setRevealFrom(visibleTextRef.current.length);
    visibleTextRef.current = `${visibleTextRef.current}${nextText}`;
    setVisibleText(visibleTextRef.current);
    if (pendingTextRef.current) {
      scheduleFlush();
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
    if (!visuallyStreaming) {
      const visibleText = visibleTextRef.current;
      const queuedText = `${visibleText}${pendingTextRef.current}`;
      if (queuedText === targetText) {
        if (pendingTextRef.current) {
          scheduleFlush();
        } else {
          setRevealFrom(null);
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
      setRevealFrom(null);
      return;
    }

    const visibleText = visibleTextRef.current;
    const queuedText = `${visibleText}${pendingTextRef.current}`;
    if (queuedText === targetText) {
      return;
    }

    if (targetText.startsWith(queuedText)) {
      pendingTextRef.current = targetText.slice(queuedText.length);
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
    setRevealFrom(null);
    setVisibleText(targetText);
  }, [targetText, visuallyStreaming, startBufferMs, revealDurationMs]);

  return {
    visibleText,
    revealFrom,
    revealing: visuallyStreaming || visibleText !== targetText || Boolean(pendingTextRef.current),
  };
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

function splitStableMarkdownChunks(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const chunks: string[] = [];
  const lines = source.split("\n");
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const pushCurrent = () => {
    const chunk = current.join("\n").trimEnd();
    if (chunk.trim()) {
      chunks.push(chunk);
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

function stableChunkHash(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return [];
  }
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some(Boolean);
}

function isMarkdownTableDivider(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isIncompleteWorkflowFence(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n").trimStart();
  const lines = source.split("\n");
  const firstLine = lines[0] || "";
  const fence = firstLine.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?/);
  if (!fence) {
    return false;
  }
  const marker = fence[1];
  const closed = lines.slice(1).some((line) => {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})/);
    return Boolean(close && close[1][0] === marker[0] && close[1].length >= marker.length);
  });
  if (closed) {
    return false;
  }
  const language = String(fence[2] || "").toLowerCase();
  const body = lines.slice(1).join("\n");
  const hasWorkflowNodeSyntax = /\[(?![ xX]\])[^\]\n]{1,120}\]/.test(body);
  const hasWorkflowNodes = /\[[^\]]+\]/.test(body) && (/->|=>|→|↔/.test(body) || (body.match(/\[[^\]]+\]/g) || []).length >= 2);
  return language === "workflow" || hasWorkflowNodes || (!language && hasWorkflowNodeSyntax);
}

function isIncompleteMermaidFence(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n").trimStart();
  const lines = source.split("\n");
  const firstLine = lines[0] || "";
  const fence = firstLine.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?/);
  if (!fence) {
    return false;
  }
  const language = String(fence[2] || "").toLowerCase();
  if (language !== "mermaid" && language !== "mmd") {
    return false;
  }
  const marker = fence[1];
  const closed = lines.slice(1).some((line) => {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    return Boolean(close && close[1][0] === marker[0] && close[1].length >= marker.length);
  });
  return !closed;
}

function isStructuredLiveMarkdown(text: string) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const trimmed = source.trimStart();
  if (isIncompleteWorkflowFence(trimmed) || isIncompleteMermaidFence(trimmed)) {
    return false;
  }
  if (/^(`{3,}|~{3,})\s*(html?|[A-Za-z0-9_-]+)?/i.test(trimmed)) {
    return true;
  }
  const lines = source.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    if (isMarkdownTableRow(lines[index - 1]) && isMarkdownTableDivider(lines[index])) {
      return true;
    }
  }
  return false;
}

function StreamingPlainText({ text, revealFrom }: { text: string; revealFrom: number | null }) {
  if (revealFrom === null || revealFrom < 0 || revealFrom >= text.length) {
    return <p>{text}</p>;
  }
  return (
    <p>
      {text.slice(0, revealFrom)}
      <span className="stream-reveal-sentence">{text.slice(revealFrom)}</span>
    </p>
  );
}

function StreamingMarkdownMessage({
  text,
  revealFrom,
  complete = false,
}: {
  text: string;
  revealFrom: number | null;
  complete?: boolean;
}) {
  const { prefix, liveTail } = useMemo(() => {
    if (complete) {
      return { prefix: String(text || "").replace(/\r\n/g, "\n").trimEnd(), liveTail: "" };
    }
    return splitStreamingMarkdown(text);
  }, [complete, text]);
  const prefixChunks = useMemo(() => splitStableMarkdownChunks(prefix), [prefix]);
  const renderLiveTailAsMarkdown = isStructuredLiveMarkdown(liveTail);
  let chunkCursor = 0;
  const liveTailRevealFrom = revealFrom !== null ? Math.max(0, revealFrom - prefix.length) : null;
  const chunkOccurrences = new Map<string, number>();

  return (
    <div className="assistant-markdown-flow">
      {prefixChunks.map((chunk) => {
        const chunkStart = prefix.indexOf(chunk, chunkCursor);
        chunkCursor = chunkStart >= 0 ? chunkStart + chunk.length : chunkCursor + chunk.length;
        const chunkHash = stableChunkHash(chunk);
        const chunkOccurrence = chunkOccurrences.get(chunkHash) || 0;
        chunkOccurrences.set(chunkHash, chunkOccurrence + 1);
        const chunkRevealFrom =
          revealFrom !== null && chunkStart >= 0 && revealFrom >= chunkStart && revealFrom < chunkStart + chunk.length
            ? revealFrom - chunkStart
            : null;
        return (
          <StableMarkdownMessage
            key={`${chunkHash}:${chunkOccurrence}`}
            text={chunk}
            revealFrom={chunkRevealFrom}
          />
        );
      })}
      {liveTail && renderLiveTailAsMarkdown ? (
        <div className="stream-live-text">
          <MarkdownMessage text={liveTail} revealFrom={liveTailRevealFrom} deferIncompleteTables />
        </div>
      ) : liveTail ? (
        <div className="markdown-body react-markdown stream-live-text">
          <StreamingPlainText text={liveTail} revealFrom={liveTailRevealFrom} />
        </div>
      ) : null}
    </div>
  );
}

export function StreamingAssistantMessage({
  message,
  settings,
  active,
  onVisibleTextChange,
}: {
  message: ChatMessage;
  settings: AppSettings;
  active: boolean;
  onVisibleTextChange?: () => void;
}) {
  const visuallyStreaming = active && !message.isComplete;
  const { visibleText, revealFrom, revealing } = useStreamingText(
    message.text,
    visuallyStreaming,
    settings.streamStartBufferMs,
    settings.streamRevealDurationMs,
  );
  const style = useMemo(() => ({
    "--stream-reveal-duration": `${Math.max(0, Math.min(2000, settings.streamRevealDurationMs))}ms`,
    "--stream-reveal-wipe": `${Math.max(100, Math.min(400, settings.streamRevealWipePercent))}%`,
  }) as CSSProperties, [settings.streamRevealDurationMs, settings.streamRevealWipePercent]);

  useEffect(() => {
    if (revealing && visibleText) {
      onVisibleTextChange?.();
    }
  }, [revealing, onVisibleTextChange, visibleText]);

  return (
    <div className={revealing ? "react-streaming-text streaming-text" : undefined} style={style}>
      <StreamingMarkdownMessage
        text={revealing ? visibleText : message.text}
        revealFrom={revealing ? revealFrom : null}
        complete={!revealing}
      />
    </div>
  );
}
