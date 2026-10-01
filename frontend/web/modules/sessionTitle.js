// Keep model-only continuity messages out of session identity, including legacy
// snapshots whose stored title was already shortened from a compaction marker.
export function isCompactionTitle(text) {
  return /^(?:\[compact (?:boundary|attachment)\b|\[conversation summary\]|this session is being continued\b|session memory summary from earlier\b)/i.test(String(text || "").trim());
}

export function storedSessionTitle(data) {
  const metadata = data.tool_metadata || {};
  if (metadata.session_title_user_edited) {
    const title = String(metadata.session_title || data.summary || "").trim();
    if (title) return title;
  }
  const candidates = [
    data.summary,
    metadata.session_title,
    data.first_user_summary,
    ...(Array.isArray(data.history_events) ? data.history_events : [])
      .filter((event) => event?.type === "user").map((event) => event.text),
    ...(Array.isArray(metadata.user_input_archive) ? metadata.user_input_archive : [])
      .map((entry) => entry?.text),
    ...(Array.isArray(data.messages) ? data.messages : [])
      .filter((message) => message?.role === "user")
      .map((message) => typeof message.text === "string" ? message.text
        : typeof message.content === "string" ? message.content
        : (Array.isArray(message.content) ? message.content : [])
          .filter((block) => block?.type === "text").map((block) => block.text || "").join(" ")),
  ];
  return candidates.map((value) => String(value || "").trim())
    .find((value) => value && !isCompactionTitle(value)) || "";
}
