"""Supplement the source audit with discovery-to-detail MCP tool workflows.

Read-only calls through isolated MyHarness MCP sessions. Record first outcomes,
bounded redacted samples and HTTP recovery evidence; never retry a failed tool.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import time

from myharness.config.settings import load_settings
from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_server_configs
from myharness.plugins import load_plugins
from verify_all_mcps import load_web_environment, redact, validate_output


SERVERS = ("worldbank", "comtrade", "ecos", "eia", "kosis", "korean-law", "national-assembly")


async def audit(root: Path, output: Path, selected: list[str]) -> int:
    load_web_environment(root)
    settings = load_settings()
    configs = load_mcp_server_configs(settings, load_plugins(settings, root, include_program_plugins=True), cwd=root, include_disabled=True)
    secrets = [v for k, v in os.environ.items() if re.search("KEY|TOKEN|SECRET|PASSWORD|_OC$", k)]
    for config in configs.values():
        secrets.extend(v for k, v in (config.env or {}).items() if re.search("KEY|TOKEN|SECRET|PASSWORD|_OC$", k))
    report = {"checks": [], "tool_retries": 0}
    output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        report["summary"] = {s: sum(c["status"] == s for c in report["checks"]) for s in sorted({c["status"] for c in report["checks"]})}
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for server in selected or SERVERS:
        config = configs[server].model_copy(deep=True)
        http_log = output.with_suffix(f".{server}.http.jsonl")
        http_log.write_text("", encoding="utf-8")
        instrumented = server not in {"korean-law", "national-assembly"}
        if instrumented:
            config.args = [str(Path(__file__).with_name("mcp_http_audit.py")), str(http_log), *config.args]
        manager = McpClientManager({server: config})

        async def call(tool, **args):
            started = time.perf_counter()
            before = len(http_log.read_text(encoding="utf-8").splitlines())
            entry = {"server": server, "tool": tool, "arguments": args}
            try:
                raw = await asyncio.wait_for(manager.call_tool(server, tool, args), 120)
                validate_output(server, tool, raw)
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = raw
                    if re.match(r"\s*(?:\[(?:ERROR|NOT_FOUND|NO_PARENT)\]|Error:)", raw, re.I):
                        raise AssertionError("Text response needs review: " + raw[:900])
                data = payload.get("data", payload) if isinstance(payload, dict) else payload
                entry.update(status="PASS", count=len(data) if isinstance(data, (list, dict)) else None, sample=redact(raw[:1400], secrets))
                return payload
            except Exception as exc:
                entry.update(status="FAIL", detail=redact(str(exc), secrets))
                return None
            finally:
                calls = [json.loads(line) for line in http_log.read_text(encoding="utf-8").splitlines()[before:]]
                entry.update(elapsed_ms=round((time.perf_counter() - started) * 1000), http_calls=calls, http_instrumented=instrumented)
                if entry["status"] == "PASS" and any(c.get("exception") or c.get("status", 0) >= 400 for c in calls):
                    entry["status"] = "RECOVERED_AFTER_HTTP_ERROR"
                report["checks"].append(entry)
                save()
                print(f"{server}:{tool} {entry['status']}", flush=True)

        try:
            await manager.ensure_server_config(server, config, force_connect=True)
            if server == "worldbank":
                await call("list_countries", limit=2)
                await call("search_countries", keyword="Korea", limit=2)
                await call("search_indicators", keyword="population", limit=2)
                await call("get_indicator_metadata", indicator="SP.POP.TOTL", limit=2)
            elif server == "comtrade":
                await call("list_reporters", limit=2)
                await call("search_reporters", keyword="Korea", limit=2)
                await call("latest_common_annual_trade_data", reporter_codes=["410", "392"], cmd_code="72", latest_year=2023, lookback_years=1, limit=2)
            elif server == "ecos":
                await call("list_stat_tables", limit=2)
                await call("get_key_statistics", limit=2)
                items = await call("list_stat_items", stat_code="731Y001", limit=2)
                if items:
                    await call("get_statistic_data", stat_code="731Y001", cycle="D", start="20250102", end="20250103", item_code1=items[0]["ITEM_CODE"], limit=2)
            elif server == "eia":
                catalog = await call("list_price_series")
                if catalog:
                    await call("get_series", series_id=catalog["brent"], length=2)
            elif server == "kosis":
                await call("list_statistics", limit=2)
                tables = await call("search_statistics", keyword="행정구역(시군구)별, 성별 인구수", limit=2)
                if tables:
                    args = {"org_id": tables[0]["ORG_ID"], "tbl_id": tables[0]["TBL_ID"]}
                    await call("get_table_meta", **args, limit=2)
                    await call("get_table_meta", **args, meta_type="ITM", limit=2)
                    await call("get_stat_data", **args, prd_se="M", new_est_prd_cnt=1, limit=2)
                    await call("explain_statistics", **args, limit=2)
            elif server == "korean-law":
                laws = await call("search_law", query="개인정보 보호법", display=5)
                if laws:
                    match = re.search(r"mst[=：: ]+(\d+)", str(laws), re.I)
                    if match:
                        await call("get_law_text", mst=match[1], jo="제1조")
                await call("get_annexes", lawName="개인정보 보호법 시행령", knd="1")
                await call("legal_analysis", mode="verify_citations", text="개인정보 보호법 제15조", maxCitations=1)
                await call("discover_tools", intent="자치법규")
                for name in ("서울특별시 강남구 주차장 설치 및 관리 조례", "서울특별시 광진구 주차장 설치 및 관리 조례"):
                    ordinances = await call("execute_tool", tool_name="search_ordinance", params={"query": name, "display": 10})
                    if ordinances:
                        match = re.search(r"\[(\d+)\]\s*" + re.escape(name) + r"\s*\n", str(ordinances))
                        if not match:
                            raise AssertionError("No exact ordinance identity in search response: " + str(ordinances)[:900])
                        await call("ordinance_radar", ordinSeq=match[1])
                decisions = await call("search_decisions", domain="precedent", query="개인정보", display=2)
                if decisions:
                    match = re.search(r"(?:ID|id|일련번호)[=：: ]+[\[\"']?(\d+)", str(decisions))
                    if match:
                        await call("get_decision_text", domain="precedent", id=match[1])
            elif server == "national-assembly":
                bills = await call("assembly_bill", page_size=2)
                if bills:
                    match = re.search(r'"(?:BILL_ID|의안ID)"\s*:\s*"([^\"]+)"', json.dumps(bills, ensure_ascii=False) if not isinstance(bills, str) else bills)
                    if match:
                        await call("bill_detail", bill_id=match[1], fields=["detail", "history"], page_size=2)
        except Exception as exc:
            report["checks"].append({"server": server, "tool": "workflow", "status": "FAIL", "detail": redact(str(exc), secrets)})
            save()
        finally:
            await manager.close()
    print(json.dumps(report["summary"]), flush=True)
    return int(any(c["status"] != "PASS" for c in report["checks"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--servers", choices=SERVERS, nargs="*", default=[])
    args = parser.parse_args()
    raise SystemExit(asyncio.run(audit(args.root.resolve(), args.output.resolve(), args.servers)))
