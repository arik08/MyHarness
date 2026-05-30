import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { sendBackendRequest } from "../api/messages";
import { useAppState } from "../state/app-state";

type QuestionChoice = {
  label: string;
  value: string;
  description: string;
  source: "structured" | "question" | "default";
};

export function InlineQuestion() {
  const { state, dispatch } = useAppState();
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [choiceFreeformAnswer, setChoiceFreeformAnswer] = useState("");
  const [questionStepIndex, setQuestionStepIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const payload = state.modal?.kind === "backend" ? state.modal.payload || {} : null;
  const kind = String(payload?.kind || "");
  const requestId = String(payload?.request_id || "");
  const isQuestion = kind === "question";
  const isPermission = kind === "permission";
  const question = String(payload?.question || payload?.reason || payload?.message || "").trim()
    || (isPermission ? "이 도구 실행을 허용할까요?" : "추가 정보가 필요합니다.");
  const questionSteps = useMemo(() => splitBatchedQuestions(question), [question]);
  const [questionStepAnswers, setQuestionStepAnswers] = useState<string[]>([]);
  const batchedQuestion = questionSteps.length > 1;
  const activeQuestionIndex = batchedQuestion ? Math.min(questionStepIndex, questionSteps.length - 1) : 0;
  const activeQuestion = questionSteps[activeQuestionIndex] || question;
  const questionProgress = useMemo(() => questionProgressLabel(question), [question]);
  const choices = useMemo(() => (
    isQuestion
      ? normalizeQuestionChoices(payload, question)
      : []
  ), [isQuestion, payload, question]);
  const sharedChoiceQuestion = batchedQuestion && choices.length > 0;
  const choiceAnsweredQuestionSteps = useMemo(
    () => questionSteps.map((step, index) => isQuestionAnsweredBySharedChoices(step, index, questionSteps)),
    [questionSteps],
  );
  const mixedBatchedChoiceQuestion = sharedChoiceQuestion
    && choiceAnsweredQuestionSteps.some(Boolean)
    && choiceAnsweredQuestionSteps.some((answeredByChoice) => !answeredByChoice);
  const activeQuestionUsesChoices = choices.length > 0
    && (!batchedQuestion || !mixedBatchedChoiceQuestion || choiceAnsweredQuestionSteps[activeQuestionIndex]);
  const displayChoices = activeQuestionUsesChoices ? choices : [];
  const conciseQuestion = useMemo(() => {
    const fromQuestion = displayChoices.some((choice) => choice.source === "question")
      && !displayChoices.some((choice) => choice.source === "structured");
    const displayQuestion = stripLeadingQuestionProgress(activeQuestion);
    return fromQuestion ? stripQuestionChoiceLines(displayQuestion, displayChoices) : displayQuestion;
  }, [activeQuestion, displayChoices]);

  useLayoutEffect(() => {
    setAnswer("");
    setQuestionStepAnswers([]);
    setQuestionStepIndex(0);
    setChoiceFreeformAnswer("");
  }, [question, requestId]);

  useLayoutEffect(() => {
    if (isQuestion) {
      inputRef.current?.focus();
    }
  }, [isQuestion, requestId, activeQuestionIndex, displayChoices.length]);

  if (!payload || (!isQuestion && !isPermission)) {
    return null;
  }

  async function respond(responsePayload: Record<string, unknown>) {
    if (!state.sessionId || submitting) return;
    setSubmitting(true);
    try {
      await sendBackendRequest(state.sessionId, state.clientId, responsePayload);
      dispatch({ type: "close_modal" });
      setAnswer("");
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSubmitting(false);
    }
  }

  function submitAnswer(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (batchedQuestion) {
      submitSequentialAnswer(trimmed);
      return;
    }
    void respond({ type: "question_response", request_id: requestId, answer: trimmed });
  }

  function submitSequentialAnswer(value: string) {
    const nextAnswers = [...questionStepAnswers];
    nextAnswers[activeQuestionIndex] = value.trim();
    if (activeQuestionIndex < questionSteps.length - 1) {
      setQuestionStepAnswers(nextAnswers);
      setQuestionStepIndex(activeQuestionIndex + 1);
      setAnswer("");
      setChoiceFreeformAnswer("");
      return;
    }
    void respond({
      type: "question_response",
      request_id: requestId,
      answer: formatBatchedQuestionAnswer(questionSteps, nextAnswers),
    });
  }

  function submitChoiceFreeform() {
    submitAnswer(choiceFreeformAnswer);
  }

  function handleAnswerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitAnswer(answer);
    }
  }

  function handleSharedChoiceFreeformKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && choiceFreeformAnswer.trim()) {
      event.preventDefault();
      submitChoiceFreeform();
    }
  }

  if (isPermission) {
    return (
      <section className="inline-question-card permission-question-card" role="dialog" aria-modal="true" data-request-id={requestId}>
        <div className="inline-question-header">
          <strong>
            <span className="inline-question-label-copy">권한 요청: {question}</span>
          </strong>
          <small>에이전트가 실행 허용을 기다리고 있습니다.</small>
        </div>
        <div className="inline-question-choices permission-question-choices">
          <button
            className="inline-question-choice"
            type="button"
            disabled={submitting}
            onClick={() => void respond({ type: "permission_response", request_id: requestId, allowed: false })}
          >
            <span className="inline-question-number inline-question-choice-number">A1</span>
            <span className="inline-question-choice-copy">거부</span>
          </button>
          <button
            className="inline-question-choice"
            type="button"
            disabled={submitting}
            onClick={() => void respond({ type: "permission_response", request_id: requestId, allowed: true })}
          >
            <span className="inline-question-number inline-question-choice-number">A2</span>
            <span className="inline-question-choice-copy">허용</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="inline-question-card" role="group" aria-live="polite" data-request-id={requestId}>
      <div className="inline-question-header">
        <strong>
          <span className="inline-question-label-copy">
            {batchedQuestion
              ? `질문 (${activeQuestionIndex + 1}/${questionSteps.length})`
              : `질문${questionProgress}`}
          </span>
        </strong>
        <small>에이전트가 답변을 기다리고 있습니다.</small>
      </div>
      <div className="inline-question-objective-question inline-question-single-question">
        <span className="inline-question-number inline-question-step-number">Q{activeQuestionIndex + 1}</span>
        <span>{conciseQuestion}</span>
      </div>
      {displayChoices.length ? (
        <div className="inline-question-choices">
          {displayChoices.map((choice, index) => (
            <button
              className="inline-question-choice"
              type="button"
              key={`${choice.value}-${index}`}
              disabled={submitting}
              onClick={() => submitAnswer(choice.value)}
            >
              <span className="inline-question-number inline-question-choice-number">A{index + 1}</span>
              <span className="inline-question-choice-copy">{choice.label}</span>
              {choice.description ? <small className="inline-question-choice-description">{choice.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className={`inline-question-form${displayChoices.length ? " inline-question-choice-freeform-row" : ""}`}>
        <span className="inline-question-number inline-question-choice-number">A{displayChoices.length + 1}</span>
        <input
          ref={inputRef}
          type="text"
          placeholder={displayChoices.length ? "기타 직접 입력..." : batchedQuestion ? "답변 입력..." : "직접 답변 입력..."}
          autoComplete="off"
          spellCheck={false}
          value={displayChoices.length ? choiceFreeformAnswer : answer}
          disabled={submitting}
          onChange={(event) => {
            if (displayChoices.length) {
              setChoiceFreeformAnswer(event.currentTarget.value);
            } else {
              setAnswer(event.currentTarget.value);
            }
          }}
          onKeyDown={displayChoices.length ? handleSharedChoiceFreeformKeyDown : handleAnswerKeyDown}
        />
        <button
          className="inline-question-submit"
          type="button"
          aria-label={displayChoices.length ? "직접 답변 보내기" : undefined}
          disabled={submitting || !(displayChoices.length ? choiceFreeformAnswer : answer).trim()}
          onClick={() => displayChoices.length ? submitChoiceFreeform() : submitAnswer(answer)}
        >
          답변
        </button>
      </div>
    </section>
  );
}

function normalizeQuestionChoices(
  modal: Record<string, unknown> | null,
  question: string,
  fallbackChoices: QuestionChoice[] = [],
  options: { allowDefaultChoices?: boolean } = {},
): QuestionChoice[] {
  const rawSources = [
    modal?.choices,
    modal?.options,
    modal?.suggestions,
    modal?.select_options,
  ];
  const choices: QuestionChoice[] = [];
  for (const source of rawSources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const choice = normalizeQuestionChoice(item, "structured");
      if (choice) choices.push(choice);
    }
  }
  if (!choices.length) {
    choices.push(...fallbackChoices);
  }
  if (!choices.length) {
    choices.push(...extractQuestionChoices(question));
  }
  if (!choices.length && options.allowDefaultChoices !== false) {
    choices.push(...defaultQuestionChoices(question));
  }
  const seen = new Set<string>();
  return choices.filter((choice) => {
    const key = choice.value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function normalizeQuestionChoice(item: unknown, source: QuestionChoice["source"]): QuestionChoice | null {
  if (typeof item === "string") {
    const value = item.trim();
    return value ? { label: cleanChoiceLabel(value), value, description: "", source } : null;
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  const raw = item as Record<string, unknown>;
  const value = String(raw.value ?? raw.answer ?? raw.label ?? raw.title ?? "").trim();
  if (!value) return null;
  const label = String(raw.label ?? raw.title ?? value).trim() || value;
  return {
    label: cleanChoiceLabel(label),
    value,
    description: String(raw.description ?? raw.detail ?? "").trim(),
    source,
  };
}

function extractQuestionChoices(question: string): QuestionChoice[] {
  return question
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)]|[A-Za-z][.)]|[가-힣][.)])\s+(.+?)\s*$/)?.[1] || "")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((value) => {
      const cleaned = cleanChoiceLabel(value);
      return { label: cleaned, value: cleaned, description: "", source: "question" as const };
    });
}

function cleanChoiceLabel(value: string) {
  return String(value || "")
    .trim()
    .replace(/^\s*(?:(?:\d{1,2}|[A-Za-z]|[가-힣])[.)]\s+|\d{1,2}\s+(?=\S))/, "")
    .trim();
}

function defaultQuestionChoices(question: string): QuestionChoice[] {
  if (isConfirmationQuestion(question)) {
    return [
      { label: "네, 진행해주세요", value: "네, 진행해주세요", description: "", source: "default" },
      { label: "아니요", value: "아니요", description: "", source: "default" },
      { label: "선택지를 더 보여주세요", value: "선택지를 더 보여주세요", description: "", source: "default" },
    ];
  }
  return [];
}

function isAlternativeQuestion(question: string) {
  return /\b(?:or|versus|vs\.?)\b|(?:아니면|또는|혹은|대신|중에서|양자택일)/i.test(question);
}

function isOpenEndedQuestion(question: string) {
  return /(?:어떤|무엇|무슨|어느|어떻게|어디|왜|누구|언제|몇|얼마|which|what|how|where|why|who|when)/i.test(question);
}

function isConfirmationQuestion(question: string) {
  if (isOpenEndedQuestion(question) || isAlternativeQuestion(question)) {
    return false;
  }
  return /(?:예|아니오|yes|no|원하시나요|괜찮을까요|맞나요|해도 될까요|진행.*(?:할까요|될까요)|시작.*(?:할까요|될까요)|만들.*(?:할까요|될까요)|수정.*(?:할까요|될까요)|적용.*(?:할까요|될까요)|확정.*(?:할까요|될까요)|should i|would you like|proceed|continue)/i.test(question);
}

function stripQuestionChoiceLines(question: string, choices: QuestionChoice[]) {
  if (!question.trim() || !choices.length) {
    return question;
  }
  let next = question.trim();
  for (const choice of choices) {
    const escaped = escapeRegExp(choice.value);
    next = next.replace(new RegExp(`\\s*(?:[-*]|\\d+[.)]|[A-Za-z][.)]|[가-힣][.)])?\\s*${escaped}\\s*`, "g"), " ");
  }
  return next.replace(/\s+/g, " ").trim() || question.split(/\r?\n/)[0] || question;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function questionProgressLabel(question: string) {
  const text = String(question || "").trim();
  const steps = splitBatchedQuestions(text);
  if (steps.length > 1) {
    return ` (${steps.length}개)`;
  }
  const explicit = text.match(/(?:^|\s)[(（]\s*(\d+)\s*[\/／]\s*(\d+)\s*[)）]/);
  if (explicit) {
    const current = Number.parseInt(explicit[1], 10);
    const total = Number.parseInt(explicit[2], 10);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 1 && current >= 1 && current <= total) {
      return ` (${current}/${total})`;
    }
  }
  const questionLines = text.split(/\r?\n/).map((line) => line.trim()).filter(isQuestionLikeLine);
  const punctuationCount = text.match(/[?？]/g)?.length || 0;
  const total = Math.max(questionLines.length, punctuationCount);
  return total > 1 ? ` (1/${Math.min(total, 9)})` : "";
}

function splitBatchedQuestions(question: string) {
  const text = String(question || "").trim();
  if (!text) {
    return [];
  }
  const explicitMarkers = [...text.matchAll(/[(（]\s*(\d+)\s*[\/／]\s*(\d+)\s*[)）]/g)]
    .filter((match) => {
      const after = text.slice((match.index || 0) + match[0].length).trimStart();
      return !after.startsWith(":") && !after.startsWith("：");
    });
  if (explicitMarkers.length > 1) {
    return explicitMarkers.map((match, index) => {
      const start = match.index || 0;
      const end = explicitMarkers[index + 1]?.index ?? text.length;
      return text.slice(start, end).trim();
    }).filter(Boolean);
  }
  const questionLines = text.split(/\r?\n/).map((line) => line.trim()).filter(isQuestionLikeLine);
  return questionLines.length > 1 ? questionLines : [text];
}

function stripLeadingQuestionProgress(question: string) {
  return String(question || "").replace(/^\s*[(（]\s*\d+\s*[\/／]\s*\d+\s*[)）]\s*/, "").trim();
}

function isSubjectiveQuestionStep(question: string) {
  return /(?:^|\s)(?:주관식|서술형)\s*[:：]/.test(stripLeadingQuestionProgress(question));
}

function isObjectiveQuestionStep(question: string) {
  return /(?:^|\s)(?:객관식|선택식|선택지)\s*[:：]/.test(stripLeadingQuestionProgress(question));
}

function isQuestionAnsweredBySharedChoices(question: string, index: number, questions: string[]) {
  const label = stripLeadingQuestionProgress(question);
  if (isSubjectiveQuestionStep(label)) {
    return false;
  }
  if (isObjectiveQuestionStep(label)) {
    return true;
  }
  if (index !== questions.length - 1) {
    return false;
  }
  return /(?:골라주세요|선택해주세요|정해주세요|고르|선택|유형|형태|방식|옵션|choice|select|option)/i.test(label);
}

function formatBatchedQuestionAnswer(questions: string[], answers: string[]) {
  return questions.map((question, index) => {
    const label = stripLeadingQuestionProgress(question);
    return `(${index + 1}/${questions.length}) ${label}\n답변: ${(answers[index] || "").trim()}`;
  }).join("\n\n");
}

function isQuestionLikeLine(line: string) {
  const value = line.replace(/^[(（]|[)）]$/g, "").trim();
  return /[?？]\s*$/.test(value)
    || /(할까요|될까요|괜찮을까요|원하시나요|맞나요|해주세요|골라주세요|알려주세요|선택해주세요|말씀해주세요|정해주세요)[.!。]?\s*$/.test(value);
}

function isFollowUpQuestionLine(line: string) {
  const value = line.replace(/^[(（]|[)）]$/g, "").trim();
  if (/^(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/.test(value)) {
    return false;
  }
  if (!/[?？]\s*$/.test(value) && !/(할까요|될까요|괜찮을까요|원하시나요|맞나요)\s*$/.test(value)) {
    return false;
  }
  return isOpenEndedQuestion(value)
    || isAlternativeQuestion(value)
    || /(진행|시작|만들|수정|적용|확정|선택|원하|괜찮|좋을까요|될까요|할까요|should i|would you like|proceed|continue)/i.test(value);
}
