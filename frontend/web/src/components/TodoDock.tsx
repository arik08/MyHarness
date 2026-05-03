import { useMemo } from "react";
import { useAppState } from "../state/app-state";

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

export function TodoDock({ variant = "dock" }: TodoDockProps) {
  const { state, dispatch } = useAppState();
  const items = useMemo(() => parseTodoMarkdown(state.todoMarkdown), [state.todoMarkdown]);

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
              <input type="checkbox" checked={item.done} readOnly aria-label={item.label} />
              <span className="todo-label">{item.done ? `(완료) ${item.label}` : item.label}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
