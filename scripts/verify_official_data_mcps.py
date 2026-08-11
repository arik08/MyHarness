"""Strict live verification for grouped official-data MCP servers.

The verifier starts the same stdio configurations used by MyHarness, applies
user-level MCP credentials, calls every source health endpoint, and exercises
representative structured-data workflows. It prints metadata only, never
response bodies or credential values.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from myharness.config.settings import load_settings
from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_server_configs


SERVER_SOURCES = {
    "company-disclosure": ("opendart", "sec", "companies_house"),
    "trade-market": ("customs_kr", "census", "wto", "eurostat_comext"),
    "macro-finance": ("fred", "ecb", "bis", "nyfed", "oecd", "estat_jp"),
    "legislation-regulation": (
        "congress",
        "federal_register",
        "europarl",
        "eurlex",
        "uk_bills",
        "uk_legislation",
    ),
    "patent-tech": ("kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"),
    "environment-industry": ("eurostat_prodcom", "epa_echo", "usda_ers"),
    "development-finance": ("adb_kidb",),
}

RESOURCE_URIS = {
    "company-disclosure": "company-disclosure://overview",
    "trade-market": "trade-market://overview",
    "macro-finance": "macro-finance://overview",
    "legislation-regulation": "legislation-regulation://overview",
    "patent-tech": "patent-tech://overview",
    "environment-industry": "environment-industry://overview",
    "development-finance": "development-finance://overview",
}


@dataclass
class CheckResult:
    label: str
    status: str
    elapsed_ms: int
    response_bytes: int = 0
    detail: str = ""


class LiveVerifier:
    def __init__(self, manager: McpClientManager) -> None:
        self.manager = manager
        self.results: list[CheckResult] = []

    async def call(
        self,
        label: str,
        server: str,
        tool: str,
        arguments: dict[str, Any],
        *,
        require_data: bool = False,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        output = await self.manager.call_tool(server, tool, arguments)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        payload = json.loads(output)
        required = {"source", "source_id", "retrieved_at", "completeness", "data"}
        missing = required - set(payload)
        if missing:
            raise AssertionError(f"missing envelope fields: {sorted(missing)}")
        if require_data and not payload["data"]:
            raise AssertionError("official source returned no data for the verification fixture")
        self.results.append(
            CheckResult(label, "PASS", elapsed_ms, len(output.encode("utf-8")))
        )
        return payload

    async def health(self, server: str, source: str) -> bool:
        label = f"health:{server}:{source}"
        started = time.perf_counter()
        output = await self.manager.call_tool(
            server,
            "get_source_health",
            {"source": source},
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        payload = json.loads(output)
        credential = payload.get("credential", {})
        configured = bool(credential.get("configured"))
        required = bool(credential.get("required"))
        if payload.get("ok") is True:
            status = "PASS"
        elif required and not configured:
            status = "BLOCKED_NO_CREDENTIAL"
        else:
            raise AssertionError(payload.get("detail") or "health probe failed")
        self.results.append(
            CheckResult(
                label,
                status,
                elapsed_ms,
                len(output.encode("utf-8")),
                str(payload.get("detail", "")),
            )
        )
        return payload.get("ok") is True

    async def verify_resources(self) -> None:
        for server, uri in RESOURCE_URIS.items():
            started = time.perf_counter()
            output = await self.manager.read_resource(server, uri)
            payload = json.loads(output)
            if not isinstance(payload, dict) or not payload:
                raise AssertionError(f"{server} overview resource is empty")
            self.results.append(
                CheckResult(
                    f"resource:{server}",
                    "PASS",
                    round((time.perf_counter() - started) * 1000),
                    len(output.encode("utf-8")),
                )
            )

    async def verify_company(self, healthy: dict[tuple[str, str], bool]) -> None:
        if not healthy[("company-disclosure", "opendart")]:
            return
        catalog = await self.call(
            "opendart:company-search",
            "company-disclosure",
            "search_catalog",
            {"source": "opendart", "query": "삼성전자", "limit": 2},
            require_data=True,
        )
        company = catalog["data"][0]
        corp_code = company["corp_code"]
        filings = await self.call(
            "opendart:filings",
            "company-disclosure",
            "search_records",
            {
                "source": "opendart",
                "identifier": corp_code,
                "start_date": "2025-01-01",
                "end_date": "2026-08-10",
                "limit": 3,
            },
            require_data=True,
        )
        await self.call(
            "opendart:company",
            "company-disclosure",
            "get_record",
            {"source": "opendart", "record_id": corp_code, "record_type": "company"},
            require_data=True,
        )
        await self.call(
            "opendart:financials",
            "company-disclosure",
            "get_record",
            {
                "source": "opendart",
                "record_id": corp_code,
                "record_type": "financials",
                "business_year": 2025,
                "report_code": "11011",
                "financial_statement": "CFS",
                "limit": 30,
            },
            require_data=True,
        )
        receipt = filings["data"][0]["rcept_no"]
        await self.call(
            "opendart:viewer-link",
            "company-disclosure",
            "get_document_link",
            {"source": "opendart", "record_id": receipt},
            require_data=True,
        )

    async def verify_trade(self, healthy: dict[tuple[str, str], bool]) -> None:
        if healthy[("trade-market", "eurostat_comext")]:
            await self.call(
                "comext:bilateral-month",
                "trade-market",
                "query_trade",
                {
                    "source": "eurostat_comext",
                    "flow": "imports",
                    "start_period": "2025-01",
                    "end_period": "2025-01",
                    "product": "7208",
                    "reporter": "DE",
                    "partner": "US",
                    "indicator": "VALUE_IN_EUROS",
                    "limit": 20,
                },
                require_data=True,
            )

    async def verify_macro(self, healthy: dict[tuple[str, str], bool]) -> None:
        cases = {
            "ecb": {
                "series_id": "D.USD.EUR.SP00.A",
                "dataset": "EXR",
                "start_period": "2025-01-02",
                "end_period": "2025-01-10",
            },
            "bis": {
                "series_id": "A.DE.",
                "dataset": "WS_LONG_CPI",
                "start_period": "2023",
                "end_period": "2024",
            },
            "nyfed": {
                "series_id": "SOFR",
                "start_period": "2025-01-02",
                "end_period": "2025-01-10",
            },
            "oecd": {
                "series_id": "KOR.M.LI...AA...H",
                "dataset": "OECD.SDD.STES,DSD_STES@DF_CLI",
                "start_period": "2024-01",
                "end_period": "2024-02",
            },
        }
        for source, arguments in cases.items():
            if healthy[("macro-finance", source)]:
                await self.call(
                    f"macro:{source}",
                    "macro-finance",
                    "query_series",
                    {"source": source, **arguments, "limit": 5},
                    require_data=True,
                )
        if healthy[("macro-finance", "nyfed")]:
            await self.call(
                "macro:nyfed-rrp",
                "macro-finance",
                "query_series",
                {
                    "source": "nyfed",
                    "series_id": "RRP",
                    "start_period": "2025-01-02",
                    "end_period": "2025-01-03",
                    "limit": 10,
                },
                require_data=True,
            )

    async def verify_legislation(self, healthy: dict[tuple[str, str], bool]) -> None:
        if healthy[("legislation-regulation", "federal_register")]:
            records = await self.call(
                "federal-register:search",
                "legislation-regulation",
                "search_records",
                {"source": "federal_register", "query": "steel", "limit": 2},
                require_data=True,
            )
            await self.call(
                "federal-register:detail",
                "legislation-regulation",
                "get_record",
                {
                    "source": "federal_register",
                    "record_id": records["data"][0]["document_number"],
                },
                require_data=True,
            )
        if healthy[("legislation-regulation", "europarl")]:
            await self.call(
                "europarl:procedure",
                "legislation-regulation",
                "get_record",
                {"source": "europarl", "record_id": "2021-0214"},
                require_data=True,
            )
            await self.call(
                "europarl:events",
                "legislation-regulation",
                "get_record",
                {"source": "europarl", "record_id": "2021-0214", "record_type": "events"},
                require_data=True,
            )
        if healthy[("legislation-regulation", "eurlex")]:
            await self.call(
                "eurlex:celex",
                "legislation-regulation",
                "get_record",
                {"source": "eurlex", "record_id": "32023R0956"},
                require_data=True,
            )
        if healthy[("legislation-regulation", "uk_bills")]:
            bills = await self.call(
                "uk-bills:search",
                "legislation-regulation",
                "search_records",
                {"source": "uk_bills", "query": "", "limit": 2},
                require_data=True,
            )
            bill = bills["data"][0]
            bill_id = bill.get("billId") or bill.get("bill_id") or bill.get("id")
            if bill_id is None:
                raise AssertionError("UK Bills search result is missing billId")
            await self.call(
                "uk-bills:detail",
                "legislation-regulation",
                "get_record",
                {"source": "uk_bills", "record_id": str(bill_id)},
                require_data=True,
            )
        if healthy[("legislation-regulation", "uk_legislation")]:
            await self.call(
                "uk-legislation:search",
                "legislation-regulation",
                "search_records",
                {"source": "uk_legislation", "query": "steel", "limit": 2},
                require_data=True,
            )
            await self.call(
                "uk-legislation:detail",
                "legislation-regulation",
                "get_record",
                {"source": "uk_legislation", "record_id": "ukpga/2025/18"},
                require_data=True,
            )

    async def verify_patent(self, healthy: dict[tuple[str, str], bool]) -> None:
        if healthy[("patent-tech", "crossref")]:
            records = await self.call(
                "crossref:search",
                "patent-tech",
                "search_records",
                {"source": "crossref", "query": "hydrogen steel", "limit": 2},
                require_data=True,
            )
            doi = records["data"][0].get("DOI")
            if not doi:
                raise AssertionError("Crossref search result is missing DOI")
            await self.call(
                "crossref:doi",
                "patent-tech",
                "get_record",
                {"source": "crossref", "record_id": doi},
                require_data=True,
            )

    async def verify_environment(self, healthy: dict[tuple[str, str], bool]) -> None:
        if healthy[("environment-industry", "eurostat_prodcom")]:
            await self.call(
                "prodcom:production",
                "environment-industry",
                "query_industry",
                {
                    "source": "eurostat_prodcom",
                    "filters_json": {
                        "reporter": "DE",
                        "product": "24102100",
                        "indicators": "PRODQNT",
                        "time": "2024",
                    },
                    "limit": 20,
                },
                require_data=True,
            )
        if healthy[("environment-industry", "epa_echo")]:
            await self.call(
                "epa-echo:facility",
                "environment-industry",
                "search_facilities",
                {"facility_name": "NUCOR", "state": "AL", "limit": 2},
                require_data=True,
            )

    async def verify_development(self, healthy: dict[tuple[str, str], bool]) -> None:
        if not healthy[("development-finance", "adb_kidb")]:
            return
        await self.call(
            "adb:catalog",
            "development-finance",
            "search_catalog",
            {"source": "adb_kidb", "dataflow": "EO_NA", "query": "gross domestic", "limit": 5},
            require_data=True,
        )
        await self.call(
            "adb:series",
            "development-finance",
            "query_series",
            {
                "source": "adb_kidb",
                "dataflow": "EO_NA",
                "indicators": "NGDP_XDC",
                "economies": "PHI+SIN",
                "start_period": 2023,
                "end_period": 2024,
                "limit": 10,
            },
            require_data=True,
        )


async def run_verification(root: Path) -> tuple[list[CheckResult], list[str]]:
    settings = load_settings()
    all_configs = load_mcp_server_configs(
        settings,
        [],
        cwd=root,
        include_disabled=True,
    )
    missing_configs = sorted(set(SERVER_SOURCES) - set(all_configs))
    if missing_configs:
        raise RuntimeError(f"Missing MCP configurations: {', '.join(missing_configs)}")
    manager = McpClientManager({name: all_configs[name] for name in SERVER_SOURCES})
    verifier = LiveVerifier(manager)
    failures: list[str] = []
    try:
        for name in SERVER_SOURCES:
            await manager.ensure_server_config(name, all_configs[name], force_connect=True)
        statuses = {item.name: item for item in manager.list_statuses()}
        for name in SERVER_SOURCES:
            status = statuses[name]
            if status.state != "connected":
                failures.append(f"startup:{name}:{status.detail}")
            else:
                verifier.results.append(CheckResult(f"startup:{name}", "PASS", 0))
        if failures:
            return verifier.results, failures

        await verifier.verify_resources()
        healthy: dict[tuple[str, str], bool] = {}
        for server, sources in SERVER_SOURCES.items():
            for source in sources:
                try:
                    healthy[(server, source)] = await verifier.health(server, source)
                except Exception as exc:
                    healthy[(server, source)] = False
                    failures.append(f"health:{server}:{source}:{type(exc).__name__}:{exc}")

        workflows = (
            verifier.verify_company,
            verifier.verify_trade,
            verifier.verify_macro,
            verifier.verify_legislation,
            verifier.verify_patent,
            verifier.verify_environment,
            verifier.verify_development,
        )
        for workflow in workflows:
            try:
                await workflow(healthy)
            except Exception as exc:
                failures.append(f"workflow:{workflow.__name__}:{type(exc).__name__}:{exc}")
    finally:
        await manager.close()
    return verifier.results, failures


def _print_results(results: list[CheckResult], failures: list[str]) -> None:
    for result in results:
        print(
            f"{result.status:21} {result.label:55} "
            f"{result.elapsed_ms:6} ms {result.response_bytes:8} bytes"
        )
    for failure in failures:
        print(f"FAIL                  {failure}")
    counts = {
        status: sum(1 for result in results if result.status == status)
        for status in ("PASS", "BLOCKED_NO_CREDENTIAL")
    }
    print(
        f"SUMMARY pass={counts['PASS']} blocked_no_credential={counts['BLOCKED_NO_CREDENTIAL']} "
        f"fail={len(failures)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="MyHarness repository root",
    )
    args = parser.parse_args()
    results, failures = asyncio.run(run_verification(args.root.resolve()))
    _print_results(results, failures)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
