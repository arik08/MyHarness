import json
import threading

import pytest

from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
from myharness.services.session_storage import (
    get_project_session_dir, list_session_snapshots, save_session_snapshot,
    rewrite_session_snapshot_if_unchanged, update_session_metadata,
    load_session_by_id,
)


def save(project, *, metadata=None, new_answer=False):
    messages = [ConversationMessage.from_user_text("first question")]
    if new_answer:
        messages.append(ConversationMessage(role="assistant", content=[{"type": "text", "text": "new answer"}]))
    save_session_snapshot(
        cwd=project, model="fixture", system_prompt="fixture", messages=messages,
        usage=UsageSnapshot(), session_id="fixture", tool_metadata=metadata or {"session_title": "first question"},
    )
    return json.loads((get_project_session_dir(project) / "session-fixture.json").read_text(encoding="utf8"))


def test_picker_title_survives_stale_autosaves_and_a_new_explicit_edit_wins(tmp_path):
    project = tmp_path / "project"
    save(project)
    update_session_metadata(project, "fixture", {"title": "Manual name", "pinned": True, "liked": True})
    payload = save(project, new_answer=True)
    assert payload["summary"] == "Manual name"
    assert payload["pinned"] is True and payload["liked"] is True
    assert payload["messages"][-1]["content"][0]["text"] == "new answer"
    assert list_session_snapshots(project)[0]["summary"] == "Manual name"
    edit_time = payload["tool_metadata"]["session_title_updated_at"]
    changed = save(project, metadata={
        "session_title": "New explicit name", "session_title_user_edited": True,
        "session_title_updated_at": edit_time + 1,
    })
    assert changed["summary"] == "New explicit name"
    stale = save(project, metadata=payload["tool_metadata"])
    assert stale["summary"] == "New explicit name"


def test_legacy_manual_title_without_version_survives_regular_save(tmp_path):
    project = tmp_path / "project"
    save(project, metadata={"session_title": "Legacy manual name", "session_title_user_edited": True})
    assert save(project)["summary"] == "Legacy manual name"


def test_stale_web_repair_cannot_overwrite_new_answers(tmp_path):
    project = tmp_path / "project"
    old = save(project)
    path = get_project_session_dir(project) / "session-fixture.json"
    info = path.stat()
    save(project, new_answer=True)
    assert rewrite_session_snapshot_if_unchanged(project, path.name, old, {"size": info.st_size, "mtimeMs": info.st_mtime * 1000}) is False
    assert json.loads(path.read_text(encoding="utf8"))["messages"][-1]["content"][0]["text"] == "new answer"


def test_metadata_mutation_failure_releases_lock_without_corrupting_snapshot(tmp_path):
    project = tmp_path / "project"
    before = save(project)
    with pytest.raises(ValueError):
        update_session_metadata(project, "fixture", {"messages": []})
    directory = get_project_session_dir(project)
    assert json.loads((directory / "session-fixture.json").read_text(encoding="utf8")) == before
    result = update_session_metadata(project, "fixture", {"liked": True})
    assert result["liked"] is True


def test_load_migration_serializes_with_autosave_without_nested_lock_deadlock(tmp_path, monkeypatch):
    import myharness.services.session_storage as storage
    project = tmp_path / "project"
    old = save(project)
    path = get_project_session_dir(project) / "session-fixture.json"
    path.write_text(json.dumps(old, indent=2), encoding="utf8")
    entered = threading.Event()
    release = threading.Event()
    saved = threading.Event()
    failures = []
    original = storage.atomic_write_text

    def gated_write(target, data, **kwargs):
        if target == path and threading.current_thread().name == "load-migration":
            entered.set()
            assert release.wait(5)
        return original(target, data, **kwargs)

    def load():
        try:
            load_session_by_id(project, "fixture")
        except BaseException as error:
            failures.append(error)

    def autosave():
        try:
            save(project, new_answer=True)
            saved.set()
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr(storage, "atomic_write_text", gated_write)
    loader = threading.Thread(target=load, name="load-migration")
    writer = threading.Thread(target=autosave, name="autosave")
    try:
        loader.start()
        assert entered.wait(5)
        writer.start()
        assert not saved.wait(0.05)
    finally:
        release.set()
        loader.join(5)
        if writer.ident is not None:
            writer.join(5)
    assert not loader.is_alive() and not writer.is_alive()
    assert failures == []
    assert saved.is_set()
    assert json.loads(path.read_text(encoding="utf8"))["messages"][-1]["content"][0]["text"] == "new answer"
