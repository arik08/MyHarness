"""Tests for session persistence."""

from __future__ import annotations

import json
from pathlib import Path

from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.services.session_storage import (
    delete_session_by_id,
    display_summary_for_first_user,
    export_session_markdown,
    fallback_session_title_from_user_text,
    get_project_session_dir,
    list_session_snapshots,
    load_session_by_id,
    load_session_snapshot,
    save_session_snapshot,
    title_matches_first_user,
    title_echoes_first_user,
)


def test_save_and_load_session_snapshot(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    path = save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="hello")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2, cached_input_tokens=1),
        usage_accounting={
            "total": {"input_tokens": 1, "output_tokens": 2, "cached_input_tokens": 1},
            "by_model": [
                {
                    "provider": "openai",
                    "model": "gpt-5.4",
                    "usage": {"input_tokens": 1, "output_tokens": 2, "cached_input_tokens": 1},
                }
            ],
        },
        tool_metadata={
            "task_focus_state": {"goal": "Fix compact carry-over"},
            "recent_verified_work": ["Focused session storage test passed"],
            "user_input_archive": [
                {
                    "id": "user-0001-alpha",
                    "turn_index": 1,
                    "timestamp": 123,
                    "text": "중요한 과거 사용자 입력",
                    "short_hint": "중요한 과거 사용자 입력",
                }
            ],
        },
    )

    assert path.exists()
    assert path == project / ".myharness" / "sessions" / "latest.json"
    snapshot = load_session_snapshot(project)
    assert snapshot is not None
    assert snapshot["model"] == "claude-test"
    assert snapshot["usage"]["output_tokens"] == 2
    assert snapshot["usage"]["cached_input_tokens"] == 1
    assert snapshot["usage_accounting"]["by_model"][0]["provider"] == "openai"
    assert snapshot["usage_accounting"]["by_model"][0]["usage"]["cached_input_tokens"] == 1
    assert snapshot["tool_metadata"]["task_focus_state"]["goal"] == "Fix compact carry-over"
    assert snapshot["tool_metadata"]["recent_verified_work"] == ["Focused session storage test passed"]
    assert snapshot["tool_metadata"]["user_input_archive"][0]["text"] == "중요한 과거 사용자 입력"


def test_worker_snapshots_are_hidden_from_history(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="역할: 조사 담당. 주제는 데이터센터 현황")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
    )

    assert load_session_snapshot(project) is None
    assert list_session_snapshots(project, limit=None) == []


def test_hidden_latest_falls_back_to_visible_session(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="일반 보고서")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="visible",
    )
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="역할: 조사 담당. 주제는 데이터센터 현황")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="worker",
    )

    snapshot = load_session_snapshot(project)

    assert snapshot is not None
    assert snapshot["session_id"] == "visible"
    assert [item["session_id"] for item in list_session_snapshots(project, limit=None)] == ["visible"]


def test_save_and_load_session_snapshot_keeps_history_events(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="보고서 만들어줘")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        history_events=[
            {"type": "user", "text": "보고서 만들어줘"},
            {"type": "tool_started", "tool_name": "shell_command", "tool_input": {"command": "pytest"}},
            {"type": "tool_completed", "tool_name": "shell_command", "output": "passed", "is_error": False},
            {"type": "assistant", "text": "완료했습니다."},
        ],
    )

    snapshot = load_session_snapshot(project)

    assert snapshot is not None
    assert snapshot["history_events"] == [
        {"type": "user", "text": "보고서 만들어줘"},
        {"type": "tool_started", "tool_name": "shell_command", "tool_input": {"command": "pytest"}},
        {"type": "tool_completed", "tool_name": "shell_command", "output": "passed", "is_error": False},
        {"type": "assistant", "text": "완료했습니다."},
    ]


def test_user_edited_session_title_is_preserved(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="삼성전자 보고서 만들어줘")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        tool_metadata={
            "session_title": "내가 정한 제목",
            "session_title_user_edited": True,
        },
    )

    snapshot = load_session_snapshot(project)
    assert snapshot is not None
    assert snapshot["summary"] == "내가 정한 제목"
    assert snapshot["tool_metadata"]["session_title_user_edited"] is True


