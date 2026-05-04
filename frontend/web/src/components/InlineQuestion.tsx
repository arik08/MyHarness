import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { sendBackendRequest, sendMessage } from "../api/messages";
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const payload = state.modal?.kind === "backend" ? state.modal.payload || {} : null;
  const assistantQuestion = useMemo(() => (
    !payload && !state.busy ? assistantFollowUpQuestion(state.messages, state.composer.draft) : null
  ), [payload, state.busy, state.composer.draft, state.messages]);
  const kind = String(payload?.kind || "");
  const requestId = String(payload?.request_id || "");
  const isAssistantFollowUp = Boolean(assistantQuestion);
  const isQuestion = kind === "question" || Boolean(assistantQuestion);
  const isPermission = kind === "permission";
  const question = (assistantQuestion?.question || String(payload?.question || payload?.reason || payload?.message || "")).trim()
    || (isPermission ? "이 도구 실행을 허용할까요?" : "추가 정보가 필요합니다.");
  const questionSteps = useMemo(() => splitBatchedQuestions(question), [question]);
  const [questionStepAnswers, setQuestionStepAnswers] = useState<string[]>([]);
  const [selectedBatchedChoice, setSelectedBatchedChoice] = useState("");
  const batchedQuestion = questionSteps.length > 1;
  const activeQuestion = questionSteps[0] || question;
  const questionProgress = useMemo(() => questionProgressLabel(question), [question]);
  const batchedAnswersComplete = batchedQuestion && questionSteps.every((_, index) => questionStepAnswers[index]?.trim());
  const choices = useMemo(() => (
    isQuestion
      ? normalizeQuestionChoices(payload, question, assistantQuestion?.choices, {
        allowDefaultChoices: !assistantQuestion || !isAlternativeQuestion(question),
      })
      : []
  ), [assistantQuestion, isQuestion, payload, question]);
  const sharedChoiceQuestion = batchedQuestion && choices.length > 0;
  const choiceAnsweredQuestionSteps = useMemo(
    () => questionSteps.map((step, index) => isQuestionAnsweredBySharedChoices(step, index, questionSteps)),
    [questionSteps],
  );
  const mixedBatchedChoiceQuestion = sharedChoiceQuestion
    && choiceAnsweredQuestionSteps.some(Boolean)
    && choiceAnsweredQuestionSteps.some((answeredByChoice) => !answeredByChoice);
  const displayChoices = batchedQuestion && !sharedChoiceQuestion ? [] : choices;
  const mixedBatchedAnswersComplete = mixedBatchedChoiceQuestion
    && Boolean(selectedBatchedChoice.trim() || choiceFreeformAnswer.trim())
    && questionSteps.every((_, index) => choiceAnsweredQuestionSteps[index] || questionStepAnswers[index]?.trim());
  const conciseQuestion = useMemo(() => {
    const fromQuestion = displayChoices.some((choice) => choice.source === "question")
      && !displayChoices.some((choice) => choice.source === "structured");
    const displayQuestion = stripLeadingQuestionProgress(activeQuestion);
    return fromQuestion ? stripQuestionChoiceLines(displayQuestion, displayChoices) : displayQuestion;
  }, [activeQuestion, displayChoices]);

  useLayoutEffect(() => {
    setAnswer("");
    setQuestionStepAnswers([]);
    setSelectedBatchedChoice("");
    setChoiceFreeformAnswer("");
  }, [question, requestId]);

  useLayoutEffect(() => {
    if (isQuestion) {
      inputRef.current?.focus();
    }
  }, [isQuestion, requestId]);

  if ((!payload && !assistantQuestion) || (!isQuestion && !isPermission)) {
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

  async function sendAssistantFollowUp(value: string) {
    const trimmed = value.trim();
    if (!state.sessionId || !trimmed || submitting) return;
    setSubmitting(true);
    dispatch({ type: "append_message", message: { role: "user", text: trimmed } });
    dispatch({ type: "set_busy", value: true });
    dispatch({ type: "clear_composer" });
    try {
      await sendMessage({
        sessionId: state.sessionId,
        clientId: state.clientId,
        line: trimmed,
        attachments: [],
        suppressUserTranscript: false,
        systemPrompt: state.systemPrompt.trim() || undefined,
      });
      setAnswer("");
    } catch (error) {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSubmitting(false);
    }
  }

  function submitAnswer(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (assistantQuestion) {
      void sendAssistantFollowUp(trimmed);
      return;
    }
    void respond({ type: "question_response", request_id: requestId, answer: trimmed });
  }

  function submitBatchedAnswers() {
    if (!batchedAnswersComplete) return;
    const combinedAnswer = formatBatchedQuestionAnswer(questionSteps, questionStepAnswers);
    if (assistantQuestion) {
      void sendAssistantFollowUp(combinedAnswer);
      return;
    }
    void respond({ type: "question_response", request_id: requestId, answer: combinedAnswer });
  }

  function submitMixedBatchedAnswers() {
    if (!mixedBatchedAnswersComplete) return;
    const combinedAnswer = formatMixedBatchedQuestionAnswer(
      questionSteps,
      questionStepAnswers,
      selectedBatchedChoice || choiceFreeformAnswer,
      choiceAnsweredQuestionSteps,
    );
    if (assistantQuestion) {
      void sendAssistantFollowUp(combinedAnswer);
      return;
    }
    void respond({ type: "question_response", request_id: requestId, answer: combinedAnswer });
  }

  function submitSharedChoiceFreeform() {
    submitAnswer(choiceFreeformAnswer);
  }

  function updateBatchedAnswer(index: number, value: string) {
    setQuestionStepAnswers((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
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

  function handleBatchedAnswerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && batchedAnswersComplete) {
      event.preventDefault();
      submitBatchedAnswers();
    }
  }

  function handleMixedBatchedAnswerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && mixedBatchedAnswersComplete) {
      event.preventDefault();
      submitMixedBatchedAnswers();
    }
  }

  function handleSharedChoiceFreeformKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && choiceFreeformAnswer.trim()) {
      event.preventDefault();
      submitSharedChoiceFreeform();
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
              ? `${isAssistantFollowUp ? "답변 입력" : "질문"} (${questionSteps.length}개)`
              : isAssistantFollowUp ? `답변 선택${questionProgress}` : `질문${questionProgress}`}
          </span>
        </strong>
        <small>{isAssistantFollowUp ? "마지막 질문에 바로 답변할 수 있습니다." : "에이전트가 답변을 기다리고 있습니다."}</small>
      </div>
      {batchedQuestion && mixedBatchedChoiceQuestion ? (
        <div className="inline-question-mixed-set">
          {questionSteps.map((step, index) => {
            const label = stripLeadingQuestionProgress(step);
            if (!choiceAnsweredQuestionSteps[index]) {
              return (
                <label className="inline-question-pair" key={`${step}-${index}`}>
                  <span className="inline-question-number inline-question-step-number">Q{index + 1}</span>
                  <span className="inline-question-pair-question">{label}</span>
                  <input
                    type="text"
                    placeholder="답변 입력..."
                    autoComplete="off"
                    spellCheck={false}
                    value={questionStepAnswers[index] || ""}
                    disabled={submitting}
                    onChange={(event) => updateBatchedAnswer(index, event.currentTarget.value)}
                    onKeyDown={handleMixedBatchedAnswerKeyDown}
                  />
                </label>
              );
            }
            return (
              <div className="inline-question-objective-block" key={`${step}-${index}`}>
                <div className="inline-question-objective-question">
                  <span className="inline-question-number inline-question-step-number">Q{index + 1}</span>
                  <span>{label}</span>
                </div>
                <div className="inline-question-choices inline-question-shared-choices">
                  {displayChoices.map((choice, choiceIndex) => (
                    <button
                      className={`inline-question-choice${selectedBatchedChoice === choice.value ? " selected" : ""}`}
                      type="button"
                      key={`${choice.value}-${choiceIndex}`}
                      disabled={submitting}
                      onClick={() => {
                        setSelectedBatchedChoice(choice.value);
                        setChoiceFreeformAnswer("");
                      }}
                    >
                      <span className="inline-question-number inline-question-choice-number">A{choiceIndex + 1}</span>
                      <span className="inline-question-choice-copy">{choice.label}</span>
                      {choice.description ? <small className="inline-question-choice-description">{choice.description}</small> : null}
                    </button>
                  ))}
                </div>
                <label className="inline-question-choice-freeform">
                  <span className="inline-question-number inline-question-choice-number">A{displayChoices.length + 1}</span>
                  <input
                    type="text"
                    placeholder="기타 직접 입력..."
                    autoComplete="off"
                    spellCheck={false}
                    value={choiceFreeformAnswer}
                    disabled={submitting}
                    onChange={(event) => {
                      setChoiceFreeformAnswer(event.currentTarget.value);
                      setSelectedBatchedChoice("");
                    }}
                    onKeyDown={handleMixedBatchedAnswerKeyDown}
                  />
                </label>
              </div>
            );
          })}
          <button className="inline-question-submit inline-question-submit-batched" type="button" aria-label="질문별 답변 보내기" disabled={submitting || !mixedBatchedAnswersComplete} onClick={submitMixedBatchedAnswers}>
            답변
          </button>
        </div>
      ) : batchedQuestion && sharedChoiceQuestion ? (
        <div className="inline-question-shared-choice-set">
          <div className="inline-question-pairs">
            {questionSteps.map((step, index) => (
              <label className="inline-question-pair" key={`${step}-${index}`}>
                <span className="inline-question-number inline-question-step-number">Q{index + 1}</span>
                <span className="inline-question-pair-question">{stripLeadingQuestionProgress(step)}</span>
                <input
                  type="text"
                  placeholder="답변 입력..."
                  autoComplete="off"
                  spellCheck={false}
                  value={questionStepAnswers[index] || ""}
                  disabled={submitting}
                  onChange={(event) => updateBatchedAnswer(index, event.currentTarget.value)}
                  onKeyDown={handleBatchedAnswerKeyDown}
                />
              </label>
            ))}
            <button className="inline-question-submit inline-question-submit-batched" type="button" aria-label="질문별 답변 보내기" disabled={submitting || !batchedAnswersComplete} onClick={submitBatchedAnswers}>
              답변
            </button>
          </div>
          <div className="inline-question-choices inline-question-shared-choices">
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
          <div className="inline-question-form inline-question-choice-freeform-row">
            <span className="inline-question-number inline-question-choice-number">A{displayChoices.length + 1}</span>
            <input
              type="text"
              placeholder="기타 직접 입력..."
              autoComplete="off"
              spellCheck={false}
              value={choiceFreeformAnswer}
              disabled={submitting}
              onChange={(event) => setChoiceFreeformAnswer(event.currentTarget.value)}
              onKeyDown={handleSharedChoiceFreeformKeyDown}
            />
            <button className="inline-question-submit" type="button" aria-label="직접 답변 보내기" disabled={submitting || !choiceFreeformAnswer.trim()} onClick={submitSharedChoiceFreeform}>
              답변
            </button>
          </div>
        </div>
      ) : batchedQuestion ? (
        <div className="inline-question-pairs">
          {questionSteps.map((step, index) => (
            <label className="inline-question-pair" key={`${step}-${index}`}>
              <span className="inline-question-number inline-question-step-number">Q{index + 1}</span>
              <span className="inline-question-pair-question">{stripLeadingQuestionProgress(step)}</span>
              <input
                type="text"
                placeholder="답변 입력..."
                autoComplete="off"
                spellCheck={false}
                value={questionStepAnswers[index] || ""}
                disabled={submitting}
                onChange={(event) => updateBatchedAnswer(index, event.currentTarget.value)}
                onKeyDown={handleBatchedAnswerKeyDown}
              />
            </label>
          ))}
          <button className="inline-question-submit inline-question-submit-batched" type="button" aria-label="질문별 답변 보내기" disabled={submitting || !batchedAnswersComplete} onClick={submitBatchedAnswers}>
            답변
          </button>
        </div>
      ) : (
        <>
          {!isAssistantFollowUp ? (
            <div className="inline-question-objective-question inline-question-single-question">
              <span className="inline-question-number inline-question-step-number">Q1</span>
              <span>{conciseQuestion}</span>
            </div>
          ) : null}
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
          <div className="inline-question-form">
            <span className="inline-question-number inline-question-choice-number">A{displayChoices.length + 1}</span>
            <input
              ref={inputRef}
              type="text"
              placeholder="직접 답변 입력..."
              autoComplete="off"
              spellCheck={false}
              value={answer}
              disabled={submitting}
              onChange={(event) => setAnswer(event.currentTarget.value)}
              onKeyDown={handleAnswerKeyDown}
            />
            <button className="inline-question-submit" type="button" disabled={submitting || !answer.trim()} onClick={() => submitAnswer(answer)}>
              답변
            </button>
          </div>
        </>
      )}
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

