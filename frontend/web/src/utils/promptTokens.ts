import type { ArtifactSummary, McpServerItem, PluginItem, SkillItem } from "../types/backend";
import { artifactDisplayName } from "./artifacts";

export type PromptTokenKind = "skill" | "plugin" | "mcp" | "file";

export type PromptTokenReferences = {
  skills?: SkillItem[];
  plugins?: PluginItem[];
  mcpServers?: McpServerItem[];
  artifacts?: ArtifactSummary[];
};

function normalizeName(value: string) {
  return String(value || "").trim().toLowerCase();
}

function isSkillMcpSource(source: string) {
  return /^(skill-mcp(?::|$)|mcp:)/i.test(String(source || "").trim());
}

function trimQuoted(value: string) {
  return value.replace(/^["']|["']$/g, "").trim();
}

export function promptTokenKind(rawToken: string): PromptTokenKind {
  if (rawToken.startsWith("@")) return "file";
  const lower = rawToken.toLowerCase();
  if (lower.startsWith("$mcp:")) return "mcp";
  if (lower.startsWith("$plugin:")) return "plugin";
  return "skill";
}

export function splitPromptToken(rawToken: string) {
  const token = String(rawToken || "");
  const match = token.match(/^(.+?)([.,;:)\]]+)$/);
  return match ? { token: match[1], trailing: match[2] } : { token, trailing: "" };
}

export function titleCaseToken(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function promptTokenLabel(rawToken: string) {
  const token = rawToken.trim();
  if (token.startsWith("@")) {
    const name = token.slice(1).split(/[\\/]/).filter(Boolean).pop() || token.slice(1);
    return name || token;
  }
  const normalized = trimQuoted(token.slice(1));
  const lower = normalized.toLowerCase();
  if (lower.startsWith("mcp:") || lower.startsWith("plugin:")) {
    return titleCaseToken(normalized.slice(normalized.indexOf(":") + 1)) || normalized;
  }
  return normalized || token;
}

export function isActionablePromptToken(rawToken: string, references: PromptTokenReferences) {
  const token = splitPromptToken(rawToken).token.trim();
  if (!token) {
    return false;
  }
  if (token.startsWith("@")) {
    const query = normalizeName(token.slice(1));
    if (!query) {
      return false;
    }
    return (references.artifacts || []).some((artifact) => {
      const path = normalizeName(artifact.path);
      const displayName = normalizeName(artifactDisplayName(artifact));
      return query === path || query === displayName;
    });
  }

  if (!token.startsWith("$")) {
    return false;
  }
  const normalized = trimQuoted(token.slice(1));
  const lower = normalizeName(normalized);
  if (!lower || /^[0-9]/.test(lower)) {
    return false;
  }
  if (lower.startsWith("plugin:")) {
    const pluginName = lower.slice("plugin:".length);
    return (references.plugins || []).some((plugin) => plugin.enabled !== false && normalizeName(plugin.name) === pluginName);
  }
  if (lower.startsWith("mcp:")) {
    const mcpName = lower.slice("mcp:".length);
    const hasServer = (references.mcpServers || []).some((server) => server.state !== "disabled" && normalizeName(server.name) === mcpName);
    const hasSkillMcp = (references.skills || []).some((skill) => (
      skill.enabled !== false
      && isSkillMcpSource(skill.source || "")
      && normalizeName(skill.name) === mcpName
    ));
    return hasServer || hasSkillMcp;
  }
  return (references.skills || []).some((skill) => (
    skill.enabled !== false
    && !isSkillMcpSource(skill.source || "")
    && normalizeName(skill.name) === lower
  ));
}
