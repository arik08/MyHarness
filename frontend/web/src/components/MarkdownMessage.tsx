import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";

const htmlPreviewUrlCache = new Map<string, string>();
const htmlPreviewSourceCache = new Map<string, string>();
const mermaidSourceCache = new Map<string, string>();
let mermaidRenderId = 0;
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let markdownEnhancementObserver: MutationObserver | null = null;
let activeMermaidZoomViewer: HTMLElement | null = null;

function sanitizeRenderedHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("script, iframe, object, embed")) {
    node.remove();
  }
  for (const element of template.content.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return template.innerHTML;
}

function codeBlockLanguage(code: Element) {
  const className = String(code.getAttribute("class") || "").toLowerCase();
  return className.match(/(?:^|\s)language-([a-z0-9_-]+)/)?.[1] || "";
}

function normalizeHtmlPreviewSource(value: string) {
  return String(value || "").replace(/\r\n/g, "\n").trimEnd();
}

function mermaidDiagramLineIndex(lines: string[]) {
  let inDirective = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    if (inDirective) {
      if (trimmed.endsWith("%%")) {
        inDirective = false;
      }
      continue;
    }
    if (/^%%\{/.test(trimmed)) {
      inDirective = !trimmed.endsWith("%%");
      continue;
    }
    if (/^%%/.test(trimmed)) {
      continue;
    }
    return index;
  }
  return -1;
}

function firstMermaidLine(source: string) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const index = mermaidDiagramLineIndex(lines);
  return index >= 0 ? lines[index].trim() : "";
}

function mermaidDiagramKind(source: string) {
  const first = firstMermaidLine(source);
  return first.match(/^([A-Za-z][\w-]*)/)?.[1] || "";
}

function quoteMermaidValue(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^["'].*["']$/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteMermaidDoubleString(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^".*"$/.test(trimmed) || /^"`[\s\S]*`"$/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function csvCells(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function formatSankeyCsvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function needsSankeyToken(value: string) {
  return /[^\x20-\x7e]/.test(value);
}

function normalizeRequirementEnum(key: string, value: string) {
  const lower = value.trim().toLowerCase();
  const risk: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
  const method: Record<string, string> = {
    analysis: "Analysis",
    inspection: "Inspection",
    test: "Test",
    demonstration: "Demonstration",
  };
  return key.toLowerCase() === "risk" ? risk[lower] || value.trim() : method[lower] || value.trim();
}

function normalizeRequirementDiagramSource(source: string) {
  return source.split("\n").map((line) => {
    const field = line.match(/^(\s*)(id|text|docref|type|risk|verifymethod):\s*(.*?)\s*$/i);
    if (!field) {
      return line;
    }
    const [, indent, rawKey, rawValue] = field;
    const key = rawKey.toLowerCase();
    if (key === "risk" || key === "verifymethod") {
      return `${indent}${rawKey}: ${normalizeRequirementEnum(key, rawValue)}`;
    }
    return `${indent}${rawKey}: ${quoteMermaidValue(rawValue)}`;
  }).join("\n");
}

function normalizeQuadrantChartSource(source: string) {
  return source.split("\n").map((line) => {
    const axis = line.match(/^(\s*[xy]-axis\s+)(.+?)(\s*--+>\s*)(.+?)\s*$/i);
    if (axis) {
      return `${axis[1]}${quoteMermaidDoubleString(axis[2])}${axis[3]}${quoteMermaidDoubleString(axis[4])}`;
    }
    const quadrant = line.match(/^(\s*quadrant-[1-4]\s+)(.+?)\s*$/i);
    if (quadrant) {
      return `${quadrant[1]}${quoteMermaidDoubleString(quadrant[2])}`;
    }
    const point = line.match(/^(\s*)(.+?)(\s*:\s*\[\s*(?:1|0(?:\.\d+)?)\s*,\s*(?:1|0(?:\.\d+)?)\s*\].*)$/);
    if (point && !/^(?:title|accTitle|accDescr|classDef)\b/i.test(point[2].trim())) {
      return `${point[1]}${quoteMermaidDoubleString(point[2])}${point[3]}`;
    }
    return line;
  }).join("\n");
}

function normalizeFlowchartSource(source: string) {
  return source.split("\n").map((line) => {
    const classDefEnd = line.match(/^(\s*classDef\s+)end(\b.*)$/i);
    if (classDefEnd) {
      return `${classDefEnd[1]}mh_end${classDefEnd[2]}`;
    }
    const classEnd = line.match(/^(\s*class\s+.+?\s+)end(\s*)$/i);
    if (classEnd) {
      return `${classEnd[1]}mh_end${classEnd[2]}`;
    }
    return line;
  }).join("\n");
}

type NormalizedMermaidSource = {
  source: string;
  labelReplacements: Array<[string, string]>;
};

function normalizeSankeySource(source: string): NormalizedMermaidSource {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const diagramIndex = mermaidDiagramLineIndex(lines);
  const labelToToken = new Map<string, string>();
  const tokenFor = (label: string) => {
    if (!needsSankeyToken(label)) {
      return label;
    }
    let token = labelToToken.get(label);
    if (!token) {
      token = `mh_sankey_node_${labelToToken.size + 1}`;
      labelToToken.set(label, token);
    }
    return token;
  };
  const normalizedLines = lines.map((line, index) => {
    if (index === diagramIndex) {
      return line.replace(/^(\s*)sankey-beta\b/i, "$1sankey");
    }
    if (diagramIndex >= 0 && index < diagramIndex) {
      return line;
    }
    const cells = csvCells(line.trim());
    if (cells.length !== 3 || !cells[0] || !cells[1]) {
      return line;
    }
    return [
      formatSankeyCsvCell(tokenFor(cells[0])),
      formatSankeyCsvCell(tokenFor(cells[1])),
      cells[2],
    ].join(",");
  });
  return {
    source: normalizedLines.join("\n"),
    labelReplacements: [...labelToToken.entries()].map(([label, token]) => [token, label]),
  };
}

function normalizeMermaidSource(source: string) {
  const normalized = normalizeHtmlPreviewSource(source);
  const kind = mermaidDiagramKind(normalized).toLowerCase();
  if (kind === "sankey" || kind === "sankey-beta") {
    return normalizeSankeySource(normalized);
  }
  if (kind === "quadrantchart") {
    return { source: normalizeQuadrantChartSource(normalized), labelReplacements: [] };
  }
  if (kind === "requirementdiagram") {
    return { source: normalizeRequirementDiagramSource(normalized), labelReplacements: [] };
  }
  if (kind === "flowchart" || kind === "graph") {
    return { source: normalizeFlowchartSource(normalized), labelReplacements: [] };
  }
  return { source: normalized, labelReplacements: [] };
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyMermaidLabelReplacements(svg: string, replacements: Array<[string, string]>) {
  if (!replacements.length) {
    return svg;
  }
  const template = document.createElement("template");
  template.innerHTML = svg;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    let value = node.nodeValue || "";
    for (const [token, label] of replacements) {
      value = value.split(token).join(label);
    }
    node.nodeValue = value;
    node = walker.nextNode();
  }
  return template.innerHTML;
}

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

function createPromptToken(rawToken: string) {
  const { token } = splitPromptToken(rawToken);
  const span = document.createElement("span");
  span.className = `prompt-token ${promptTokenKind(token)}`;
  span.setAttribute("aria-label", token);
  span.textContent = promptTokenLabel(token);
  return span;
}

function promptTokenPattern() {
  return /(^|\s)(\$"[^"]+"|\$'[^']+'|\$[A-Za-z][A-Za-z0-9_.:-]*|@[A-Za-z0-9_][A-Za-z0-9_.\\/-]*)/g;
}

function isSinglePromptToken(value: string) {
  return /^(\$"[^"]+"|\$'[^']+'|\$[A-Za-z][A-Za-z0-9_.:-]*|@[A-Za-z0-9_][A-Za-z0-9_.\\/-]*)$/.test(value.trim());
}

function replacePromptTokensInTextNode(node: Text) {
  const value = node.nodeValue || "";
  const pattern = promptTokenPattern();
  if (!pattern.test(value)) {
    return;
  }
  pattern.lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const leading = match[1] || "";
    const rawToken = match[2] || "";
    const tokenStart = (match.index || 0) + leading.length;
    const before = value.slice(cursor, tokenStart);
    if (before) {
      fragment.append(document.createTextNode(before));
    }
    const { token, trailing } = splitPromptToken(rawToken);
    fragment.append(createPromptToken(token));
    if (trailing) {
      fragment.append(document.createTextNode(trailing));
    }
    cursor = tokenStart + rawToken.length;
  }
  const after = value.slice(cursor);
  if (after) {
    fragment.append(document.createTextNode(after));
  }
  node.replaceWith(fragment);
}

