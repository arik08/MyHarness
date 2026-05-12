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

export function normalizeMermaidSource(source: string) {
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
