import type { WorkflowEvent } from "../types/ui";
import "./QuestionRound.css";
import "./QuestionHistory.css";

type Choice = { value: string; label?: string; description?: string };
type Question = { id: string; question: string; choices?: Choice[] };
type Answer = { id: string; answer: string | string[]; kind: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function questionHistory(event: WorkflowEvent) {
  const input = event.toolInput;
  if (event.toolName !== "ask_user_question" || !input) return null;
  const raw = Array.isArray(input.questions) && input.questions.length ? input.questions
    : typeof input.question === "string" && input.question.trim()
      ? [{ id: "question", question: input.question, choices: input.choices }] : [];
  const questions: Question[] = raw.filter((q) => record(q) && typeof q.id === "string" && typeof q.question === "string")
    .map((q) => ({ id: q.id, question: q.question, choices: Array.isArray(q.choices)
      ? q.choices.filter((c: unknown) => record(c) && typeof c.value === "string") : [] }));
  if (!questions.length) return null;
  let answers: Answer[] = [];
  try {
    const parsed = JSON.parse(event.output || "");
    if (record(parsed) && Array.isArray(parsed.answers)) answers = parsed.answers.filter((a) => record(a)
      && typeof a.id === "string" && (a.kind === "text" || a.kind === "choice")
      && (typeof a.answer === "string" || (Array.isArray(a.answer) && a.answer.every((v: unknown) => typeof v === "string"))));
  } catch { /* Older tools returned plain text. Keep that response readable. */ }
  if (!answers.length && questions.length === 1 && event.status === "done" && event.output) {
    answers = [{ id: questions[0].id, answer: event.output, kind: questions[0].choices?.some((c) => c.value === event.output) ? "choice" : "text" }];
  }
  return { questions, answers };
}

export function QuestionHistory({ event }: { event: WorkflowEvent }) {
  const history = questionHistory(event);
  if (!history) return null;
  return <section className="lumina-question clarification-card question-history" aria-label="질의응답 기록">
    <div className="clarification-questions">{history.questions.map((question, index) => {
      const answer = history.answers.find((item) => item.id === question.id);
      const selected = answer?.kind === "choice" ? (Array.isArray(answer.answer) ? answer.answer : [answer.answer]) : [];
      return <fieldset className="clarification-question" key={question.id}>
        <legend><span>질문 {index + 1} / {history.questions.length}</span><strong>{question.question}</strong></legend>
        <div className="clarification-options">{question.choices?.map((choice) => <button type="button" key={choice.value}
          aria-disabled="true" aria-pressed={selected.includes(choice.value)} className={selected.includes(choice.value) ? "is-selected" : ""}>
          <span>{choice.label || choice.value}</span>{choice.description ? <small>{choice.description}</small> : null}
        </button>)}</div>
        {answer?.kind === "text" ? <div className="question-history-answer"><small>직접 답변</small><p>{answer.answer}</p></div> : null}
        {!answer ? <p className="question-history-answer">{event.status === "running" ? "답변 대기 중" : event.status === "error" ? "답변이 완료되지 않았습니다." : "저장된 답변을 확인할 수 없습니다."}</p> : null}
      </fieldset>;
    })}</div>
  </section>;
}
