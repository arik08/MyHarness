import { type ReactNode, useState } from "react";
import { saveArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { UsageCostSummary } from "../types/backend";
import type { ChatMessage } from "../types/ui";
import { artifactName } from "../utils/artifacts";
import { chatShareUrl, shareBaseUrl } from "../utils/chatShare";
import { copyTextToClipboard } from "../utils/clipboard";

function answerFileName(title: string, text: string) {
  const source = title.trim() && title.trim() !== "MyHarness"
    ? title.trim()
    : String(text || "").split(/\r?\n/).find((line) => line.trim()) || "answer";
  const clean = source
    .replace(/[#*_`~[\](){}<>]/g, "")
    .replace(/[\\/:*?"|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `outputs/${clean || "answer"}.md`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatMessageTime(timestamp?: number) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  return "'" + [
    pad2(date.getFullYear() % 100),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join(".") + ` (${dayNames[date.getDay()]}) ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

const tokenFormatter = new Intl.NumberFormat("en-US");

function formatTokenCount(value?: number | null) {
  return tokenFormatter.format(Math.max(0, Number(value || 0)));
}

function formatUsageCost(usage?: UsageCostSummary | null) {
  if (!usage || usage.cost_supported !== true || usage.estimated_cost_usd === null || usage.estimated_cost_usd === undefined) {
    return "계산 불가";
  }
  const value = Number(usage.estimated_cost_usd);
  if (!Number.isFinite(value)) {
    return "계산 불가";
  }
  return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}

function usageHasData(usage?: UsageCostSummary | null) {
  return Boolean(usage && (usage.input_tokens || usage.output_tokens || usage.cached_input_tokens));
}

function UsageMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="assistant-usage-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageSection({ title, usage }: { title: string; usage?: UsageCostSummary | null }) {
  if (!usageHasData(usage)) {
    return (
      <section className="assistant-usage-section">
        <h4>{title}</h4>
        <p className="assistant-usage-empty">기록 없음</p>
      </section>
    );
  }
  return (
    <section className="assistant-usage-section">
      <h4>{title}</h4>
      <UsageMetricRow label="Input" value={formatTokenCount(usage?.input_tokens)} />
      <UsageMetricRow label="Cached" value={formatTokenCount(usage?.cached_input_tokens)} />
      <UsageMetricRow label="Output" value={formatTokenCount(usage?.output_tokens)} />
      <UsageMetricRow label="Total" value={formatTokenCount(usage?.total_tokens)} />
      <UsageMetricRow label="Cost" value={formatUsageCost(usage)} />
    </section>
  );
}

function UsageCostPopover({ answerUsage, sessionUsage }: { answerUsage?: UsageCostSummary; sessionUsage?: UsageCostSummary | null }) {
  const cacheHit = Boolean((answerUsage?.cached_input_tokens || 0) > 0 || (sessionUsage?.cached_input_tokens || 0) > 0);
  return (
    <span className="assistant-usage-control">
      <button
        className="assistant-action-button assistant-usage-button"
        type="button"
        aria-label="토큰/비용 보기"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <rect x="7" y="10" width="3" height="6" rx="1" />
          <rect x="12" y="7" width="3" height="9" rx="1" />
          <rect x="17" y="4" width="3" height="12" rx="1" />
        </svg>
      </button>
      <span className="assistant-usage-popover" role="tooltip">
        <span className={`assistant-usage-cache ${cacheHit ? "hit" : ""}`}>
          Cache hit {cacheHit ? "적용" : "없음"}
        </span>
        <UsageSection title="이 답변" usage={answerUsage} />
        <UsageSection title="세션 누적" usage={sessionUsage} />
      </span>
    </span>
  );
}

export function AssistantActions({ message, children }: { message: ChatMessage; children?: ReactNode }) {
  const { state, dispatch } = useAppState();
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const text = message.text.trim();
  const messageTime = formatMessageTime(message.createdAt);

  if (message.suppressActions || !message.isComplete || !text) {
    return null;
  }

  async function copyAnswer() {
    setCopying(true);
    try {
      await copyTextToClipboard(text);
      setStatus("복사했습니다.");
    } catch (error) {
      setStatus(`복사 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.setTimeout(() => {
        setCopying(false);
        setStatus("");
      }, 1400);
    }
  }

  async function saveAnswer() {
    if (!state.sessionId) {
      setStatus("저장할 세션이 없습니다.");
      return;
    }
    setSaving(true);
    setStatus("저장 중...");
    try {
      const payload = await saveArtifact(answerFileName(state.chatTitle, text), text, state.sessionId, state.clientId);
      dispatch({ type: "refresh_artifacts" });
      setStatus(payload.artifact?.path ? `${artifactName(payload.artifact.path)} 저장됨` : "저장했습니다.");
    } catch (error) {
      setStatus(`저장 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.setTimeout(() => {
        setSaving(false);
        setStatus((current) => current.includes("실패") ? current : "");
      }, 1800);
    }
  }

  async function shareAnswer() {
    const chatId = state.activeHistoryId || state.sessionId || "";
    if (!chatId) {
      setStatus("공유할 대화가 없습니다.");
      return;
    }
    setSharing(true);
    try {
      const baseUrl = await shareBaseUrl();
      await copyTextToClipboard(chatShareUrl({
        baseUrl,
        chatId,
        messageId: message.id,
        workspaceName: state.workspaceName,
        workspacePath: state.workspacePath,
      }));
      setStatus("공유 링크를 복사했습니다.");
    } catch (error) {
      setStatus(`공유 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.setTimeout(() => {
        setSharing(false);
        setStatus((current) => current.includes("실패") ? current : "");
      }, 1400);
    }
  }

  return (
    <div className="assistant-actions">
      <span className="assistant-done">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span>답변 완료</span>
      </span>
      <button
        className="assistant-action-button"
        type="button"
        data-tooltip="원문 복사"
        aria-label="원문 복사"
        disabled={copying}
        onClick={() => void copyAnswer()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="9" y="9" width="10" height="10" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button
        className="assistant-action-button"
        type="button"
        data-tooltip="본문 저장"
        aria-label="본문 저장"
        disabled={saving}
        onClick={() => void saveAnswer()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v5h8" />
        </svg>
      </button>
      <button
        className="assistant-action-button"
        type="button"
        data-tooltip="채팅 링크 공유"
        aria-label="채팅 링크 공유"
        disabled={sharing}
        onClick={() => void shareAnswer()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.6 10.6 6.8-4.2" />
          <path d="m8.6 13.4 6.8 4.2" />
        </svg>
      </button>
      <UsageCostPopover answerUsage={message.usage} sessionUsage={state.sessionUsage} />
      {messageTime ? <span className="assistant-action-time">{messageTime}</span> : null}
      <span className="assistant-action-status">{status}</span>
      {children}
    </div>
  );
}
