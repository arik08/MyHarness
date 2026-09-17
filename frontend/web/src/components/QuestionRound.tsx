import { MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendBackendRequest } from "../api/messages";
import { useAppState } from "../state/app-state";
import "./QuestionRound.css";

type Choice = { value: string; label?: string; description?: string };
type Question = { id: string; question: string; choices: Choice[]; multi_select?: boolean };
type Answer = { id: string; answer: string | string[]; kind: "choice" | "text" };

function choiceValues(answer?: Answer): string[] {
  return answer?.kind === "choice" ? (Array.isArray(answer.answer) ? answer.answer : [answer.answer]) : [];
}

function validAnswer(question: Question, item?: Answer): boolean {
  if (item?.kind === "text") return typeof item.answer === "string" && !!item.answer.trim();
  const values = choiceValues(item);
  return values.length > 0 && (question.multi_select !== false || values.length === 1)
    && new Set(values).size === values.length
    && values.every((value) => question.choices.some((choice) => choice.value === value));
}

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
        return validAnswer(question, item)
          ? [[question.id, { ...item, id: question.id }]] : [];
      }));
    } catch { return {}; }
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const completeCount = questions.filter((question) => validAnswer(question, answers[question.id])).length;

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
    setAnswers((current) => {
      const selected = choiceValues(current[question.id]);
      const answer = kind === "choice" && question.multi_select !== false
        ? (selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
        : value;
      return { ...current, [question.id]: { id: question.id, answer, kind } };
    });
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
          ...answers[question.id], answer: typeof answers[question.id].answer === "string"
            ? (answers[question.id].answer as string).trim() : answers[question.id].answer,
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
              {question.choices.length > 0 && <small>{question.multi_select === false ? "하나만 선택" : "여러 개 선택 가능"}</small>}
              <div className="clarification-options">
                {question.choices.map((choice) => (
                  <button key={choice.value} type="button"
                    className={choiceValues(selected).includes(choice.value) ? "is-selected" : ""}
                    aria-pressed={choiceValues(selected).includes(choice.value)}
                    onClick={() => updateAnswer(question, choice.value, "choice")}>
                    <span>{choice.label || choice.value}</span>
                    {choice.description && <small>{choice.description}</small>}
                  </button>
                ))}
              </div>
              <div className="clarification-custom-answer">
                <input type="text" aria-label={`${index + 1}번 질문에 직접 답변`}
                  placeholder="직접 답변하기" value={selected?.kind === "text" ? String(selected.answer) : ""}
                  onChange={(event) => {
                    updateAnswer(question, event.currentTarget.value, "text");
                  }}
                  onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.preventDefault(); }} />
              </div>
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
