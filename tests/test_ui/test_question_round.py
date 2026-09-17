import asyncio
import io
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from myharness.tools.ask_user_question_tool import AskUserQuestionTool, AskUserQuestionToolInput
from myharness.tools.base import ToolExecutionContext
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.question_answers import resolve_question_answers


QUESTIONS = [
    {"id": "audience", "question": "누가 읽나요?", "choices": [{"value": "board", "label": "임원"}]},
    {"id": "detail", "question": "추가 조건은?", "choices": []},
]
ANSWERS = [
    {"id": "detail", "answer": "회사 내부용\n세부 근거 포함", "kind": "text"},
    {"id": "audience", "answer": "board", "kind": "choice"},
]


@pytest.mark.asyncio
@pytest.mark.parametrize("multiple", [False, True])
async def test_round_travels_from_tool_through_host_and_back(monkeypatch, tmp_path, multiple):
    host = ReactBackendHost(BackendHostConfig())
    questions = [dict(QUESTIONS[0], multi_select=multiple, choices=[
        *QUESTIONS[0]["choices"], {"value": "team", "label": "실무자"},
    ]), QUESTIONS[1]]
    submitted = [ANSWERS[0], dict(ANSWERS[1], answer=["board", "team"] if multiple else "board")]
    events = []
    reader = None

    async def emit(event):
        nonlocal reader
        events.append(event)
        if event.type == "modal_request" and event.modal.get("questions") and not event.modal.get("error"):
            request_id = event.modal["request_id"]
            assert event.modal["questions"][1]["choices"] == []
            assert event.modal["questions"][0]["multi_select"] is multiple
            def wire(answers):
                return json.dumps({"type": "question_response", "request_id": request_id,
                                   "answer": json.dumps(answers)}).encode() + b"\n"
            # Invalid response must not resume execution; valid duplicate must not duplicate history.
            monkeypatch.setattr("myharness.ui.backend_host.sys.stdin", SimpleNamespace(
                buffer=io.BytesIO(wire([]) + wire(submitted) + wire(submitted))))
            reader = asyncio.create_task(host._read_requests())

    host._emit = emit
    result = await asyncio.wait_for(AskUserQuestionTool().execute(
        AskUserQuestionToolInput(questions=questions),
        ToolExecutionContext(cwd=tmp_path, metadata={"ask_user_prompt": host._ask_question}),
    ), timeout=5)
    await reader
    answers = json.loads(result.output)["answers"]
    assert [item["id"] for item in answers] == ["audience", "detail"]
    assert answers[0]["answer"] == (["board", "team"] if multiple else "board")
    assert answers[0]["label"] == (["임원", "실무자"] if multiple else "임원")
    assert answers[1]["answer"] == "회사 내부용\n세부 근거 포함"
    assert len([event for event in events if event.type == "transcript_item"]) == 1
    assert any(event.modal and event.modal.get("error") for event in events)
    assert any(event.modal and event.modal.get("status") == "answered" for event in events)
    assert not host._question_requests


@pytest.mark.asyncio
async def test_round_preserves_questions_in_legacy_terminal_prompt(tmp_path):
    seen = []
    async def prompt(question):
        seen.append(question)
        return "임원용, 내부 근거 포함"
    result = await AskUserQuestionTool().execute(AskUserQuestionToolInput(questions=QUESTIONS),
        ToolExecutionContext(cwd=tmp_path, metadata={"ask_user_prompt": prompt}))
    assert "누가 읽나요?" in seen[0] and "임원" in seen[0] and "추가 조건은?" in seen[0]
    assert result.output == "임원용, 내부 근거 포함"


@pytest.mark.parametrize("answers", [[], ANSWERS[:1], [ANSWERS[0], ANSWERS[0]],
    [{"id": "unknown", "answer": "x", "kind": "text"}, ANSWERS[0]],
    [{"id": "audience", "answer": "invalid", "kind": "choice"}, ANSWERS[0]],
    [{"id": "audience", "answer": "  ", "kind": "text"}, ANSWERS[0]],
])
def test_invalid_answers_are_rejected(answers):
    with pytest.raises(ValueError):
        resolve_question_answers(QUESTIONS, json.dumps(answers))


@pytest.mark.parametrize("arguments", [{}, {"questions": [QUESTIONS[0], QUESTIONS[0]]},
    {"question": "legacy", "questions": QUESTIONS},
    {"questions": [{"id": "a", "question": " ", "choices": []}]},
])
def test_invalid_question_contract_is_rejected(arguments):
    with pytest.raises(ValidationError):
        AskUserQuestionToolInput(**arguments)


def test_choice_values_and_question_ids_are_normalized_before_delivery():
    arguments = AskUserQuestionToolInput(questions=[{
        "id": "  new-id  ", "question": "Question", "choices": [{"value": " value "}],
    }])
    question = arguments.questions[0].model_dump()
    assert question["id"] == "new-id"
    result, _ = resolve_question_answers([question], json.dumps([
        {"id": "new-id", "answer": "value", "kind": "choice"},
    ]))
    assert json.loads(result)["answers"][0]["answer"] == "value"


@pytest.mark.asyncio
async def test_cancellation_clears_pending_question_and_emits_dismissal():
    host = ReactBackendHost(BackendHostConfig())
    emitted = []
    ready = asyncio.Event()
    async def emit(event):
        emitted.append(event)
        ready.set()
    host._emit = emit
    task = asyncio.create_task(host._ask_question("", questions=QUESTIONS))
    await asyncio.wait_for(ready.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert emitted[-1].modal["status"] == "cancelled"
    assert not host._question_requests
    assert not host._question_request_details


@pytest.mark.parametrize("mode", [True, False])
def test_selection_mode_enforces_cardinality_without_losing_values(mode):
    question = {"id": "new", "question": "Choose", "multi_select": mode,
                "choices": [{"value": "a,b", "label": "First"}, {"value": "c", "label": "Second"}]}
    raw = json.dumps([{"id": "new", "kind": "choice", "answer": ["a,b", "c"]}])
    if not mode:
        with pytest.raises(ValueError, match="하나"):
            resolve_question_answers([question], raw)
    else:
        result, transcript = resolve_question_answers([question], raw)
        assert json.loads(result)["answers"][0]["answer"] == ["a,b", "c"]
        assert "First, Second" in transcript


@pytest.mark.parametrize("value", [[], ["board", "board"], ["unknown"], [None], [1]])
def test_invalid_multiple_selections_are_rejected(value):
    with pytest.raises(ValueError):
        resolve_question_answers(QUESTIONS, json.dumps([
            {"id": "audience", "kind": "choice", "answer": value}, ANSWERS[0]]))


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [True, False])
async def test_legacy_tool_uses_question_round_with_model_selected_mode(tmp_path, mode):
    captured = []
    async def prompt(question, *, questions):
        captured.extend(questions)
        return "done"
    await AskUserQuestionTool().execute(
        AskUserQuestionToolInput(question="Choose", choices=[{"value": "new"}], multi_select=mode),
        ToolExecutionContext(cwd=tmp_path, metadata={"ask_user_prompt": prompt}))
    assert captured[0]["multi_select"] is mode
    assert captured[0]["choices"][0]["value"] == "new"


def test_model_schema_defaults_to_multiple_and_explains_exception():
    schema = AskUserQuestionToolInput.model_json_schema()
    field = schema["$defs"]["UserQuestion"]["properties"]["multi_select"]
    assert field["default"] is True
    assert "logically incompatible" in field["description"]
