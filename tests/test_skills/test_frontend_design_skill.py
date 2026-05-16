from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_design_skill_is_scoped_to_sites_and_app_ui_not_reports():
    skill_text = (ROOT / ".skills" / "frontend-design" / "SKILL.md").read_text(encoding="utf-8")

    assert "homepage, landing page, marketing site, product site" in skill_text
    assert "app UI, prototype, demo, game UI" in skill_text
    assert "Do not use it for HTML reports" in skill_text
    assert "use visual-artifact or html-a4-landscape-report" in skill_text
    assert "Use `visual-artifact` for scrolling HTML reports" in skill_text
