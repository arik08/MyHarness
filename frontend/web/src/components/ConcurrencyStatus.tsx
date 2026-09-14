import { useCallback, useEffect, useId, useState } from "react";
import { readServerMetrics, type ServerMetrics } from "../api/serverMetrics";
import { ServerMetricsPanel, percentLabel } from "./ServerMetricsPanel";
import {
  concurrencySettingsChangedEvent,
  readConcurrencyStatus,
  type ConcurrencyStatus as ConcurrencyStatusValue,
} from "../api/settings";
import { useAppState } from "../state/app-state";

const refreshIntervalMs = 5_000;

type StatusItem = {
  key: "sessions" | "capacity" | "responses" | "browser";
  label: string;
  current: number | null;
  maximum: number | null;
};

function SessionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="3" y="4" width="11" height="9" rx="1.5" />
      <path d="M6 16h9a2 2 0 0 0 2-2V8" />
    </svg>
  );
}

function ResponsesIcon() {
  return (
    <svg aria-hidden="true" data-icon="responses" viewBox="0 0 20 20">
      <path d="M4.5 4.5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-4.5 3v-3a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" />
      <path d="M6.5 9h.01M10 9h.01M13.5 9h.01" />
    </svg>
  );
}

function CapacityIcon() {
  return (
    <svg aria-hidden="true" data-icon="capacity" viewBox="0 0 20 20">
      <path d="M3 15a7 7 0 0 1 14 0" />
      <path d="M5.1 10.1l1.2 1.2M10 8v1.7M14.9 10.1l-1.2 1.2" />
      <path d="m10 15 3.5-4.5" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 7h15" />
      <path d="M5 5.3h.01M7.2 5.3h.01" />
      <path d="m11.5 9.5.65 1.85L14 12l-1.85.65-.65 1.85-.65-1.85L9 12l1.85-.65.65-1.85Z" />
    </svg>
  );
}

function StatusIcon({ item }: { item: StatusItem["key"] }) {
  if (item === "sessions" || item === "capacity") return <SessionsIcon />;
  if (item === "responses") return <ResponsesIcon />;
  return <BrowserIcon />;
}

function displayedRatio(current: number | null, maximum: number | null) {
  return `${current ?? "–"} / ${maximum ?? "–"}`;
}

function displayedStatus(item: StatusItem) {
  return item.key !== "browser" ? `${item.current ?? "–"}개` : displayedRatio(item.current, item.maximum);
}

export function ConcurrencyStatus() {
  const { state } = useAppState();
  const [status, setStatus] = useState<ConcurrencyStatusValue | null>(null);
  const tooltipId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [metricsError, setMetricsError] = useState("");
  const closeDetails = useCallback(() => setDetailsOpen(false), []);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const next = await readConcurrencyStatus(state.clientId);
        if (active) setStatus(next);
      } catch {
        // Keep the last known values during a transient refresh failure.
      }
    }

    void refresh();
    const interval = window.setInterval(refresh, refreshIntervalMs);
    window.addEventListener(concurrencySettingsChangedEvent, refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener(concurrencySettingsChangedEvent, refresh);
    };
  }, [state.clientId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await readServerMetrics(detailsOpen);
        if (active) { setMetrics(next); setMetricsError(""); }
      } catch {
        if (active) setMetricsError("서버 지표를 갱신하지 못했습니다. 서버 연결 및 재시작 여부를 확인하세요.");
      } finally {
        if (active) timer = setTimeout(refresh, refreshIntervalMs);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [detailsOpen]);

  const items: StatusItem[] = [
    {
      key: "sessions",
      label: "연결된 화면",
      current: status?.connectedScreens ?? null,
      maximum: null,
    },
    {
      key: "capacity",
      label: "열린 작업 세션",
      current: status?.activeSessions ?? null,
      maximum: null,
    },
    {
      key: "responses",
      label: "동시에 AI 응답을 생성하는 세션",
      current: status?.busySessions ?? null,
      maximum: null,
    },
    {
      key: "browser",
      label: "같은 브라우저의 동시 AI 응답",
      current: status?.busySessionsForClient ?? null,
      maximum: status?.maxBusySessionsPerClient ?? null,
    },
  ];
  const statusLabel = items
    .map((item) => `${item.label} ${displayedStatus(item)}`)
    .concat(`대기열 세션 ${status?.queuedSessions ?? 0}, 응답 ${status?.queuedResponses ?? 0}`)
    .join(", ");
  const usersLabel = `사용자 수 ${status?.activeUsers ?? "–"}명`;
  const queuedSessions = status?.queuedSessions ?? 0;
  const queuedResponses = status?.queuedResponses ?? 0;
  const resources = metricsError ? null : metrics?.resources;
  const memoryUsage = resources ? 100 * (1 - resources.availableMemoryBytes / resources.totalMemoryBytes) : null;

  return (
    <span className="concurrency-status" data-details-open={detailsOpen}>
      <button
        className="header-icon-button concurrency-status-button"
        type="button"
        aria-describedby={tooltipId}
        aria-label={`동시 사용 현황: ${usersLabel}, ${statusLabel}`}
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(true)}
      >
        <CapacityIcon />
      </button>
      <span className="concurrency-status-tooltip" id={tooltipId} role="tooltip">
        <strong>동시 사용 현황</strong>
        <span className="concurrency-status-row"><CapacityIcon /><span>서버 CPU</span><span className="concurrency-status-value">{metricsError ? "확인 불가" : percentLabel(metrics?.resources?.cpuPercent)}</span></span>
        <span className="concurrency-status-row"><SessionsIcon /><span>서버 메모리</span><span className="concurrency-status-value concurrency-memory-value">{resources ? `${((resources.totalMemoryBytes - resources.availableMemoryBytes) / 1024 ** 3).toFixed(1)} / ${(resources.totalMemoryBytes / 1024 ** 3).toFixed(1)} GB · ${percentLabel(memoryUsage)}` : "확인 불가"}</span></span>
        <span className="concurrency-status-row" data-status="users">
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <circle cx="7" cy="6" r="2.5" />
            <path d="M2.5 16v-2a4.5 4.5 0 0 1 9 0v2M13 3.5a2.5 2.5 0 0 1 0 5M14 11a3.5 3.5 0 0 1 3.5 3.5V16" />
          </svg>
          <span>사용자 수</span>
          <span className="concurrency-status-value">{status?.activeUsers ?? "–"}명</span>
        </span>
        {items.map((item) => (
          <span className="concurrency-status-row" data-status={item.key} key={item.key}>
            <StatusIcon item={item.key} />
            <span>{item.label}</span>
            <span className="concurrency-status-value">{displayedStatus(item)}</span>
          </span>
        ))}
        {(
          <span className="concurrency-status-row" data-status="queue">
            <CapacityIcon />
            <span>대기열</span>
            <span className="concurrency-status-value">세션 {queuedSessions} · 응답 {queuedResponses}</span>
          </span>
        )}
        <span className="concurrency-status-hint">CPU {status?.maxCpuPercent ?? "–"}% · 메모리 {status?.maxMemoryPercent ?? "–"}% 이상 시 대기</span>
      </span>
      {detailsOpen && <ServerMetricsPanel metrics={metrics} error={metricsError} onClose={closeDetails} />}
    </span>
  );
}
