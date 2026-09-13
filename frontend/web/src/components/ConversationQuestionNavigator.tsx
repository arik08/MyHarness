import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { ChatMessage } from "../types/ui";
import { showTooltipNowEvent } from "./TooltipLayer";
import "./conversation-question-navigator.css";

// Ported from Lumina's ConversationQuestionNavigator, using MyHarness message IDs.
export function questionNavigatorPreview(text: string, limit = 180) {
  const preview = text
    .replace(/```[\s\S]*?```/g, " 코드 ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " 이미지 ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*`~>|]/g, "")
    .replace(/\s+/g, " ").trim();
  return preview.length <= limit ? preview : `${preview.slice(0, limit).trimEnd()}…`;
}

export function ConversationQuestionNavigator({ messages, scrollContainerRef, onNavigateStart }: {
  messages: ChatMessage[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  onNavigateStart: () => void;
}) {
  const items = useMemo(() => {
    const questions: { id: string; question: string; answer: string }[] = [];
    let current: (typeof questions)[number] | undefined;
    for (const message of messages) {
      if (message.role === "user") {
        const question = questionNavigatorPreview(message.text, 96);
        current = question ? { id: message.id, question, answer: "" } : undefined;
        if (current) questions.push(current);
      } else if (message.role === "assistant" && current && !current.answer) {
        current.answer = questionNavigatorPreview(message.text, 140);
      }
    }
    return questions;
  }, [messages]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const frame = useRef<number | null>(null);
  const itemKey = items.map((item) => item.id).join("|");
  function cancelAnimation() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }
  useEffect(() => {
    setActiveIndex(null);
    cancelAnimation();
  }, [itemKey]);
  useEffect(() => {
    const container = scrollContainerRef.current;
    const events = ["wheel", "pointerdown", "touchstart"] as const;
    events.forEach((name) => container?.addEventListener(name, cancelAnimation, { passive: true }));
    return () => {
      cancelAnimation();
      events.forEach((name) => container?.removeEventListener(name, cancelAnimation));
    };
  }, [scrollContainerRef, itemKey]);

  function navigate(id: string) {
    const container = scrollContainerRef.current;
    const target = container && [...container.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === id);
    if (!container || !target) return;
    onNavigateStart();
    cancelAnimation();
    const start = container.scrollTop;
    const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
      start + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24));
    const distance = top - start;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || Math.abs(distance) < 2) {
      container.scrollTop = top;
      return;
    }
    const duration = Math.min(340, Math.max(190, 190 + Math.abs(distance) / 7));
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - ((-2 * progress + 2) ** 3) / 2;
      container.scrollTop = start + distance * eased;
      frame.current = progress < 1 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  }

  if (!items.length) return null;
  return (
    <nav className="question-navigator" aria-label={`사용자 질문 ${items.length}개 바로가기`}
      onMouseLeave={() => setActiveIndex(null)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setActiveIndex(null); }}
      onKeyDown={(event) => { if (event.key === "Escape") setActiveIndex(null); }}>
      <div className="question-navigator-track" style={{ "--question-count": items.length } as CSSProperties}>
        {items.map((item, index) => {
          const distance = activeIndex === null ? Infinity : Math.abs(activeIndex - index);
          const scale = [1, 0.76, 0.56, 0.4][distance] ?? 0.28;
          return <button key={item.id} type="button" className="question-navigator-marker"
            aria-label={`질문 ${index + 1}로 이동: ${item.question}`}
            data-tooltip={item.question} data-tooltip-description={item.answer || "아직 답변이 없습니다."}
            data-tooltip-placement="right" data-tooltip-immediate="true"
            style={{ "--question-marker-scale": scale, "--question-marker-opacity": distance === 0 ? 1 : distance <= 3 ? 0.4 : 0.18 } as CSSProperties}
            onMouseEnter={(event) => {
              setActiveIndex(index);
              window.dispatchEvent(new CustomEvent(showTooltipNowEvent, { detail: { target: event.currentTarget } }));
            }}
            onFocus={() => setActiveIndex(index)} onClick={() => navigate(item.id)} />;
        })}
      </div>
    </nav>
  );
}
