// Build an independent conversation prefix; never copy a live task's state.
function textOf(message) {
  if (typeof message?.content === "string") return message.content.trim();
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || "")).join("\n").trim();
}

function answerText(event) {
  return String(event?.text || "").trim() || (event?.artifacts?.length ? "작성 완료했습니다." : "");
}

function isFinalAnswer(events, index) {
  if (events[index]?.type !== "assistant" || !answerText(events[index])) return false;
  for (const next of events.slice(index + 1)) {
    if (next.type === "user") return true;
    if (next.type === "assistant" && answerText(next)) return false;
    if (["tool_started", "tool_completed", "tool_progress", "tool_input_delta"].includes(next.type)) return false;
  }
  return true;
}

export function branchSnapshot(source, { sessionId, answerIndex, expectedText, now = Date.now() / 1000 }) {
  const events = Array.isArray(source.history_events) ? source.history_events : [];
  const answers = events.flatMap((event, index) => isFinalAnswer(events, index) ? [index] : []);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= answers.length) {
    throw new Error("완료된 분기 답변을 찾을 수 없습니다. 대화를 다시 불러온 뒤 시도해 주세요.");
  }
  const anchorIndex = answers[answerIndex];
  const anchor = events[anchorIndex];
  if (!String(expectedText || "").trim() || answerText(anchor) !== String(expectedText).trim()) {
    throw new Error("대화 내용이 변경되었습니다. 분기할 답변을 다시 선택해 주세요.");
  }
  const prefix = events.slice(0, anchorIndex + 1);
  const originalMessages = Array.isArray(source.messages) ? source.messages : [];
  const historyAnswers = events.filter((event) => event.type === "assistant")
    .map((event) => String(event.text || "").trim()).filter(Boolean);
  const modelAnswers = originalMessages.filter((message) => message.role === "assistant")
    .map(textOf).filter(Boolean);
  const completeContext = JSON.stringify(historyAnswers) === JSON.stringify(modelAnswers);
  // Match occurrences as well as text so repeated answers do not select the first turn.
  const occurrence = prefix.filter((event) => event.type === "assistant" && answerText(event) === answerText(anchor)).length;
  let seen = 0;
  const messageIndex = completeContext ? originalMessages.findIndex((message) => (
    message.role === "assistant" && textOf(message) === String(anchor.text || "").trim() && ++seen === occurrence
  )) : -1;
  let messages;
  if (messageIndex >= 0) {
    messages = structuredClone(originalMessages.slice(0, messageIndex + 1));
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        message.content = message.content.filter((block) => block.type !== "responses_state");
      }
    }
    messages = messages.filter((message) => !Array.isArray(message.content) || message.content.length);
  } else {
    // Compaction may have removed an old anchor from the model context. Rebuild
    // from the visible prefix instead of copying a summary containing later turns.
    messages = prefix.flatMap((event) => {
      if (!["user", "assistant"].includes(event.type)) return [];
      const text = event.type === "assistant" ? answerText(event) : String(event.text || "").trim();
      return text ? [{ role: event.type, content: [{ type: "text", text }] }] : [];
    });
  }
  const title = `${String(source.summary || "새 대화").trim()} · 분기`;
  const history = structuredClone(prefix).filter((event) => event.type !== "swarm_status");
  for (const event of history) delete event.session_usage;
  return {
    storage_version: 2,
    session_id: sessionId,
    cwd: source.cwd,
    model: source.model,
    messages,
    history_events: history,
    history_events_saved_at: now,
    history_replay_compacted: false,
    usage: {},
    usage_accounting: {},
    tool_metadata: {
      session_title: title,
      session_title_source: "branch",
      session_title_user_edited: true,
      branch_origin: { session_id: source.session_id, answer_index: answerIndex },
    },
    created_at: now,
    last_assistant_at: now * 1000,
    summary: title,
    message_count: messages.length,
    pinned: false,
    liked: false,
  };
}
