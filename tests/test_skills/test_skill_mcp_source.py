"""Tests for MCP-routed skill source metadata."""

from __future__ import annotations

from pathlib import Path

from myharness.skills.loader import load_skills_from_dirs


def test_skill_frontmatter_can_mark_mcp_routed_source(tmp_path: Path) -> None:
    skill_dir = tmp_path / "skills" / "vector-db-rag"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: vector-db-rag\n"
        "description: Use local Vector GraphRAG MCP\n"
        "source: skill-mcp:vector_db\n"
        "---\n\n"
        "# Vector DB RAG\n",
        encoding="utf-8",
    )

    skills = load_skills_from_dirs([tmp_path / "skills"], source="project")

    assert skills[0].name == "vector-db-rag"
    assert skills[0].source == "skill-mcp:vector_db"


def test_skill_frontmatter_ignores_non_mcp_source_override(tmp_path: Path) -> None:
    skill_dir = tmp_path / "skills" / "regular"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: regular\n"
        "description: Regular skill\n"
        "source: admin\n"
        "---\n\n"
        "# Regular\n",
        encoding="utf-8",
    )

    skills = load_skills_from_dirs([tmp_path / "skills"], source="project")

    assert skills[0].source == "project"
