import type { AppSettings, ChatMessage } from "../types/ui";
import { StreamingTextRenderer } from "./StreamingTextRenderer";

export function StreamingAssistantMessage({
  message,
  settings,
  active,
  onVisibleTextChange,
}: {
  message: ChatMessage;
  settings: AppSettings;
  active: boolean;
  onVisibleTextChange?: () => void;
}) {
  return (
    <StreamingTextRenderer
      text={message.text}
      settings={settings}
      streaming={active && !message.isComplete}
      onVisibleTextChange={onVisibleTextChange}
    />
  );
}
