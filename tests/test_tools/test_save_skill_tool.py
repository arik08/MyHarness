import pytest
import yaml

import myharness.tools.save_skill_tool as save_skill_module
from myharness.tools.base import ToolExecutionContext
from myharness.tools.save_skill_tool import SaveSkillTool, SaveSkillToolInput


@pytest.mark.asyncio
async def test_save_skill_creates_complete_skill_with_supporting_script(tmp_path, monkeypatch):
    target_root = tmp_path / "program" / ".skills" / "POSCO_Skill"
    monkeypatch.setattr(save_skill_module, "get_default_learning_skills_dir", lambda: target_root)
    monkeypatch.setattr(save_skill_module, "load_skill_registry", lambda *args, **kwargs: {})
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={"invoked_skills": ["skill-creator"]},
    )

    result = await SaveSkillTool().execute(
        SaveSkillToolInput(
            name="annyeonghi-gaseyo",
            description=(
                "사용자가 안녕히 가세요, 잘 가, 이만 갈게요처럼 작별 인사를 할 때 "
                "짧고 정중한 한국어 작별 인사로 응답합니다."
            ),
            instructions=(
                "# 안녕히 가세요\n\n"
                "사용자의 말투에 맞춰 한 문장으로 자연스럽게 작별 인사하세요."
            ),
            display_name="안녕히 가세요",
            short_description="안녕히 가세요 인사에 짧게 응답",
            default_prompt="작별 인사에 정중하게 응답해 주세요.",
            supporting_files=[
                {
                    "path": "scripts/random_suffix.py",
                    "content": "import random\n\nprint(random.randint(0, 9999))\n",
                }
            ],
        ),
        context,
    )

    skill_dir = target_root / "annyeonghi-gaseyo"
    assert result.is_error is False
    assert "scripts/random_suffix.py" in result.output.replace("\\", "/")
    assert "no Python initialization command" in result.output
    assert "[TODO" not in (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    assert (skill_dir / "scripts" / "random_suffix.py").read_text(encoding="utf-8") == (
        "import random\n\nprint(random.randint(0, 9999))\n"
    )
    assert str(skill_dir / "scripts" / "random_suffix.py") in result.metadata["written_files"]
    interface = yaml.safe_load((skill_dir / "agents" / "openai.yaml").read_text(encoding="utf-8"))[
        "interface"
    ]
    assert 25 <= len(interface["short_description"]) <= 64
    assert "$annyeonghi-gaseyo" in interface["default_prompt"]
    assert context.metadata["skill_registry_dirty"] is True


@pytest.mark.asyncio
async def test_save_skill_updates_existing_skill_in_place(tmp_path, monkeypatch):
    skill_dir = tmp_path / ".skills" / "existing-skill"
    skill_dir.mkdir(parents=True)
    skill_path = skill_dir / "SKILL.md"
    skill_path.write_text(
        "---\nname: existing-skill\ndescription: Old description.\n---\n\n# Old\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        save_skill_module,
        "get_default_learning_skills_dir",
        lambda: tmp_path / "unused",
    )
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={"invoked_skills": ["skill-creator"]},
    )

    result = await SaveSkillTool().execute(
        SaveSkillToolInput(
            name="existing-skill",
            mode="update",
            description="Updated trigger description for an existing skill.",
            instructions="# Updated\n\nFollow the updated instructions.",
        ),
        context,
    )

    assert result.is_error is False
    assert str(skill_path) in result.metadata["skill_path"]
    assert "Updated trigger description" in skill_path.read_text(encoding="utf-8")
    assert not (tmp_path / "unused" / "existing-skill").exists()


def test_default_registry_exposes_save_skill_tool():
    from myharness.tools import create_default_tool_registry

    registry = create_default_tool_registry()

    assert registry.get("save_skill") is not None


@pytest.mark.asyncio
async def test_save_skill_requires_skill_creator_in_current_session(tmp_path, monkeypatch):
    target_root = tmp_path / "program" / ".skills" / "POSCO_Skill"
    monkeypatch.setattr(save_skill_module, "get_default_learning_skills_dir", lambda: target_root)

    result = await SaveSkillTool().execute(
        SaveSkillToolInput(
            name="skipped-guidance",
            description="Use when testing a skill creation prerequisite.",
            instructions="# Skipped guidance\n\nThis must not be written.",
        ),
        ToolExecutionContext(cwd=tmp_path),
    )

    assert result.is_error is True
    assert "skill(name='skill-creator', mode='use')" in result.output
    assert not target_root.exists()


@pytest.mark.asyncio
async def test_save_skill_rejects_invalid_description_before_creating_files(tmp_path, monkeypatch):
    target_root = tmp_path / "program" / ".skills" / "POSCO_Skill"
    monkeypatch.setattr(save_skill_module, "get_default_learning_skills_dir", lambda: target_root)
    monkeypatch.setattr(save_skill_module, "load_skill_registry", lambda *args, **kwargs: {})

    result = await SaveSkillTool().execute(
        SaveSkillToolInput(
            name="invalid-description",
            description="Use this for <placeholder> requests.",
            instructions="# Invalid\n\nThis must not be written.",
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={"invoked_skills": ["skill-creator"]},
        ),
    )

    assert result.is_error is True
    assert "angle brackets" in result.output
    assert not target_root.exists()


@pytest.mark.asyncio
async def test_save_skill_rejects_supporting_file_path_traversal(tmp_path, monkeypatch):
    target_root = tmp_path / "program" / ".skills" / "POSCO_Skill"
    monkeypatch.setattr(save_skill_module, "get_default_learning_skills_dir", lambda: target_root)
    monkeypatch.setattr(save_skill_module, "load_skill_registry", lambda *args, **kwargs: {})

    result = await SaveSkillTool().execute(
        SaveSkillToolInput(
            name="unsafe-support",
            description="Use when testing supporting file path validation.",
            instructions="# Unsafe support\n\nDo not save paths outside the skill.",
            supporting_files=[{"path": "scripts/../../outside.py", "content": "print('no')\n"}],
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={"invoked_skills": ["skill-creator"]},
        ),
    )

    assert result.is_error is True
    assert "scripts/, references/, or assets/" in result.output
    assert not target_root.exists()
