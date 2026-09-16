"""Validate and describe a submitted question round at the UI boundary."""

import json


def resolve_question_answers(questions: list[dict], raw: str) -> tuple[str, str]:
    """Return a model-readable result and a human-readable history entry."""
    try:
        answers = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError("질문별 답변을 확인해 주세요.") from exc
    if not isinstance(answers, list) or len(answers) != len(questions):
        raise ValueError("모든 질문에 답변해 주세요.")
    by_id = {}
    for answer in answers:
        if not isinstance(answer, dict) or not isinstance(answer.get("id"), str):
            raise ValueError("질문별 답변을 확인해 주세요.")
        if answer["id"] in by_id:
            raise ValueError("중복된 질문 답변이 있습니다.")
        by_id[answer["id"]] = answer
    if set(by_id) != {question["id"] for question in questions}:
        raise ValueError("현재 질문과 답변이 일치하지 않습니다.")
    results, transcript = [], []
    for question in questions:
        answer = by_id[question["id"]]
        value = answer.get("answer")
        if not isinstance(value, str) or not value.strip():
            raise ValueError("빈 답변은 보낼 수 없습니다.")
        value = value.strip()
        kind = answer.get("kind")
        label = value
        if kind == "choice":
            choice = next((item for item in question["choices"] if item["value"] == value), None)
            if choice is None:
                raise ValueError("현재 선택지에 없는 답변입니다.")
            label = choice.get("label") or value
        elif kind != "text":
            raise ValueError("답변 유형을 확인해 주세요.")
        results.append({"id": question["id"], "question": question["question"],
                        "answer": value, "label": label, "kind": kind})
        transcript.append(f"질문 {len(results)}: {question['question']}\n답변: {label}")
    return json.dumps({"answers": results}, ensure_ascii=False), "\n\n".join(transcript)
