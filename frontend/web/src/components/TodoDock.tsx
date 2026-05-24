import { useMemo } from "react";
import { useAppState } from "../state/app-state";
import type { AppState, WorkflowEvent } from "../types/ui";

type TodoItem = {
  label: string;
  done: boolean;
};

function parseTodoMarkdown(markdown: string): TodoItem[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (!match) return null;
      return {
        done: match[1].toLowerCase() === "x",
        label: match[2].trim(),
      };
    })
    .filter((item): item is TodoItem => Boolean(item));
}

type TodoDockProps = {
  variant?: "dock" | "composerButton";
};

const todoActivityGenericDetails = new Set([
  "준비됨",
  "요청 확인",
  "사용자 요청을 확인했습니다.",
  "필요한 맥락과 진행 방향을 정리합니다.",
  "진행 방향을 정했습니다.",
  "필요한 자료와 맥락을 확인하고 있습니다.",
  "필요한 정보를 확인했습니다.",
  "도구 결과를 읽고 다음 작업이나 최종 답변을 결정하고 있습니다.",
  "작업 실행을 마쳤습니다.",
  "최종 답변을 작성했습니다.",
]);

function compactTodoActivity(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isUsefulTodoActivity(value: string) {
  const detail = compactTodoActivity(value);
  return Boolean(detail) && !todoActivityGenericDetails.has(detail) && !isFollowupWaitingActivity(detail);
}

function appendTodoActivityLine(lines: string[], value: string) {
  const detail = compactTodoActivity(value);
  if (!isUsefulTodoActivity(detail) || lines.at(-1) === detail) {
    return;
  }
  lines.push(detail);
}

function isFollowupWaitingActivity(detail: string) {
  return detail === "후속 응답 대기 중"
    || detail === "오류 후속 응답 대기 중"
    || /^.+ 후속 응답 대기 중$/.test(detail)
    || (
      detail.includes("응답 대기 중입니다.")
      && detail.includes("결과를 모델에 전달했습니다.")
    )
    || detail.includes("다음 도구 호출이나 최종 답변 이벤트를 기다립니다.")
    || detail.includes("추가 도구 호출이나 최종 답변 이벤트를 기다립니다.")
    || detail.includes("최종 안내나 추가 작업 이벤트를 기다립니다.")
    || detail.includes("복구 방향이나 최종 안내 이벤트를 기다립니다.");
}

function stringWorkflowInput(event: WorkflowEvent, key: string) {
  const value = event.toolInput?.[key];
  return typeof value === "string" ? compactTodoActivity(value) : "";
}

function numberWorkflowInput(event: WorkflowEvent, key: string) {
  const value = event.toolInput?.[key];
  if (typeof value === "boolean") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function workflowFileName(path: string) {
  const clean = path.replace(/\\/g, "/").split("?")[0].split("#")[0].trim();
  return clean.split("/").filter(Boolean).pop() || clean;
}

function artifactPreviewText(content: string) {
  return compactTodoActivity(
    content
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&"),
  );
}

function workflowIntermediateFiles(event: WorkflowEvent) {
  const raw = event.toolInput?.intermediate_files;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return typeof record.path === "string" ? record.path.trim() : "";
    })
    .filter(Boolean);
}

function appendLongReportActivity(lines: string[], event: WorkflowEvent) {
  const phaseLabel = stringWorkflowInput(event, "phase_label") || "보고서 뼈대 생성 중";
  const sectionTitle = stringWorkflowInput(event, "section_title");
  const sectionIndex = numberWorkflowInput(event, "section_index");
  const sectionTotal = numberWorkflowInput(event, "section_total");
  const writtenTokens = numberWorkflowInput(event, "document_written_tokens");
  const summary = stringWorkflowInput(event, "section_summary");
  const content = stringWorkflowInput(event, "content");
  const intermediateFiles = workflowIntermediateFiles(event);
  const outputPath = stringWorkflowInput(event, "output_path") || stringWorkflowInput(event, "path") || stringWorkflowInput(event, "file_path");
  const detail = compactTodoActivity(event.detail).replace(/^진행 중\s*·\s*/i, "");
  appendTodoActivityLine(lines, [
    phaseLabel,
    sectionIndex && sectionTotal ? `${sectionIndex}/${sectionTotal} 섹션` : "",
    sectionTitle,
    writtenTokens ? `작성 ${writtenTokens.toLocaleString()} 토큰` : "",
  ].filter(Boolean).join(" · "));
  if (content) {
    const lineCount = content.replace(/\r\n/g, "\n").split("\n").length;
    const charCount = Array.from(content).length;
    appendTodoActivityLine(lines, [
      outputPath ? `산출물 ${workflowFileName(outputPath)}` : "산출물 업데이트",
      `실제 파일 ${lineCount.toLocaleString()}줄 · ${charCount.toLocaleString()}자`,
    ].join(" · "));
    const previewText = artifactPreviewText(content);
    if (previewText) {
      appendTodoActivityLine(lines, `최근 내용: ${previewText.slice(-110)}`);
    }
  }
  if (intermediateFiles.length) {
    appendTodoActivityLine(
      lines,
      `중간 산출물 ${intermediateFiles.length.toLocaleString()}개 갱신 · ${workflowFileName(intermediateFiles[0])}`,
    );
    return;
  }
  appendTodoActivityLine(lines, summary || detail);
}

