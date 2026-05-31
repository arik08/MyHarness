import type { AppSettings, ChatMessage } from "../types/ui";
import type { SourceEvidenceByUrl } from "./MarkdownMessage";
import { StreamingTextRenderer } from "./StreamingTextRenderer";

export function StreamingAssistantMessage({
  message,
  settings,
  active,
  onVisibleTextChange,
  sourceEvidenceByUrl,
}: {
  message: ChatMessage;
  settings: AppSettings;
  active: boolean;
  onVisibleTextChange?: () => void;
  sourceEvidenceByUrl?: SourceEvidenceByUrl;
}) {
  return (
    <StreamingTextRenderer
      text={message.text}
      settings={settings}
      streaming={active && !message.isComplete}
      onVisibleTextChange={onVisibleTextChange}
      sourceEvidenceByUrl={sourceEvidenceByUrl}
    />
  );
}
