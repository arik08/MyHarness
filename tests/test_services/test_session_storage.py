"""Tests for session persistence."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import myharness.services.session_storage as session_storage
import pytest
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock
from myharness.services.session_storage import (
    delete_session_by_id,
    display_summary_for_first_user,
    export_session_markdown,
    fallback_session_title_from_user_text,
    get_project_session_dir,
    list_session_snapshots,
    load_session_by_id,
    load_session_snapshot,
    migrate_session_snapshots,
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


def test_new_session_storage_uses_compact_utf8_snapshot_and_latest_pointer(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    latest_path = save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="시스템 지침",
        messages=[ConversationMessage.from_user_text("한글 대화")],
        usage=UsageSnapshot(),
        session_id="compactutf8",
    )
    session_path = get_project_session_dir(project) / "session-compactutf8.json"
    serialized = session_path.read_text(encoding="utf-8")
    stored = json.loads(serialized)
    pointer = json.loads(latest_path.read_text(encoding="utf-8"))

    assert serialized.count("\n") == 1
    assert "한글 대화" in serialized
    assert "\\ud55c" not in serialized
    assert stored["storage_version"] == session_storage._SESSION_STORAGE_VERSION
    assert "system_prompt" not in stored
    assert stored["system_prompt_hash"] == hashlib.sha256("시스템 지침".encode("utf-8")).hexdigest()
    assert pointer == {
        "format": session_storage._SESSION_POINTER_FORMAT,
        "version": 1,
        "session_id": "compactutf8",
    }
    assert latest_path.stat().st_size < 120
    assert load_session_snapshot(project)["messages"] == stored["messages"]


def test_migrate_session_snapshots_preserves_messages_and_compacts_legacy_files(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    session_dir = get_project_session_dir(project)
    large_input = "보고서 본문 " * 20_000
    large_output = "도구 결과 " * 20_000
    legacy = {
        "session_id": "legacy123",
        "cwd": str(project),
        "model": "claude-test",
        "system_prompt": "과거 시스템 지침",
        "messages": [ConversationMessage.from_user_text("유용한 과거 세션").model_dump(mode="json")],
        "history_events": [
            {"type": "tool_progress", "tool_name": "write_file", "tool_call_id": "write-1", "tool_input": {"content": large_input}, "message": "1초"},
            {"type": "tool_progress", "tool_name": "write_file", "tool_call_id": "write-1", "tool_input": {"content": large_input}, "message": "2초"},
            {"type": "tool_completed", "tool_name": "skill", "tool_call_id": "skill-1", "output": large_output, "is_error": False},
            {"type": "assistant", "text": "완료"},
        ],
        "usage": UsageSnapshot().model_dump(mode="json"),
        "tool_metadata": {},
        "created_at": 100,
        "summary": "보존할 세션",
        "message_count": 1,
        "pinned": False,
    }
    original = json.dumps(legacy, indent=2) + "\n"
    session_path = session_dir / "session-legacy123.json"
    latest_path = session_dir / "latest.json"
    session_path.write_text(original, encoding="utf-8")
    latest_path.write_text(original, encoding="utf-8")
    before = session_path.stat().st_size + latest_path.stat().st_size

    result = migrate_session_snapshots(project, force=True)

    after = session_path.stat().st_size + latest_path.stat().st_size
    stored = json.loads(session_path.read_text(encoding="utf-8"))
    pointer = json.loads(latest_path.read_text(encoding="utf-8"))
    assert result["migrated"] == 1
    assert result["pointers"] == 1
    assert after < before // 10
    assert "system_prompt" not in stored
    assert stored["system_prompt_hash"] == hashlib.sha256("과거 시스템 지침".encode("utf-8")).hexdigest()
    assert stored["messages"] == legacy["messages"]
    assert pointer["session_id"] == "legacy123"
    progress = [event for event in stored["history_events"] if event["type"] == "tool_progress"]
    assert progress == [{
        "type": "tool_progress",
        "tool_name": "write_file",
        "tool_call_id": "write-1",
        "tool_input": {},
        "message": "2초",
    }]
    completed = next(event for event in stored["history_events"] if event["type"] == "tool_completed")
    assert len(completed["output"]) <= session_storage._HISTORY_TOOL_OUTPUT_MAX_CHARS
    assert load_session_snapshot(project)["messages"] == legacy["messages"]
    assert (session_dir / "session-legacy123.meta").exists()
    assert (session_dir / "latest.meta").exists()
    assert json.loads((session_dir / "session-legacy123.meta").read_text(encoding="utf-8"))["storage_version"] == 2

    second = migrate_session_snapshots(project, force=True)
    assert second["migrated"] == 0
    assert second["pointers"] == 0


def test_migrate_session_snapshots_promotes_orphan_latest_before_pointer_conversion(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    session_dir = get_project_session_dir(project)
    legacy = {
        "session_id": "orphan123",
        "model": "claude-test",
        "system_prompt": "system",
        "messages": [ConversationMessage.from_user_text("latest에만 있던 세션").model_dump(mode="json")],
        "history_events": [],
        "usage": UsageSnapshot().model_dump(mode="json"),
        "created_at": 100,
        "summary": "orphan",
    }
    (session_dir / "latest.json").write_text(json.dumps(legacy), encoding="utf-8")

    result = migrate_session_snapshots(project, force=True)

    assert result["promoted"] == 1
    assert (session_dir / "session-orphan123.json").exists()
    assert json.loads((session_dir / "latest.json").read_text(encoding="utf-8"))["format"] == session_storage._SESSION_POINTER_FORMAT
    assert load_session_snapshot(project)["messages"] == legacy["messages"]


def test_migration_trusts_fresh_current_metadata_but_rechecks_changed_snapshots(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    session_dir = get_project_session_dir(project)
    session_path = session_dir / "session-marked123.json"
    marked = {
        "storage_version": 2,
        "session_id": "marked123",
        "model": "claude-test",
        "system_prompt": "메타가 최신일 때는 본문을 다시 검사하지 않음",
        "messages": [ConversationMessage.from_user_text("완료 표식 테스트").model_dump(mode="json")],
        "history_events": [],
        "usage": UsageSnapshot().model_dump(mode="json"),
        "created_at": 100,
        "summary": "완료 표식",
    }
    original = json.dumps(marked, ensure_ascii=False, separators=(",", ":")) + "\n"
    session_path.write_text(original, encoding="utf-8")
    session_storage._write_snapshot_summary(session_path, marked)

    first = migrate_session_snapshots(project, force=True)

    assert first["migrated"] == 0
    assert session_path.read_text(encoding="utf-8") == original

    session_path.write_text(original + " ", encoding="utf-8")
    second = migrate_session_snapshots(project, force=True)
    migrated = json.loads(session_path.read_text(encoding="utf-8"))

    assert second["migrated"] == 1
    assert "system_prompt" not in migrated


def test_saved_session_list_uses_compact_metadata_without_loading_full_history(
    tmp_path: Path, monkeypatch
):
    project = tmp_path / "repo"
    project.mkdir()
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="큰 세션 목록 테스트")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        session_id="compact123",
    )
    session_dir = get_project_session_dir(project)
    assert (session_dir / "session-compact123.meta").exists()
    assert (session_dir / "latest.meta").exists()

    full_loads: list[Path] = []
    original_load = session_storage._load_snapshot_file

    def record_full_load(path: Path):
        full_loads.append(path)
        return original_load(path)

    monkeypatch.setattr(session_storage, "_load_snapshot_file", record_full_load)

    sessions = list_session_snapshots(project)

    assert [item["session_id"] for item in sessions] == ["compact123"]
    assert sessions[0]["summary"] == "큰 세션 목록 테스트"
    assert full_loads == []

    assert delete_session_by_id(project, "compact123") is True
    assert not (session_dir / "session-compact123.meta").exists()
    assert not (session_dir / "latest.meta").exists()


def test_session_list_falls_back_when_compact_metadata_is_corrupt(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="fallback session")])],
        usage=UsageSnapshot(),
        session_id="fallback123",
    )
    session_dir = get_project_session_dir(project)
    (session_dir / "session-fallback123.meta").write_text("{broken", encoding="utf-8")

    sessions = list_session_snapshots(project)

    assert [item["session_id"] for item in sessions] == ["fallback123"]


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


def test_session_history_compacts_replay_only_tool_payloads(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()
    large_output = "fetch-head\n" + ("web evidence " * 8_000) + "\nfetch-tail"
    large_tool_output = "tool-head\n" + ("skill instructions " * 8_000) + "\ntool-tail"
    large_error_output = "error-head\n" + ("trace detail " * 8_000) + "\nerror-tail"
    large_content = "<html>\n" + ("<p>generated</p>\n" * 8_000) + "</html>"
    messages = [
        ConversationMessage.from_user_text("웹 자료를 확인해 보고서를 작성해줘"),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="fetch-1", name="web_fetch", input={"url": "https://example.com"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="fetch-1", content=large_output)],
        ),
        ConversationMessage(role="assistant", content=[TextBlock(text="완료했습니다.")]),
    ]

    save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=messages,
        usage=UsageSnapshot(),
        session_id="large-replay",
        history_events=[
            {"type": "user", "text": "웹 자료를 확인해 보고서를 작성해줘"},
            {
                "type": "tool_input_delta",
                "tool_name": "write_file",
                "arguments_delta": large_content,
            },
            {
                "type": "tool_started",
                "tool_name": "write_file",
                "tool_input": {"file_path": "outputs/report.html", "content": large_content},
            },
            {
                "type": "tool_progress",
                "tool_name": "write_file",
                "tool_input": {"file_path": "outputs/report.html", "content": large_content},
                "message": "파일 작성 중",
            },
            {
                "type": "tool_completed",
                "tool_name": "write_file",
                "output": "outputs/report.html",
                "is_error": False,
            },
            {
                "type": "tool_completed",
                "tool_name": "web_fetch",
                "output": large_output,
                "is_error": False,
            },
            {
                "type": "tool_completed",
                "tool_name": "skill",
                "output": large_tool_output,
                "is_error": False,
            },
            {
                "type": "tool_completed",
                "tool_name": "shell_command",
                "output": large_error_output,
                "is_error": True,
            },
            {"type": "assistant", "text": "완료했습니다."},
        ],
    )

    # Existing snapshots can still contain the pre-compaction replay payload.
    # Restore must compact those files on their first load as well.
    session_path = session_storage.get_project_session_dir(project) / "session-large-replay.json"
    legacy_snapshot = json.loads(session_path.read_text(encoding="utf-8"))
    legacy_events = legacy_snapshot["history_events"]
    legacy_events.insert(
        1,
        {
            "type": "tool_input_delta",
            "tool_name": "write_file",
            "arguments_delta": large_content,
        },
    )
    legacy_started = next(event for event in legacy_events if event["type"] == "tool_started")
    legacy_started["tool_input"] = {"file_path": "outputs/report.html", "content": large_content}
    legacy_events.insert(
        legacy_events.index(legacy_started) + 1,
        {
            "type": "tool_progress",
            "tool_name": "write_file",
            "tool_input": {"file_path": "outputs/report.html", "content": large_content},
            "message": "파일 작성 중",
        },
    )
    legacy_web_completed = next(
        event
        for event in legacy_events
        if event["type"] == "tool_completed" and event["tool_name"] == "web_fetch"
    )
    legacy_web_completed["output"] = large_output
    session_path.write_text(json.dumps(legacy_snapshot, ensure_ascii=False), encoding="utf-8")

    snapshot = load_session_by_id(project, "large-replay")

    assert snapshot is not None
    assert snapshot["messages"][2]["content"][0]["content"] == large_output
    replay_events = snapshot["history_events"]
    assert all(event["type"] != "tool_input_delta" for event in replay_events)
    started = next(event for event in replay_events if event["type"] == "tool_started")
    completed = next(
        event
        for event in replay_events
        if event["type"] == "tool_completed" and event["tool_name"] == "web_fetch"
    )
    write_completed = next(
        event
        for event in replay_events
        if event["type"] == "tool_completed" and event["tool_name"] == "write_file"
    )
    skill_completed = next(
        event
        for event in replay_events
        if event["type"] == "tool_completed" and event["tool_name"] == "skill"
    )
    error_completed = next(
        event
        for event in replay_events
        if event["type"] == "tool_completed" and event.get("is_error") is True
    )
    assert started["tool_input"] == {
        "file_path": "outputs/report.html",
        "_history_replay_truncated": True,
        "_history_replay_original_chars": len(
            json.dumps(
                {"file_path": "outputs/report.html", "content": large_content},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        ),
    }
    assert all(event["type"] != "tool_progress" for event in replay_events)
    assert write_completed["output"] == "outputs/report.html"
    assert len(completed["output"]) <= session_storage._HISTORY_WEB_TOOL_OUTPUT_MAX_CHARS
    assert completed["output"].startswith("fetch-head")
    assert completed["output"].endswith("fetch-tail")
    assert "이전 세션 빠른 복원을 위해 원문 축약" in completed["output"]
    assert len(skill_completed["output"]) <= session_storage._HISTORY_TOOL_OUTPUT_MAX_CHARS
    assert skill_completed["output"].startswith("tool-head")
    assert skill_completed["output"].endswith("tool-tail")
    assert len(error_completed["output"]) <= session_storage._HISTORY_TOOL_ERROR_OUTPUT_MAX_CHARS
    assert error_completed["output"].startswith("error-head")
    assert error_completed["output"].endswith("error-tail")

    pending_progress = session_storage._sanitize_history_events([
        {
            "type": "tool_progress",
            "tool_name": "write_file",
            "tool_call_id": "pending-write",
            "tool_input": {"content": large_content},
            "message": "3초 경과",
        },
        {
            "type": "tool_progress",
            "tool_name": "write_file",
            "tool_call_id": "pending-write",
            "tool_input": {"content": large_content},
            "message": "6초 경과",
        },
    ])
    assert pending_progress == [{
        "type": "tool_progress",
        "tool_name": "write_file",
        "tool_call_id": "pending-write",
        "tool_input": {},
        "message": "6초 경과",
    }]

    swarm_history = session_storage._sanitize_history_events([
        {"type": "swarm_status", "swarm_teammates": [{"id": "agent-1", "status": "running"}]},
        {"type": "assistant", "text": "중간 보고"},
        {"type": "swarm_status", "swarm_teammates": [{"id": "agent-1", "status": "completed"}]},
    ])
    assert swarm_history == [
        {"type": "assistant", "text": "중간 보고"},
        {"type": "swarm_status", "swarm_teammates": [{"id": "agent-1", "status": "completed"}]},
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


def test_session_storage_rejects_ids_with_path_separators(tmp_path: Path):
    project = tmp_path / "repo"
    project.mkdir()
    invalid_id = "../../../outside"

    with pytest.raises(ValueError, match="Invalid session id"):
        save_session_snapshot(
            cwd=project,
            model="claude-test",
            system_prompt="system",
            messages=[ConversationMessage.from_user_text("hello")],
            usage=UsageSnapshot(),
            session_id=invalid_id,
        )

    sentinel = project / ".myharness" / "outside.json"
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    sentinel.write_text("keep", encoding="utf-8")

    assert load_session_by_id(project, invalid_id) is None
    assert delete_session_by_id(project, invalid_id) is False
    assert sentinel.read_text(encoding="utf-8") == "keep"


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
