import type { WorkflowEvent } from "../types/ui";

// Explicit display categories: do not infer intent from arbitrary MCP names or shell text.
const toolCategories: Record<string, string> = {
  web_search: "검색", grep: "검색", glob: "검색",
  tool_search: "검색", conversation_history_search: "검색",
  web_fetch: "페이지 확인",
  read_file: "파일 확인",
  write_file: "파일 작성", edit_file: "파일 수정",
  "mcp__national-assembly__assembly_bill": "검색",
  "mcp__national-assembly__bill_detail": "자료 확인",
};

export function workflowActionSummary(events: WorkflowEvent[]): string {
  const calls = new Map<string, WorkflowEvent>();
  for (const event of events) {
    if (!event.toolName || event.role === "reasoning" || event.role === "purpose") continue;
    // Old records lack call IDs; their event IDs still identify individual calls.
    calls.set(event.toolCallId ? `call:${event.toolCallId}` : `event:${event.id}`, event);
  }
  if (!calls.size) return "처리 내역";
  const categories = new Map<string, number>();
  for (const event of calls.values()) {
    const category = toolCategories[event.toolName];
    if (!category) return `작업 ${calls.size}회`;
    categories.set(category, (categories.get(category) || 0) + 1);
  }
  if (categories.size > 2) return `작업 ${calls.size}회`;
  return [...categories].map(([label, count]) => `${label} ${count}회`).join(" · ");
}

export function workflowDisplayStatus(event: WorkflowEvent): WorkflowEvent["status"] | "empty" {
  if (event.status === "running") return event.status;
  const raw = (event.output || event.detail).trim();
  // Legacy web searches recorded a normal zero-result response as an error.
  if (event.toolName === "web_search" && raw === "검색 결과가 없습니다.") return "empty";
  if (event.status === "error") return event.status;
  try {
    const root = record(JSON.parse(raw));
    const data = root && (record(root.detail) || root);
    // Require an explicit empty collection AND count; missing data is not zero results.
    if (root && data && !root.error && !root.isError && !root.is_error
      && !data.error && !data.isError && !data.is_error
      && data.total === 0 && Array.isArray(data.items) && data.items.length === 0) return "empty";
  } catch { /* Unstructured outputs retain their recorded status. */ }
  return event.status;
}

export function workflowGroupStatus(events: WorkflowEvent[]): WorkflowEvent["status"] | "empty" {
  const actions = events.filter((event) => event.role !== "reasoning" && event.role !== "purpose")
    .map((event) => ({ status: workflowDisplayStatus(event) }));
  if (actions.some((event) => event.status === "running")) return "running";
  if (actions.length && actions.every((event) => event.status === "empty")) return "empty";
  if (actions.some((event) => event.status === "error")) {
    return actions.some((event) => event.status === "done" || event.status === "warning") ? "warning" : "error";
  }
  return actions.some((event) => event.status === "warning") ? "warning" : "done";
}

// Display metadata only; never use names to authorize or execute a tool.
const toolLabels: Record<string, string> = {
  web_search: "웹 검색",
  web_fetch: "웹 페이지 조회",
  "mcp__national-assembly__assembly_bill": "국회 법안 검색",
  "mcp__national-assembly__bill_detail": "법안 상세 조회",
};

export function toolDisplayName(name: string) {
  if (!name.startsWith("mcp__")) return toolLabels[name] || "";
  const [server, ...tool] = name.slice("mcp__".length).split("__");
  return ["mcp", server, tool.join("__")].filter(Boolean).join(" · ");
}

export function isKnownLookupTool(name: string) {
  return Object.hasOwn(toolLabels, name);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function toolResultSummary(event: WorkflowEvent): string | null {
  if (event.toolName !== "web_search" && workflowDisplayStatus(event) === "empty") return "이 조회 조건에서는 결과가 없습니다.";
  if (event.toolName === "web_search" || event.toolName === "web_fetch") {
    const input = event.toolInput || {};
    const provided = typeof input.progress_message === "string" ? input.progress_message.trim().slice(0, 220) : "";
    const search = event.toolName === "web_search";
    let target = typeof input.query === "string" ? input.query : "";
    if (!search && typeof input.url === "string") {
      try { target = new URL(input.url).hostname; } catch { target = ""; }
    }
    const fallback = search
      ? (target ? `‘${target.slice(0, 140)}’ 관련 자료 검색` : "관련 웹 자료 검색")
      : (target ? `${target} 페이지 내용 조회` : "웹 페이지 내용 조회");
    const raw = event.output || event.detail;
    const status = raw.trim() === "검색 결과가 없습니다."
      ? "이 검색 조건에서는 결과가 없습니다."
      : event.status === "error" ? "조회 실패 · 상세 실행 기록을 확인해 주세요."
      : event.status === "warning" ? "부분응답 · 상세 실행 기록을 확인해 주세요."
      : event.status === "done" ? "" : "진행 중";
    return [provided || fallback, status].filter(Boolean).join(" · ");
  }
  if (!event.toolName.startsWith("mcp__")) return null;
  if (event.status === "running") return "진행 중";
  if (event.status === "error") return "도구 작업에 실패했습니다. 상세 실행 기록에서 원인을 확인할 수 있습니다.";
  if (event.status === "warning") return "부분응답 · 상세 실행 기록을 확인해 주세요.";
  let value: unknown;
  try {
    value = JSON.parse(event.output || event.detail);
  } catch {
    return "응답 수신";
  }
  const root = record(value);
  if (!root) return "응답 수신";
  if (root.error || root.isError === true || root.is_error === true) {
    return "응답에 오류가 포함되어 있습니다. 상세 실행 기록을 확인해 주세요.";
  }
  const data = record(root.detail) || root;
  const items = Array.isArray(data.items) ? data.items : null;
  const total = typeof data.total === "number" && Number.isInteger(data.total) && data.total >= 0
    ? data.total : null;
  if (total === 0 && items?.length === 0) return "이 조회 조건에서는 결과가 없습니다.";
  const titleOf = (item: unknown) => {
    const row = record(item);
    const title = row && (row.billName || row["의안명"] || row.BILL_NM || row.title || row.name);
    return typeof title === "string" ? title.slice(0, 160) : "";
  };
  if (items) {
    const count = total !== null ? `조회 결과 ${total}건` : `응답에 포함된 항목 ${items.length}건`;
    const titles = items.slice(0, 3).map(titleOf).filter(Boolean);
    return [count, ...titles, items.length > 3 ? `외 ${items.length - 3}건은 상세 실행 기록에서 확인` : ""].filter(Boolean).join(" · ");
  }
  const title = titleOf(data);
  return title ? `상세 정보 확인 · ${title}` : "응답 수신";
}
