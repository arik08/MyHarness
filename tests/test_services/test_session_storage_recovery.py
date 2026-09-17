"""Unreadable session files must not hide other usable conversations."""

from pathlib import Path
import json

import pytest

from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
from myharness.services.session_storage import (
    get_project_session_dir, list_session_snapshots, load_session_by_id,
    load_session_snapshot, save_session_snapshot,
)


def save(project: Path, session_id: str):
    save_session_snapshot(cwd=project, model="test", system_prompt="", session_id=session_id,
                          messages=[ConversationMessage.from_user_text("keep my conversation")], usage=UsageSnapshot())


@pytest.mark.parametrize("damaged_file", ["session-broken.json", "latest.json", "session-healthy.meta", "latest.meta"])
def test_invalid_utf8_does_not_break_healthy_history(tmp_path, damaged_file):
    save(tmp_path, "healthy")
    directory = get_project_session_dir(tmp_path)
    damaged = directory / damaged_file
    damaged.write_bytes(b"\xff\xfe\x80 invalid UTF-8")
    listed = list_session_snapshots(tmp_path)
    assert any(item["session_id"] == "healthy" for item in listed)
    assert load_session_by_id(tmp_path, "healthy")["session_id"] == "healthy"
    assert load_session_snapshot(tmp_path)["session_id"] == "healthy"
    if damaged.suffix == ".json":
        assert damaged.read_bytes() == b"\xff\xfe\x80 invalid UTF-8"


def test_loading_corrupt_named_snapshot_returns_none(tmp_path):
    directory = get_project_session_dir(tmp_path)
    (directory / "session-broken.json").write_bytes(b"\xffbad")
    assert load_session_by_id(tmp_path, "broken") is None


@pytest.mark.parametrize("damaged", [b"\xffbad", b"[]", b"null", b"42", b'"text"', b"{broken"])
def test_saving_live_conversation_recovers_damaged_existing_snapshot(tmp_path, damaged):
    save(tmp_path, "active")
    snapshot = get_project_session_dir(tmp_path) / "session-active.json"
    snapshot.write_bytes(damaged)

    save(tmp_path, "active")

    loaded = load_session_by_id(tmp_path, "active")
    assert loaded is not None
    assert loaded["messages"][0]["content"][0]["text"] == "keep my conversation"
    assert load_session_snapshot(tmp_path)["session_id"] == "active"


def test_missing_latest_pointer_still_restores_saved_conversation(tmp_path):
    save(tmp_path, "healthy")
    (get_project_session_dir(tmp_path) / "latest.json").unlink()
    loaded = load_session_snapshot(tmp_path)
    assert loaded is not None
    assert loaded["session_id"] == "healthy"


@pytest.mark.parametrize("session_id", ["", "../outside", "a/b", None])
def test_invalid_latest_pointer_does_not_become_empty_conversation(tmp_path, session_id):
    save(tmp_path, "healthy")
    latest = get_project_session_dir(tmp_path) / "latest.json"
    latest.write_text(json.dumps({"format": "myharness-session-pointer", "version": 1, "session_id": session_id}), encoding="utf-8")
    loaded = load_session_snapshot(tmp_path)
    assert loaded is not None
    assert loaded["session_id"] == "healthy"
