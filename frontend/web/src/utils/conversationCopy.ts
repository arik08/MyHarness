import type { ChatMessage } from "../types/ui";

export function conversationTextThrough(messages: ChatMessage[], answerId: string): string {
  const end = messages.findIndex((message) => message.id === answerId);
  if (end < 0) throw new Error("복사할 답변을 현재 대화에서 찾을 수 없습니다.");
  return messages.slice(0, end + 1).flatMap((message) => {
    if (message.pendingRequestId || message.terminal || message.responsePhase === "commentary") return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (message.role === "assistant" && (!message.isComplete || message.suppressActions)) return [];
    const text = (message.role === "user" && message.images?.length
      ? message.displayText ?? message.text : message.text).trim();
    const attachments = message.role === "user" ? (message.images || []).map((image) => `[첨부 이미지: ${image.name}]`) : [];
    const body = [text, ...attachments].filter(Boolean).join("\n");
    return body ? [`${message.role === "user" ? "사용자" : "AI"} :\n${body}`] : [];
  }).join("\n\n");
}
