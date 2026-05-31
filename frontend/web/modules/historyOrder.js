export function historyOrderTimestamp(data = {}, info = {}, fallbackNow = Date.now()) {
  const createdAt = Number(data?.created_at || 0);
  if (Number.isFinite(createdAt) && createdAt > 0) {
    return createdAt;
  }
  for (const field of ["birthtimeMs", "ctimeMs", "mtimeMs"]) {
    const value = Number(info?.[field] || 0);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  const fallback = Number(fallbackNow);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now();
}

export function normalizedHistoryTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 0;
  }
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function hasAssistantContent(message) {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return true;
  }
  if (typeof message.content === "string" && message.content.trim()) {
    return true;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    if (typeof block.text === "string" && block.text.trim()) {
      return true;
    }
    if (typeof block.content === "string" && block.content.trim()) {
      return true;
    }
    return block.type === "tool_use" || block.type === "image";
  });
}

export function lastAssistantActivityTimestamp(data = {}, info = {}, fallbackNow = 0) {
  const explicit = normalizedHistoryTimestamp(data?.last_assistant_at || data?.lastAssistantAt);
  if (explicit > 0) {
    return explicit;
  }

  let latest = 0;
  for (const event of Array.isArray(data?.history_events) ? data.history_events : []) {
    if (!event || typeof event !== "object" || event.type !== "assistant") {
      continue;
    }
    const hasContent = String(event.text || "").trim() || (Array.isArray(event.artifacts) && event.artifacts.length);
    if (!hasContent) {
      continue;
    }
    latest = Math.max(
      latest,
      normalizedHistoryTimestamp(event.timestamp || event.createdAt || event.created_at),
    );
  }
  if (latest > 0) {
    return latest;
  }

  const hasAssistant = (Array.isArray(data?.messages) ? data.messages : []).some(hasAssistantContent);
  if (!hasAssistant) {
    return 0;
  }
  return normalizedHistoryTimestamp(fallbackNow) || normalizedHistoryTimestamp(historyOrderTimestamp(data, info, Date.now()));
}

function historyTitleForSort(item) {
  return String(item?.titleSortKey || item?.description || item?.label || item?.value || "").trim();
}

function compareHistoryTitle(left, right) {
  return (
    historyTitleForSort(left).localeCompare(historyTitleForSort(right), "ko", {
      numeric: true,
      sensitivity: "base",
    })
    || String(left?.value || "").localeCompare(String(right?.value || ""), "ko")
  );
}

export function compareHistoryItems(left, right) {
  const byPinned = Number(right?.pinned === true) - Number(left?.pinned === true);
  if (byPinned) return byPinned;
  if (left?.pinned === true && right?.pinned === true) {
    const byTitle = compareHistoryTitle(left, right);
    if (byTitle) return byTitle;
  }

  const leftAssistantAt = normalizedHistoryTimestamp(left?.lastAssistantAt || left?.last_assistant_at);
  const rightAssistantAt = normalizedHistoryTimestamp(right?.lastAssistantAt || right?.last_assistant_at);
  const byAssistantPresence = Number(rightAssistantAt > 0) - Number(leftAssistantAt > 0);
  if (byAssistantPresence) return byAssistantPresence;
  const byAssistantActivity = rightAssistantAt - leftAssistantAt;
  if (byAssistantActivity) return byAssistantActivity;

  return (right?.createdAt || 0) - (left?.createdAt || 0);
}
