"""Memory prompt helpers."""

from __future__ import annotations

from pathlib import Path

from myharness.memory.paths import get_memory_entrypoint, get_project_memory_dir


def load_memory_prompt(cwd: str | Path, *, max_entrypoint_lines: int = 200) -> str | None:
    """Return the memory prompt section for the current project."""
    memory_dir = get_project_memory_dir(cwd)
    entrypoint = get_memory_entrypoint(cwd)
    lines = [
        "# Memory",
        f"- Persistent memory directory: {memory_dir}",
        "- Use this directory to store durable user or project context that should survive future sessions.",
        "- Prefer concise topic files plus an index entry in MEMORY.md.",
        "- Session goals, pending tools and compacted handoffs belong to session state, not durable memory.",
        "- Record source, verified_at and scope for durable facts. Prefer newer verified evidence and explicit user corrections over stale memory.",
        "- Read detailed topic files only when relevant; the index is a discovery aid, not proof of current facts.",
        "- Do not run automatic extraction or consolidation model calls without an explicit enabled product policy and cost budget.",
    ]

    if entrypoint.exists():
        content_lines = entrypoint.read_text(encoding="utf-8").splitlines()[:max_entrypoint_lines]
        if content_lines:
            lines.extend(["", "## MEMORY.md", "```md", *content_lines, "```"])
    else:
        lines.extend(
            [
                "",
                "## MEMORY.md",
                "(not created yet)",
            ]
        )

    return "\n".join(lines)
