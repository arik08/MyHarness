from pathlib import Path

from myharness.skills.refresh import is_skill_catalog_change


def test_skill_catalog_change_matches_skill_and_plugin_metadata_only():
    assert is_skill_catalog_change(Path(".skills/POSCO_Skill/demo/SKILL.md")) is True
    assert is_skill_catalog_change(Path(".plugins/demo/plugin.json")) is True
    assert is_skill_catalog_change(Path(".skills/POSCO_Skill/demo/agents/openai.yaml")) is False
    assert is_skill_catalog_change(Path(".skills/General/tool/__pycache__/helper.pyc")) is False
