import { useEffect, useId, useState } from "react";
import {
  concurrencySettingsChangedEvent,
  readConcurrencyStatus,
  type ConcurrencyStatus as ConcurrencyStatusValue,
} from "../api/settings";
import { useAppState } from "../state/app-state";

const refreshIntervalMs = 5_000;

type StatusItem = {
  key: "sessions" | "responses" | "browser";
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
  if (item === "sessions") return <SessionsIcon />;
  if (item === "responses") return <ResponsesIcon />;
  return <BrowserIcon />;
}

function displayedRatio(current: number | null, maximum: number | null) {
  return `${current ?? "–"} / ${maximum ?? "–"}`;
}

export function ConcurrencyStatus() {
  const { state } = useAppState();
  const [status, setStatus] = useState<ConcurrencyStatusValue | null>(null);
  const tooltipId = useId();

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

  const items: StatusItem[] = [
    {
      key: "sessions",
      label: "열린 작업 세션",
      current: status?.activeSessions ?? null,
      maximum: status?.maxActiveSessions ?? null,
    },
    {
      key: "responses",
      label: "동시에 AI 응답을 생성하는 세션",
      current: status?.busySessions ?? null,
      maximum: status?.maxBusySessions ?? null,
    },
    {
      key: "browser",
      label: "같은 브라우저의 동시 AI 응답",
      current: status?.busySessionsForClient ?? null,
      maximum: status?.maxBusySessionsPerClient ?? null,
    },
  ];
  const statusLabel = items
    .map((item) => `${item.label} ${displayedRatio(item.current, item.maximum)}`)
    .concat(`대기열 세션 ${status?.queuedSessions ?? 0}, 응답 ${status?.queuedResponses ?? 0}`)
    .join(", ");
  const queuedSessions = status?.queuedSessions ?? 0;
  const queuedResponses = status?.queuedResponses ?? 0;

  return (
    <span className="concurrency-status">
      <button
        className="header-icon-button concurrency-status-button"
        type="button"
        aria-describedby={tooltipId}
        aria-label={`동시 사용 현황: ${statusLabel}`}
      >
        <CapacityIcon />
      </button>
      <span className="concurrency-status-tooltip" id={tooltipId} role="tooltip">
        <strong>동시 사용 현황</strong>
        {items.map((item) => (
          <span className="concurrency-status-row" data-status={item.key} key={item.key}>
            <StatusIcon item={item.key} />
            <span>{item.label}</span>
            <span className="concurrency-status-value">{displayedRatio(item.current, item.maximum)}</span>
          </span>
        ))}
        {queuedSessions || queuedResponses ? (
          <span className="concurrency-status-row" data-status="queue">
            <CapacityIcon />
            <span>대기열</span>
            <span className="concurrency-status-value">세션 {queuedSessions} · 응답 {queuedResponses}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}
