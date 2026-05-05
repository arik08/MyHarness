import { useState } from "react";
import type { ReactNode } from "react";

function promptTokenKind(rawToken: string) {
  if (rawToken.startsWith("@")) return "file";
  const lower = rawToken.toLowerCase();
  if (lower.startsWith("$mcp:")) return "mcp";
  if (lower.startsWith("$plugin:")) return "plugin";
  return "skill";
}

function splitPromptToken(rawToken: string) {
  const token = String(rawToken || "");
  const match = token.match(/^(.+?)([.,;:)\]]+)$/);
  return match ? { token: match[1], trailing: match[2] } : { token, trailing: "" };
}

function titleCaseToken(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function promptTokenLabel(rawToken: string) {
  const token = rawToken.trim();
  if (token.startsWith("@")) {
    const name = token.slice(1).split(/[\\/]/).filter(Boolean).pop() || token.slice(1);
    return name || token;
  }
  const normalized = token.slice(1).replace(/^["']|["']$/g, "").trim();
  const lower = normalized.toLowerCase();
  if (lower.startsWith("mcp:") || lower.startsWith("plugin:")) {
    return titleCaseToken(normalized.slice(normalized.indexOf(":") + 1)) || normalized;
  }
  return normalized || token;
}

function renderPromptParts(text: string) {
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
    parts.push(
      <span className={`prompt-token ${promptTokenKind(token)}`} aria-label={token} key={`token-${tokenStart}-${rawToken}`}>
        {promptTokenLabel(token)}
      </span>,
    );
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
  return value.length > 180 || value.split(/\r?\n/).length > 2;
}

function previewText(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function UserMessageText({ text }: { text: string }) {
  const value = String(text || "");
  const [expanded, setExpanded] = useState(false);
  const collapsible = shouldCollapseUserMessage(value);

  if (collapsible) {
    return (
      <div className={expanded ? "user-expanded-message" : "user-collapsed-message"} data-raw-text={value}>
        {expanded ? (
          <p className="react-message-text prompt-line">{renderPromptParts(value)}</p>
        ) : (
          <span className="user-message-preview prompt-line">{renderPromptParts(previewText(value))}</span>
        )}
        <button
          type="button"
          className="user-message-toggle"
          aria-expanded={expanded ? "true" : "false"}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      </div>
    );
  }

  return <p className="react-message-text prompt-line">{renderPromptParts(value)}</p>;
}
