import { MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendBackendRequest } from "../api/messages";
import { useAppState } from "../state/app-state";
import "./QuestionRound.css";

type Choice = { value: string; label?: string; description?: string };
type Question = { id: string; question: string; choices: Choice[] };
type Answer = { id: string; answer: string; kind: "choice" | "text" };

export function QuestionRound({ payload }: { payload: Record<string, unknown> }) {
  const { state } = useAppState();
  const questions = payload.questions as Question[];
  const requestId = String(payload.request_id || "");
  const draftKey = `myharness:question:${state.sessionId}:${requestId}`;
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || "{}");
      return Object.fromEntries(questions.flatMap((question) => {
        const item = saved?.[question.id];
        return item && typeof item.answer === "string"
          && (item.kind === "text" || (item.kind === "choice" && question.choices.some((c) => c.value === item.answer)))
          ? [[question.id, { ...item, id: question.id }]] : [];
      }));
    } catch { return {}; }
  });
  const [customText, setCustomText] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(answers).filter(([, item]) => item.kind === "text").map(([id, item]) => [id, item.answer])));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const completeCount = questions.filter((question) => answers[question.id]?.answer.trim()).length;

  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify(answers)); } catch { /* Storage may be disabled. */ }
  }, [answers, draftKey]);

  useEffect(() => {
    if (payload.error) {
      setError(String(payload.error));
      setSubmitting(false);
      inFlight.current = false;
    }
  }, [payload]);

  function updateAnswer(question: Question, value: string, kind: Answer["kind"]) {
    setAnswers((current) => ({ ...current, [question.id]: { id: question.id, answer: value, kind } }));
    setError("");
  }

  async function submit() {
    if (!state.sessionId || inFlight.current || completeCount !== questions.length) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "question_response", request_id: requestId,
        answer: JSON.stringify(questions.map((question) => ({
          ...answers[question.id], answer: answers[question.id].answer.trim(),
        }))),
      });
      // The backend acknowledgement closes only this request, not a newer question.
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  return (
    <section className="lumina-question clarification-card" aria-label="AI 확인 질문" aria-busy={submitting} data-request-id={requestId}>
      <header className="clarification-header">
        <span className="clarification-title">
          <MessageCircleQuestion size={19} aria-hidden="true" />
          <strong>확인 질문</strong>
        </span>
        <span className="clarification-header-actions">
          <button className="clarification-ai-judgment" type="button" disabled={submitting}
            onClick={() => setAnswers(Object.fromEntries(questions.map((question) => [question.id, { id: question.id, answer: "AI가 판단해 주세요.", kind: "text" as const }])))}>
            <Sparkles size={14} aria-hidden="true" />
            AI가 판단
          </button>
        </span>
      </header>
      <div className="clarification-questions">
        {questions.map((question, index) => {
          const selected = answers[question.id];
          return (
            <fieldset key={question.id} disabled={submitting} className="clarification-question">
              <legend><span>질문 {index + 1} / {questions.length}</span><strong>{question.question}</strong></legend>
              <div className="clarification-options">
                {question.choices.map((choice) => (
                  <button key={choice.value} type="button"
                    className={selected?.kind === "choice" && selected.answer === choice.value ? "is-selected" : ""}
                    aria-pressed={selected?.kind === "choice" && selected.answer === choice.value}
                    onClick={() => updateAnswer(question, choice.value, "choice")}>
                    <span>{choice.label || choice.value}</span>
                    {choice.description && <small>{choice.description}</small>}
                  </button>
                ))}
              </div>
              <form className="clarification-custom-answer" onSubmit={(event) => {
                event.preventDefault();
                if (customText[question.id]?.trim()) updateAnswer(question, customText[question.id].trim(), "text");
              }}>
                <input type="text" aria-label={`${index + 1}번 질문에 직접 답변`}
                  placeholder="직접 답변하기" value={customText[question.id] || ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomText((current) => ({ ...current, [question.id]: value }));
                    if (selected?.kind === "text") updateAnswer(question, value, "text");
                  }}
                  onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); }} />
                <button type="submit" disabled={submitting || !customText[question.id]?.trim()}>적용</button>
              </form>
              {selected?.kind === "text" && selected.answer === "AI가 판단해 주세요." && <div className="clarification-ai-answer">AI가 판단하도록 맡겼습니다.</div>}
            </fieldset>
          );
        })}
      </div>
      {error && <p className="clarification-error" role="alert">{error}</p>}
      <footer className="clarification-footer">
        <span aria-live="polite">{completeCount} / {questions.length} 답변</span>
        <button className="clarification-submit" type="button" aria-label="답변 보내기"
          disabled={submitting || completeCount !== questions.length} onClick={() => void submit()}>
          <Send size={14} aria-hidden="true" />
          {submitting ? "보내는 중" : "보내기"}
        </button>
      </footer>
    </section>
  );
}
