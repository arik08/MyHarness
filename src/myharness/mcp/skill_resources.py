"""Expose a packaged Agent Skill through MCP resources.

This implements the resource baseline from draft SEP-2640 without depending on
the draft-only ``skills/list`` and ``skills/get`` methods.  A package keeps its
private runtime and config beside, but outside, the public skill directory.
"""

from __future__ import annotations

from dataclasses import dataclass
import inspect
import mimetypes
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class PackagedMcpSkill:
    """One Agent Skill stored beside an MCP runtime."""

    root: Path
    name: str
    description: str

    @classmethod
    def from_runtime_file(cls, runtime_file: str | Path) -> "PackagedMcpSkill":
        """Resolve and validate the single skill belonging to a runtime."""
        module_root = Path(runtime_file).resolve().parents[1]
        skill_files = sorted((module_root / "skills").glob("*/SKILL.md"))
        if len(skill_files) != 1:
            raise ValueError(f"Expected one packaged MCP skill under {module_root}, found {len(skill_files)}")
        skill_file = skill_files[0]
        frontmatter = _read_frontmatter(skill_file)
        name = str(frontmatter.get("name") or "").strip()
        description = str(frontmatter.get("description") or "").strip()
        if not name or not description:
            raise ValueError(f"Packaged MCP skill requires name and description: {skill_file}")
        if skill_file.parent.name != name:
            raise ValueError(
                f"Packaged MCP skill directory '{skill_file.parent.name}' must match name '{name}'"
            )
        return cls(root=skill_file.parent, name=name, description=description)

    @property
    def uri(self) -> str:
        """Return the SEP-2640 resource URI for ``SKILL.md``."""
        return f"skill://{self.name}/SKILL.md"

    @property
    def instructions(self) -> str:
        """Return compact server guidance that keeps the manual deferred."""
        return f"For detailed workflow guidance, read {self.uri} only when this server is relevant."

    def register_resources(self, server: Any) -> None:
        """Register every public skill file as an individually readable resource."""
        for path in sorted(item for item in self.root.rglob("*") if item.is_file()):
            relative = path.relative_to(self.root).as_posix()
            uri = f"skill://{self.name}/{relative}"
            mime_type = _mime_type(path)

            def read_resource(resource_path: Path = path) -> str | bytes:
                if _is_text_mime(_mime_type(resource_path)):
                    return resource_path.read_text(encoding="utf-8")
                return resource_path.read_bytes()

            # FastMCP interprets any function parameter as a URI-template
            # parameter, so hide the closed-over path from its signature.
            read_resource.__signature__ = inspect.Signature()  # type: ignore[attr-defined]
            server.resource(
                uri,
                name=path.name,
                description=self.description if relative == "SKILL.md" else f"Supporting file for {self.name}",
                mime_type=mime_type,
            )(read_resource)


def attach_packaged_skill(server: Any, runtime_file: str | Path) -> PackagedMcpSkill:
    """Attach the packaged skill and its deferred instruction pointer."""
    skill = PackagedMcpSkill.from_runtime_file(runtime_file)
    server._mcp_server.instructions = skill.instructions
    skill.register_resources(server)
    return skill


def _read_frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"SKILL.md must start with YAML frontmatter: {path}")
    closing = text.find("\n---", 4)
    if closing < 0:
        raise ValueError(f"SKILL.md frontmatter is not closed: {path}")
    payload = yaml.safe_load(text[4:closing]) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"SKILL.md frontmatter must be a mapping: {path}")
    return payload


def _mime_type(path: Path) -> str:
    if path.suffix.lower() == ".md":
        return "text/markdown"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _is_text_mime(mime_type: str) -> bool:
    return mime_type.startswith("text/") or mime_type in {
        "application/json",
        "application/javascript",
        "application/x-yaml",
    }