function enhancePromptTokens(root: HTMLElement | null) {
  if (!root) {
    return;
  }

  root.querySelectorAll("code").forEach((code) => {
    if (code.closest("pre")) {
      return;
    }
    const value = code.textContent || "";
    if (isSinglePromptToken(value)) {
      const { token, trailing } = splitPromptToken(value.trim());
      const fragment = document.createDocumentFragment();
      fragment.append(createPromptToken(token));
      if (trailing) {
        fragment.append(document.createTextNode(trailing));
      }
      code.replaceWith(fragment);
    }
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("pre, code, .prompt-token, .code-copy, .mermaid-chart, .html-render-preview, .assistant-workflow-diagram")) {
        return NodeFilter.FILTER_REJECT;
      }
      return promptTokenPattern().test(node.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }
  textNodes.forEach(replacePromptTokensInTextNode);
}

function enhanceRenderedPromptTokenHtml(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  enhancePromptTokens(container);
  return container.innerHTML;
}

function normalizeHighlightLanguage(language: string) {
  const value = String(language || "").toLowerCase();
  if (value === "py") return "python";
  if (value === "js" || value === "jsx") return "javascript";
  if (value === "ts" || value === "tsx") return "typescript";
  if (value === "ps1" || value === "powershell") return "powershell";
  if (value === "sh" || value === "shell") return "bash";
  return value;
}

function inferCodeLanguage(source: string) {
  const text = String(source || "");
  if (/\b(print|input)\s*\(/.test(text) || /^\s*(def|class|if|elif|else|for|while|try|except|with)\b.*:/m.test(text)) {
    return "python";
  }
  return "";
}

function highlightedCodeHtml(source: string, language: string) {
  const normalized = normalizeHighlightLanguage(language) || inferCodeLanguage(source);
  if (normalized && hljs.getLanguage(normalized)) {
    return {
      html: hljs.highlight(source, { language: normalized, ignoreIllegals: true }).value,
      language: normalized,
    };
  }
  const highlighted = hljs.highlightAuto(source);
  return {
    html: highlighted.value || escapeHtml(source),
    language: normalizeHighlightLanguage(highlighted.language || ""),
  };
}

function codeCopyButtonHtml() {
  return '<button type="button" class="code-copy" aria-label="Copy code" data-tooltip="코드 복사"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span></button>';
}

function enhanceRenderedCodeBlockHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const pre of template.content.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code || pre.querySelector(".code-copy")) {
      continue;
    }
    pre.classList.toggle("single-line-code", !code.textContent?.trimEnd().includes("\n"));
    const source = code.textContent || "";
    const highlighted = highlightedCodeHtml(source, codeBlockLanguage(code));
    code.innerHTML = highlighted.html;
    code.classList.add("hljs");
    if (highlighted.language) {
      code.classList.add(`language-${highlighted.language}`);
    }
    code.setAttribute("data-highlighted", "yes");
    pre.insertAdjacentHTML("beforeend", codeCopyButtonHtml());
  }
  return template.innerHTML;
}

