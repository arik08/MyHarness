// Admission controls new work only; running work is never interrupted.
export function resourceAdmissionReason(snapshot, limits, now = Date.now()) {
  const { resources, sampledAt, resourceError } = snapshot;
  if (resourceError || !resources || sampledAt == null || now - sampledAt > 20_000
    || !Number.isFinite(resources.cpuPercent) || resources.cpuPercent < 0 || resources.cpuPercent > 100
    || !Number.isFinite(resources.totalMemoryBytes) || resources.totalMemoryBytes <= 0
    || !Number.isFinite(resources.availableMemoryBytes) || resources.availableMemoryBytes < 0
    || resources.availableMemoryBytes > resources.totalMemoryBytes) {
    return "서버 CPU·메모리 측정을 기다리는 중";
  }
  if (resources.cpuPercent >= limits.maxCpuPercent) return "서버 CPU 사용률이 기준 이상입니다";
  const memoryPercent = 100 * (1 - resources.availableMemoryBytes / resources.totalMemoryBytes);
  if (memoryPercent >= limits.maxMemoryPercent) return "서버 메모리 사용률이 기준 이상입니다";
  return "";
}
