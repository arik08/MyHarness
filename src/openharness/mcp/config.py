"""Load MCP server config from settings and plugins."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from pydantic import ValidationError

from openharness.mcp.types import McpJsonConfig
from openharness.plugins.types import LoadedPlugin

logger = logging.getLogger(__name__)


def get_program_mcp_dirs() -> list[Path]:
    """Return OpenHarness installation-local MCP config directories."""
    package_dir = Path(__file__).resolve().parents[1]
    candidates = [
        package_dir / ".mcp",
        package_dir.parent / ".mcp",
    ]

    for ancestor in package_dir.parents:
        if (ancestor / "pyproject.toml").exists() and (ancestor / "src" / "openharness").exists():
            candidates.append(ancestor / ".mcp")
            break

    seen: set[Path] = set()
    result: list[Path] = []
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.exists():
            result.append(resolved)
        elif (resolved.parent / "pyproject.toml").exists():
            resolved.mkdir(parents=True, exist_ok=True)
            result.append(resolved)
    return result


def load_mcp_configs_from_dirs(directories: list[Path]) -> dict[str, object]:
    """Load MCP server configs from ``*.json`` files in the given directories."""
    servers: dict[str, object] = {}
    for directory in directories:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                config = McpJsonConfig.model_validate(payload)
            except (OSError, json.JSONDecodeError, ValidationError) as exc:
                logger.warning("Failed to load MCP config from %s: %s", path, exc)
                continue
            for name, server in config.mcpServers.items():
                servers.setdefault(name, server)
    return servers


def load_mcp_server_configs(
    settings,
    plugins: list[LoadedPlugin],
    cwd: str | Path | None = None,
    *,
    include_disabled: bool = False,
) -> dict[str, object]:
    """Merge settings and plugin MCP server configs."""
    mcp_dirs = get_program_mcp_dirs()
    servers = load_mcp_configs_from_dirs(mcp_dirs)
    servers.update(settings.mcp_servers)
    for plugin in plugins:
        if not plugin.enabled:
            continue
        for name, config in plugin.mcp_servers.items():
            servers.setdefault(f"{plugin.manifest.name}:{name}", config)
    if include_disabled:
        return servers
    disabled = set(getattr(settings, "disabled_mcp_servers", set()) or set())
    if disabled:
        servers = {name: config for name, config in servers.items() if name not in disabled}
    return servers