function isLikelyStandaloneHtml(value: string) {
  const source = normalizeHtmlPreviewSource(value).trim().toLowerCase();
  return source.includes("<!doctype html")
    || source.includes("<html")
    || (source.includes("<script") && (source.includes("<canvas") || source.includes("<svg") || source.includes("<div")));
}

function htmlPreviewPlaceholder(id: string) {
  return `<div class="html-render-preview-placeholder" data-html-preview-id="${escapeHtml(id)}"></div>`;
}

function mermaidPreviewPlaceholder(id: string, source: string) {
  return `<div class="mermaid-render-placeholder" data-mermaid-preview-id="${escapeHtml(id)}" data-mermaid-source-encoded="${escapeHtml(encodeURIComponent(source))}"></div>`;
}

function decodeMermaidPlaceholderSource(value: string) {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function isMermaidFenceInfo(info: string) {
  return info === "mermaid" || info === "mmd";
}

function pendingHtmlPreviewPlaceholder(source: string) {
  const label = source.trim() ? "차트 미리보기 준비 중" : "차트 미리보기 대기 중";
  return [
    '<div class="workflow-output-preview html-stream-preview" data-html-preview-pending="true">',
    '<div class="workflow-output-title">',
    `<span class="workflow-output-label">${label}</span>`,
    `<span class="workflow-output-line-count">${Math.max(0, source.length).toLocaleString()}자</span>`,
    "</div>",
    '<div class="workflow-output-body html-preview-pending-body">',
    '<span class="html-preview-spinner" aria-hidden="true"></span>',
    "<span>소스를 받은 뒤 바로 렌더링합니다.</span>",
    "</div>",
    "</div>",
  ].join("");
}

function replaceHtmlFencesWithPreviewPlaceholders(markdown: string) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const open = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const info = String(open[2] || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const isHtml = info === "html" || info === "htm";
    if (!isHtml) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const marker = open[1][0];
    const length = open[1].length;
    const content: string[] = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const close = lines[cursor].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === marker && close[1].length >= length) {
        closed = true;
        break;
      }
      content.push(lines[cursor]);
      cursor += 1;
    }

    const htmlSource = normalizeHtmlPreviewSource(content.join("\n"));
    if (closed && htmlSource.trim()) {
      const id = `html-preview-${htmlPreviewSourceCache.size + 1}-${Math.random().toString(16).slice(2)}`;
      htmlPreviewSourceCache.set(id, htmlSource);
      output.push(htmlPreviewPlaceholder(id));
      index = cursor + 1;
      continue;
    }

    output.push(pendingHtmlPreviewPlaceholder(htmlSource));
    index = closed ? cursor + 1 : lines.length;
  }

  return output.join("\n");
}

function replaceMermaidFencesWithPreviewPlaceholders(markdown: string) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const open = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const info = String(open[2] || "").trim().toLowerCase().split(/\s+/)[0] || "";
    if (!isMermaidFenceInfo(info)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const marker = open[1][0];
    const length = open[1].length;
    const content: string[] = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const close = lines[cursor].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === marker && close[1].length >= length) {
        closed = true;
        break;
      }
      content.push(lines[cursor]);
      cursor += 1;
    }

    const mermaidSource = normalizeHtmlPreviewSource(content.join("\n"));
    if (closed && mermaidSource.trim()) {
      const id = `mermaid-preview-${mermaidSourceCache.size + 1}-${Math.random().toString(16).slice(2)}`;
      mermaidSourceCache.set(id, mermaidSource);
      output.push(mermaidPreviewPlaceholder(id, mermaidSource));
      index = cursor + 1;
      continue;
    }

    output.push(lines[index]);
    output.push(...content);
    index = closed ? cursor + 1 : lines.length;
  }

  return output.join("\n");
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return [];
  }
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some(Boolean);
}

function isMarkdownTableDivider(line: string) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isPossibleStreamingTableContinuation(line: string) {
  const trimmed = String(line || "").trim();
  return Boolean(trimmed && trimmed.includes("|"));
}

function deferTrailingMarkdownTable(markdown: string) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  let tableStart = -1;
  let pendingEnd = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (!isMarkdownTableRow(lines[index - 1]) || !isMarkdownTableDivider(lines[index])) {
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) {
      cursor += 1;
    }
    tableStart = index - 1;
    pendingEnd = cursor;
    if (cursor < lines.length && isPossibleStreamingTableContinuation(lines[cursor])) {
      pendingEnd = lines.length;
    }
  }

  const trailingLines = pendingEnd >= 0 ? lines.slice(pendingEnd) : [];
  const hasOnlyTrailingBlankLines = trailingLines.every((line) => line.trim() === "");
  if (tableStart < 0 || (pendingEnd < lines.length && !hasOnlyTrailingBlankLines)) {
    return source;
  }

  const before = lines.slice(0, tableStart).join("\n").trimEnd();
  const pendingTable = lines.slice(tableStart, pendingEnd).join("\n").trimEnd();
  if (!pendingTable) {
    return source;
  }
  return [
    before,
    `<pre class="markdown-pending-table">${escapeHtml(pendingTable)}</pre>`,
  ].filter(Boolean).join("\n\n");
}

function isHtmlPreviewCodeBlock(code: Element) {
  const language = codeBlockLanguage(code);
  return language === "html" || language === "htm" || (!language && isLikelyStandaloneHtml(code.textContent || ""));
}

function isMermaidCodeBlock(code: Element) {
  return isMermaidFenceInfo(codeBlockLanguage(code));
}

type WorkflowDiagramNode = {
  id: string;
  label: string;
  title: string;
  order: number;
};

type WorkflowDiagramStage = {
  nodes: WorkflowDiagramNode[];
};

function workflowNodeId(label: string) {
  return String(label || "").trim().replace(/\s+/g, " ");
}

function hasWorkflowConnector(value: string) {
  return /->|=>|→|↔|├>|└>|[┐┘]/.test(value);
}

