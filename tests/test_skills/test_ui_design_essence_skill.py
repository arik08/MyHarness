from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_ui_design_essence_is_supporting_quality_guardrail_not_primary_creator():
    skill_text = (ROOT / ".skills" / "ui-design-essence" / "SKILL.md").read_text(encoding="utf-8")

    assert "Design-quality guardrails" in skill_text
    assert "supporting skill, not the primary creator" in skill_text
    assert "Use `frontend-design` as the primary skill" in skill_text
    assert "Use `visual-artifact` as the primary skill" in skill_text
    assert "Use `html-a4-landscape-report` together with `visual-artifact`" in skill_text
    assert "preserve the artifact type" in skill_text


def test_ui_design_essence_openai_metadata_matches_supporting_scope():
    openai_yaml = (ROOT / ".skills" / "ui-design-essence" / "agents" / "openai.yaml").read_text(encoding="utf-8")

    assert "UI quality guardrails and polish" in openai_yaml
    assert "supporting design-quality pass" in openai_yaml
    assert "preserve the requested artifact type" in openai_yaml
