"""Load MCP server config from settings and plugins."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from pydantic import ValidationError

from myharness.mcp.types import (
    McpAuthConfig,
    McpHttpServerConfig,
    McpJsonConfig,
    McpStdioServerConfig,
    McpWebSocketServerConfig,
)
from myharness.plugins.types import LoadedPlugin

logger = logging.getLogger(__name__)


def get_program_mcp_dirs() -> list[Path]:
    """Return MyHarness installation-local MCP config directories."""
    package_dir = Path(__file__).resolve().parents[1]
    candidates = [
        package_dir / ".skills" / "mcp",
        package_dir.parent / ".skills" / "mcp",
        package_dir / ".mcp",  # Legacy layout.
        package_dir.parent / ".mcp",  # Legacy layout.
    ]

    for ancestor in package_dir.parents:
        if (ancestor / "pyproject.toml").exists() and (ancestor / "src" / "myharness").exists():
            candidates.extend(
                [
                    ancestor / ".skills" / "mcp",
                    ancestor / ".mcp",  # Legacy layout.
                ]
            )
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
    return result


def load_mcp_configs_from_dirs(directories: list[Path]) -> dict[str, object]:
    """Load legacy configs and self-contained ``*/mcp.json`` packages."""
    servers: dict[str, object] = {}
    for directory in directories:
        if not directory.exists():
            continue
        config_paths = sorted({*directory.glob("*.json"), *directory.glob("*/mcp.json")})
        for path in config_paths:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                config = McpJsonConfig.model_validate(payload)
            except (OSError, json.JSONDecodeError, ValidationError) as exc:
                logger.warning("Failed to load MCP config from %s: %s", path, exc)
                continue
            for name, server in config.mcpServers.items():
                if isinstance(server, McpStdioServerConfig) and server.cwd:
                    cwd_path = Path(server.cwd).expanduser()
                    if not cwd_path.is_absolute():
                        base = path.parent if path.name == "mcp.json" else directory.parent
                        server._cwd_base = str(base.resolve())
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
    packaged_servers = load_mcp_configs_from_dirs(mcp_dirs)
    servers = dict(settings.mcp_servers)
    for name, config in list(servers.items()):
        if name not in packaged_servers and _is_legacy_program_config(config):
            logger.info("Ignoring retired program MCP config for %s", name)
            servers.pop(name)
    for name, packaged in packaged_servers.items():
        servers[name] = _merge_mcp_credentials(packaged, settings.mcp_servers.get(name))
    for name, auth in getattr(settings, "mcp_auth", {}).items():
        if name in servers:
            servers[name] = _apply_mcp_auth(servers[name], auth)
    for plugin in plugins:
        if not plugin.enabled:
            continue
        for name, config in plugin.mcp_servers.items():
            servers.setdefault(f"{plugin.manifest.name}:{name}", config)
    if include_disabled:
        return servers
    disabled = set(getattr(settings, "disabled_mcp_servers", set()) or set())
    if cwd is not None:
        disabled.update(_disabled_mcp_skill_servers(settings, cwd))
    if disabled:
        servers = {name: config for name, config in servers.items() if name not in disabled}
    return servers


def _merge_mcp_credentials(packaged: object, configured: object | None) -> object:
    """Keep a packaged runtime authoritative while preserving old auth values."""
    if isinstance(packaged, McpStdioServerConfig) and isinstance(configured, McpStdioServerConfig):
        env = {**(packaged.env or {}), **(configured.env or {})}
        return packaged.model_copy(update={"env": env or None})
    if isinstance(packaged, (McpHttpServerConfig, McpWebSocketServerConfig)) and isinstance(
        configured, (McpHttpServerConfig, McpWebSocketServerConfig)
    ):
        headers = {**packaged.headers, **configured.headers}
        return packaged.model_copy(update={"headers": headers})
    return packaged


def _apply_mcp_auth(config: object, auth: McpAuthConfig) -> object:
    if isinstance(config, McpStdioServerConfig):
        env = {**(config.env or {}), **auth.env}
        return config.model_copy(update={"env": env or None})
    if isinstance(config, (McpHttpServerConfig, McpWebSocketServerConfig)):
        return config.model_copy(update={"headers": {**config.headers, **auth.headers}})
    return config


def _is_legacy_program_config(config: object) -> bool:
    if not isinstance(config, McpStdioServerConfig):
        return False
    return any(
        str(argument).replace("\\", "/").startswith(".mcp/")
        for argument in config.args
    )


def _disabled_mcp_skill_servers(settings, cwd: str | Path) -> set[str]:
    """Return MCP servers whose skill-mcp wrapper is disabled in this workspace."""
    from myharness.skills import load_skill_registry
    from myharness.skills.routing import is_mcp_routed_skill, mcp_server_name_from_skill_source

    registry = load_skill_registry(cwd, settings=settings, include_disabled=True)
    return {
        server_name
        for skill in registry.list_skills()
        if not skill.enabled and is_mcp_routed_skill(skill)
        if (server_name := mcp_server_name_from_skill_source(skill.source))
    }
