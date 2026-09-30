import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { postJson } from "../api/http";
import { useAppState } from "../state/app-state";
import type { ChatMessage } from "../types/ui";
import "./response-feedback.css";

export function ResponseFeedback({ message }: { message: ChatMessage }) {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [savedRating, setSavedRating] = useState<"up" | "down" | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [open, rating, status]);

  useEffect(() => {
    if (!open) return;
    if (rating) input.current?.focus();
    else panel.current?.querySelector<HTMLButtonElement>(".response-feedback-choice")?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node) && !pending.current) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, rating]);

  async function save() {
    if (!rating || pending.current) return;
    pending.current = true;
    setSaving(true);
    setStatus("");
    try {
      await postJson("/api/response-feedback", {
        sessionId: state.activeHistoryId || state.sessionId,
        clientId: state.clientId,
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        messageId: message.id,
        answerText: message.text,
        answerIndex: state.messages.filter((item) => item.role === "assistant" && item.responsePhase !== "commentary" && item.isComplete && !item.suppressActions && item.text.trim()).findIndex((item) => item.id === message.id),
        rating,
        comment,
      });
      setSavedRating(rating);
      setStatus("평가를 저장했습니다.");
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      setStatus(`저장 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <div className="response-feedback" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} className="assistant-action-button response-feedback-trigger" type="button"
      aria-label="응답 평가" data-tooltip="응답 평가" aria-expanded={open} aria-controls={panelId}
      aria-haspopup="dialog" data-rated={savedRating || undefined} onClick={() => setOpen(!open)}>
      {savedRating ? (savedRating === "up" ? <ThumbsUp /> : <ThumbsDown />) : <span className="response-feedback-icon" aria-hidden="true"><ThumbsUp /><ThumbsDown /></span>}
    </button>
    {open && createPortal(<div ref={panel} style={position} id={panelId} role="dialog" aria-label="응답 평가" className={`response-feedback-popover${rating ? " editing" : ""}`}>
      <div className="response-feedback-choices">
        <button type="button" className="response-feedback-choice" aria-pressed={rating === "up"} disabled={saving}
          onClick={() => { setRating("up"); setStatus(""); }}><ThumbsUp />좋아요</button>
        <button type="button" className="response-feedback-choice" aria-pressed={rating === "down"} disabled={saving}
          onClick={() => { setRating("down"); setStatus(""); }}><ThumbsDown />별로예요</button>
      </div>
      {rating && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <textarea ref={input} aria-label="평가 의견" placeholder="의견을 남겨 주세요 (선택 사항)" maxLength={4000}
          value={comment} disabled={saving} onChange={(event) => setComment(event.target.value)} rows={3} />
        <div className="response-feedback-footer">
          <button type="button" disabled={saving} onClick={() => { setOpen(false); trigger.current?.focus(); }}>닫기</button>
          <button type="submit" disabled={saving}>{saving ? "저장 중…" : "평가 저장"}</button>
        </div>
      </form>}
      {status && <p role="alert" className="response-feedback-error">{status}</p>}
    </div>, document.body)}
    <span className="response-feedback-status" role="status">{!open ? status : ""}</span>
  </div>;
}
