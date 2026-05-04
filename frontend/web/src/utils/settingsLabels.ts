import type { AppSettings } from "../types/ui";

export function isLocalBrowserHostname(hostname: string) {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function isLocalBrowserHost(hostname = window.location.hostname) {
  return isLocalBrowserHostname(hostname);
}

export function shellPreferenceLabel(value: AppSettings["shell"]) {
  return {
    auto: "자동: PowerShell 우선",
    powershell: "PowerShell",
    "git-bash": "Git Bash",
    cmd: "cmd",
  }[value] || "자동: PowerShell 우선";
}

export function downloadModeLabel(settings: AppSettings, localBrowserHost = isLocalBrowserHost()) {
  if (!localBrowserHost) return "브라우저 다운로드";
  if (settings.downloadMode === "browser") return "브라우저 다운로드";
  if (settings.downloadMode === "folder") {
    return settings.downloadFolderPath ? `지정 폴더: ${settings.downloadFolderPath}` : "지정 폴더 필요";
  }
  return "매번 저장 위치 선택";
}

export function streamingSettingsLabel(settings: AppSettings) {
  return `따라가기 ${settings.streamScrollDurationMs} ms / 버퍼 ${settings.streamStartBufferMs} ms / 앞섬 ${settings.streamFollowLeadPx}px`;
}

export function formatNumber(value: unknown) {
  return new Intl.NumberFormat("ko-KR").format(Number(value || 0));
}

export function formatStatsDate(value: unknown) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "-";
  const date = new Date(timestamp * (timestamp < 10_000_000_000 ? 1000 : 1));
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
