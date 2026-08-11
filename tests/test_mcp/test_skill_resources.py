"""Tests for the MCP resource baseline of packaged Agent Skills."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from myharness.mcp.skill_resources import PackagedMcpSkill


ROOT = Path(__file__).resolve().parents[2]


def _load_worldbank_server():
    path = ROOT / ".skills" / "mcp" / "worldbank" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("worldbank_skill_resource_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.server


@pytest.mark.asyncio
async def test_packaged_skill_is_exposed_as_deferred_mcp_resource() -> None:
    server = _load_worldbank_server()
    resources = {str(resource.uri): resource for resource in server._resource_manager.list_resources()}

    assert server._mcp_server.instructions == (
        "For detailed workflow guidance, read skill://worldbank/SKILL.md "
        "only when this server is relevant."
    )
    resource = resources["skill://worldbank/SKILL.md"]
    assert resource.mime_type == "text/markdown"
    content = await resource.read()
    assert isinstance(content, str)
    assert "name: worldbank" in content
    assert "source: skill-mcp:worldbank" in content


def test_packaged_skill_rejects_directory_name_mismatch(tmp_path: Path) -> None:
    runtime = tmp_path / "module" / "runtime"
    skill = tmp_path / "module" / "skills" / "wrong-name"
    runtime.mkdir(parents=True)
    skill.mkdir(parents=True)
    runtime_file = runtime / "server.py"
    runtime_file.write_text("", encoding="utf-8")
    (skill / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo\n---\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="must match name"):
        PackagedMcpSkill.from_runtime_file(runtime_file)