def test_overwriting_session_snapshot_keeps_original_created_at(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    times = iter([100.0, 200.0])
    monkeypatch.setattr("myharness.services.session_storage.time.time", lambda: next(times))

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="첫 질문")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="stable-order",
    )
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="이어진 질문")])],
        usage=UsageSnapshot(input_tokens=3, output_tokens=4),
        session_id="stable-order",
    )

    snapshot = load_session_by_id(project, "stable-order")

    assert snapshot is not None
    assert snapshot["created_at"] == 100.0


def test_overwriting_session_snapshot_updates_last_assistant_activity(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    times = iter([100.0, 200.0])
    monkeypatch.setattr("myharness.services.session_storage.time.time", lambda: next(times))

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="첫 질문")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="active-order",
    )
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[
            ConversationMessage(role="user", content=[TextBlock(text="첫 질문")]),
            ConversationMessage(role="assistant", content=[TextBlock(text="답변")]),
        ],
        usage=UsageSnapshot(input_tokens=3, output_tokens=4),
        session_id="active-order",
        history_events=[{"type": "assistant", "text": "답변", "timestamp": 1_700_000_300_000}],
    )

    snapshot = load_session_by_id(project, "active-order")

    assert snapshot is not None
    assert snapshot["created_at"] == 100.0
    assert snapshot["last_assistant_at"] == 1_700_000_300_000.0


def test_list_session_snapshots_prioritizes_sessions_with_recent_assistant_answers(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    times = iter([100.0, 200.0, 300.0])
    monkeypatch.setattr("myharness.services.session_storage.time.time", lambda: next(times))

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="오래된 질문")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="old-user-only",
    )
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="최신 질문")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="new-user-only",
    )
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[
            ConversationMessage(role="user", content=[TextBlock(text="답변 있는 질문")]),
            ConversationMessage(role="assistant", content=[TextBlock(text="답변")]),
        ],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="answered",
        history_events=[{"type": "assistant", "text": "답변", "timestamp": 1_700_000_150_000}],
    )

    sessions = list_session_snapshots(project, limit=None)

    assert [item["session_id"] for item in sessions] == [
        "answered",
        "new-user-only",
        "old-user-only",
    ]