function formatMixedBatchedQuestionAnswer(questions: string[], answers: string[], selectedChoice: string, choiceAnsweredQuestions: boolean[]) {
  return questions.map((question, index) => {
    const label = stripLeadingQuestionProgress(question);
    const answer = choiceAnsweredQuestions[index] ? selectedChoice.trim() : (answers[index] || "").trim();
    return `(${index + 1}/${questions.length}) ${label}\n답변: ${answer}`;
  }).join("\n\n");
}

function isQuestionLikeLine(line: string) {
  const value = line.replace(/^[(（]|[)）]$/g, "").trim();
  return /[?？]\s*$/.test(value)
    || /(할까요|될까요|괜찮을까요|원하시나요|맞나요|해주세요|골라주세요|알려주세요|선택해주세요|말씀해주세요|정해주세요)[.!。]?\s*$/.test(value);
}

function assistantFollowUpQuestion(messages: Array<{ role: string; text: string; isComplete?: boolean; isError?: boolean }>, draft = "") {
  if (draft.trim()) {
    return null;
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.isComplete || last.isError) {
    return null;
  }
  const text = String(last.text || "").trim();
  if (!text || text.length > 4000) {
    return null;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const trailingLines = lines.slice(-3);
  const batchedQuestions = trailingLines.filter(isFollowUpQuestionLine);
  const question = batchedQuestions.length > 1
    ? batchedQuestions.join("\n")
    : [...trailingLines].reverse().find(isFollowUpQuestionLine) || "";
  if (!question) {
    return null;
  }
  return {
    question,
    choices: isAlternativeQuestion(question) ? [] : defaultQuestionChoices(question),
  };
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
