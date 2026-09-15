"""Live MCP audit using web-launcher settings; writes metadata, never response bodies.

Starts isolated MCP processes, reads resources, and runs bounded read-only
fixtures. Missing credentials and tool-less placeholders are not successes.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time

from myharness.config.settings import load_settings
from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_server_configs
from myharness.plugins import load_plugins
from verify_official_data_mcps import LiveVerifier, SERVER_SOURCES
from verify_mcp_packages import TOOLLESS_PLACEHOLDERS


def load_web_environment(root: Path) -> None:
    """Match the web launcher's local env order without logging values."""
    for name in ("myharness.local.env", "API_KEY.env"):
        path = root / name
        if path.is_file():
            for raw in path.read_text(encoding="utf-8-sig").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key.strip()):
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")
    os.environ.setdefault("MYHARNESS_CONFIG_DIR", str(root / ".myharness"))


def redact(detail: str, secrets: list[str]) -> str:
    for value in sorted(set(secrets), key=len, reverse=True):
        if len(value) >= 4:
            detail = detail.replace(value, "[REDACTED]")
    detail = re.sub(r"(?i)(api[_-]?key|token|authorization)([=: ]+)[^&\s,]+", r"\1\2[REDACTED]", detail)
    return detail[:1500]


EXTRA_CASES = {
    "worldbank": [("check_connection", {}), ("fetch_indicator_data", {"country": "KOR", "indicator": "SP.POP.TOTL", "start_year": 2022, "end_year": 2023, "limit": 2})],
    "comtrade": [("check_connection", {}), ("preview_trade_data", {"reporter_code": "410", "period": "2023", "cmd_code": "72", "limit": 2}), ("get_trade_data", {"reporter_code": "410", "period": "2023", "cmd_code": "72", "limit": 2})],
    "ecos": [("check_connection", {}), ("get_exchange_rate", {"currency": "USD", "start_date": "20250102", "end_date": "20250103", "limit": 2})],
    "eia": [("check_connection", {}), ("get_energy_price", {"alias": "wti", "length": 2})],
    "kosis": [("check_connection", {}), ("search_statistics", {"keyword": "인구", "limit": 2})],
    "korean-law": [("legal_research", {"query": "개인정보 보호법", "task": "law_system"}), ("legal_research", {"query": "개인정보 보호법 과징금 부과 기준", "task": "action_basis", "scenario": "penalty"}), ("search_decisions", {"domain": "precedent", "query": "개인정보", "display": 2})],
    "national-assembly": [
        ("discover_apis", {"page_size": 2}),
        ("assembly_member", {"page_size": 2}),
        ("assembly_bill", {"page_size": 2}),
        ("assembly_session", {"type": "meeting", "page_size": 2}),
        ("assembly_org", {"type": "lawmaking", "category": "legislation", "diff": "0", "page_size": 2}),
        ("committee_detail", {"page_size": 2}),
        ("petition_detail", {"status": "all", "page_size": 2}),
        ("research_data", {"keyword": "경제", "source": "all_integrated", "page_size": 2}),
        ("get_nabo", {"type": "report", "page_size": 2}),
        ("query_assembly", {"api_code": "BILLRCP", "params": {"AGE": 22}, "page_size": 2}),
    ],
}


def validate_output(server: str, tool: str, text: str) -> None:
    if not text.strip():
        raise AssertionError("empty tool response")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        if server not in {"korean-law", "national-assembly"}:
            raise
        if server == "korean-law" and tool == "legal_research" and "처분 근거 확인" in text:
            if "벌칙·과태료" not in text:
                raise AssertionError("Penalty scenario omitted the penalty article section")
        return
    if not payload:
        raise AssertionError("empty data")
    if isinstance(payload, dict):
        if payload.get("ok") is False or payload.get("isError") is True or payload.get("error"):
            raise AssertionError(str(payload))
        for key in ("data", "results", "rows"):
            if key in payload and not payload[key]:
                raise AssertionError(f"empty {key}")
        if "sample_count" in payload and not payload["sample_count"]:
            raise AssertionError("zero health sample_count")


