"""Validate self-contained MCP packages under ``.skills/mcp``."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
PACKAGES_ROOT = ROOT / ".skills" / "mcp"
SKILL_RESOURCE_EXCEPTIONS = {"korean-law", "national-assembly"}
TOOLLESS_PLACEHOLDERS = {
    "posco-calender",
    "posco-datalake",
    "posco-ecm",
    "posco-email",
    "posco-erp",
    "posco-gih",
    "posco-mih",
    "posco-ontology",
    "posco-plm",
}


def _skill_frontmatter(path: Path) -> dict[str, object]:
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


def verify_packages(*, require_runtime_deps: bool = False) -> list[str]:
    """Return configured server names or raise for an invalid package."""
    if not PACKAGES_ROOT.is_dir():
        raise ValueError(f"MCP package directory is missing: {PACKAGES_ROOT}")
    packages = sorted(path for path in PACKAGES_ROOT.iterdir() if (path / "mcp.json").is_file())
    if not packages:
        raise ValueError(f"No MCP packages found under {PACKAGES_ROOT}")

    server_names: list[str] = []
    for package in packages:
        payload = json.loads((package / "mcp.json").read_text(encoding="utf-8"))
        servers = payload.get("mcpServers")
        if not isinstance(servers, dict) or len(servers) != 1:
            raise ValueError(f"Each MCP package must declare exactly one server: {package}")
        server_name, config = next(iter(servers.items()))
        if not isinstance(config, dict):
            raise ValueError(f"Invalid MCP server config: {package / 'mcp.json'}")
        if config.get("auto_connect") is not False:
            raise ValueError(f"Packaged MCP servers must activate on demand: {server_name}")

        skill_files = sorted((package / "skills").glob("*/SKILL.md"))
        if len(skill_files) != 1:
            raise ValueError(f"Each MCP package must contain exactly one Agent Skill: {package}")
        skill_file = skill_files[0]
        frontmatter = _skill_frontmatter(skill_file)
        skill_name = str(frontmatter.get("name") or "")
        if not skill_name or skill_file.parent.name != skill_name:
            raise ValueError(f"Skill directory must match frontmatter name: {skill_file}")
        if str(frontmatter.get("source") or "") != f"skill-mcp:{server_name}":
            raise ValueError(f"Skill must route to its packaged MCP server: {skill_file}")

        if config.get("type") == "stdio":
            args = config.get("args") or []
            if args and isinstance(args[0], str) and not Path(args[0]).is_absolute():
                entrypoint = package / str(config.get("cwd") or ".") / args[0]
                try:
                    entrypoint.resolve().relative_to(package.resolve())
                except ValueError as exc:
                    raise ValueError(f"MCP entrypoint must stay inside its package: {entrypoint}") from exc
                if require_runtime_deps or "node_modules" not in entrypoint.parts:
                    if not entrypoint.resolve().is_file():
                        raise ValueError(f"MCP entrypoint is missing: {entrypoint}")
        server_names.append(str(server_name))

    if len(set(server_names)) != len(server_names):
        raise ValueError("MCP server names must be unique across packages")
    return server_names


async def verify_connections(server_names: list[str]) -> None:
    """Start every package and verify its advertised MCP surface."""
    from myharness.mcp.client import McpClientManager
    from myharness.mcp.config import load_mcp_configs_from_dirs

    configs = load_mcp_configs_from_dirs([PACKAGES_ROOT])
    manager = McpClientManager({name: configs[name] for name in server_names})
    try:
        for name in server_names:
            await manager.ensure_server_config(name, configs[name], force_connect=True)
        statuses = {status.name: status for status in manager.list_statuses()}
        failures: list[str] = []
        for package in sorted(path for path in PACKAGES_ROOT.iterdir() if (path / "mcp.json").is_file()):
            payload = json.loads((package / "mcp.json").read_text(encoding="utf-8"))
            server_name = next(iter(payload["mcpServers"]))
            status = statuses[server_name]
            if status.state != "connected":
                failures.append(f"{server_name}: {status.detail}")
                continue
            if not status.tools and server_name not in TOOLLESS_PLACEHOLDERS:
                failures.append(f"{server_name}: no tools advertised")
                continue
            if server_name not in SKILL_RESOURCE_EXCEPTIONS:
                skill_file = next((package / "skills").glob("*/SKILL.md"))
                skill_name = skill_file.parent.name
                skill_uri = f"skill://{skill_name}/SKILL.md"
                if skill_uri not in status.instructions:
                    failures.append(f"{server_name}: instructions do not point to {skill_uri}")
                    continue
                if not any(resource.uri == skill_uri for resource in status.resources):
                    failures.append(f"{server_name}: missing {skill_uri} resource")
                    continue
                resource_text = await manager.read_resource(server_name, skill_uri)
                if resource_text != skill_file.read_text(encoding="utf-8").strip():
                    failures.append(f"{server_name}: skill resource differs from canonical SKILL.md")
                    continue
            print(
                f"CONNECTED {server_name}: "
                f"tools={len(status.tools)} resources={len(status.resources)}"
            )
        if failures:
            raise RuntimeError("MCP connection verification failed:\n" + "\n".join(failures))
    finally:
        await manager.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-runtime-deps", action="store_true")
    parser.add_argument("--connect", action="store_true")
    args = parser.parse_args()
    servers = verify_packages(require_runtime_deps=args.require_runtime_deps)
    print(f"Verified {len(servers)} self-contained MCP packages.")
    if args.connect:
        asyncio.run(verify_connections(servers))
        print(f"Connected and inspected {len(servers)} MCP packages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