function cleanWorkflowTitle(value: string) {
  return String(value || "")
    .replace(/^[\s.:：\-–—|>→↔=┐┘├└]+/, "")
    .replace(/\s*(?:->|=>|→|↔|[┐┘├└|>]).*$/, "")
    .trim();
}

function parseWorkflowDiagram(source: string) {
  const text = String(source || "").replace(/\r\n/g, "\n");
  const nodesById = new Map<string, WorkflowDiagramNode>();
  const nodesByLabel = new Map<string, WorkflowDiagramNode[]>();
  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  let order = 0;

  function ensureNode(label: string, title = "") {
    const labelKey = workflowNodeId(label);
    const cleanTitle = cleanWorkflowTitle(title);
    if (!labelKey) return null;
    const labeledNodes = nodesByLabel.get(labelKey) || [];
    if (cleanTitle) {
      const sameTitle = labeledNodes.find((node) => node.title === cleanTitle);
      if (sameTitle) {
        return sameTitle;
      }
    } else if (labeledNodes.length) {
      return labeledNodes[0];
    }
    const id = labeledNodes.length ? `${labelKey}#${labeledNodes.length + 1}` : labelKey;
    const node = { id, label: labelKey, title: cleanTitle, order: order++ };
    nodesById.set(id, node);
    nodesByLabel.set(labelKey, [...labeledNodes, node]);
    edges.set(id, new Set());
    incoming.set(id, new Set());
    return node;
  }

  function addEdge(from: string, to: string) {
    if (!from || !to || from === to) return;
    edges.get(from)?.add(to);
    incoming.get(to)?.add(from);
  }

  let currentSources: WorkflowDiagramNode[] = [];
  let branchLabel = "";
  let branchNodes: WorkflowDiagramNode[] = [];

  function flushBranchSources() {
    if (branchNodes.length) {
      currentSources = branchNodes;
      branchNodes = [];
      branchLabel = "";
    }
  }

  for (const line of text.split("\n")) {
    const matches = [...line.matchAll(/\[([^\]]+)\]/g)];
    if (!matches.length) {
      continue;
    }
    const parsedNodes = matches.map((match) => {
      const label = match[1].trim();
      const start = match.index || 0;
      const titleStart = start + match[0].length;
      const nextStart = matches[matches.indexOf(match) + 1]?.index ?? line.length;
      return {
        node: ensureNode(label, line.slice(titleStart, nextStart)),
        start,
        titleStart,
      };
    }).filter((item): item is { node: WorkflowDiagramNode; start: number; titleStart: number } => Boolean(item.node));
    if (!parsedNodes.length) {
      continue;
    }
    const leadingConnector = hasWorkflowConnector(line.slice(0, parsedNodes[0].start));
    if (leadingConnector && parsedNodes.length === 1) {
      const node = parsedNodes[0].node;
      if (branchLabel && branchLabel !== node.label) {
        flushBranchSources();
      }
      currentSources.forEach((source) => addEdge(source.id, node.id));
      if (!branchLabel) {
        branchLabel = node.label;
      }
      branchNodes.push(node);
      continue;
    }

    flushBranchSources();
    if (leadingConnector) {
      currentSources.forEach((source) => addEdge(source.id, parsedNodes[0].node.id));
    }
    let previousNode: WorkflowDiagramNode | null = null;
    let previousEnd = 0;
    parsedNodes.forEach(({ node, start, titleStart }) => {
      if (node && previousNode && hasWorkflowConnector(line.slice(previousEnd, start))) {
        addEdge(previousNode.id, node.id);
      }
      previousNode = node;
      previousEnd = titleStart;
    });
    currentSources = [parsedNodes[parsedNodes.length - 1].node];
  }
  flushBranchSources();

  if (!nodesById.size) {
    for (const line of text.split("\n")) {
      const match = line.trim().match(/^(?:[-*]\s*)?(?:parallel|merge|then|stage|wave)?\s*:?\s*([가-힣A-Za-z]+(?:\s*\d+)?)\s*[:：-]\s*(.+)$/i);
      if (!match) continue;
      const label = match[1].trim();
      const title = match[2].trim();
      ensureNode(label, title);
    }
  }

  const depthCache = new Map<string, number>();
  function depthFor(id: string, visiting = new Set<string>()): number {
    if (depthCache.has(id)) return depthCache.get(id) || 0;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = [...(incoming.get(id) || [])];
    const depth = parents.length ? Math.max(...parents.map((parent) => depthFor(parent, visiting) + 1)) : 0;
    visiting.delete(id);
    depthCache.set(id, depth);
    return depth;
  }

  const stages: WorkflowDiagramStage[] = [];
  for (const node of nodesById.values()) {
    const depth = depthFor(node.id);
    if (!stages[depth]) {
      stages[depth] = { nodes: [] };
    }
    stages[depth].nodes.push(node);
  }
  return stages
    .filter((stage) => stage?.nodes.length)
    .map((stage) => ({ nodes: [...stage.nodes].sort((a, b) => a.order - b.order) }));
}

function looksLikeWorkflowDiagram(source: string) {
  const text = String(source || "");
  const nodeCount = (text.match(/\[[^\]]+\]/g) || []).length;
  return nodeCount >= 2 && (/[→↔]|->|=>|├|┐|┘/.test(text) || nodeCount >= 3);
}

