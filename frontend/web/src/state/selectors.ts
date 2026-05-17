import type { AppState, ChatMessage } from "../types/ui";

const defaultConversationTitle = "MyHarness";

function normalizeConversationTitle(value: string) {
  return value.trim() || defaultConversationTitle;
}

export function currentConversationTitle(state: Pick<AppState, "chatTitle">) {
  return normalizeConversationTitle(state.chatTitle || "");
}

export function currentConversationHistoryTitle(state: Pick<AppState, "chatTitle" | "messages">) {
  const title = currentConversationTitle(state);
  if (title !== defaultConversationTitle) {
    return title;
  }
  return firstUserMessageTitle(state.messages);
}

function firstUserMessageTitle(messages: ChatMessage[]) {
  return messages.find((message) => (
    message.role === "user" && !message.kind && !/^\/\S*/.test(message.text.trim())
  ))?.text.replace(/\s+/g, " ").trim() || "";
}
