from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".skills" / "General" / "skill-creator" / "scripts"


def test_init_skill_validates_interface_before_creating_directory(tmp_path: Path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "init_skill.py"),
            "greeting-test",
            "--path",
            str(tmp_path),
            "--interface",
            "display_name=Greeting Test",
            "--interface",
            "short_description=간단한 인사 응답 테스트 스킬",
            "--interface",
            "default_prompt=$greeting-test 스킬로 정중하게 인사하세요.",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 1
    assert "short_description must be 25-64 characters (got 16)" in result.stdout
    assert not (tmp_path / "greeting-test").exists()


def test_generate_openai_yaml_requires_default_prompt_skill_reference(tmp_path: Path):
    skill_dir = tmp_path / "greeting-test"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: greeting-test\ndescription: Test greetings.\n---\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "generate_openai_yaml.py"),
            str(skill_dir),
            "--interface",
            "short_description=간단하고 정중한 인사 응답을 만드는 테스트 스킬",
            "--interface",
            "default_prompt=간단하고 정중하게 인사하세요.",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 1
    assert "default_prompt must explicitly mention the skill as '$greeting-test'" in result.stdout
    assert not (skill_dir / "agents" / "openai.yaml").exists()


def test_init_skill_accepts_valid_korean_interface_metadata(tmp_path: Path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "init_skill.py"),
            "greeting-test",
            "--path",
            str(tmp_path),
            "--interface",
            "display_name=Greeting Test",
            "--interface",
            "short_description=간단하고 정중한 인사 응답을 만드는 테스트 스킬입니다",
            "--interface",
            "default_prompt=$greeting-test 스킬로 간단하고 정중하게 인사하세요.",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    openai_yaml = tmp_path / "greeting-test" / "agents" / "openai.yaml"
    assert openai_yaml.exists()
    content = openai_yaml.read_text(encoding="utf-8")
    assert 'display_name: "Greeting Test"' in content
    assert 'default_prompt: "$greeting-test 스킬로 간단하고 정중하게 인사하세요."' in content


def test_quick_validate_reads_korean_skill_as_utf8(tmp_path: Path):
    skill_dir = tmp_path / "korean-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: korean-skill\n"
        "description: 한글 설명이 포함된 테스트 스킬입니다.\n"
        "---\n\n"
        "# 한글 스킬\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "quick_validate.py"), str(skill_dir)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Skill is valid!" in result.stdout
