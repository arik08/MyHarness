import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./answer-copy-menu.css";

export function AnswerCopyMenu({ copying, onCopy }: {
  copying: boolean;
  onCopy: (scope: "answer" | "conversation") => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = panel.current?.getBoundingClientRect();
      if (!anchor || !popup) return;
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - popup.width - 8)),
        top: Math.max(8, Math.min(anchor.top - popup.height - 6 >= 8 ? anchor.top - popup.height - 6 : anchor.bottom + 6, window.innerHeight - popup.height - 8)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("button")?.focus();
    function outside(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function choose(scope: "answer" | "conversation") {
    setOpen(false);
    trigger.current?.focus();
    onCopy(scope);
  }

  return <>
    <button ref={trigger} className="assistant-action-button answer-copy-trigger" type="button"
      data-tooltip={open ? undefined : "원문 복사"} aria-label="원문 복사" aria-expanded={open}
      aria-controls={open ? panelId : undefined} aria-haspopup="dialog" aria-disabled={copying}
      onClick={() => { if (!copying) setOpen(!open); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="9" y="9" width="10" height="10" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
    {open && createPortal(<div ref={panel} id={panelId} role="dialog" aria-label="복사 범위 선택"
      className="answer-copy-popover" style={position} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setOpen(false);
      }}>
      <button type="button" onClick={() => choose("answer")}>이 답변만 복사</button>
      <button type="button" onClick={() => choose("conversation")}>이 답변까지 질의응답 복사</button>
    </div>, document.body)}
  </>;
}