function createWorkflowDiagram(source: string) {
  const stages = parseWorkflowDiagram(source);
  if (!stages.length) {
    return null;
  }
  const diagram = document.createElement("section");
  diagram.className = "assistant-workflow-diagram";
  if (stages.length > 4) {
    diagram.classList.add("many-stages");
  }
  diagram.setAttribute("aria-label", "워크플로우 다이어그램");
  const header = document.createElement("div");
  header.className = "assistant-workflow-diagram-header";
  const title = document.createElement("strong");
  title.textContent = "워크플로우";
  const meta = document.createElement("span");
  meta.textContent = `${stages.length}개 레이어`;
  header.append(title, meta);
  diagram.append(header);

  const rail = document.createElement("div");
  rail.className = "assistant-workflow-rail";
  stages.forEach((stage, index) => {
    const column = document.createElement("div");
    column.className = "assistant-workflow-stage";
    const stageTitle = document.createElement("div");
    stageTitle.className = "assistant-workflow-stage-title";
    const step = document.createElement("span");
    step.textContent = String(index + 1);
    const label = document.createElement("strong");
    label.textContent = `${index + 1}단계`;
    stageTitle.append(step, label);
    column.append(stageTitle);
    const list = document.createElement("div");
    list.className = "assistant-workflow-node-list";
    stage.nodes.forEach((node) => {
      const item = document.createElement("div");
      item.className = "assistant-workflow-node";
      const nodeLabel = document.createElement("strong");
      nodeLabel.textContent = node.label;
      item.append(nodeLabel);
      if (node.title) {
        const nodeTitle = document.createElement("span");
        nodeTitle.textContent = node.title;
        item.append(nodeTitle);
      }
      list.append(item);
    });
    column.append(list);
    rail.append(column);
    if (index < stages.length - 1) {
      const arrow = document.createElement("div");
      arrow.className = "assistant-workflow-arrow";
      arrow.textContent = "→";
      rail.append(arrow);
    }
  });
  diagram.append(rail);
  return diagram;
}

function workflowDiagramForPre(pre: Element) {
  const code = pre.querySelector("code");
  if (!code) return null;
  const source = code.textContent || "";
  const language = codeBlockLanguage(code);
  if (language !== "workflow" && !looksLikeWorkflowDiagram(source)) {
    return null;
  }
  return createWorkflowDiagram(source);
}

function enhanceRenderedWorkflowDiagramHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("pre").forEach((pre) => {
    const diagram = workflowDiagramForPre(pre);
    if (diagram) {
      pre.replaceWith(diagram);
    }
  });
  return template.innerHTML;
}

function enhanceWorkflowDiagrams(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll("pre").forEach((pre) => {
    const diagram = workflowDiagramForPre(pre);
    if (diagram) {
      pre.replaceWith(diagram);
    }
  });
}

function htmlPreviewHeight(value: unknown) {
  const minHeight = 220;
  const maxHeight = Math.min(720, Math.max(420, Math.round(window.innerHeight * 0.72)));
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.min(maxHeight, Math.max(minHeight, height + 12)) : minHeight;
}

function htmlPreviewToken() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadHtmlPreview(frame: HTMLIFrameElement, errorNode: HTMLDivElement, source: string) {
  try {
    const cacheKey = normalizeHtmlPreviewSource(source);
    let previewUrl = htmlPreviewUrlCache.get(cacheKey);
    if (!previewUrl) {
      const response = await fetch("/api/html-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: source }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Could not create HTML preview");
      }
      previewUrl = String(payload.url);
      if (htmlPreviewUrlCache.size >= 24 && !htmlPreviewUrlCache.has(cacheKey)) {
        const oldestKey = htmlPreviewUrlCache.keys().next().value;
        if (typeof oldestKey === "string") {
          htmlPreviewUrlCache.delete(oldestKey);
        }
      }
      htmlPreviewUrlCache.set(cacheKey, previewUrl);
    }
    if (!frame.isConnected) {
      return;
    }
    const token = htmlPreviewToken();
    const onMessage = (event: MessageEvent) => {
      if (!frame.isConnected) {
        window.removeEventListener("message", onMessage);
        return;
      }
      if (event.data?.type === "myharness-html-preview-size" && event.data?.token === token) {
        frame.style.height = `${htmlPreviewHeight(event.data.height)}px`;
      }
    };
    window.addEventListener("message", onMessage);
    frame.name = token;
    frame.src = `${previewUrl}?ohPreviewToken=${encodeURIComponent(token)}`;
  } catch {
    if (!frame.isConnected) {
      return;
    }
    frame.remove();
    errorNode.hidden = false;
  }
}

function createHtmlPreview(source: string) {
  const preview = document.createElement("div");
  preview.className = "html-render-preview";
  const frame = document.createElement("iframe");
  frame.className = "html-render-frame";
  frame.title = "HTML preview";
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-scripts");
  const error = document.createElement("div");
  error.className = "html-render-error";
  error.hidden = true;
  error.textContent = "HTML 미리보기를 불러오지 못했습니다.";
  preview.append(frame, error);
  void loadHtmlPreview(frame, error, source);
  return preview;
}

function mermaidCssVariable(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function configureMermaid() {
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      background: "transparent",
      primaryColor: mermaidCssVariable("--panel-raised", "#ffffff"),
      primaryTextColor: mermaidCssVariable("--ink", "#33322f"),
      primaryBorderColor: mermaidCssVariable("--line-strong", "#c9c5bd"),
      secondaryColor: mermaidCssVariable("--accent-soft", "#f4ebe6"),
      secondaryTextColor: mermaidCssVariable("--ink", "#33322f"),
      tertiaryColor: mermaidCssVariable("--sidebar-hover", "#eeeeeb"),
      tertiaryTextColor: mermaidCssVariable("--ink", "#33322f"),
      lineColor: mermaidCssVariable("--muted", "#74716b"),
      textColor: mermaidCssVariable("--ink", "#33322f"),
      noteBkgColor: mermaidCssVariable("--warning-soft", "#f8ecd5"),
      noteTextColor: mermaidCssVariable("--ink", "#33322f"),
      actorBkg: mermaidCssVariable("--panel-raised", "#ffffff"),
      actorBorder: mermaidCssVariable("--line-strong", "#c9c5bd"),
      actorTextColor: mermaidCssVariable("--ink", "#33322f"),
      clusterBkg: mermaidCssVariable("--panel", "#ffffff"),
      clusterBorder: mermaidCssVariable("--line", "#e1dfda"),
    },
    flowchart: {
      htmlLabels: false,
    },
  } as const;
  return config;
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  const module = await mermaidModulePromise;
  const mermaid = module.default;
  mermaid.initialize({
    ...configureMermaid(),
  });
  return mermaid;
}

