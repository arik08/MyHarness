"""Tests for the Korean National Assembly MCP connector config."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig
from myharness.skills.loader import load_skills_from_dirs


def _load_bootstrap_module():
    bootstrap_path = (
        Path(__file__).resolve().parents[2]
        / ".skills"
        / "mcp"
        / "national-assembly"
        / "runtime"
        / "bootstrap.py"
    )
    spec = importlib.util.spec_from_file_location("national_assembly_bootstrap", bootstrap_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_national_assembly_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["national-assembly"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == ["runtime/bootstrap.py"]
    assert server.cwd == "."
    assert server.auto_connect is False
    assert server.env == {
        "ASSEMBLY_API_KEY": "8b90dd60d8484b0eb9d369ee8a324149",
        "LAWMKING_OC": "arik08",
        "MCP_PROFILE": "full",
        "MCP_TRANSPORT": "stdio",
    }


def test_national_assembly_skill_is_mcp_routed() -> None:
    skills_dir = Path(__file__).resolve().parents[2] / ".skills"

    skills = {
        skill.name: skill
        for skill in load_skills_from_dirs([skills_dir / "mcp"], source="project")
    }

    skill = skills["national-assembly"]
    assert skill.source == "skill-mcp:national-assembly"
    assert "열린국회정보" in skill.description


def test_national_assembly_runtime_is_bundled_with_licenses(monkeypatch) -> None:
    bootstrap = _load_bootstrap_module()
    runtime_dir = Path(bootstrap.__file__).parent
    monkeypatch.delenv("NATIONAL_ASSEMBLY_MCP_DIR", raising=False)

    assert bootstrap._server_index() == runtime_dir / "index.js"
    assert (runtime_dir / "244.index.js").is_file()
    assert (runtime_dir / "package.json").is_file()
    assert (runtime_dir / "UPSTREAM_LICENSE.txt").is_file()
    assert (runtime_dir / "licenses.txt").is_file()


def test_national_assembly_default_runtime_does_not_build(monkeypatch) -> None:
    bootstrap = _load_bootstrap_module()
    monkeypatch.delenv("NATIONAL_ASSEMBLY_MCP_DIR", raising=False)
    monkeypatch.setattr(
        bootstrap,
        "_ensure_override_built",
        lambda _path: (_ for _ in ()).throw(AssertionError("unexpected build")),
    )

    assert bootstrap._server_index() == bootstrap.BUNDLED_INDEX


@pytest.mark.asyncio
async def test_national_assembly_bundled_runtime_connects_over_stdio() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"
    config = load_mcp_configs_from_dirs([mcp_dir])["national-assembly"]
    manager = McpClientManager({"national-assembly": config})

    await manager.ensure_server_config("national-assembly", config, force_connect=True)
    try:
        status = manager.list_statuses()[0]
        assert status.state == "connected", status.detail
        assert len(status.tools) >= 1
        assert len(status.resources) >= 1
    finally:
        await manager.close()


def test_national_assembly_bootstrap_applies_compatibility_patch(monkeypatch, tmp_path) -> None:
    bootstrap = _load_bootstrap_module()
    checks = []
    runs = []

    def _patch_can_apply(_server_dir, *, reverse=False):
        checks.append(reverse)
        return not reverse

    monkeypatch.setattr(bootstrap, "_patch_can_apply", _patch_can_apply)
    monkeypatch.setattr(bootstrap, "_run", lambda args, cwd: runs.append((args, cwd)))

    assert bootstrap._apply_compatibility_patch(tmp_path) is True
    assert checks == [False]
    assert runs == [(["git", "apply", str(bootstrap.COMPATIBILITY_PATCH)], tmp_path)]


def test_national_assembly_bootstrap_accepts_already_applied_patch(monkeypatch, tmp_path) -> None:
    bootstrap = _load_bootstrap_module()
    monkeypatch.setattr(
        bootstrap,
        "_patch_can_apply",
        lambda _server_dir, *, reverse=False: reverse,
    )

    assert bootstrap._apply_compatibility_patch(tmp_path) is False


def test_national_assembly_patch_check_ignores_line_ending_whitespace(monkeypatch, tmp_path) -> None:
    bootstrap = _load_bootstrap_module()
    runs = []

    class Result:
        returncode = 0

    monkeypatch.setattr(bootstrap, "_resolve_command", lambda args: args)
    monkeypatch.setattr(
        bootstrap.subprocess,
        "run",
        lambda args, **kwargs: runs.append((args, kwargs)) or Result(),
    )

    assert bootstrap._patch_can_apply(tmp_path, reverse=True) is True
    assert runs[0][0] == [
        "git",
        "apply",
        "--reverse",
        "--check",
        "--ignore-space-change",
        str(bootstrap.COMPATIBILITY_PATCH),
    ]
