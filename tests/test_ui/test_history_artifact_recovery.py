"""Saved output recovery must preserve artifacts without inventing assistant prose."""

from __future__ import annotations

import pytest

from myharness.engine.messages import ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock
from myharness.ui.backend_host import _recover_history_artifact_links


def _written_artifact_messages(path: str, *, is_error: bool = False) -> list[ConversationMessage]:
    return [
        ConversationMessage.from_user_text("분석 결과를 파일로 저장해 주세요."),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="write-1", name="write_file", input={"path": path, "content": "result"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="write-1", content="write result", is_error=is_error)],
        ),
    ]


@pytest.mark.parametrize("filename", ["분석_결과.html", "quarterly_findings.md", "new_export.csv"])
def test_recovered_history_keeps_artifact_without_fabricated_completion(tmp_path, filename):
    output = tmp_path / "outputs" / filename
    output.parent.mkdir()
    output.write_text("saved result", encoding="utf-8")
    path = output.relative_to(tmp_path).as_posix()
    history = [{"type": "user", "text": "분석 결과를 파일로 저장해 주세요."}]

    repaired = _recover_history_artifact_links(history, _written_artifact_messages(path), tmp_path)

    assert repaired == [
        *history,
        {
            "type": "assistant",
            "text": "",
            "has_tool_uses": False,
            "artifacts": [{"path": path, "name": filename, "size": output.stat().st_size}],
        },
    ]
    assert len(history) == 1


def test_recovered_history_preserves_substantive_assistant_text(tmp_path):
    output = tmp_path / "findings.md"
    output.write_text("saved result", encoding="utf-8")
    text = "수집 자료 4건을 비교했고, 미확인 항목은 보고서에 표시했습니다."
    messages = _written_artifact_messages(output.name)
    messages.append(ConversationMessage(role="assistant", content=[TextBlock(text=text)]))
    history = [{"type": "assistant", "text": text}]

    repaired = _recover_history_artifact_links(history, messages, tmp_path)

    assert repaired[0]["text"] == text
    assert repaired[0]["artifacts"] == [{"path": output.name, "name": output.name, "size": output.stat().st_size}]
    assert "artifacts" not in history[0]


@pytest.mark.parametrize("missing_file,is_error", [(True, False), (False, True)])
def test_unsaved_or_failed_outputs_do_not_create_completion_history(tmp_path, missing_file, is_error):
    output = tmp_path / "findings.md"
    if not missing_file:
        output.write_text("older result", encoding="utf-8")
    history = [{"type": "user", "text": "분석 결과를 파일로 저장해 주세요."}]

    repaired = _recover_history_artifact_links(
        history,
        _written_artifact_messages(output.name, is_error=is_error),
        tmp_path,
    )

    assert repaired == history