async function renderMermaidSvg(source: string) {
  const mermaid = await loadMermaid();
  const id = `mermaid-chart-${++mermaidRenderId}`;
  const normalized = normalizeMermaidSource(source);
  const result = await mermaid.render(id, normalized.source);
  return {
    svg: applyMermaidLabelReplacements(sanitizeRenderedHtml(result.svg), normalized.labelReplacements),
    bindFunctions: result.bindFunctions,
  };
}

function mermaidZoomButtonIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M8 3H3v5"></path>
      <path d="M3 3l7 7"></path>
      <path d="M16 3h5v5"></path>
      <path d="m21 3-7 7"></path>
      <path d="M8 21H3v-5"></path>
      <path d="m3 21 7-7"></path>
      <path d="M16 21h5v-5"></path>
      <path d="m21 21-7-7"></path>
    </svg>
  `;
}

function closeMermaidZoomViewer() {
  activeMermaidZoomViewer?.dispatchEvent(new CustomEvent("mermaid-viewer-close"));
}

const mermaidZoomControlIcons = {
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
  reset: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7v5h5"></path><path d="M5.7 12A7 7 0 0 1 17 6.5"></path><path d="M18.3 12A7 7 0 0 1 7 17.5"></path></svg>',
  zoomIn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
  zoomOut: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"></path></svg>',
};

type MermaidZoomControlIcon = keyof typeof mermaidZoomControlIcons;

function createMermaidZoomControl(label: string, tooltip: string, icon: MermaidZoomControlIcon, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-zoom-control";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = tooltip;
  button.innerHTML = mermaidZoomControlIcons[icon];
  button.addEventListener("click", onClick);
  return button;
}

function openMermaidZoomViewer(source: string) {
  if (!source.trim()) {
    return;
  }
  closeMermaidZoomViewer();

  const backdrop = document.createElement("div");
  backdrop.className = "mermaid-zoom-backdrop";
  backdrop.setAttribute("role", "presentation");

  const dialog = document.createElement("div");
  dialog.className = "mermaid-zoom-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Mermaid 다이어그램 확대 보기");

  const title = document.createElement("strong");
  title.className = "mermaid-zoom-title";
  title.textContent = "Mermaid";

  const zoomValue = document.createElement("span");
  zoomValue.className = "mermaid-zoom-value";
  zoomValue.textContent = "100%";

  const controls = document.createElement("div");
  controls.className = "mermaid-zoom-controls";

  const viewport = document.createElement("div");
  viewport.className = "mermaid-zoom-viewport";

  const canvas = document.createElement("div");
  canvas.className = "mermaid-zoom-canvas mermaid-loading";
  canvas.textContent = "다이어그램 렌더링 중...";
  viewport.append(canvas);

  let zoom = 1;
  let fitScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let dragPointerId = -1;
  let lastX = 0;
  let lastY = 0;

  const updateTransform = () => {
    canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${fitScale * zoom})`;
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };

  const canvasSize = () => {
    const svg = canvas.querySelector<SVGSVGElement>("svg");
    const viewBoxParts = (svg?.getAttribute("viewBox") || "").split(/[\s,]+/).map((part) => Number(part));
    const attrNumber = (name: "width" | "height") => {
      const value = Number.parseFloat(svg?.getAttribute(name) || "");
      return Number.isFinite(value) ? value : 0;
    };
    return {
      width: (viewBoxParts.length >= 4 && Number.isFinite(viewBoxParts[2]) ? viewBoxParts[2] : attrNumber("width")) || canvas.scrollWidth || 1,
      height: (viewBoxParts.length >= 4 && Number.isFinite(viewBoxParts[3]) ? viewBoxParts[3] : attrNumber("height")) || canvas.scrollHeight || 1,
    };
  };

  const fitView = () => {
    const rect = viewport.getBoundingClientRect();
    const size = canvasSize();
    const padding = 56;
    const availableWidth = Math.max(1, rect.width - padding);
    const availableHeight = Math.max(1, rect.height - padding);
    fitScale = Math.min(4, Math.max(0.05, Math.min(availableWidth / size.width, availableHeight / size.height)));
    zoom = 1;
    offsetX = (rect.width - size.width * fitScale) / 2;
    offsetY = (rect.height - size.height * fitScale) / 2;
    updateTransform();
  };

  const zoomAt = (nextZoom: number, clientX?: number, clientY?: number) => {
    const clampedZoom = Math.min(4, Math.max(0.25, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const centerX = typeof clientX === "number" ? clientX - rect.left : rect.width / 2;
    const centerY = typeof clientY === "number" ? clientY - rect.top : rect.height / 2;
    const currentScale = fitScale * zoom;
    const nextScale = fitScale * clampedZoom;
    const diagramX = (centerX - offsetX) / currentScale;
    const diagramY = (centerY - offsetY) / currentScale;
    zoom = clampedZoom;
    offsetX = centerX - diagramX * nextScale;
    offsetY = centerY - diagramY * nextScale;
    updateTransform();
  };

  const resetView = fitView;

  const closeButton = createMermaidZoomControl("닫기", "닫기", "close", closeMermaidZoomViewer);
  closeButton.classList.add("mermaid-zoom-close");
  controls.append(
    createMermaidZoomControl("축소", "축소", "zoomOut", () => zoomAt(zoom / 1.2)),
    zoomValue,
    createMermaidZoomControl("확대", "확대", "zoomIn", () => zoomAt(zoom * 1.2)),
    createMermaidZoomControl("이동 초기화", "Reset", "reset", resetView),
    closeButton,
  );

  const header = document.createElement("div");
  header.className = "mermaid-zoom-header";
  header.append(title, controls);
  dialog.append(header, viewport);
  backdrop.append(dialog);

  const onClose = () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    viewport.removeEventListener("wheel", onWheel);
    backdrop.remove();
    if (activeMermaidZoomViewer === backdrop) {
      activeMermaidZoomViewer = null;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeMermaidZoomViewer();
    }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomAt(zoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX, event.clientY);
  };
  const pointerEventId = (event: PointerEvent) => Number.isFinite(event.pointerId) ? event.pointerId : 1;
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || pointerEventId(event) !== dragPointerId) {
      return;
    }
    event.preventDefault();
    const clientX = Number.isFinite(event.clientX) ? event.clientX : lastX;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : lastY;
    offsetX += clientX - lastX;
    offsetY += clientY - lastY;
    lastX = clientX;
    lastY = clientY;
    updateTransform();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (pointerEventId(event) !== dragPointerId) {
      return;
    }
    dragging = false;
    dragPointerId = -1;
    viewport.classList.remove("dragging");
  };

  backdrop.addEventListener("mermaid-viewer-close", onClose, { once: true });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeMermaidZoomViewer();
    }
  });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", (event) => {
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    dragging = true;
    dragPointerId = pointerEventId(event);
    lastX = Number.isFinite(event.clientX) ? event.clientX : 0;
    lastY = Number.isFinite(event.clientY) ? event.clientY : 0;
    viewport.classList.add("dragging");
    viewport.setPointerCapture?.(event.pointerId);
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  activeMermaidZoomViewer = backdrop;
  document.body.append(backdrop);
  closeButton.focus();
  updateTransform();

  void renderMermaidSvg(source)
    .then((result) => {
      if (!canvas.isConnected) {
        return;
      }
      canvas.classList.remove("mermaid-loading");
      canvas.innerHTML = result.svg;
      fitMermaidZoomSvg(canvas);
      result.bindFunctions?.(canvas);
      fitView();
    })
    .catch(() => {
      if (!canvas.isConnected) {
        return;
      }
      canvas.classList.remove("mermaid-loading");
      canvas.classList.add("mermaid-error");
      canvas.textContent = "Mermaid 다이어그램을 렌더링하지 못했습니다.";
    });
}

