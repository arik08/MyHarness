from pathlib import Path

from myharness.prompts.system_prompt import get_base_system_prompt
from myharness.skills import load_skill_registry


ROOT = Path(__file__).resolve().parents[2]


def test_visual_artifact_is_program_local_and_discoverable(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    registry = load_skill_registry(ROOT)
    skill = registry.get("visual-artifact")

    assert skill is not None
    assert skill.source == "skill-category:General"
    assert skill.path == str(ROOT / ".skills" / "General" / "visual-artifact" / "SKILL.md")
    assert "HTML" in skill.description
    assert "A4 landscape" in skill.content


def test_visual_artifact_handles_a4_without_requiring_an_installed_layout_skill():
    skill_text = (ROOT / ".skills" / "General" / "visual-artifact" / "SKILL.md").read_text(encoding="utf-8")

    assert "html-a4-landscape-report" in skill_text
    assert "A4 landscape" in skill_text or "A4 가로" in skill_text
    assert "only when the user explicitly asks" in skill_text
    assert "Use a suitable fixed-page report skill if available" in skill_text
    assert "otherwise implement explicit page dimensions, density limits, table splitting, and overflow QA directly" in skill_text


def test_visual_artifact_preserves_general_scrolling_report_design():
    skill_text = (ROOT / ".skills" / "General" / "visual-artifact" / "SKILL.md").read_text(encoding="utf-8")

    assert "ordinary report-style HTML should remain a web-native scrolling report" in skill_text
    assert "ordinary vertical HTML reports" in skill_text
    assert "It should feel designed, not like a plain document exported to HTML" in skill_text
    assert "Restrained does not mean all-white, gray, or template-like" in skill_text
    assert "Choose a visual concept before writing CSS" in skill_text
    assert "Choose the archetype yourself" in skill_text
    assert "Do not ask the user to choose a layout, style, or report archetype" in skill_text
    assert "Avoid defaulting to the same hero/KPI-card/three-section/table layout" in skill_text


def test_base_prompt_does_not_duplicate_a4_landscape_skill_rules():
    prompt = get_base_system_prompt()

    assert "A4 landscape" not in prompt
    assert "section.page" not in prompt
    assert "Page Plan" not in prompt