function appendWorkflowActivity(lines: string[], event: WorkflowEvent) {
  if (isFollowupWaitingWorkflowEvent(event)) {
    return;
  }
  if (longReportActivityUiEnabled && event.toolName.toLowerCase() === "write_long_report") {
    appendLongReportActivity(lines, event);
    return;
  }
  for (const detail of event.detailLog || []) {
    appendTodoActivityLine(lines, detail);
  }
  appendTodoActivityLine(lines, event.detail);
}

function isFollowupWaitingWorkflowEvent(event: WorkflowEvent) {
  const title = compactTodoActivity(event.title);
  return event.role === "activity" && (
    title === "후속 응답 대기"
    || title === "오류 후속 응답 대기"
    || title === "후속 응답 수신"
  );
}

function todoActivityLines(state: AppState) {
  if (!state.busy) {
    return [];
  }
  const lines: string[] = [];
  let hasLongReportActivity = false;
  for (const event of state.workflowEvents) {
    if (longReportActivityUiEnabled && event.toolName.toLowerCase() === "write_long_report") {
      hasLongReportActivity = true;
    }
    if (event.status === "error" || event.status === "warning") {
      appendWorkflowActivity(lines, event);
      continue;
    }
    if (event.status === "running" || event.role === "purpose" || event.role === "activity" || event.role === "planning") {
      appendWorkflowActivity(lines, event);
    }
  }
  if (!hasLongReportActivity) {
    appendTodoActivityLine(lines, state.statusText);
  }
  return lines.slice(-4);
}

const longReportActivityUiEnabled = false;

export function TodoDock({ variant = "dock" }: TodoDockProps) {
  const { state, dispatch } = useAppState();
  const activeTodoSessionId = state.activeHistoryId || state.sessionId || null;
  const items = useMemo(() => parseTodoMarkdown(state.todoMarkdown), [state.todoMarkdown]);
  const activityLines = useMemo(() => todoActivityLines(state), [state]);

  if (state.todoSessionId && state.todoSessionId !== activeTodoSessionId) {
    return null;
  }

  if (!state.todoMarkdown.trim() || !items.length) {
    return null;
  }

  const doneCount = items.filter((item) => item.done).length;
  const runningIndex = state.busy ? items.findIndex((item) => !item.done) : -1;
  const listId = "todoChecklistItems";
  const toggleCollapsed = () => dispatch({ type: "toggle_todo_collapsed" });

  if (variant === "composerButton") {
    if (!state.todoCollapsed) {
      return null;
    }

    return (
      <button
        className="composer-todo-button"
        type="button"
        aria-controls={listId}
        aria-expanded="false"
        aria-label={`작업 목록 펼치기 ${doneCount}/${items.length}`}
        data-tooltip={`작업 목록 ${doneCount}/${items.length}`}
        onClick={toggleCollapsed}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M9 6h11" />
          <path d="M9 12h11" />
          <path d="M9 18h11" />
          <path d="m4 6 .8.8L6.5 5" />
          <path d="m4 12 .8.8 1.7-1.8" />
          <path d="m4 18 .8.8 1.7-1.8" />
        </svg>
      </button>
    );
  }

  if (state.todoCollapsed) {
    return null;
  }

  return (
    <div className="todo-checklist-dock" aria-label="작업 체크리스트">
      <section
        className={`todo-card composer-todo-card check-list-card${state.todoCollapsed ? " collapsed" : ""}`}
        aria-live="polite"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }
          toggleCollapsed();
        }}
      >
        <div className="todo-card-header">
          <strong>작업 목록</strong>
          <span className="todo-card-actions">
            <span className="todo-card-count">
              {doneCount}/{items.length}
            </span>
            <button
              className="todo-collapse-toggle"
              type="button"
              aria-controls={listId}
              aria-expanded={state.todoCollapsed ? "false" : "true"}
              aria-label={state.todoCollapsed ? "작업 목록 펼치기" : "작업 목록 접기"}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed();
              }}
            />
          </span>
        </div>
        <ul className="todo-card-list" id={listId}>
          {items.map((item, index) => (
            <li className={`${item.done ? "done" : ""}${index === runningIndex ? " running" : ""}`} key={`${item.label}-${index}`}>
              <span className="todo-spinner" aria-hidden="true" />
              <span className="todo-checkmark" aria-hidden="true" />
              <span className="todo-label">{item.done ? `(완료) ${item.label}` : item.label}</span>
              {index === runningIndex && activityLines.length ? (
                <ul className="todo-activity-list" aria-label="현재 작업 진행">
                  {activityLines.map((line) => (
                    <li className="todo-activity-line" key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
