from pathlib import Path

from myharness.prompts.system_prompt import get_base_system_prompt
from myharness.skills import load_skill_registry
from myharness.skills.display import translate_skill_description


ROOT = Path(__file__).resolve().parents[2]


def test_a4_landscape_report_skill_is_program_local_and_discoverable(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    registry = load_skill_registry(ROOT)
    skill = registry.get("html-a4-landscape-report")

    assert skill is not None
    assert skill.source == "program"
    assert skill.path == str(ROOT / ".skills" / "html-a4-landscape-report" / "SKILL.md")
    assert "A4" in skill.description
    assert "landscape" in skill.description
    assert "section.page" in skill.content
    assert "Page Plan" in skill.content


def test_visual_artifact_routes_a4_landscape_requests_to_specific_skill():
    skill_text = (ROOT / ".skills" / "visual-artifact" / "SKILL.md").read_text(encoding="utf-8")

    assert "html-a4-landscape-report" in skill_text
    assert "A4 landscape" in skill_text or "A4 가로" in skill_text
    assert "only when the user explicitly asks" in skill_text


def test_visual_artifact_preserves_general_scrolling_report_design():
    skill_text = (ROOT / ".skills" / "visual-artifact" / "SKILL.md").read_text(encoding="utf-8")

    assert "ordinary report-style HTML should remain a web-native scrolling report" in skill_text
    assert "ordinary vertical HTML reports" in skill_text
    assert "It should feel designed, not like a plain document exported to HTML" in skill_text
    assert "Restrained does not mean all-white, gray, or template-like" in skill_text
    assert "Choose a visual concept before writing CSS" in skill_text
    assert "Choose the archetype yourself" in skill_text
    assert "Do not ask the user to choose a layout, style, or report archetype" in skill_text
    assert "Avoid defaulting to the same hero/KPI-card/three-section/table layout" in skill_text


def test_a4_landscape_report_skill_description_is_translated_for_ui():
    translated = translate_skill_description(
        "html-a4-landscape-report",
        "Use when creating A4 landscape HTML reports.",
    )

    assert translated.startswith("A4 가로")
    assert "HTML" in translated


def test_a4_landscape_report_skill_default_prompt_mentions_skill_name():
    openai_yaml = (ROOT / ".skills" / "html-a4-landscape-report" / "agents" / "openai.yaml").read_text(encoding="utf-8")

    assert "$html-a4-landscape-report" in openai_yaml


def test_base_prompt_treats_a4_landscape_html_as_page_based_report():
    prompt = get_base_system_prompt()

    assert "A4 landscape" in prompt
    assert "section.page" in prompt
    assert "slide deck" in prompt
