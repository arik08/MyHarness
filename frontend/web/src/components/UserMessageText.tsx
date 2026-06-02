import { useState } from "react";
import type { ReactNode } from "react";
import type { PromptTokenReferences } from "../utils/promptTokens";
import { copyTextToClipboard } from "../utils/clipboard";
import { isActionablePromptToken, promptTokenKind, promptTokenLabel, splitPromptToken } from "../utils/promptTokens";

function renderPromptParts(text: string, references: PromptTokenReferences) {
  const value = String(text || "");
  const tokenPattern = /(^|\s)(\$"[^"]+"|\$'[^']+'|\$[^\s]+|@[A-Za-z0-9_][A-Za-z0-9_.\\/-]*)/gi;
  const parts: ReactNode[] = [];
  let cursor = 0;

  function pushText(part: string, keyPrefix: string) {
    const lines = part.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) {
        parts.push(<br key={`${keyPrefix}-br-${index}-${parts.length}`} />);
      }
      if (line) {
        parts.push(line);
      }
    });
  }

  for (const match of value.matchAll(tokenPattern)) {
    const leading = match[1] || "";
    const rawToken = match[2] || "";
    const tokenStart = (match.index || 0) + leading.length;
    pushText(value.slice(cursor, tokenStart), `text-${cursor}`);
    const { token, trailing } = splitPromptToken(rawToken);
    if (isActionablePromptToken(token, references)) {
      parts.push(
        <span className={`prompt-token ${promptTokenKind(token)}`} aria-label={token} key={`token-${tokenStart}-${rawToken}`}>
          {promptTokenLabel(token)}
        </span>,
      );
    } else {
      parts.push(token);
    }
    if (trailing) {
      parts.push(trailing);
    }
    cursor = tokenStart + rawToken.length;
  }
  pushText(value.slice(cursor), `text-${cursor}`);
  return parts.length ? parts : value;
}

function shouldCollapseUserMessage(text: string) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  const lineCount = value.split(/\r?\n/).length;
  return lineCount >= 10;
}

function previewText(text: string) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n").slice(0, 10).join("\n").trim();
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function UserMessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = failed ? "입력 복사 실패" : copied ? "입력 복사됨" : "입력 복사";

  async function copyUserMessage() {
    setFailed(false);
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 1800);
    }
  }

  return (
    <button
      type="button"
      className={`user-message-copy${copied ? " copied" : ""}${failed ? " failed" : ""}`}
      data-tooltip={label}
      aria-label={label}
      onClick={() => void copyUserMessage()}
    >
      <CopyIcon />
    </button>
  );
}

export function UserMessageText({ text, promptTokenReferences }: { text: string; promptTokenReferences: PromptTokenReferences }) {
  const value = String(text || "");
  const [expanded, setExpanded] = useState(false);
  const collapsible = shouldCollapseUserMessage(value);

  if (collapsible) {
    return (
      <div className={expanded ? "user-expanded-message" : "user-collapsed-message"} data-raw-text={value}>
        <div className="user-message-toolbar">
          <UserMessageCopyButton text={value} />
        </div>
        <div className="user-message-body">
          {expanded ? (
            <p className="react-message-text prompt-line">{renderPromptParts(value, promptTokenReferences)}</p>
          ) : (
            <p className="user-message-preview prompt-line">{renderPromptParts(previewText(value), promptTokenReferences)}</p>
          )}
        </div>
        <div className="user-message-toggle-row">
          <button
            type="button"
            className="user-message-toggle"
            aria-expanded={expanded ? "true" : "false"}
            onClick={() => setExpanded((current) => !current)}
          >
            <span>{expanded ? "접기" : "확장"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="user-inline-message">
      <div className="user-message-toolbar">
        <UserMessageCopyButton text={value} />
      </div>
      <p className="react-message-text prompt-line">{renderPromptParts(value, promptTokenReferences)}</p>
    </div>
  );
}
