"""Tests for the grouped company disclosure MCP server."""

from __future__ import annotations

import importlib.util
import io
import json
import logging
import subprocess
import zipfile
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from defusedxml.common import DefusedXmlException

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp import official_data
from myharness.mcp.types import McpStdioServerConfig


def _load_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "company_disclosure_server.py"
    spec = importlib.util.spec_from_file_location(
        "company_disclosure_server_under_test", module_path
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dart_corp_zip() -> bytes:
    xml = b"""<?xml version='1.0' encoding='UTF-8'?>
<result><list><corp_code>00126380</corp_code><corp_name>Samsung Electronics</corp_name>
<corp_eng_name>Samsung Electronics Co., Ltd.</corp_eng_name><stock_code>005930</stock_code>
<modify_date>20260101</modify_date></list></result>"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("CORPCODE.xml", xml)
    return output.getvalue()


def test_opendart_company_search_parses_structured_zip(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = _dart_corp_zip()

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"source": source, "url": url, **kwargs})
        return Response()

    monkeypatch.setenv("DART_API_KEY", "test-dart-key")
    monkeypatch.setattr(module, "request", fake_request)

    result = json.loads(module.search_catalog("opendart", "005930"))

    assert result["source"] == "Financial Supervisory Service OpenDART"
    assert result["data"][0]["corp_code"] == "00126380"
    assert calls[0]["params"]["crtfc_key"] == "test-dart-key"
    assert "test-dart-key" not in json.dumps(result)


def test_opendart_financials_use_json_api_and_common_metadata(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {
            "status": "000",
            "message": "OK",
            "list": [{"account_nm": "Revenue", "thstrm_amount": "100"}],
        }

    monkeypatch.setenv("DART_API_KEY", "test-dart-key")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result = json.loads(
        module.get_record(
            "opendart",
            "00126380",
            record_type="financials",
            business_year=2025,
            report_code="11011",
            financial_statement="CFS",
        )
    )

    assert calls[0]["url"].endswith("/fnlttSinglAcntAll.json")
    assert calls[0]["params"]["corp_code"] == "00126380"
    assert result["as_of"] == "2025"
    assert result["completeness"] == "row_limited_reported_by_filer"
    assert result["data"][0]["account_nm"] == "Revenue"


def test_opendart_missing_key_is_explicit(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("DART_API_KEY", raising=False)
    monkeypatch.delenv("OPENDART_API_KEY", raising=False)

    with pytest.raises(ValueError, match="DART_API_KEY"):
        module.get_record("opendart", "00126380")


def test_sec_search_requires_and_sends_fair_access_user_agent(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}}

    monkeypatch.setenv("SEC_USER_AGENT", "MyHarness test@example.com")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result = json.loads(module.search_catalog("sec", "AAPL"))

    assert result["data"][0]["cik_str"] == 320193
    assert calls[0]["headers"]["User-Agent"] == "MyHarness test@example.com"


def test_sec_json_falls_back_to_system_curl_without_shell(monkeypatch) -> None:
    module = _load_server()

    def fail_request_json(*args: Any, **kwargs: Any) -> object:
        del args, kwargs
        raise RuntimeError("edge block")

    def fake_run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        assert kwargs["check"] is False
        assert "shell" not in kwargs
        assert args[-1].startswith("https://data.sec.gov/")
        return subprocess.CompletedProcess(args, 0, b'{"cik":"0000320193"}', b"")

    monkeypatch.setenv("SEC_USER_AGENT", "MyHarness test@example.com")
    monkeypatch.setattr(module, "request_json", fail_request_json)
    monkeypatch.setattr(
        module.shutil, "which", lambda name: "curl.exe" if name == "curl.exe" else None
    )
    monkeypatch.setattr(module.subprocess, "run", fake_run)

    payload = module._sec_json("https://data.sec.gov/submissions/CIK0000320193.json")

    assert payload == {"cik": "0000320193"}


def test_sec_health_uses_data_host_that_serves_filing_json(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"cik": "0000320193", "name": "Apple Inc."}

    monkeypatch.setenv("SEC_USER_AGENT", "MyHarness test@example.com")
    monkeypatch.setattr(module, "_sec_json", lambda url: fake_request_json("SEC EDGAR", url))

    health = json.loads(module.get_source_health("sec"))

    assert health["ok"] is True
    assert calls[0]["url"].startswith("https://data.sec.gov/submissions/")


def test_companies_house_uses_basic_auth_without_returning_key(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"items": [{"company_number": "00000006", "title": "MARINE AND GENERAL"}]}

    monkeypatch.setenv("COMPANIES_HOUSE_API_KEY", "test-house-key")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result_text = module.search_catalog("companies_house", "marine")
    result = json.loads(result_text)

    assert result["data"][0]["company_number"] == "00000006"
    assert calls[0]["headers"]["Authorization"].startswith("Basic ")
    assert "test-house-key" not in result_text


def test_document_tool_returns_links_without_downloading() -> None:
    module = _load_server()

    result = json.loads(module.get_document_link("opendart", "20260101000001"))

    assert result["data"]["url"].endswith("rcpNo=20260101000001")
    assert result["completeness"] == "link_only_no_document_download"


def test_company_disclosure_config_is_loaded_without_embedded_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    config = configs["company-disclosure"]
    assert isinstance(config, McpStdioServerConfig)
    assert config.command == "python"
    assert config.args == [".mcp/company_disclosure_server.py"]
    assert config.cwd == "."
    assert config.env is None


def test_common_http_logging_does_not_expose_query_credentials() -> None:
    assert logging.getLogger("httpx").level >= logging.WARNING
    assert logging.getLogger("httpcore").level >= logging.WARNING


def test_opendart_search_normalizes_iso_dates(monkeypatch) -> None:
    module = _load_server()
    captured: dict[str, Any] = {}

    def fake_dart(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        captured.update(params)
        return {"status": "000", "list": []}

    monkeypatch.setattr(module, "_dart_json", fake_dart)
    module.search_records(
        "opendart",
        identifier="00126380",
        start_date="2025-01-02",
        end_date="20250131",
    )

    assert captured["bgn_de"] == "20250102"
    assert captured["end_de"] == "20250131"


def test_sec_search_applies_requested_date_range(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "_sec_json",
        lambda _url: {
            "name": "Example",
            "filings": {
                "recent": {
                    "accessionNumber": ["a", "b", "c"],
                    "filingDate": ["2025-02-01", "2025-01-15", "2024-12-01"],
                }
            },
        },
    )

    result = json.loads(
        module.search_records(
            "sec",
            identifier="320193",
            start_date="2025-01-01",
            end_date="2025-01-31",
        )
    )

    assert [row["accessionNumber"] for row in result["data"]] == ["b"]


def test_sec_companyfacts_are_bounded(monkeypatch) -> None:
    module = _load_server()
    facts = {
        f"Concept{index}": {
            "label": f"Concept {index}",
            "units": {"USD": [{"fy": year} for year in range(1990, 2026)]},
        }
        for index in range(5)
    }
    monkeypatch.setattr(
        module,
        "_sec_json",
        lambda _url: {"cik": 1, "entityName": "Example", "facts": {"us-gaap": facts}},
    )

    result = json.loads(module.get_record("sec", "1", "companyfacts", limit=2))

    assert result["metadata"] == {"total_concepts": 5, "returned_concepts": 2}
    assert len(result["data"]["facts"]["us-gaap"]) == 2
    first = next(iter(result["data"]["facts"]["us-gaap"].values()))
    assert len(first["units"]["USD"]) == 20


@pytest.mark.parametrize(
    ("source", "env_names"),
    [
        ("opendart", ("DART_API_KEY", "OPENDART_API_KEY")),
        ("sec", ("SEC_USER_AGENT",)),
        ("companies_house", ("COMPANIES_HOUSE_API_KEY",)),
    ],
)
def test_company_health_reports_missing_credentials(monkeypatch, source, env_names) -> None:
    module = _load_server()
    for name in env_names:
        monkeypatch.delenv(name, raising=False)

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is False
    assert result["credential"]["configured"] is False


def test_sec_submissions_profile_is_bounded(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "_sec_json",
        lambda _url: {
            "cik": "1",
            "name": "Example",
            "tickers": ["EX"],
            "filings": {
                "recent": {
                    "accessionNumber": ["a", "b", "c"],
                    "filingDate": ["2025-03-01", "2025-02-01", "2025-01-01"],
                }
            },
        },
    )

    result = json.loads(module.get_record("sec", "1", "submissions", limit=2))

    assert result["data"]["name"] == "Example"
    assert len(result["data"]["recent_filings"]) == 2
    with pytest.raises(ValueError, match="record_type"):
        module.get_record("sec", "1", "unknown")


def test_companies_house_search_filings_profile_and_officers(monkeypatch) -> None:
    module = _load_server()
    calls: list[str] = []

    def fake_json(path: str, params=None) -> object:
        calls.append(path)
        if path == "search/companies":
            return {"items": [{"company_number": "00000006"}]}
        if path.endswith("filing-history"):
            return {
                "total_count": 2,
                "items": [
                    {"date": "2025-02-01", "type": "AA"},
                    {"date": "2024-02-01", "type": "AA"},
                ],
            }
        if path.endswith("officers"):
            return {"items": [{"name": "Director"}]}
        return {"company_name": "EXAMPLE PLC"}

    monkeypatch.setattr(module, "_companies_house_json", fake_json)

    catalog = json.loads(module.search_catalog("companies_house", "EXAMPLE", 1))
    filings = json.loads(
        module.search_records(
            "companies_house",
            identifier="00000006",
            start_date="2025-01-01",
            limit=5,
        )
    )
    profile = json.loads(module.get_record("companies_house", "00000006", "company"))
    officers = json.loads(module.get_record("companies_house", "00000006", "officers"))

    assert catalog["data"][0]["company_number"] == "00000006"
    assert len(filings["data"]) == 1
    assert profile["data"]["company_name"] == "EXAMPLE PLC"
    assert officers["data"]["items"][0]["name"] == "Director"
    assert "company/00000006/officers" in calls


@pytest.mark.parametrize(
    ("source", "env_name", "probe_name"),
    [
        ("opendart", "DART_API_KEY", "_dart_json"),
        ("sec", "SEC_USER_AGENT", "_sec_json"),
        ("companies_house", "COMPANIES_HOUSE_API_KEY", "_companies_house_json"),
    ],
)
def test_company_health_success_paths(monkeypatch, source, env_name, probe_name) -> None:
    module = _load_server()
    monkeypatch.setenv(env_name, "configured-test-value")
    monkeypatch.setattr(module, probe_name, lambda *_args, **_kwargs: {})

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True


def test_company_document_links_cover_sec_accession_and_companies_house() -> None:
    module = _load_server()

    sec = json.loads(module.get_document_link("sec", "0000320193-25-000079", auxiliary_id="320193"))
    companies_house = json.loads(module.get_document_link("companies_house", "00000006"))

    assert "/000032019325000079/" in sec["data"]["url"]
    assert companies_house["data"]["url"].endswith("/company/00000006")
    assert official_data.logging.getLogger("httpx").level >= logging.WARNING


def test_opendart_corporation_xml_rejects_external_entities(monkeypatch) -> None:
    module = _load_server()

    class Response:
        content = b'<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><result><list><corp_name>&xxe;</corp_name></list></result>'

    monkeypatch.setenv("DART_API_KEY", "configured")
    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: Response())
    module._dart_corporations.cache_clear()

    with pytest.raises(DefusedXmlException):
        module._dart_corporations()
