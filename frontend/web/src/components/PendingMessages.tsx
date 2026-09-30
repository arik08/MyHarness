import { useEffect, useRef, useState } from "react";
import { useAppState } from "../state/app-state";
import { sendBackendRequest } from "../api/messages";
import "./pending-messages.css";

export function PendingMessages() {
  const { state, dispatch } = useAppState();
  const [cancellingRequestIds, setCancellingRequestIds] = useState<Set<string>>(() => new Set());
  const currentView = useRef("");
  currentView.current = `${state.sessionId}:${state.conversationViewRevision}`;
  useEffect(() => {
    const pendingIds = new Set(state.messages.flatMap((message) => message.pendingRequestId ? [message.pendingRequestId] : []));
    setCancellingRequestIds((current) => {
      const next = new Set([...current].filter((id) => pendingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state.messages]);

  async function cancelPendingMessage(requestId: string) {
    if (!state.sessionId || cancellingRequestIds.has(requestId)) return;
    const sessionId = state.sessionId;
    const viewRevision = state.conversationViewRevision;
    setCancellingRequestIds((current) => new Set(current).add(requestId));
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "cancel_queued_line",
        request_id: requestId,
      });
    } catch (error) {
      if (currentView.current !== `${sessionId}:${viewRevision}`) return;
      setCancellingRequestIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const pending = state.messages.filter((message) => message.pendingRequestId);
  if (!pending.length) return null;
  return <div className="pending-messages" aria-label="전달 대기 중인 메시지" aria-live="polite">
    {pending.map((message) => <div className="pending-message" key={message.id}>
      <span className="pending-message-label">{message.kind === "queued" ? "다음 질문 대기" : "반영 대기"}</span>
      <span className="pending-message-text">{message.text}</span>
      <button type="button" className="pending-message-cancel"
        aria-label={`${message.kind === "queued" ? "대기열" : "스티어링"} 요청 취소`}
        data-tooltip="전달 전 요청 취소"
        disabled={cancellingRequestIds.has(message.pendingRequestId!)}
        onClick={() => void cancelPendingMessage(message.pendingRequestId!)}>
        <span aria-hidden="true">×</span>
      </button>
    </div>)}
  </div>;
}
