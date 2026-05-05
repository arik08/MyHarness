import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { sendBackendRequest } from "../api/messages";
import { useAppState } from "../state/app-state";
import type { SwarmTeammateSnapshot } from "../types/backend";

type SwarmStatus = "running" | "idle" | "completed" | "failed" | "killed";

function normalizedStatus(value: unknown): SwarmStatus {
  const status = String(value || "").trim().toLowerCase();
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  if (status === "running" || status === "idle" || status === "completed" || status === "failed" || status === "killed") {
    return status;
  }
  return "idle";
}

function statusLabel(status: SwarmStatus) {
  if (status === "running") return "진행 중";
  if (status === "idle") return "대기";
  if (status === "completed") return "완료";
  if (status === "failed") return "오류";
  return "중단됨";
}

function statusClass(status: SwarmStatus) {
  return status === "failed" || status === "killed" ? "warning" : status;
}

function taskIdFor(teammate: SwarmTeammateSnapshot) {
  return String(teammate.taskId || teammate.task_id || teammate.id || teammate.agent_id || "").trim();
}

function labelFor(teammate: SwarmTeammateSnapshot) {
  return String(teammate.role || teammate.name || teammate.id || "작업자").trim();
}

function taskFor(teammate: SwarmTeammateSnapshot) {
  return String(teammate.task || "맡은 작업을 정리하는 중입니다.").trim();
}

function outputFor(teammate: SwarmTeammateSnapshot) {
  return String(teammate.lastOutput || teammate.last_output || "").trim();
}

function startedAtFor(teammate: SwarmTeammateSnapshot) {
  const value = teammate.startedAt ?? teammate.started_at;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatElapsed(startedAt: number | null, now: number) {
  if (!startedAt) return "";
  const elapsed = Math.max(1, Math.floor((now - startedAt) / 1000));
  if (elapsed < 60) return `${elapsed}초`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function popupStyle(anchor: HTMLButtonElement | null): CSSProperties {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) {
    return {};
  }
  const width = Math.min(360, Math.max(300, window.innerWidth - 16));
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  const bottomSpace = window.innerHeight - rect.bottom;
  const top = bottomSpace >= 320 ? rect.bottom + 8 : Math.max(8, rect.top - 328);
  return { left, top, width };
}

export function SwarmButton() {
  const { state, dispatch } = useAppState();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const [now, setNow] = useState(() => Date.now());
  const teammates = state.swarmTeammates;
  const activeCount = teammates.filter((item) => normalizedStatus(item.status) === "running").length;
  const warningCount = teammates.filter((item) => ["failed", "killed"].includes(normalizedStatus(item.status))).length;
  const completedCount = teammates.filter((item) => normalizedStatus(item.status) === "completed").length;
  const buttonClassName = [
    "swarm-command",
    teammates.length ? "active" : "",
    activeCount ? "running" : "",
    warningCount ? "warning" : "",
  ].filter(Boolean).join(" ");

  const summary = useMemo(() => ({
    running: activeCount,
    completed: completedCount,
    warning: warningCount,
  }), [activeCount, completedCount, warningCount]);

  useLayoutEffect(() => {
    if (!state.swarmPopupOpen) return;
    const update = () => setStyle(popupStyle(buttonRef.current));
    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [state.swarmPopupOpen, teammates.length]);

  useEffect(() => {
    if (!state.swarmPopupOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (popupRef.current?.contains(target) || buttonRef.current?.contains(target))) {
        return;
      }
      dispatch({ type: "set_swarm_popup_open", value: false });
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dispatch({ type: "set_swarm_popup_open", value: false });
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dispatch, state.swarmPopupOpen]);

  useEffect(() => {
    if (!state.swarmPopupOpen || !activeCount) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeCount, state.swarmPopupOpen]);

  async function requestTaskOutput(teammate: SwarmTeammateSnapshot) {
    if (!state.sessionId) return;
    const taskId = taskIdFor(teammate);
    if (!taskId) return;
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "task_output",
        task_id: taskId,
        max_bytes: 12000,
      });
    } catch (error) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  async function stopTask(teammate: SwarmTeammateSnapshot) {
    if (!state.sessionId) return;
    const taskId = taskIdFor(teammate);
    if (!taskId) return;
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "task_stop",
        task_id: taskId,
      });
    } catch (error) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  const popup = state.swarmPopupOpen ? (
    <div
      ref={popupRef}
      className="swarm-popup-layer"
      role="dialog"
      aria-label="AI 팀"
      style={style}
    >
      <div className="swarm-popup-header">
        <div>
          <strong>AI 팀</strong>
          <small>사무 작업 진행 현황</small>
        </div>
        <div className="swarm-popup-counts" aria-label="작업자 상태 요약">
          <span>{summary.running} 진행</span>
          <span>{summary.completed} 완료</span>
          <span className={summary.warning ? "warning" : ""}>{summary.warning} 오류</span>
        </div>
      </div>

      {teammates.length ? (
        <div className="swarm-agent-list">
          {teammates.map((teammate) => {
            const taskId = taskIdFor(teammate);
            const status = normalizedStatus(teammate.status);
            const elapsed = formatElapsed(startedAtFor(teammate), now);
            const output = outputFor(teammate);
            return (
              <article className={`swarm-agent-card ${statusClass(status)}`} key={teammate.id || taskId || labelFor(teammate)}>
                <div className="swarm-agent-main">
                  <div>
                    <strong>{labelFor(teammate)}</strong>
                    <span className={`swarm-status-pill ${statusClass(status)}`}>{statusLabel(status)}</span>
                  </div>
                  {elapsed ? <small>{elapsed}</small> : null}
                </div>
                <p>{taskFor(teammate)}</p>
                {output ? <code>{output}</code> : null}
                {taskId ? (
                  <div className="swarm-agent-actions">
                    <button type="button" aria-label={`${taskId} 결과 보기`} onClick={() => void requestTaskOutput(teammate)}>
                      결과 보기
                    </button>
                    {status === "running" || status === "idle" ? (
                      <button type="button" aria-label={`${taskId} 중단`} onClick={() => void stopTask(teammate)}>
                        중단
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="swarm-empty">아직 진행 중인 팀 작업이 없습니다.</p>
      )}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        className={buttonClassName}
        type="button"
        aria-label="AI 팀 열기"
        aria-expanded={state.swarmPopupOpen ? "true" : "false"}
        data-tooltip="AI 팀"
        onClick={() => dispatch({ type: "set_swarm_popup_open", value: !state.swarmPopupOpen })}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M16 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M4.5 20v-2.2A4.8 4.8 0 0 1 9.3 13h5.4a4.8 4.8 0 0 1 4.8 4.8V20" />
        </svg>
        {teammates.length ? <span className="swarm-command-badge">{teammates.length}</span> : null}
      </button>
      {popup ? createPortal(popup, document.body) : null}
    </>
  );
}
