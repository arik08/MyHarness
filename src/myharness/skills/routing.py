"""Skill capability classification helpers."""

from __future__ import annotations

from typing import Any


def is_mcp_routed_skill(skill: Any) -> bool:
    """Return whether a skill should be presented as an MCP capability."""
    return is_mcp_routed_skill_source(str(getattr(skill, "source", "") or ""))


def is_mcp_routed_skill_source(source: str) -> bool:
    """Return whether a skill source marks skill-driven MCP routing."""
    normalized = source.strip().lower()
    return normalized == "skill-mcp" or normalized.startswith(("skill-mcp:", "mcp:"))
