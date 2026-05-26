type ChatShareUrlParams = {
  baseUrl: string;
  chatId: string;
  messageId: string;
  workspaceName?: string;
  workspacePath?: string;
};

function encodeReadableQueryValue(value: string) {
  return encodeURIComponent(value)
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":")
    .replace(/%5C/g, "\\")
    .replace(/%[0-9A-F]{2}/g, (segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return /[^\x00-\x7F]/.test(decoded) ? decoded : segment.toUpperCase();
      } catch {
        return segment.toUpperCase();
      }
    });
}

function readableQuery(params: Array<[string, string]>) {
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeReadableQueryValue(value)}`)
    .join("&");
}

export function chatShareUrl({
  baseUrl,
  chatId,
  messageId,
  workspaceName,
  workspacePath,
}: ChatShareUrlParams) {
  const base = String(baseUrl || window.location.origin).replace(/\/+$/, "");
  const query: Array<[string, string]> = [
    ["chat", chatId],
    ["message", messageId],
  ];
  if (workspaceName) {
    query.push(["workspace", workspaceName]);
  } else if (workspacePath) {
    query.push(["workspacePath", workspacePath]);
  }
  return `${base}/?${readableQuery(query)}`;
}

export async function shareBaseUrl() {
  try {
    const response = await fetch("/api/share/base-url", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not read share URL");
    }
    const payload = await response.json() as { baseUrl?: string };
    return String(payload.baseUrl || "").trim() || window.location.origin;
  } catch {
    return window.location.origin;
  }
}