async def audit(root: Path, output: Path, selected: list[str], *, http_audit: bool = False) -> int:
    load_web_environment(root)
    settings = load_settings()
    plugins = load_plugins(settings, root, include_program_plugins=True)
    configs = load_mcp_server_configs(settings, plugins, cwd=root, include_disabled=True)
    secrets = [v for k, v in os.environ.items() if re.search("KEY|TOKEN|SECRET|PASSWORD", k)]
    for config in configs.values():
        secrets.extend(v for k, v in (getattr(config, "env", None) or {}).items() if re.search("KEY|TOKEN|SECRET|PASSWORD|_OC$", k))
        secrets.extend((getattr(config, "headers", None) or {}).values())
    report = {"root": str(root), "started_at": datetime.now(timezone.utc).isoformat(), "servers": {}, "checks": []}
    output.parent.mkdir(parents=True, exist_ok=True)

    def record(label: str, status: str, detail: str = "", elapsed_ms: int = 0) -> None:
        report["checks"].append({"label": label, "status": status, "detail": redact(detail, secrets), "elapsed_ms": elapsed_ms})
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{status:24} {label} {redact(detail, secrets)[:200]}", flush=True)

    async def check(label, action, *, record_success=True, http_log=None):
        started = time.perf_counter()
        before = len(http_log.read_text(encoding="utf-8").splitlines()) if http_log else 0
        try:
            value = await asyncio.wait_for(action(), timeout=100)
            calls = [json.loads(line) for line in http_log.read_text(encoding="utf-8").splitlines()[before:]] if http_log else []
            recovered = any(c.get("exception") or c.get("status", 0) >= 400 for c in calls)
            if recovered:
                record(label, "RECOVERED_AFTER_HTTP_ERROR", json.dumps(calls), round((time.perf_counter() - started) * 1000))
            elif record_success:
                record(label, "PASS", elapsed_ms=round((time.perf_counter() - started) * 1000))
            return value
        except Exception as exc:
            detail = str(exc) or type(exc).__name__
            missing = re.search(r"(required|missing|not configured|설정|필요).*(API.?KEY|credential)|(API.?KEY|credential).*(required|missing|not configured|설정|필요)", detail, re.IGNORECASE)
            status = "BLOCKED_NO_CREDENTIAL" if missing else "FAIL"
            if "HTTP 429" in detail:
                status = "BLOCKED_RATE_LIMIT"
            if "has not been indexed" in detail:
                status = "BLOCKED_NO_INDEX"
            record(label, status, detail, round((time.perf_counter() - started) * 1000))
            return None

    semaphore = asyncio.Semaphore(3)

    async def server_audit(name, config):
        async with semaphore:
            if name in TOOLLESS_PLACEHOLDERS:
                record(f"workflow:{name}", "PLACEHOLDER", "No business tools implemented; execution intentionally disabled")
                return
            http_log = None
            if http_audit and config.args and Path(config.args[0]).name == "server.py":
                config = config.model_copy(deep=True)
                http_log = output.with_suffix(f".{name}.http.jsonl")
                http_log.write_text("", encoding="utf-8")
                config.args = [str(Path(__file__).with_name("mcp_http_audit.py")), str(http_log), *config.args]
            manager = McpClientManager({name: config})
            try:
                # Keep connection and teardown in the same task (AnyIO cancel scopes).
                await manager.ensure_server_config(name, config, force_connect=True)
                status = manager.list_statuses()[0]
                report["servers"][name] = {"state": status.state, "tools": [{"name": t.name, "schema": t.input_schema} for t in status.tools], "resources": [r.uri for r in status.resources]}
                if status.state != "connected":
                    record(f"startup:{name}", "FAIL", status.detail)
                    return
                record(f"startup:{name}", "PASS")
                for resource in status.resources:
                    async def read(uri=resource.uri):
                        result = await manager.read_resource(name, uri)
                        assert result.strip(), "empty resource"
                    await check(f"resource:{name}:{resource.uri}", read)
                if name in SERVER_SOURCES:
                    verifier = LiveVerifier(manager)
                    workflow = {"company-disclosure": verifier.verify_company, "trade-market": verifier.verify_trade, "macro-finance": verifier.verify_macro, "legislation-regulation": verifier.verify_legislation, "patent-tech": verifier.verify_patent, "environment-industry": verifier.verify_environment, "development-finance": verifier.verify_development}[name]
                    for source in SERVER_SOURCES[name]:
                        async def health(source=source):
                            payload = json.loads(await manager.call_tool(name, "get_source_health", {"source": source}))
                            if payload.get("ok") is not True:
                                credential = payload.get("credential", {})
                                if credential.get("required") and not credential.get("configured"):
                                    raise ValueError("Missing credential: " + ", ".join(credential.get("environment_names", [])))
                                raise AssertionError(payload.get("detail") or "health probe failed")
                            return True
                        healthy = await check(f"health:{name}:{source}", health, http_log=http_log)
                        if healthy:
                            states = {(s, src): False for s, sources in SERVER_SOURCES.items() for src in sources}
                            states[(name, source)] = True
                            before = len(verifier.results)
                            async def run_workflow():
                                await workflow(states)
                            # Health probes already perform a live source request. Do not
                            # count a workflow with no fixture as another successful call.
                            await check(f"workflow:{name}:{source}", run_workflow, record_success=False, http_log=http_log)
                            for result in verifier.results[before:]:
                                record(result.label, result.status, elapsed_ms=result.elapsed_ms)
                elif name in EXTRA_CASES:
                    for index, (tool, arguments) in enumerate(EXTRA_CASES[name]):
                        async def call(tool=tool, arguments=arguments):
                            result = await manager.call_tool(name, tool, arguments)
                            validate_output(name, tool, result)
                        await check(f"call:{name}:{tool}:{index}", call, http_log=http_log)
                else:
                    record(f"workflow:{name}", "UNVERIFIED", "No read-only fixture configured")
            except Exception as exc:
                record(f"server:{name}", "FAIL", str(exc))
            finally:
                await manager.close()

    names = selected or sorted(configs)
    unknown = set(names) - set(configs)
    if unknown:
        raise ValueError(f"Unknown servers: {sorted(unknown)}")
    await asyncio.gather(*(server_audit(name, configs[name]) for name in names))
    counts = {status: sum(c["status"] == status for c in report["checks"]) for status in sorted({c["status"] for c in report["checks"]})}
    report["summary"] = counts
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(counts), flush=True)
    return int(any(count for status, count in counts.items() if status not in {
        "PASS", "BLOCKED_NO_CREDENTIAL", "PLACEHOLDER",
    }))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path(".myharness/ui-checks/mcp-audit.json"))
    parser.add_argument("--servers", nargs="*", default=[])
    parser.add_argument("--http-audit", action="store_true", help="Record Python MCP HTTP statuses and flag recovered errors separately")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(audit(args.root.resolve(), args.output.resolve(), args.servers, http_audit=args.http_audit)))
