import type { WorkflowEvent } from "../types/ui";

// Display metadata only; never use names to authorize or execute a tool.
const toolLabels: Record<string, string> = {
  web_search: "웹 검색",
  web_fetch: "웹 페이지 조회",
  "mcp__national-assembly__assembly_bill": "국회 법안 검색",
  "mcp__national-assembly__bill_detail": "법안 상세 조회",
};

export function toolDisplayName(name: string) {
  return toolLabels[name] || (name.startsWith("mcp__") ? "외부 도구 작업" : "");
}

export function isKnownLookupTool(name: string) {
  return Object.hasOwn(toolLabels, name);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function toolResultSummary(event: WorkflowEvent): string | null {
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
      : event.status === "warning" ? "확인 필요 · 상세 실행 기록을 확인해 주세요."
      : event.status === "done" ? "조회 완료" : "진행 중";
    return `${provided || fallback} · ${status}`;
  }
  if (!event.toolName.startsWith("mcp__")) return null;
  if (event.status === "running") return "요청한 작업을 진행하고 있습니다.";
  if (event.status === "error") return "도구 작업에 실패했습니다. 상세 실행 기록에서 원인을 확인할 수 있습니다.";
  if (event.status === "warning") return "작업 결과를 확인해야 합니다. 상세 실행 기록을 확인해 주세요.";
  let value: unknown;
  try {
    value = JSON.parse(event.output || event.detail);
  } catch {
    return "응답을 받았습니다. 상세 실행 기록에서 내용을 확인할 수 있습니다.";
  }
  const root = record(value);
  if (!root) return "응답을 받았습니다. 상세 실행 기록에서 내용을 확인할 수 있습니다.";
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
  return title ? `상세 정보 확인 · ${title}` : "응답을 받았습니다. 상세 실행 기록에서 내용을 확인할 수 있습니다.";
}
