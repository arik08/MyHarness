import { getJson } from "./http";

export type ServerResources = {
  cpuPercent: number | null;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  appMemoryBytes: number;
  processCount: number;
  partial: boolean;
};
export type ServerLoad = {
  connectedScreens: number;
  retainedSessions: number;
  detachedIdleSessions: number;
  busySessions: number;
  queuedSessions: number;
  queuedResponses: number;
  oldestWaitMs: number;
  maxCpuPercent: number;
  maxMemoryPercent: number;
};
export type ServerMetricPoint = {
  at: number;
  resources: ServerResources | null;
  load: ServerLoad;
  apiP95Ms: number | null;
};
export type ServerMetrics = {
  startedAt: number;
  sampledAt: number | null;
  intervalMs: number;
  windowMs: number;
  resources: ServerResources | null;
  resourceError: string | null;
  load: ServerLoad;
  api: { count: number; p95Ms: number | null };
  queueWait: { count: number; p95Ms: number | null };
  history?: ServerMetricPoint[];
};

export function readServerMetrics(history = false) {
  return getJson<ServerMetrics>(`/api/server-metrics${history ? "?history=1" : ""}`);
}
