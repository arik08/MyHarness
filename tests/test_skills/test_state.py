from __future__ import annotations

import json

from myharness.skills.state import get_skill_state_path, set_skill_enabled, toggle_skill_enabled


def test_skill_state_updates_are_locked_and_toggle_from_one_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    assert set_skill_enabled("Ship", False) is False
    assert toggle_skill_enabled("ship") is True
    assert toggle_skill_enabled("ship") is False

    state_path = get_skill_state_path()
    assert json.loads(state_path.read_text(encoding="utf-8")) == {"disabled_skills": ["ship"]}
    assert state_path.with_suffix(".json.lock").exists()
