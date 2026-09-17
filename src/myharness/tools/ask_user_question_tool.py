"""Tool for asking the interactive user a follow-up question."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, Field, model_validator

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


AskUserPrompt = Callable[..., Awaitable[str]]


class AskUserQuestionChoice(BaseModel):
    """One structured answer the user can select."""

    value: str = Field(description="The exact answer value to return if selected")
    label: str | None = Field(default=None, description="Short text shown to the user")
    description: str | None = Field(default=None, description="Optional detail shown below the label")


class UserQuestion(BaseModel):
    """An independent question with its own answer choices."""

    id: str = Field(min_length=1, max_length=80)
    question: str = Field(min_length=1)
    choices: list[AskUserQuestionChoice] = Field(default_factory=list, max_length=6)
    multi_select: bool = Field(
        default=True,
        description="Allow multiple choices by default. Set false ONLY when selecting two or more "
        "answers would be logically incompatible for this question. Decide from the question's "
        "meaning, not the number of options or a preference for one recommendation.",
    )

    @model_validator(mode="after")
    def validate_question(self):
        if not self.id.strip() or not self.question.strip():
            raise ValueError("Question id and question must not be blank")
        self.id = self.id.strip()
        self.question = self.question.strip()
        for choice in self.choices:
            choice.value = choice.value.strip()
        values = [choice.value.casefold() for choice in self.choices]
        if any(not value for value in values) or len(set(values)) != len(values):
            raise ValueError("Choice values must be nonblank and unique within each question")
        return self


class AskUserQuestionToolInput(BaseModel):
    """Arguments for asking the user a question."""

    question: str = Field(
        default="",
        description=(
            "Legacy single question. Prefer questions for a round of independent questions."
        )
    )
    multi_select: bool = Field(
        default=True,
        description="For legacy question/choices: allow multiple selections by default; set false "
        "only when multiple answers are logically incompatible. For questions, set per question.",
    )
    questions: list[UserQuestion] = Field(
        default_factory=list, max_length=20,
        description="Independent questions, each with a unique id, question and its own choices. "
        "Use 2-4 useful choices when possible; omit choices for free text. "
        "The UI always provides direct input, so do not add an Other option. "
        "Put the recommended option first and mark its label as recommended.",
    )

    choices: list[AskUserQuestionChoice] = Field(
        default_factory=list,
        description=(
            "Optional structured multiple-choice answers. Use this JSON array instead of "
            "embedding answer choices in the question text. Each choice.value is the exact "
            "answer returned when selected."
        ),
    )
    @model_validator(mode="after")
    def validate_questions(self):
        if not self.questions and not self.question.strip():
            raise ValueError("Provide question or questions")
        if self.questions and (self.question.strip() or self.choices):
            raise ValueError("Use questions or legacy question/choices, not both")
        ids = [item.id for item in self.questions]
        if len(set(ids)) != len(ids):
            raise ValueError("Question ids must be unique")
        return self



class AskUserQuestionTool(BaseTool):
    """Ask the interactive user a question and return the answer."""

    name = "ask_user_question"
    description = (
        "Ask the person through an interactive question form and return their answers. "
        "For ordinary work, ask only when missing information would make the work meaningfully "
        "wrong, destructive, or wasteful; otherwise state the assumption and proceed. "
        "Use questions to group independent decisions, each with its own choices. The UI always "
        "allows direct input. Put the recommended choice first and mark its label. "
        "Multiple choices are allowed by default (multi_select=true). For EACH question, "
        "set multi_select=false only if two or more choices cannot logically hold together. "
        "Compatible preferences, requirements and deliverables must remain multi-select. "
        "After answers arrive, continue the original task without restating the plan or "
        "asking approval-only questions. For an explicitly requested interview or grill-me, "
        "continue rounds when answers unlock dependent decisions, without repeating resolved questions. "
        "Whenever you ask the person a question, use this tool rather than visible assistant text. "
        "Do not use this tool for execution permission."
    )
    input_model = AskUserQuestionToolInput

    def is_read_only(self, arguments: AskUserQuestionToolInput) -> bool:
        del arguments
        return True

    async def execute(
        self,
        arguments: AskUserQuestionToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        prompt = context.metadata.get("ask_user_prompt")
        if not callable(prompt):
            return ToolResult(
                output="ask_user_question is unavailable in this session",
                is_error=True,
            )
        # Route legacy tool arguments through the same structured GUI contract when supported.
        if not arguments.questions:
            try:
                parameters = inspect.signature(prompt).parameters.values()
                supports_round = any(
                    param.name == "questions" or param.kind == inspect.Parameter.VAR_KEYWORD
                    for param in parameters
                )
            except (TypeError, ValueError):
                supports_round = False
            if supports_round:
                arguments = AskUserQuestionToolInput(questions=[UserQuestion(
                    id="question", question=arguments.question, choices=arguments.choices,
                    multi_select=arguments.multi_select,
                )])
        if arguments.questions:
            questions = [item.model_dump(exclude_none=True) for item in arguments.questions]
            try:
                parameters = inspect.signature(prompt).parameters.values()
                supports_questions = any(
                    param.name == "questions" or param.kind == inspect.Parameter.VAR_KEYWORD
                    for param in parameters
                )
            except (TypeError, ValueError):
                supports_questions = True
            if supports_questions:
                answer = await prompt("", questions=questions)
            else:
                # Terminal and older integrations retain all question/choice context.
                text = "\n\n".join(
                    f"({index + 1}/{len(questions)}) {item['question']}\n"
                    + ("[Select multiple]\n" if item["multi_select"] else "[Select one]\n")
                    + "\n".join(
                        f"- {choice.get('label') or choice['value']}: {choice.get('description', '')}"
                        for choice in item["choices"]
                    )
                    for index, item in enumerate(questions)
                )
                answer = await prompt(text)
            return ToolResult(output=str(answer).strip() or "(no response)")
        choices = [
            choice.model_dump(exclude_none=True)
            for choice in arguments.choices
            if choice.value.strip()
        ]
        answer = str(await _call_user_prompt(prompt, arguments.question, choices)).strip()
        if not answer:
            return ToolResult(output="(no response)")
        return ToolResult(output=answer)


async def _call_user_prompt(prompt: AskUserPrompt, question: str, choices: list[dict[str, str]]) -> str:
    """Call old one-argument prompts or newer prompts that accept structured choices."""
    if not choices:
        return await prompt(question)
    try:
        signature = inspect.signature(prompt)
    except (TypeError, ValueError):
        return await prompt(question, choices=choices)

    parameters = list(signature.parameters.values())
    accepts_kwargs = any(param.kind == inspect.Parameter.VAR_KEYWORD for param in parameters)
    accepts_args = any(param.kind == inspect.Parameter.VAR_POSITIONAL for param in parameters)
    accepts_choices_kw = any(param.name == "choices" for param in parameters)
    positional_capacity = sum(
        1
        for param in parameters
        if param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    )
    if accepts_kwargs or accepts_choices_kw:
        return await prompt(question, choices=choices)
    if accepts_args or positional_capacity >= 2:
        return await prompt(question, choices)
    return await prompt(question)