def test_export_session_markdown(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    path = export_session_markdown(
        cwd=project,
        messages=[
            ConversationMessage(role="user", content=[TextBlock(text="hello")]),
            ConversationMessage(role="assistant", content=[TextBlock(text="world")]),
        ],
    )

    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "MyHarness Session Transcript" in content
    assert "hello" in content
    assert "world" in content


def test_load_session_snapshot_sanitizes_legacy_empty_assistant_messages(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    target_dir = get_project_session_dir(project)
    payload = {
        "session_id": "legacy123",
        "cwd": str(project),
        "model": "claude-test",
        "system_prompt": "system",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": None},
            {"role": "assistant", "content": []},
            {"role": "assistant", "content": [{"type": "text", "text": "world"}]},
        ],
        "usage": {"input_tokens": 1, "output_tokens": 1},
        "tool_metadata": {},
        "created_at": 1.0,
        "summary": "hello",
        "message_count": 4,
    }
    (target_dir / "latest.json").write_text(json.dumps(payload), encoding="utf-8")

    snapshot = load_session_snapshot(project)
    assert snapshot is not None
    assert snapshot["message_count"] == 2
    assert [message["role"] for message in snapshot["messages"]] == ["user", "assistant"]
    assert snapshot["messages"][1]["content"][0]["text"] == "world"


def test_load_session_snapshot_returns_none_for_corrupt_json(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    (target_dir / "latest.json").write_text("{not valid json", encoding="utf-8")

    assert load_session_snapshot(project) is None


def test_load_session_snapshot_returns_none_for_non_object_json(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    (target_dir / "latest.json").write_text("[]", encoding="utf-8")

    assert load_session_snapshot(project) is None


def test_load_session_snapshot_returns_none_for_invalid_message_payload(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    payload = {
        "session_id": "broken",
        "cwd": str(project),
        "model": "claude-test",
        "system_prompt": "system",
        "messages": [{"role": "not-a-role", "content": [{"type": "text", "text": "hello"}]}],
        "usage": {},
        "tool_metadata": {},
        "created_at": 1.0,
        "summary": "broken",
        "message_count": 1,
    }
    (target_dir / "latest.json").write_text(json.dumps(payload), encoding="utf-8")

    assert load_session_snapshot(project) is None


def test_load_session_by_id_returns_none_for_corrupt_json(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    (target_dir / "session-broken.json").write_text("{not valid json", encoding="utf-8")

    assert load_session_by_id(project, "broken") is None


def test_list_session_snapshots_skips_invalid_message_payload(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    payload = {
        "session_id": "broken",
        "cwd": str(project),
        "model": "claude-test",
        "system_prompt": "system",
        "messages": [{"role": "not-a-role", "content": [{"type": "text", "text": "hello"}]}],
        "usage": {},
        "tool_metadata": {},
        "created_at": 1.0,
        "summary": "broken",
        "message_count": 1,
    }
    (target_dir / "session-broken.json").write_text(json.dumps(payload), encoding="utf-8")

    assert list_session_snapshots(project) == []


def test_delete_session_by_id_ignores_non_object_latest_json(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    latest = target_dir / "latest.json"
    latest.write_text("[]", encoding="utf-8")

    assert delete_session_by_id(project, "anything") is False
    assert latest.exists()


def test_delete_session_by_id_removes_matching_session_documents_only(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    target_dir = get_project_session_dir(project)
    session_path = target_dir / "session-abc123def456.json"
    session_path.write_text('{"session_id":"abc123def456"}', encoding="utf-8")
    target_docs = target_dir / "session-documents" / "abc123def456"
    other_docs = target_dir / "session-documents" / "def456abc123"
    target_docs.mkdir(parents=True)
    other_docs.mkdir(parents=True)
    (target_docs / "doc.txt").write_text("secret organization duties", encoding="utf-8")
    (other_docs / "doc.txt").write_text("keep this", encoding="utf-8")

    assert delete_session_by_id(project, "abc123def456") is True

    assert not session_path.exists()
    assert not target_docs.exists()
    assert other_docs.exists()
    assert (other_docs / "doc.txt").read_text(encoding="utf-8") == "keep this"


def test_korean_report_prompt_fallback_title_is_not_prompt_echo():
    prompt = (
        "삼성전자 메모리 경쟁사를 정의하고, 그 회사들의 최근 1주일 내 근황을 정리하여 "
        "md 보고서 만들고, 그걸로 html 보고서 만들어줘, 그리고 마지막으로 pptx 만들어줘"
    )

    assert fallback_session_title_from_user_text(prompt) == "삼성전자 메모리 경쟁사 보고서"


def test_display_summary_replaces_prompt_echo_title():
    prompt = (
        "삼성전자 메모리 경쟁사를 정의하고, 그 회사들의 최근 1주일 내 근황을 정리하여 "
        "md 보고서 만들고, 그걸로 html 보고서 만들어줘"
    )
    echoed = prompt[:80]

    assert title_echoes_first_user(echoed, prompt) is True
    assert display_summary_for_first_user(echoed, prompt) == "삼성전자 메모리 경쟁사 보고서"


def test_korean_first_clause_title_counts_as_prompt_echo():
    prompt = "삼성전자 메모리 경쟁사를 정의하고, 그 회사들의 최근 1주일 내 근황을 정리해줘"
    echoed_clause = "삼성전자 메모리 경쟁사를 정의하고"

    assert title_echoes_first_user(echoed_clause, prompt) is True
    assert display_summary_for_first_user(echoed_clause, prompt) == "삼성전자 메모리 경쟁사"


def test_korean_recommendation_prompt_fallback_title():
    assert fallback_session_title_from_user_text("서울 피자 맛집 추천해줘") == "서울 피자 맛집 추천"


def test_url_prompt_fallback_title_uses_link_context_not_url_prefix():
    prompt = "https://www.youtube.com/watch?v=LLTRqeHpY_U\n이 내용 설명해줘"

    assert fallback_session_title_from_user_text(prompt) == "YouTube 영상 설명"


def test_url_prompt_accepts_generated_conversation_title():
    prompt = "https://www.youtube.com/watch?v=LLTRqeHpY_U\n이 내용 설명해줘"
    generated = "꿈꾸는 AI와 메모리 설명"

    assert title_matches_first_user(generated, prompt) is True
    assert display_summary_for_first_user(generated, prompt) == generated


def test_list_session_snapshots_uses_clean_display_summary(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    prompt = (
        "삼성전자 메모리 경쟁사를 정의하고, 그 회사들의 최근 1주일 내 근황을 정리하여 "
        "md 보고서 만들고, 그걸로 html 보고서 만들어줘"
    )

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text=prompt)])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        tool_metadata={"session_title": prompt[:80]},
    )

    sessions = list_session_snapshots(project)

    assert sessions[0]["summary"] == "삼성전자 메모리 경쟁사 보고서"
