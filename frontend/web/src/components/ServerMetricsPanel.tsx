import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ServerMetrics, ServerMetricPoint } from "../api/serverMetrics";
import "./server-metrics.css";

export function memoryLabel(bytes: number | null | undefined) {
  return bytes == null ? "–" : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
export function percentLabel(value: number | null | undefined) {
  return value == null ? "–" : `${value.toFixed(1)}%`;
}
function timeLabel(value: number | null | undefined) {
  if (value == null) return "표본 없음";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}초` : `${Math.round(value)} ms`;
}

function Trend({ points, label, value, format, ceiling }: {
  points: ServerMetricPoint[]; label: string;
  value: (point: ServerMetricPoint) => number | null;
  format: (value: number | null) => string; ceiling?: number;
}) {
  const available = points.map(value).filter((item): item is number => item != null);
  const max = ceiling ?? Math.max(1, ...available);
  const end = points.at(-1)?.at ?? Date.now();
  // Fixed 15-minute axis; missing samples create gaps rather than fake zero values.
  const segments: string[] = [];
  let segment = "";
  for (const point of points) {
    const amount = value(point);
    if (amount == null) { if (segment) segments.push(segment); segment = ""; continue; }
    const x = Math.max(0, 480 * (1 - (end - point.at) / 900_000));
    const y = 66 - Math.min(1, amount / max) * 60;
    segment += `${segment ? " L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  if (segment) segments.push(segment);
  return <figure className="server-trend">
    <figcaption><span>{label}</span><strong>{format(points.length ? value(points[points.length - 1]) : null)}</strong></figcaption>
    {available.length > 1 ? <svg viewBox="0 0 480 72" role="img" aria-label={`${label} 최근 15분 추이 · 최댓값 ${format(Math.max(...available))}`} preserveAspectRatio="none">
      <path className="server-trend-grid" d="M0 6H480 M0 36H480 M0 66H480" />
      {segments.map((path, index) => <path className="server-trend-line" d={path} key={index} />)}
    </svg> : <div className="server-trend-empty">추이를 수집하고 있습니다</div>}
    <div className="server-trend-axis"><span>15분 전</span><span>현재 · 최대 {format(available.length ? Math.max(...available) : null)}</span></div>
  </figure>;
}

export function ServerMetricsPanel({ metrics, error, onClose }: {
  metrics: ServerMetrics | null; error: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); previous?.focus(); };
  }, [onClose]);
  const resource = metrics?.resources;
  const load = metrics?.load;
  const points = metrics?.history ?? [];
  const usedPercent = resource ? 100 * (1 - resource.availableMemoryBytes / resource.totalMemoryBytes) : null;
  const stale = metrics?.sampledAt != null && Date.now() - metrics.sampledAt > 20_000;
  return createPortal(<div className="modal-backdrop server-metrics-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="modal-card server-metrics-panel" role="dialog" aria-modal="true" aria-labelledby="server-metrics-title">
      <header className="server-metrics-header">
        <div><h2 id="server-metrics-title">서버 부하</h2><p>최근 15분 · 5초마다 갱신 · 서버 재시작 시 초기화</p></div>
        <button ref={close} type="button" className="header-icon-button" aria-label="서버 부하 닫기" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
      </header>
      {(error || stale || metrics?.resourceError) && <p role="status" className="server-metrics-warning">{error || (stale ? "수집이 지연되고 있습니다. 마지막 측정값입니다." : metrics?.resourceError)}</p>}
      {!metrics ? <p role="status">서버 지표를 불러오는 중입니다.</p> : <>
        <dl className="server-metrics-summary">
          <div><dt>서버 CPU</dt><dd>{percentLabel(resource?.cpuPercent)}</dd><small>컴퓨터 전체 · 구간 평균</small></div>
          <div><dt>가용 메모리</dt><dd>{memoryLabel(resource?.availableMemoryBytes)}</dd><small>전체 {memoryLabel(resource?.totalMemoryBytes)} · 사용 {percentLabel(usedPercent)}</small></div>
          <div><dt>MyHarness 메모리</dt><dd>{memoryLabel(resource?.appMemoryBytes)}</dd><small>{resource ? `${resource.processCount}개 프로세스${resource.partial ? " · 일부만 집계" : ""}` : "수집 중 또는 확인 불가"}</small></div>
        </dl>
        <div className="server-metrics-trends">
          <Trend points={points} label="서버 CPU" value={(p) => p.resources?.cpuPercent ?? null} format={percentLabel} ceiling={100} />
          <Trend points={points} label="가용 메모리" value={(p) => p.resources?.availableMemoryBytes ?? null} format={memoryLabel} ceiling={resource?.totalMemoryBytes} />
          <Trend points={points} label="MyHarness 메모리" value={(p) => p.resources?.appMemoryBytes ?? null} format={memoryLabel} />
          <Trend points={points} label="실행 중 AI 작업" value={(p) => p.load.busySessions} format={(n) => n == null ? "–" : `${n}개`} />
        </div>
        <h3>작업과 대기</h3>
        <dl className="server-metrics-rows">
          <div><dt>연결된 화면</dt><dd>{load?.connectedScreens}개</dd></div>
          <div><dt>보유 세션 <small>메모리를 사용하는 전체 세션</small></dt><dd>{load?.retainedSessions}개</dd></div>
          <div><dt>화면 없는 유휴 세션</dt><dd>{load?.detachedIdleSessions}개</dd></div>
          <div><dt>실행 중 AI 작업</dt><dd>{load?.busySessions}개</dd></div>
          <div><dt>현재 대기</dt><dd>세션 {load?.queuedSessions} · 응답 {load?.queuedResponses}</dd></div>
          <div><dt>현재 가장 오래 기다린 시간</dt><dd>{timeLabel(load?.oldestWaitMs)}</dd></div>
          <div><dt>대기 후 시작한 작업의 대기시간 p95 <small>{metrics.queueWait.count}개 표본</small></dt><dd>{timeLabel(metrics.queueWait.p95Ms)}</dd></div>
          <div><dt>일반 API 응답시간 p95 <small>{metrics.api.count}개 표본 · 성공한 JSON 조회</small></dt><dd>{timeLabel(metrics.api.p95Ms)}</dd></div>
        </dl>
        <div className="server-metrics-trends">
          <Trend points={points} label="대기 작업" value={(p) => p.load.queuedSessions + p.load.queuedResponses} format={(n) => n == null ? "–" : `${n}개`} />
          <Trend points={points} label="일반 API 응답시간 p95" value={(p) => p.apiP95Ms} format={timeLabel} />
        </div>
        <details className="server-metrics-notes"><summary>측정 기준과 한도 조정 참고</summary>
          <p>CPU {load?.maxCpuPercent}% 또는 메모리 {load?.maxMemoryPercent}% 이상이면 새 세션과 응답이 대기하며, 기준 미만으로 내려가면 자동 재개됩니다. 자원은 5초마다 측정합니다. 진행 중인 작업은 중단하지 않으므로 실제 사용률은 기준을 넘을 수 있습니다. 세션 수와 서버 전체 응답 수에는 고정 한도가 없습니다. 대기 인원은 접속 IP 기준으로 집계합니다.</p>
          <p>MyHarness 메모리는 웹 서버와 하위 Python·도구·수집기 프로세스의 RSS 합계입니다. 공유 메모리가 중복될 수 있어 컴퓨터 전체 사용량과 같지 않습니다. 분리 실행되어 부모 관계가 끊긴 프로세스는 포함되지 않습니다.</p>
          <p>p95는 표본의 95%가 해당 시간 이내라는 뜻입니다. 최근 15분의 최대 10,000개 표본을 사용합니다. 대기시간은 취소된 작업을 제외하며, API 지연에는 AI 실행·스트리밍·지표 조회가 포함되지 않습니다. 배경 탭도 연결이 유지되면 화면 수에 포함합니다.</p>
        </details>
        <p className="server-metrics-updated">마지막 자원 측정: {metrics.sampledAt ? new Date(metrics.sampledAt).toLocaleTimeString("ko-KR") : "아직 없음"}</p>
      </>}
    </div>
  </div>, document.body);
}
