from myharness.skills.display import display_skill_description, translate_skill_description
from myharness.skills.types import SkillDefinition


def test_known_skill_description_is_translated_for_display():
    skill = SkillDefinition(
        name="skill-creator",
        description=(
            "Guide for creating effective skills. This skill should be used when users want to create a new skill "
            "(or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, "
            "or tool integrations."
        ),
        content="# skill-creator\n",
        source="project",
    )

    assert display_skill_description(skill).startswith("효과적인 스킬을 만들거나")
    assert skill.description.startswith("Guide for creating effective skills.")


def test_unmapped_skill_description_stays_original():
    description = "Use this brand-new imported workflow exactly as written."

    assert translate_skill_description("new-imported-skill", description) == description


def test_program_skill_description_is_translated_by_name():
    description = "Create clean, well-structured git commits."

    assert translate_skill_description("commit", description) == "작업 내용을 깔끔하고 구조화된 git 커밋으로 정리해야 할 때 사용합니다."


def test_frontend_design_display_scope_prioritizes_homepages_not_reports():
    translated = translate_skill_description("frontend-design", "Create distinctive frontend interfaces.")

    assert "홈페이지" in translated
    assert "랜딩 페이지" in translated
    assert "앱 UI" in translated
    assert "HTML 보고서" in translated
    assert "`visual-artifact`" in translated
    assert "`html-a4-landscape-report`" in translated


def test_ui_design_essence_display_scope_is_supporting_guardrail():
    translated = translate_skill_description("ui-design-essence", "Visual UI design standards.")

    assert "보조 가드레일" in translated
    assert "주 생성 스킬" in translated
    assert "`visual-artifact`" in translated
    assert "`html-a4-landscape-report`" in translated
    assert "`frontend-design`" in translated


def test_learned_skill_description_uses_korean_fallback():
    description = "Use when MyHarness sees this repeated verified failure pattern: web_search: No search results found."

    assert translate_skill_description("learned-web-search-no-search-results-found", description).startswith("MyHarness가 반복적으로 확인한")