function ensureMermaidZoomButton(chart: HTMLDivElement, source: string) {
  if (chart.querySelector(".mermaid-expand-button") || !source.trim()) {
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-expand-button";
  button.setAttribute("aria-label", "Mermaid 다이어그램 크게 보기");
  button.dataset.tooltip = "크게 보기";
  button.innerHTML = mermaidZoomButtonIcon();
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMermaidZoomViewer(source);
  });
  chart.prepend(button);
}

function fitMermaidZoomSvg(canvas: HTMLElement) {
  const svg = canvas.querySelector<SVGSVGElement>("svg");
  if (!svg) {
    return;
  }
  const viewBox = svg.getAttribute("viewBox") || "";
  const parts = viewBox.split(/[\s,]+/).map((part) => Number(part));
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const viewBoxWidth = parts.length >= 4 && Number.isFinite(parts[2]) ? parts[2] : width;
  const viewBoxHeight = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : height;
  if (Number.isFinite(viewBoxWidth) && viewBoxWidth > 0) {
    svg.style.width = `${Math.ceil(viewBoxWidth)}px`;
  }
  if (Number.isFinite(viewBoxHeight) && viewBoxHeight > 0) {
    svg.style.height = `${Math.ceil(viewBoxHeight)}px`;
  }
}

async function renderMermaidChart(chart: HTMLDivElement, source: string) {
  try {
    const result = await renderMermaidSvg(source);
    if (!chart.isConnected) {
      return;
    }
    chart.classList.remove("mermaid-loading");
    chart.innerHTML = result.svg;
    result.bindFunctions?.(chart);
    ensureMermaidZoomButton(chart, source);
  } catch {
    if (!chart.isConnected) {
      return;
    }
    chart.classList.remove("mermaid-loading");
    chart.classList.add("mermaid-error");
    chart.textContent = "Mermaid 다이어그램을 렌더링하지 못했습니다.";
  }
}

function createMermaidChart(source: string) {
  const chart = document.createElement("div");
  chart.className = "mermaid-chart mermaid-loading";
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", "Mermaid diagram");
  const status = document.createElement("div");
  status.className = "mermaid-chart-status";
  status.textContent = "다이어그램 렌더링 중...";
  chart.append(status);
  void renderMermaidChart(chart, source);
  return chart;
}

function replaceMermaidPreviewPlaceholders(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll<HTMLElement>("[data-mermaid-preview-id]").forEach((placeholder) => {
    const id = placeholder.dataset.mermaidPreviewId || "";
    const encodedSource = placeholder.dataset.mermaidSourceEncoded || "";
    const source = mermaidSourceCache.get(id) || decodeMermaidPlaceholderSource(encodedSource);
    if (!source.trim()) {
      placeholder.remove();
      return;
    }
    placeholder.replaceWith(createMermaidChart(source));
    mermaidSourceCache.delete(id);
  });
}

function enhanceMarkdownRoot(root: HTMLElement | null, revealFrom: number | null) {
  replaceMermaidPreviewPlaceholders(root);
  replaceHtmlPreviewPlaceholders(root);
  enhanceWorkflowDiagrams(root);
  enhanceMermaidCharts(root);
  enhanceHtmlPreviews(root);
  enhanceCodeBlocks(root);
  enhancePromptTokens(root);
  revealRenderedText(root, revealFrom);
}

function markdownRootForNode(node: Node | null) {
  const HtmlElement = globalThis.window?.HTMLElement;
  const element = HtmlElement && node instanceof HtmlElement ? node : node?.parentElement;
  if (!element) {
    return null;
  }
  return element.classList.contains("markdown-body")
    ? element
    : element.closest<HTMLElement>(".markdown-body");
}

function enhanceMarkdownRootsFromMutations(mutations: MutationRecord[]) {
  const roots = new Set<HTMLElement>();
  for (const mutation of mutations) {
    const targetRoot = markdownRootForNode(mutation.target);
    if (targetRoot) {
      roots.add(targetRoot);
    }
    mutation.addedNodes.forEach((node) => {
      const root = markdownRootForNode(node);
      if (root) {
        roots.add(root);
      }
    });
  }
  roots.forEach((root) => enhanceMarkdownRoot(root, null));
}

