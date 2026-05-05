import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { StatusPill } from "./StatusPill";
import { SwarmButton } from "./SwarmButton";
import { useAppState } from "../state/app-state";
import { sendBackendRequest } from "../api/messages";
import { useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

export function ChatPanel() {
  const { state, dispatch } = useAppState();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleCommitRef = useRef(false);

  function closeArtifactPanelFromChat(event: MouseEvent<HTMLElement>) {
    if (!state.artifactPanelOpen) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, textarea, select, [role='button']")) {
      return;
    }
    dispatch({ type: "close_artifact" });
  }

  function displayTitle(title: string) {
    return title.length > 58 ? `${title.slice(0, 55)}...` : title;
  }

  function startTitleEdit() {
    setTitleDraft(state.chatTitle);
    setEditingTitle(true);
  }

  async function persistTitle(nextTitle: string, previousTitle: string) {
    dispatch({ type: "set_chat_title", value: nextTitle });
    if (!state.sessionId) {
      return;
    }
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "update_session_title",
        value: nextTitle,
      });
    } catch (error) {
      dispatch({ type: "set_chat_title", value: previousTitle });
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function finishTitleEdit(commit: boolean) {
    if (!editingTitle || titleCommitRef.current) {
      return;
    }
    titleCommitRef.current = true;
    const previousTitle = state.chatTitle;
    const nextTitle = titleDraft.trim();
    setEditingTitle(false);
    if (commit && nextTitle) {
      void persistTitle(nextTitle, previousTitle);
    }
    window.setTimeout(() => {
      titleCommitRef.current = false;
    }, 0);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      finishTitleEdit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishTitleEdit(false);
    }
  }

  return (
    <main className="chat-panel" onClick={closeArtifactPanelFromChat}>
      <header className="chat-header">
        <div className="header-left">
          {editingTitle ? (
            <div className="chat-title editing">
              <input
                className="chat-title-input"
                value={titleDraft}
                aria-label="대화 제목"
                autoFocus
                onBlur={() => finishTitleEdit(true)}
                onChange={(event) => setTitleDraft(event.currentTarget.value)}
                onKeyDown={handleTitleKeyDown}
              />
            </div>
          ) : (
            <button className="chat-title" type="button" onClick={startTitleEdit}>
              <span>{displayTitle(state.chatTitle)}</span>
            </button>
          )}
        </div>
        <div className="header-actions">
          <StatusPill />
          <SwarmButton />
          <button
            className="header-icon-button"
            type="button"
            aria-label="프로젝트 파일 보기"
            data-tooltip="프로젝트 파일"
            onClick={() => dispatch({ type: "open_artifact_list" })}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" />
              <path d="M8 17h6" />
            </svg>
          </button>
        </div>
      </header>

      <MessageList />
      <Composer />
    </main>
  );
}
