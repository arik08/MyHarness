"""Read-only source/tool audit for configured credentials, including EPO OPS.

Uses real MCP stdio calls, discovery-derived IDs, and no tool-level retries.
Each case records its first outcome; errors and empty results stay distinct.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
import time

from verify_all_mcps import load_web_environment, redact
from myharness.config.settings import load_settings
from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_server_configs
from myharness.plugins import load_plugins

SOURCES = {
    "company-disclosure": ("companies_house", "sec"),
    "trade-market": ("customs_kr", "census", "wto"),
    "macro-finance": ("fred", "estat_jp"),
    "legislation-regulation": ("congress",),
    "patent-tech": ("kipris", "epo_ops", "openalex", "semantic_scholar"),
    "environment-industry": ("usda_ers",),
    "national-assembly": ("nabo",),
}


def rows_of(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "items", "Dataset", "observations", "TABLE_INF", "actions", "committees", "cosponsors", "summaries", "textVersions"):
            if isinstance(data.get(key), list):
                return data[key]
        if isinstance(data.get("DATA_INF"), dict):
            return data["DATA_INF"].get("VALUE", [])
    return None


async def audit(root: Path, output: Path, sources: list[str]):
    load_web_environment(root)
    settings = load_settings()
    configs = load_mcp_server_configs(settings, load_plugins(settings, root, include_program_plugins=True), cwd=root, include_disabled=True)
    secrets = [v for k, v in os.environ.items() if re.search("KEY|TOKEN|SECRET|PASSWORD", k)]
    for cfg in configs.values():
        secrets.extend(v for k, v in (getattr(cfg, "env", None) or {}).items() if re.search("KEY|TOKEN|SECRET|PASSWORD|_OC$", k))
    report = {"checks": [], "tool_retries": 0}
    output.parent.mkdir(parents=True, exist_ok=True)
    http_log = output.with_suffix(".http.jsonl")
    http_log.write_text("", encoding="utf-8")

    def http_calls():
        return [json.loads(line) for line in http_log.read_text(encoding="utf-8").splitlines() if line]

    def save():
        report["summary"] = {s: sum(c["status"] == s for c in report["checks"]) for s in sorted({c["status"] for c in report["checks"]})}
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for server, server_sources in SOURCES.items():
        selected = [s for s in server_sources if not sources or s in sources]
        if not selected:
            continue
        config = configs[server].model_copy(deep=True)
        if server != "national-assembly":
            config.args = [str(Path(__file__).with_name("mcp_http_audit.py")), str(http_log), *config.args]
        manager = McpClientManager({server: config})

        async def call(source, tool, *, case="", allow_empty=False, **args):
            started = time.perf_counter()
            http_before = len(http_calls())
            entry = {"source": source, "tool": tool, "case": case, "arguments": args, "attempt": 1}
            try:
                text = await asyncio.wait_for(manager.call_tool(server, tool, {"source": source, **args} if source != "nabo" else args), 120)
                payload = json.loads(text)
                data = payload.get("data", payload)
                if payload.get("error") or payload.get("isError") or payload.get("ok") is False:
                    raise ValueError(str(payload))
                if isinstance(data, dict) and data.get("errors"):
                    raise ValueError(str(data["errors"]))
                rows = rows_of(data)
                count = len(rows) if rows is not None else (len(data) if isinstance(data, dict) else int(bool(data)))
                entry.update(status="PASS" if count else "EMPTY", count=count)
                if rows:
                    entry["fields"] = list(rows[0]) if isinstance(rows[0], dict) else []
                if tool == "search_records" and source in {"kipris", "openalex", "semantic_scholar"} and rows:
                    id_field = {"kipris": "applicationNumber", "openalex": "id", "semantic_scholar": "paperId"}[source]
                    if not all(row.get(id_field) for row in rows):
                        raise AssertionError("Missing record identity: " + str(rows[0]))
                if rows is not None and "limit" in args and count > args["limit"]:
                    raise AssertionError(f"row limit exceeded: {count} > {args['limit']}")
                if not count and not allow_empty:
                    entry["status"] = "EMPTY_UNEXPECTED"
                return data
            except Exception as exc:
                entry.update(status="FAIL", detail=redact(str(exc), secrets))
                if "BLOCKED_CREDENTIAL_SCOPE" in str(exc):
                    entry["status"] = "BLOCKED_CREDENTIAL_SCOPE"
                return None
            finally:
                entry["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
                calls = http_calls()[http_before:]
                entry["http_calls"] = calls
                entry["http_instrumented"] = server != "national-assembly"
                if entry["status"] == "PASS" and any(c.get("exception") or c.get("status", 0) >= 400 for c in calls):
                    entry["status"] = "RECOVERED_AFTER_HTTP_ERROR"
                report["checks"].append(entry)
                save()
                print(f"{source}:{tool}:{case} {entry['status']}", flush=True)

        try:
            await manager.ensure_server_config(server, config, force_connect=True)
            for source in selected:
                if source != "nabo":
                    await call(source, "get_source_health")
                if source in {"companies_house", "sec"}:
                    catalog = await call(source, "search_catalog", query="marine" if source == "companies_house" else "Apple", limit=2)
                    if not catalog:
                        continue
                    identifier = str(catalog[0]["company_number" if source == "companies_house" else "cik_str"])
                    filings = await call(source, "search_records", identifier=identifier, limit=2)
                    for kind in (("company", "officers") if source == "companies_house" else ("company", "submissions", "companyfacts")):
                        await call(source, "get_record", case=kind, record_id=identifier, record_type=kind, limit=2)
                    await call(source, "get_document_link", record_id=identifier)
                    if source == "sec" and filings:
                        await call(source, "get_document_link", case="filing", record_id=filings[0]["accessionNumber"], auxiliary_id=identifier)
                elif source in {"customs_kr", "census", "wto"}:
                    await call(source, "search_catalog", query="ITS_MTV_AX" if source == "wto" else "", limit=2)
                    for flow in ("exports", "imports"):
                        args = dict(flow=flow, limit=3)
                        if source == "wto":
                            args.update(reporter="410", partner="000", product="MAIS", indicator="ITS_MTV_AX" if flow == "exports" else "ITS_MTV_AM", start_period="2023", end_period="2024")
                        else:
                            args.update(partner="US" if source == "customs_kr" else "5800", product="7208", start_period="2025-01", end_period="2025-02")
                        await call(source, "query_trade", case=flow, allow_empty=source == "census", **args)
                    if source == "census":
                        await call(source, "query_trade", case="exports-machinery", flow="exports", partner="5800", product="84", start_period="2025-01", end_period="2025-02", limit=3)
                elif source in {"fred", "estat_jp"}:
                    catalog = await call(source, "search_catalog", query="federal funds" if source == "fred" else "population", limit=2)
                    if catalog:
                        items = rows_of(catalog) or ([catalog] if isinstance(catalog, dict) else catalog)
                        identifier = items[0]["id" if source == "fred" else "@id"]
                        args = dict(series_id=identifier, limit=3)
                        if source == "fred":
                            args.update(start_period="2023-01-01", end_period="2024-12-31")
                        data = await call(source, "query_series", **args)
                        if source == "estat_jp" and data and rows_of(data):
                            row = rows_of(data)[0]
                            filters = {"cd" + k[1:2].upper() + k[2:]: v for k, v in row.items() if k.startswith("@") and k[1:] in {"time", "area", "cat01", "cat02", "tab"}}
                            await call(source, "query_series", case="discovered-filters", series_id=identifier, filters_json=filters, limit=2)
                elif source == "congress":
                    await call(source, "search_catalog", limit=2)
                    await call(source, "search_records", congress=119, bill_type="hr", limit=2)
                    # Enacted bill with established related records, not a guessed latest bill.
                    for kind in ("detail", "actions", "committees", "cosponsors", "subjects", "summaries", "text"):
                        await call(source, "get_record", case=kind, record_id="118/hr/2617", record_type=kind, allow_empty=True)
                    await call(source, "get_document_link", record_id="118/hr/2617")
                elif source == "epo_ops":
                    await call(source, "search_catalog", limit=2)
                    for query in ('ti="hydrogen"', 'ti="steel" and pd within "20230101 20231231"'):
                        records = await call(source, "search_records", query=query, limit=2)
                        if records:
                            for kind in ("bibliography", "family"):
                                await call(source, "get_record", case=kind, record_id=records[0]["record_id"], record_type=kind)
                elif source in {"kipris", "openalex", "semantic_scholar"}:
                    await call(source, "search_catalog", query="hydrogen" if source == "openalex" else "", limit=2)
                    for filtered in (False, True):
                        args = dict(query="수소" if source == "kipris" else "hydrogen steel", limit=2)
                        if filtered:
                            args.update(start_year=2023, end_year=2023)
                        records = await call(source, "search_records", case="year" if filtered else "keyword", **args)
                        if records:
                            rid = records[0][{"kipris": "applicationNumber", "openalex": "id", "semantic_scholar": "paperId"}[source]]
                            await call(source, "get_record", case="year" if filtered else "keyword", record_id=rid)
                elif source == "usda_ers":
                    catalog = await call(source, "search_catalog", query="income", limit=2)
                    if catalog:
                        row = rows_of(catalog)[0]
                        key = next(k for k in row if k.lower() in {"variable", "variableid", "variable_id", "id", "abb"})
                        data = await call(source, "query_industry", filters_json={"year": 2023, "variable": row[key]}, limit=2)
                        if data:
                            state = data[0]["state"]
                            await call(source, "query_industry", case="report", filters_json={"year": 2023, "report": data[0]["reportName"], "state": state["code"] if isinstance(state, dict) else state}, limit=2)
                else:
                    for kind in ("report",):
                        await call(source, "get_nabo", case=kind, type=kind, page_size=2, allow_empty=True)
                    await call(source, "get_nabo", case="keyword", type="report", keyword="경제", page_size=2)
        finally:
            await manager.close()
    print(json.dumps(report["summary"]), flush=True)
    return int(any(c["status"] not in {"PASS", "EMPTY"} for c in report["checks"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sources", nargs="*", default=[])
    args = parser.parse_args()
    raise SystemExit(asyncio.run(audit(args.root.resolve(), args.output.resolve(), args.sources)))