function ensureMarkdownEnhancementObserver() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || markdownEnhancementObserver) {
    return;
  }
  const start = () => {
    if (!document.body || markdownEnhancementObserver) {
      return;
    }
    markdownEnhancementObserver = new MutationObserver(enhanceMarkdownRootsFromMutations);
    markdownEnhancementObserver.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll<HTMLElement>(".markdown-body").forEach((root) => enhanceMarkdownRoot(root, null));
  };
  if (document.body) {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

function replaceHtmlPreviewPlaceholders(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll<HTMLElement>("[data-html-preview-id]").forEach((placeholder) => {
    const id = placeholder.dataset.htmlPreviewId || "";
    const source = htmlPreviewSourceCache.get(id) || "";
    if (!source.trim()) {
      placeholder.remove();
      return;
    }
    placeholder.replaceWith(createHtmlPreview(source));
    htmlPreviewSourceCache.delete(id);
  });
}

function enhanceHtmlPreviews(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code || !isHtmlPreviewCodeBlock(code)) {
      return;
    }
    const source = String(code.textContent || "");
    if (!source.trim()) {
      return;
    }
    pre.replaceWith(createHtmlPreview(source));
  });
}

function enhanceMermaidCharts(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code || !isMermaidCodeBlock(code)) {
      return;
    }
    const source = String(code.textContent || "");
    if (!source.trim()) {
      return;
    }
    pre.replaceWith(createMermaidChart(source));
  });
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) {
    throw new Error("Copy failed");
  }
}

function enhanceCodeBlocks(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy")) {
      return;
    }
    const code = pre.querySelector("code");
    if (!code) {
      return;
    }
    pre.classList.toggle("single-line-code", !code.textContent?.trimEnd().includes("\n"));
    if (!code.hasAttribute("data-highlighted")) {
      const highlighted = highlightedCodeHtml(code.textContent || "", codeBlockLanguage(code));
      code.innerHTML = highlighted.html;
      code.classList.add("hljs");
      if (highlighted.language) {
        code.classList.add(`language-${highlighted.language}`);
      }
      code.setAttribute("data-highlighted", "yes");
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code");
    button.dataset.tooltip = "코드 복사";
    button.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy</span>
    `;
    pre.append(button);
  });
}

async function handleCodeCopyClick(event: MouseEvent<HTMLDivElement>) {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".code-copy");
  if (!button) {
    return;
  }
  const pre = button.closest("pre");
  const code = pre?.querySelector("code");
  const label = button.querySelector("span");
  try {
    await copyTextToClipboard(code?.textContent || "");
    button.classList.add("copied");
    if (label) {
      label.textContent = "Copied";
    }
    window.setTimeout(() => {
      button.classList.remove("copied");
      if (label) {
        label.textContent = "Copy";
      }
    }, 1300);
  } catch {
    if (label) {
      label.textContent = "Failed";
    }
    window.setTimeout(() => {
      if (label) {
        label.textContent = "Copy";
      }
    }, 1300);
  }
}

function revealRenderedText(root: HTMLElement | null, revealFrom: number | null) {
  if (!root || revealFrom === null || revealFrom < 0) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest(".code-copy, .mermaid-chart, .html-render-preview, .assistant-workflow-diagram")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const replacements: Array<{ node: Text; chars: string[]; localStart: number }> = [];
  let cursor = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const chars = Array.from(node.nodeValue || "");
    const nextCursor = cursor + chars.length;
    if (nextCursor > revealFrom) {
      replacements.push({ node, chars, localStart: Math.max(0, revealFrom - cursor) });
    }
    cursor = nextCursor;
  }

  for (const replacement of replacements) {
    const fragment = document.createDocumentFragment();
    const before = replacement.chars.slice(0, replacement.localStart).join("");
    const revealText = replacement.chars.slice(replacement.localStart).join("");
    if (before) {
      fragment.append(document.createTextNode(before));
    }
    if (revealText) {
      const span = document.createElement("span");
      span.className = "stream-reveal-sentence";
      span.textContent = revealText;
      fragment.append(span);
    }
    replacement.node.replaceWith(fragment);
  }
}

export function MarkdownMessage({
  text,
  revealFrom = null,
  deferIncompleteTables = false,
}: {
  text: string;
  revealFrom?: number | null;
  deferIncompleteTables?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => {
    const tableSafeText = deferIncompleteTables ? deferTrailingMarkdownTable(text || "") : text || "";
    const mermaidMarkdown = replaceMermaidFencesWithPreviewPlaceholders(tableSafeText);
    const previewMarkdown = replaceHtmlFencesWithPreviewPlaceholders(mermaidMarkdown);
    const rendered = marked.parse(previewMarkdown, { async: false }) as string;
    return enhanceRenderedCodeBlockHtml(enhanceRenderedWorkflowDiagramHtml(enhanceRenderedPromptTokenHtml(sanitizeRenderedHtml(rendered))));
  }, [deferIncompleteTables, text]);

  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    if (!node) {
      return;
    }
    ensureMarkdownEnhancementObserver();
    enhanceMarkdownRoot(node, revealFrom);
    window.requestAnimationFrame(() => enhanceMarkdownRoot(node, revealFrom));
  }, [html, revealFrom]);

  useLayoutEffect(() => {
    ensureMarkdownEnhancementObserver();
    enhanceMarkdownRoot(ref.current, revealFrom);
    const frame = window.requestAnimationFrame(() => enhanceMarkdownRoot(ref.current, revealFrom));
    return () => window.cancelAnimationFrame(frame);
  }, [html, revealFrom]);

  return (
    <div
      ref={setRootRef}
      className="markdown-body react-markdown"
      onClick={(event) => void handleCodeCopyClick(event)}
      dangerouslySetInnerHTML={{ __html: html || "<p></p>" }}
    />
  );
}
