"""Tests for the grouped legislation-regulation MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from defusedxml.common import DefusedXmlException

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_server() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "legislation-regulation" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("legislation_regulation_server_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_federal_register_uses_structured_search(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"results": [{"document_number": "2025-12345", "title": "Steel rule"}]}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(module.search_records("federal_register", "steel", 5))

    assert calls[0]["params"]["conditions[term]"] == "steel"
    assert result["data"][0]["document_number"] == "2025-12345"


def test_europarl_requires_json_ld_and_locally_filters(monkeypatch) -> None:
    module = _load_server()

    def fake_ep(path: str, params: dict[str, Any] | None = None) -> object:
        return {"data": [{"process_id": "2024-2526", "label": "Steel procedure"}]}

    monkeypatch.setattr(module, "_ep_json", fake_ep)
    result = json.loads(module.search_records("europarl", "steel"))

    assert result["data"][0]["process_id"] == "2024-2526"
    assert result["completeness"] == "latest_page_locally_filtered"


def test_uk_bills_routes_stages(monkeypatch) -> None:
    module = _load_server()
    calls: list[str] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(url)
        return {"items": [{"stageId": 1}]}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(module.get_record("uk_bills", "4123", "stages"))

    assert calls[0].endswith("/Bills/4123/Stages")
    assert result["source_id"] == "Bills/4123/Stages"


def test_uk_legislation_rejects_arbitrary_paths() -> None:
    module = _load_server()

    try:
        module.get_record("uk_legislation", "../../secret")
    except ValueError as exc:
        assert "ukpga/2025/18" in str(exc)
    else:
        raise AssertionError("unsafe path should be rejected")


def test_cellar_parses_bounded_structured_xml(monkeypatch) -> None:
    module = _load_server()

    class Response:
        content = b"<NOTICE><WORK><ID>32023R0956</ID><TITLE>CBAM</TITLE></WORK></NOTICE>"

    monkeypatch.setattr(module, "request", lambda *args, **kwargs: Response())
    result = json.loads(module.get_record("eurlex", "32023R0956"))

    assert result["data"]["values"]["TITLE"] == ["CBAM"]
    assert result["completeness"] == "structured_metadata_no_pdf_or_ocr"


def test_legislation_xml_rejects_external_entities() -> None:
    module = _load_server()

    with pytest.raises(DefusedXmlException):
        module._xml_summary(
            b'<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><NOTICE>&xxe;</NOTICE>'
        )


def test_congress_requires_key_without_exposing_it(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("CONGRESS_API_KEY", "secret-test-key")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"bill": {"number": "1"}}

    monkeypatch.setattr(module, "request_json", fake_json)
    output = module.get_record("congress", "119/hr/1")

    assert calls[0]["params"]["api_key"] == "secret-test-key"
    assert "secret-test-key" not in output


def test_config_is_loaded_without_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"
    config = load_mcp_configs_from_dirs([mcp_dir])["legislation-regulation"]

    assert isinstance(config, McpStdioServerConfig)
    assert config.env is None
    assert config.args == ["runtime/server.py"]


@pytest.mark.parametrize(
    ("record_id", "expected_segment"),
    [
        ("119/hr/1", "/house-bill/1"),
        ("119/s/1", "/senate-bill/1"),
        ("119/hjres/1", "/house-joint-resolution/1"),
    ],
)
def test_congress_document_links_use_public_site_bill_type_slugs(
    record_id, expected_segment
) -> None:
    module = _load_server()

    result = json.loads(module.get_document_link("congress", record_id))

    assert expected_segment in result["data"]["url"]


def test_congress_rejects_unknown_detail_suffix_before_network() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="record_type"):
        module.get_record("congress", "119/hr/1", "made-up")


def test_congress_health_reports_missing_key(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("CONGRESS_API_KEY", raising=False)
    monkeypatch.delenv("DATA_GOV_API_KEY", raising=False)

    result = json.loads(module.get_source_health("congress"))

    assert result["ok"] is False
    assert result["credential"]["configured"] is False


def test_legislation_health_converts_probe_failure_to_health_json(monkeypatch) -> None:
    module = _load_server()

    def fail(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(module, "request_json", fail)
    result = json.loads(module.get_source_health("federal_register"))

    assert result["ok"] is False
    assert "RuntimeError" in result["detail"]


def test_congress_catalog_and_search_apply_local_filter(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("CONGRESS_API_KEY", "configured")

    def fake_congress(path: str, params=None) -> object:
        if path == "congress":
            return {"congresses": [{"number": 119}]}
        return {
            "bills": [
                {"number": "1", "title": "Steel competitiveness"},
                {"number": "2", "title": "Unrelated"},
            ]
        }

    monkeypatch.setattr(module, "_congress_json", fake_congress)

    catalog = json.loads(module.search_catalog("congress", limit=1))
    search = json.loads(module.search_records("congress", "steel", congress=119, bill_type="hr"))

    assert catalog["data"] == [{"number": 119}]
    assert search["source_id"] == "bill/119/hr"
    assert [row["number"] for row in search["data"]] == ["1"]
    with pytest.raises(ValueError, match="congress is required"):
        module.search_records("congress", bill_type="hr")


def test_eurlex_search_delegates_to_exact_celex_record(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "get_record",
        lambda source, record_id: json.dumps({"source": source, "id": record_id}),
    )

    result = json.loads(module.search_records("eurlex", "32023R0956"))

    assert result == {"source": "eurlex", "id": "32023R0956"}
    with pytest.raises(ValueError, match="exact CELEX"):
        module.search_records("eurlex", "")


def test_uk_bills_search_and_federal_register_detail(monkeypatch) -> None:
    module = _load_server()
    calls: list[str] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(url)
        return (
            {"items": [{"billId": 1}]} if url.endswith("/Bills") else {"document_number": "2025-1"}
        )

    monkeypatch.setattr(module, "request_json", fake_json)

    bills = json.loads(module.search_records("uk_bills", "steel", limit=1))
    detail = json.loads(module.get_record("federal_register", "2025-12345"))

    assert bills["data"] == [{"billId": 1}]
    assert detail["data"]["document_number"] == "2025-1"
    assert calls[1].endswith("/documents/2025-12345.json")


def test_uk_legislation_atom_search_and_xml_detail(monkeypatch) -> None:
    module = _load_server()

    class Response:
        content = b"""<feed xmlns='http://www.w3.org/2005/Atom'>
        <entry><id>ukpga/2025/18</id><title>Steel Act</title><updated>2025-01-01</updated>
        <link href='https://example.test/act'/></entry></feed>"""

    class DetailResponse:
        content = b"<Legislation><Title>Steel Act</Title></Legislation>"

    responses = iter([Response(), DetailResponse()])
    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: next(responses))

    search = json.loads(module.search_records("uk_legislation", "steel", limit=1))
    detail = json.loads(module.get_record("uk_legislation", "ukpga/2025/18"))

    assert search["data"][0]["title"] == "Steel Act"
    assert detail["data"]["values"]["Title"] == ["Steel Act"]


def test_europarl_events_and_uk_bill_publications(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(module, "_ep_json", lambda path, params=None: {"path": path})
    monkeypatch.setattr(
        module,
        "request_json",
        lambda source, url, **kwargs: {"items": [{"publicationId": 7}]},
    )

    events = json.loads(module.get_record("europarl", "2021-0214", "events"))
    publications = json.loads(module.get_record("uk_bills", "4123", "publications"))

    assert events["data"]["path"].endswith("/events")
    assert publications["source_id"].endswith("/Publications")


@pytest.mark.parametrize(
    ("source", "record_id", "expected"),
    [
        ("federal_register", "2025-12345", "federalregister.gov/d/2025-12345"),
        ("europarl", "2021-0214", "reference=2021-0214"),
        ("eurlex", "32023R0956", "CELEX:32023R0956"),
        ("uk_bills", "4123", "bills.parliament.uk/bills/4123"),
        ("uk_legislation", "ukpga/2025/18", "legislation.gov.uk/ukpga/2025/18"),
    ],
)
def test_document_links_for_every_non_congress_source(source, record_id, expected) -> None:
    module = _load_server()

    result = json.loads(module.get_document_link(source, record_id))

    assert expected in result["data"]["url"]


@pytest.mark.parametrize(
    "source",
    ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"],
)
def test_legislation_health_success_for_every_source(monkeypatch, source) -> None:
    module = _load_server()
    monkeypatch.setenv("CONGRESS_API_KEY", "configured")

    class Response:
        content = b"<feed/>"

    monkeypatch.setattr(module, "_congress_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(module, "_ep_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: Response())

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True
