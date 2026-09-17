export function backendToolCallIndex(event) {
  const raw = event.tool_call_index;
  if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "") return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

export function toolCallKey(event) {
  if (typeof event.tool_call_id === "string" && event.tool_call_id) return `id:${event.tool_call_id}`;
  const index = backendToolCallIndex(event);
  return index === null ? `tool:${String(event.tool_name || "")}` : `index:${index}`;
}
