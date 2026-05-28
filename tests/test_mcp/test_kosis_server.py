"""Tests for the KOSIS MCP server."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any


def _load_kosis_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "kosis_server.py"
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
