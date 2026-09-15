import type { ClientAttachmentRef } from "../api/messages";

// The runtime and the web queue currently use different attachment summaries.
// Keep these identities separate from the filename-based text shown in the UI.
export function submittedTranscriptTexts(line: string, images: readonly unknown[], files: readonly ClientAttachmentRef[]) {
  if (!images.length && !files.length) return undefined;
  const parts: string[] = [];
  if (images.length) parts.push(`image attachments: ${images.length}`);
  if (files.length) {
    const names = files.map((file) => file.name || file.path.split(/[\\/]/).pop() || "file").join(", ");
    parts.push(`file attachments: ${names || files.length}`);
  }
  const text = line.trim();
  return [
    [text, ...parts.map((part) => `[${part}]`)].filter(Boolean).join(" "),
    `${text || "(파일 첨부)"} [${parts.join("; ")}]`,
  ];
}
