// Admission controls new work only; running work is never interrupted.
const cpuSustainMs = 15_000;
const maxSampleGapMs = 10_000;

function sustainedCpuOverload(snapshot, threshold) {
  let previousAt = snapshot.sampledAt;
  const history = snapshot.history || [];
  for (let index = history.length - 1; index >= 0; index--) {
    const { at, resources } = history[index];
    if (!Number.isFinite(at) || at > previousAt || previousAt - at > maxSampleGapMs
      || !Number.isFinite(resources?.cpuPercent) || resources.cpuPercent > 100
      || resources.cpuPercent < threshold) break;
    if (snapshot.sampledAt - at >= cpuSustainMs) return true;
    previousAt = at;
  }
  return false;
}

export function resourceAdmissionReason(snapshot, limits, now = Date.now()) {
  const { resources, sampledAt, resourceError } = snapshot;
  if (resourceError || !resources || sampledAt == null || now - sampledAt > 20_000
    || !Number.isFinite(resources.cpuPercent) || resources.cpuPercent < 0 || resources.cpuPercent > 100
    || !Number.isFinite(resources.totalMemoryBytes) || resources.totalMemoryBytes <= 0
    || !Number.isFinite(resources.availableMemoryBytes) || resources.availableMemoryBytes < 0
    || resources.availableMemoryBytes > resources.totalMemoryBytes) {
    return "서버 CPU·메모리 측정을 기다리는 중";
  }
  const memoryPercent = 100 * (1 - resources.availableMemoryBytes / resources.totalMemoryBytes);
  if (memoryPercent >= limits.maxMemoryPercent) return "서버 메모리 사용률이 기준 이상입니다";
  if (resources.cpuPercent >= limits.maxCpuPercent && sustainedCpuOverload(snapshot, limits.maxCpuPercent)) {
    return "서버 CPU 사용률이 15초 이상 연속으로 기준 이상입니다";
  }
  return "";
}
