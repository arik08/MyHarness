import { type CSSProperties, type ReactNode, useCallback, useRef, useState } from "react";
import { saveArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { UsageCostSummary } from "../types/backend";
import type { ChatMessage } from "../types/ui";
import { artifactName } from "../utils/artifacts";
import { chatShareUrl, shareBaseUrl } from "../utils/chatShare";
import { copyTextToClipboard } from "../utils/clipboard";
import { getUsdKrwExchangeRate, type UsdKrwExchangeRate } from "../utils/exchangeRate";

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
const krwFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const tokenPricingUsdPerMillion: Record<string, { cachedInput: number; input: number; output: number }> = {
  "gpt-5.5": { cachedInput: 0.5, input: 5.0, output: 30.0 },
  "gpt-5.4": { cachedInput: 0.25, input: 2.5, output: 15.0 },
  "gpt-5.4-mini": { cachedInput: 0.075, input: 0.75, output: 4.5 },
};

const openAiPricingProviders = new Set([
  "codex",
  "openai",
  "openai-compatible",
  "openai-compat",
  "openai-codex",
  "pgpt",
]);

function formatTokenCount(value?: number | null) {
  return tokenFormatter.format(Math.max(0, Number(value || 0)));
}

function usageHasSupportedCost(usage?: UsageCostSummary | null) {
  if (!usage || usage.cost_supported !== true || usage.estimated_cost_usd === null || usage.estimated_cost_usd === undefined) {
    return false;
  }
  const value = Number(usage.estimated_cost_usd);
  return Number.isFinite(value);
}

function usageHasSupportedSavings(usage?: UsageCostSummary | null) {
  if (!usage || usage.cost_supported !== true || usage.estimated_cache_savings_usd === null || usage.estimated_cache_savings_usd === undefined) {
    return false;
  }
  const value = Number(usage.estimated_cache_savings_usd);
  return Number.isFinite(value);
}

function formatKrwFromUsd(value: number, exchangeRate: ExchangeRateState) {
  if (!Number.isFinite(value)) {
    return "계산 불가";
  }
  if (exchangeRate.status === "ready") {
    const krw = value * exchangeRate.rate.rate;
    if (krw > 0 && krw < 1) {
      return "1원 미만";
    }
    return `${krwFormatter.format(krw)}원`;
  }
  return exchangeRate.status === "error" ? "환율 불가" : "환율 확인 중";
}

function formatUsageCost(usage: UsageCostSummary | null | undefined, exchangeRate: ExchangeRateState) {
  if (!usageHasSupportedCost(usage)) {
    return "계산 불가";
  }
  return formatKrwFromUsd(Number(usage?.estimated_cost_usd), exchangeRate);
}

function finiteOptionalNumber(value?: number | null) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function sumOptionalNumbers(...values: Array<number | null | undefined>) {
  const finiteValues = values
    .map((value) => finiteOptionalNumber(value))
    .filter((value): value is number => value !== null);
  return finiteValues.length === values.length
    ? finiteValues.reduce((total, value) => total + value, 0)
    : null;
}

function formatOptionalUsageCost(value: number | null | undefined, exchangeRate: ExchangeRateState) {
  const finiteValue = finiteOptionalNumber(value);
  return finiteValue === null ? "" : formatKrwFromUsd(finiteValue, exchangeRate);
}

function normalizedPricingModel(model?: string) {
  const normalized = String(model || "").trim().toLowerCase().replace(/_/g, "-");
  return normalized === "gpt-5.4 mini" || normalized === "gpt-5.4mini" ? "gpt-5.4-mini" : normalized;
}

function normalizedPricingProvider(provider?: string) {
  return String(provider || "").trim().toLowerCase().replace(/_/g, "-");
}

function estimateUsageCostParts(usage?: UsageCostSummary | null) {
  if (!usage || !openAiPricingProviders.has(normalizedPricingProvider(usage.provider))) {
    return null;
  }
  const pricing = tokenPricingUsdPerMillion[normalizedPricingModel(usage.model)];
  if (!pricing) {
    return null;
  }
  return {
    cachedInput: usage.cached_input_tokens * pricing.cachedInput / 1_000_000,
    output: usage.output_tokens * pricing.output / 1_000_000,
    uncachedInput: usage.uncached_input_tokens * pricing.input / 1_000_000,
  };
}

function usageCostParts(usage?: UsageCostSummary | null) {
  const direct = {
    cachedInput: finiteOptionalNumber(usage?.estimated_cached_input_cost_usd),
    output: finiteOptionalNumber(usage?.estimated_output_cost_usd),
    uncachedInput: finiteOptionalNumber(usage?.estimated_uncached_input_cost_usd),
  };
  const directTotal = sumOptionalNumbers(direct.cachedInput, direct.output, direct.uncachedInput);
  const estimatedTotal = finiteOptionalNumber(usage?.estimated_cost_usd);
  if (directTotal !== null && directTotal > 0) {
    return direct;
  }
  if (!estimatedTotal || estimatedTotal <= 0) {
    return direct;
  }
  return estimateUsageCostParts(usage) || { cachedInput: null, output: null, uncachedInput: null };
}

function formatCacheHitRatio(usage?: UsageCostSummary | null) {
  const explicit = Number(usage?.cache_hit_ratio);
  const ratio = Number.isFinite(explicit) && explicit >= 0
    ? explicit
    : (usage?.input_tokens ? (usage.cached_input_tokens || 0) / usage.input_tokens : 0);
  return `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
}

function usageModelLabel(usage?: UsageCostSummary | null) {
  const model = String(usage?.model || usage?.model_breakdown?.[0]?.model || "").trim();
  const provider = String(usage?.provider || usage?.model_breakdown?.[0]?.provider || "").trim();
  return (model || provider || "-").toUpperCase();
}

function usageHasData(usage?: UsageCostSummary | null) {
  return Boolean(usage && (usage.input_tokens || usage.output_tokens || usage.cached_input_tokens));
}

const usageDuplicateKeys = [
  "input_tokens",
  "cached_input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "total_tokens",
  "estimated_cost_usd",
  "estimated_cache_savings_usd",
  "estimated_uncached_input_cost_usd",
  "estimated_cached_input_cost_usd",
  "estimated_output_cost_usd",
  "cache_hit_ratio",
] as const;

function usageNumberForDuplicateCheck(usage: UsageCostSummary | null | undefined, key: typeof usageDuplicateKeys[number]) {
  const raw = usage?.[key];
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function usageSummariesAreDuplicate(answerUsage?: UsageCostSummary | null, sessionUsage?: UsageCostSummary | null) {
  if (!usageHasData(answerUsage) || !usageHasData(sessionUsage)) {
    return false;
  }
  if (answerUsage?.cost_supported !== sessionUsage?.cost_supported) {
    return false;
  }
  return usageDuplicateKeys.every((key) =>
    usageNumberForDuplicateCheck(answerUsage, key) === usageNumberForDuplicateCheck(sessionUsage, key),
  );
}

type UsageMetricLevel = "parent" | "child";

type UsageMetric = {
  cost?: string;
  id: string;
  label: string;
  level: UsageMetricLevel;
  note?: string;
  value: string;
};

function usageMetrics(usage: UsageCostSummary | null | undefined, exchangeRate: ExchangeRateState): UsageMetric[] {
  const costParts = usageCostParts(usage);
  const inputCostUsd = sumOptionalNumbers(costParts.uncachedInput, costParts.cachedInput);
  return [
    { cost: formatOptionalUsageCost(inputCostUsd, exchangeRate), id: "input", label: "Input", level: "parent", value: formatTokenCount(usage?.input_tokens) },
    {
      cost: formatOptionalUsageCost(costParts.cachedInput, exchangeRate),
      id: "cached",
      label: "Cached",
      level: "child",
      value: formatTokenCount(usage?.cached_input_tokens),
    },
    { cost: formatOptionalUsageCost(costParts.uncachedInput, exchangeRate), id: "uncached", label: "Uncached", level: "child", value: formatTokenCount(usage?.uncached_input_tokens) },
    { cost: "-", id: "cache-rate", label: "Cache rate", level: "child", value: formatCacheHitRatio(usage) },
    { cost: formatOptionalUsageCost(costParts.output, exchangeRate), id: "output", label: "Output", level: "parent", value: formatTokenCount(usage?.output_tokens) },
    { cost: usageHasSupportedCost(usage) ? formatUsageCost(usage, exchangeRate) : "", id: "total", label: "Total", level: "parent", value: formatTokenCount(usage?.total_tokens) },
  ];
}

function UsageMetricValue({ metric }: { metric: UsageMetric }) {
  return (
    <strong className="assistant-usage-metric-value">
      <span>{metric.value}</span>
      {metric.cost ? <span className="assistant-usage-metric-cost">{metric.cost}</span> : null}
      {metric.note ? <span className="assistant-usage-metric-note">{metric.note}</span> : null}
    </strong>
  );
}

function UsageMetricRow({ metric }: { metric: UsageMetric }) {
  return (
    <div className={`assistant-usage-row assistant-usage-row-${metric.level}`} data-metric={metric.id}>
      <span>{metric.label}</span>
      <UsageMetricValue metric={metric} />
    </div>
  );
}

type ExchangeRateState =
  | { status: "idle" | "loading" | "error"; rate?: undefined }
  | { status: "ready"; rate: UsdKrwExchangeRate };

function UsageSection({ title, usage, exchangeRate }: { title: string; usage?: UsageCostSummary | null; exchangeRate: ExchangeRateState }) {
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
      {usageMetrics(usage, exchangeRate).map((metric) => (
        <UsageMetricRow key={metric.label} metric={metric} />
      ))}
    </section>
  );
}

function UsageComparisonTable({ answerUsage, sessionUsage, exchangeRate }: { answerUsage?: UsageCostSummary | null; sessionUsage?: UsageCostSummary | null; exchangeRate: ExchangeRateState }) {
  const answerRows = usageMetrics(answerUsage, exchangeRate);
  const sessionRows = usageMetrics(sessionUsage, exchangeRate);
  const fallbackMetric = (metric: UsageMetric): UsageMetric => ({ ...metric, value: "0" });
  return (
    <table className="assistant-usage-table" aria-label="사용량 비교">
      <colgroup>
        <col className="assistant-usage-table-label-col" />
        <col className="assistant-usage-table-token-col" />
        <col className="assistant-usage-table-cost-col" />
        <col className="assistant-usage-table-token-col" />
        <col className="assistant-usage-table-cost-col" />
      </colgroup>
      <thead>
        <tr>
          <th className="assistant-usage-table-model-head" scope="col">{usageModelLabel(answerUsage)}</th>
          <th className="assistant-usage-table-group-head" scope="colgroup" colSpan={2}>이번 답변</th>
          <th className="assistant-usage-table-group-head" scope="colgroup" colSpan={2}>세션 누적</th>
        </tr>
        <tr>
          <th scope="col" />
          <th scope="col">토큰량</th>
          <th scope="col">비용</th>
          <th scope="col">토큰량</th>
          <th scope="col">비용</th>
        </tr>
      </thead>
      <tbody>
        {answerRows.map((metric, index) => {
          const sessionMetric = sessionRows[index] || fallbackMetric(metric);
          return (
            <tr key={metric.label} className={`assistant-usage-table-row assistant-usage-table-row-${metric.level}`} data-metric={metric.id}>
              <th scope="row">{metric.label}</th>
              <td className="assistant-usage-table-count">{metric.value}</td>
              <td className="assistant-usage-table-cost">{metric.cost || ""}</td>
              <td className="assistant-usage-table-count">{sessionMetric.value}</td>
              <td className="assistant-usage-table-cost">{sessionMetric.cost || ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UsageAnswerTable({ answerUsage, exchangeRate }: { answerUsage?: UsageCostSummary | null; exchangeRate: ExchangeRateState }) {
  const answerRows = usageMetrics(answerUsage, exchangeRate);
  return (
    <table className="assistant-usage-table" aria-label="이번 답변 사용량">
      <colgroup>
        <col className="assistant-usage-table-label-col" />
        <col className="assistant-usage-table-token-col" />
        <col className="assistant-usage-table-cost-col" />
      </colgroup>
      <thead>
        <tr>
          <th className="assistant-usage-table-model-head" scope="col">{usageModelLabel(answerUsage)}</th>
          <th className="assistant-usage-table-group-head" scope="colgroup" colSpan={2}>이번 답변</th>
        </tr>
        <tr>
          <th scope="col" />
          <th scope="col">토큰량</th>
          <th scope="col">비용</th>
        </tr>
      </thead>
      <tbody>
        {answerRows.map((metric) => (
          <tr key={metric.label} className={`assistant-usage-table-row assistant-usage-table-row-${metric.level}`} data-metric={metric.id}>
            <th scope="row">{metric.label}</th>
            <td className="assistant-usage-table-count">{metric.value}</td>
            <td className="assistant-usage-table-cost">{metric.cost || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageCostPopover({ answerUsage, sessionUsage }: { answerUsage?: UsageCostSummary; sessionUsage?: UsageCostSummary | null }) {
  const controlRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const [placement, setPlacement] = useState<"above" | "below">("above");
  const [horizontalPlacement, setHorizontalPlacement] = useState<"left" | "right">("right");
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const [exchangeRate, setExchangeRate] = useState<ExchangeRateState>({ status: "idle" });
  const hasSupportedCost = usageHasSupportedCost(answerUsage)
    || usageHasSupportedCost(sessionUsage)
    || usageHasSupportedSavings(answerUsage)
    || usageHasSupportedSavings(sessionUsage);
  const hasAnswerUsage = usageHasData(answerUsage);
  const hasSessionUsage = usageHasData(sessionUsage);
  const showSessionUsage = hasSessionUsage && !usageSummariesAreDuplicate(answerUsage, sessionUsage);
  const sectionCount = (hasAnswerUsage ? 1 : 0) + (showSessionUsage ? 1 : 0) || 1;
  const updatePlacement = useCallback(() => {
    const control = controlRef.current;
    const popover = popoverRef.current;
    if (!control || !popover) return;
    const controlRect = control.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const popoverHeight = popoverRect.height || popover.offsetHeight || 220;
    const desiredPopoverWidth = sectionCount > 1 ? 500 : 310;
    const measuredPopoverWidth = popoverRect.width || popover.offsetWidth || 0;
    const popoverWidth = Math.max(measuredPopoverWidth, desiredPopoverWidth);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || popoverWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || popoverHeight;
    const constrainedWidth = Math.min(popoverWidth, Math.max(240, viewportWidth - 32));
    const placeBelow = controlRect.top - popoverHeight - 8 < 12;
    const controlCenter = controlRect.left + controlRect.width / 2;
    const preferredLeft = controlCenter - constrainedWidth / 2;
    const nextLeft = Math.max(12, Math.min(preferredLeft, viewportWidth - constrainedWidth - 12));
    const preferredTop = placeBelow ? controlRect.bottom + 8 : controlRect.top - popoverHeight - 8;
    const nextTop = Math.max(12, Math.min(preferredTop, viewportHeight - popoverHeight - 12));
    setPlacement(placeBelow ? "below" : "above");
    setHorizontalPlacement(nextLeft < preferredLeft ? "left" : "right");
    setPopoverStyle({ left: nextLeft, top: nextTop, width: constrainedWidth });
  }, [sectionCount]);
  const loadExchangeRate = useCallback(() => {
    if (!hasSupportedCost || exchangeRate.status === "loading" || exchangeRate.status === "ready") {
      return;
    }
    setExchangeRate({ status: "loading" });
    void getUsdKrwExchangeRate()
      .then((rate) => setExchangeRate({ status: "ready", rate }))
      .catch(() => setExchangeRate({ status: "error" }));
  }, [exchangeRate.status, hasSupportedCost]);
  const handlePopoverOpen = useCallback(() => {
    updatePlacement();
    loadExchangeRate();
  }, [loadExchangeRate, updatePlacement]);

  return (
    <span
      ref={controlRef}
      className="assistant-usage-control"
      onFocusCapture={handlePopoverOpen}
      onMouseEnter={handlePopoverOpen}
    >
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
      <span
        ref={popoverRef}
        className="assistant-usage-popover"
        data-align={horizontalPlacement}
        data-placement={placement}
        role="tooltip"
        style={popoverStyle}
        data-columns={sectionCount > 1 ? "2" : "1"}
      >
        {hasAnswerUsage ? (
          showSessionUsage ? (
            <UsageComparisonTable answerUsage={answerUsage} sessionUsage={sessionUsage} exchangeRate={exchangeRate} />
          ) : (
            <UsageAnswerTable answerUsage={answerUsage} exchangeRate={exchangeRate} />
          )
        ) : (
          <span className="assistant-usage-sections" data-count={sectionCount}>
            {!showSessionUsage ? (
              <UsageSection title="이번 답변" usage={answerUsage} exchangeRate={exchangeRate} />
            ) : null}
            {showSessionUsage ? (
              <UsageSection title="세션 누적" usage={sessionUsage} exchangeRate={exchangeRate} />
            ) : null}
          </span>
        )}
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
      <UsageCostPopover answerUsage={message.usage} sessionUsage={message.sessionUsage} />
      {messageTime ? <span className="assistant-action-time">{messageTime}</span> : null}
      <span className="assistant-action-status">{status}</span>
      {children}
    </div>
  );
}
