import { spawn } from "node:child_process";
import readline from "node:readline";

const windowMs = 15 * 60_000;
const maxObservations = 10_000;

export function createResourceSampler(python, script) {
  let child;
  let reader;
  let pending;
  let retryAt = 0;
  function reset() {
    reader?.close();
    child?.kill();
    child = null;
    reader = null;
    pending?.reject(new Error("Resource collector unavailable"));
    pending = null;
  }
  return {
    async sample() {
      if (Date.now() < retryAt) throw new Error("Resource collector unavailable");
      if (!child) {
        child = spawn(python.file, [...python.args, script, String(process.pid)], {
          windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
        });
        reader = readline.createInterface({ input: child.stdout });
        reader.on("line", (line) => {
          try {
            const result = JSON.parse(line);
            if (result.error) pending?.reject(new Error(result.error));
            else pending?.resolve(result);
          } catch { pending?.reject(new Error("Invalid resource sample")); }
          pending = null;
        });
        child.once("error", () => { retryAt = Date.now() + 60_000; reset(); });
        child.once("exit", () => { retryAt = Date.now() + 60_000; reset(); });
        child.stdin.on("error", () => { /* exit/timeout handles a broken pipe */ });
      }
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => {
            retryAt = Date.now() + 60_000;
            reset();
          }, 4_000);
          child.stdin.write("sample\n");
        });
      } finally { clearTimeout(timer); }
    },
    stop: reset,
  };
}

export function createServerMetrics({ sampleResources, readLoad, onSample = () => {}, now = Date.now, intervalMs = 5_000 }) {
  const history = [];
  const api = [];
  const waits = [];
  const startedAt = now();
  let resources = null;
  let resourceSampledAt = null;
  let resourceError = null;
  let sampling = false;
  let timer;

  function trim(values) {
    const cutoff = now() - windowMs;
    while (values.length && values[0].at < cutoff) values.shift();
    if (values.length > maxObservations) values.splice(0, values.length - maxObservations);
  }
  function stats(values) {
    trim(values);
    const sorted = values.map((value) => value.ms).sort((a, b) => a - b);
    return { count: sorted.length, p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
  }
  function snapshot(includeHistory = false) {
    trim(history);
    return {
      startedAt, sampledAt: resourceSampledAt, intervalMs, windowMs,
      resources, resourceError,
      load: readLoad(), api: stats(api), queueWait: stats(waits),
      ...(includeHistory ? { history: [...history] } : {}),
    };
  }
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      resources = await sampleResources();
      resourceSampledAt = now();
      resourceError = null;
    } catch {
      resources = null;
      resourceSampledAt = null;
      resourceError = "서버 자원 수집 불가 · Python 환경의 psutil 설치 상태를 확인하세요.";
    } finally {
      const current = snapshot();
      history.push({ at: now(), resources, load: current.load, apiP95Ms: current.api.p95Ms });
      trim(history);
      // Bounded even if the clock moves backwards or sample() is invoked manually.
      if (history.length > 181) history.splice(0, history.length - 181);
      sampling = false;
      onSample();
    }
  }
  return {
    snapshot, sample,
    start() {
      if (timer) return;
      // Startup may already have collected a meaningful CPU interval.
      if (resourceSampledAt == null) void sample();
      timer = setInterval(() => void sample(), intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    recordQueueWait(queuedAt) {
      if (!Number.isFinite(queuedAt)) return;
      waits.push({ at: now(), ms: Math.max(0, now() - queuedAt) });
      trim(waits);
    },
    observeRequest(request, response) {
      const path = new URL(request.url || "/", "http://localhost").pathname;
      // Observe successful ordinary JSON reads, not AI execution, SSE, or telemetry polls.
      if (request.method !== "GET" || !path.startsWith("/api/")
        || path.startsWith("/api/auth/") || ["/api/events", "/api/server-metrics", "/api/settings/concurrency", "/api/session-queue"].includes(path)) return;
      const start = performance.now();
      response.once("finish", () => {
        if (response.statusCode >= 400 || !String(response.getHeader("content-type")).includes("application/json")) return;
        api.push({ at: now(), ms: Math.max(0, performance.now() - start) });
        trim(api);
      });
    },
  };
}
