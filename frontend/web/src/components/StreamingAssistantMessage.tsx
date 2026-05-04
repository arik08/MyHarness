import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppSettings, ChatMessage } from "../types/ui";
import { MarkdownMessage } from "./MarkdownMessage";

function useStreamingText(
  targetText: string,
  visuallyStreaming: boolean,
) {
  const [visibleText, setVisibleText] = useState(targetText);
  const revealFromRef = useRef<number | null>(null);
  const visibleTextRef = useRef(visibleText);

  useEffect(() => {
    visibleTextRef.current = visibleText;
  }, [visibleText]);

  useEffect(() => {
    if (!visuallyStreaming) {
      revealFromRef.current = null;
      visibleTextRef.current = targetText;
      setVisibleText(targetText);
      return;
    }

    const current = visibleTextRef.current;
    revealFromRef.current = targetText.startsWith(current) ? Array.from(current).length : 0;
    visibleTextRef.current = targetText;
    setVisibleText(targetText);
  }, [targetText, visuallyStreaming]);

  return { visibleText, revealFrom: revealFromRef.current, visualComplete: visibleText === targetText };
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
  const { visibleText, revealFrom, visualComplete } = useStreamingText(
    message.text,
    visuallyStreaming,
  );
  const style = useMemo(() => ({
    "--stream-reveal-duration": `${Math.max(0, Math.min(2000, settings.streamRevealDurationMs))}ms`,
    "--stream-reveal-wipe": `${Math.max(100, Math.min(400, settings.streamRevealWipePercent))}%`,
  }) as CSSProperties, [settings.streamRevealDurationMs, settings.streamRevealWipePercent]);

  useEffect(() => {
    if (visuallyStreaming && visibleText) {
      onVisibleTextChange?.();
    }
  }, [visuallyStreaming, onVisibleTextChange, visibleText]);

  return (
    <div className={visuallyStreaming && !visualComplete ? "react-streaming-text streaming-text" : undefined} style={style}>
      <MarkdownMessage text={visuallyStreaming ? visibleText : message.text} revealFrom={visuallyStreaming ? revealFrom : null} />
    </div>
  );
}
