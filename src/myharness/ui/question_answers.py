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
        kind = answer.get("kind")
        if kind == "choice":
            values = value if isinstance(value, list) else [value]
            if not values or any(not isinstance(item, str) or not item.strip() for item in values):
                raise ValueError("빈 답변은 보낼 수 없습니다.")
            values = [item.strip() for item in values]
            if len(set(values)) != len(values):
                raise ValueError("중복된 선택지가 있습니다.")
            if question.get("multi_select", True) is False and len(values) > 1:
                raise ValueError("이 질문은 하나의 선택지만 선택해 주세요.")
            choices = {item["value"]: item for item in question["choices"]}
            if any(item not in choices for item in values):
                raise ValueError("현재 선택지에 없는 답변입니다.")
            labels = [choices[item].get("label") or item for item in values]
            label = labels if isinstance(value, list) else labels[0]
            value = values if isinstance(value, list) else values[0]
        elif kind == "text":
            if not isinstance(value, str) or not value.strip():
                raise ValueError("빈 답변은 보낼 수 없습니다.")
            value = value.strip()
            label = value
        else:
            raise ValueError("답변 유형을 확인해 주세요.")
        results.append({"id": question["id"], "question": question["question"],
                        "answer": value, "label": label, "kind": kind})
        display = ", ".join(label) if isinstance(label, list) else label
        transcript.append(f"질문 {len(results)}: {question['question']}\n답변: {display}")
    return json.dumps({"answers": results}, ensure_ascii=False), "\n\n".join(transcript)
