import { useState } from "react";
import { saveArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ChatMessage } from "../types/ui";

function answerFileName(title: string, text: string) {
  const source = title.trim() && title.trim() !== "MyHarness"
    ? title.trim()
    : String(text || "").split(/\r?\n/).find((line) => line.trim()) || "answer";
  const clean = source
    .replace(/[#*_`~[\](){}<>]/g, "")
    .replace(/[\\/:*?"|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `outputs/${clean || "answer"}.md`;
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

export function AssistantActions({ message }: { message: ChatMessage }) {
  const { state, dispatch } = useAppState();
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const text = message.text.trim();

  if (!message.isComplete || !text) {
    return null;
  }

  async function copyAnswer() {
    setCopying(true);
    try {
      await copyTextToClipboard(text);
      setStatus("복사했습니다.");
    } catch (error) {
      setStatus(`복사 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.setTimeout(() => {
        setCopying(false);
        setStatus("");
      }, 1400);
    }
  }

  async function saveAnswer() {
    if (!state.sessionId) {
      setStatus("저장할 세션이 없습니다.");
      return;
    }
    setSaving(true);
    setStatus("저장 중...");
    try {
      const payload = await saveArtifact(answerFileName(state.chatTitle, text), text, state.sessionId, state.clientId);
      dispatch({ type: "refresh_artifacts" });
      setStatus(payload.artifact?.path ? `${payload.artifact.path} 저장됨` : "저장했습니다.");
    } catch (error) {
      setStatus(`저장 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.setTimeout(() => {
        setSaving(false);
        setStatus((current) => current.includes("실패") ? current : "");
      }, 1800);
    }
  }

  return (
    <div className="assistant-actions">
      <span className="assistant-done">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span>답변 완료</span>
      </span>
      <button
        className="assistant-action-button"
        type="button"
        data-tooltip="원문 복사"
        aria-label="원문 복사"
        disabled={copying}
        onClick={() => void copyAnswer()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="9" y="9" width="10" height="10" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button
        className="assistant-action-button"
        type="button"
        data-tooltip="본문 저장"
        aria-label="본문 저장"
        disabled={saving}
        onClick={() => void saveAnswer()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v5h8" />
        </svg>
      </button>
      <span className="assistant-action-status">{status}</span>
    </div>
  );
}
