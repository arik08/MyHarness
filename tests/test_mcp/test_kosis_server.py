"""Tests for the KOSIS MCP server."""

from __future__ import annotations

import pytest

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any


def _load_kosis_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "kosis" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("kosis_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_get_passes_corporate_ssl_context_to_httpx(monkeypatch) -> None:
    kosis_server = _load_kosis_server()
    verify_context = object()
    calls: list[dict[str, Any]] = []

    class Response:
        text = "[]"

        def raise_for_status(self) -> None:
            return None

    def fake_get(*args: Any, **kwargs: Any) -> Response:
        calls.append({"args": args, "kwargs": kwargs})
        return Response()

    monkeypatch.setattr(kosis_server, "_httpx_verify_argument", lambda: verify_context, raising=False)
    monkeypatch.setattr(kosis_server.httpx, "get", fake_get)

    assert kosis_server._get("statisticsList.do", {}) == []

    assert calls
    assert calls[0]["kwargs"]["verify"] is verify_context


@pytest.mark.parametrize("alias,expected", [("title","TBL"),("items","ITM"),("prd","PRD"),("unit","UNIT")])
def test_metadata_aliases_and_upstream_errors(monkeypatch, alias, expected):
    module = _load_kosis_server()
    def get(path, params):
        assert params["type"] == expected
        raise ValueError("KOSIS API error 30: no data")
    monkeypatch.setattr(module, "_get", get)
    with pytest.raises(ValueError, match="error 30"):
        module.get_table_meta("101", "any-new-table", alias)


def test_unknown_metadata_type_does_not_make_request(monkeypatch):
    module = _load_kosis_server()
    monkeypatch.setattr(module, "_get", lambda *a: pytest.fail("unexpected network request"))
    with pytest.raises(ValueError, match="meta_type"):
        module.get_table_meta("101", "table", "unknown")
