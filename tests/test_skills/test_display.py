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


def test_learned_skill_description_uses_korean_fallback():
    description = "Use when MyHarness sees this repeated verified failure pattern: web_search: No search results found."

    assert translate_skill_description("learned-web-search-no-search-results-found", description).startswith("MyHarness가 반복적으로 확인한")
