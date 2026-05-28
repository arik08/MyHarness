"""Tests for the worldsteel SQLite MCP server."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path
from types import ModuleType

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_worldsteel_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "worldsteel_server.py"
    spec = importlib.util.spec_from_file_location("worldsteel_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE dataset_sources (
                id INTEGER PRIMARY KEY,
                publication_year INTEGER NOT NULL,
                title TEXT NOT NULL,
                source_url TEXT NOT NULL,
                source_type TEXT NOT NULL,
                retrieved_at TEXT NOT NULL,
                license_note TEXT NOT NULL
            );
            CREATE TABLE worldsteel_values (
                id INTEGER PRIMARY KEY,
                source_id INTEGER NOT NULL,
                publication_year INTEGER NOT NULL,
                section TEXT NOT NULL,
                indicator TEXT NOT NULL,
                unit TEXT,
                row_label TEXT NOT NULL,
                period TEXT,
                column_label TEXT,
                value REAL NOT NULL,
                value_text TEXT NOT NULL,
                raw_line TEXT NOT NULL,
                source_url TEXT NOT NULL
            );
            INSERT INTO dataset_sources VALUES
                (1, 2025, 'World Steel in Figures 2025', 'https://worldsteel.org/example', 'html', '2026-01-01T00:00:00Z', 'Public worldsteel source.');
            INSERT INTO worldsteel_values VALUES
                (1, 1, 2025, 'Crude steel production', 'World crude steel production', 'million tonnes', 'World', '2024', 'World', 1885.0, '1 885', '2024 1 885', 'https://worldsteel.org/example'),
                (2, 1, 2025, 'Crude steel production', 'Top 50 steel-producing companies 2024', 'million tonnes', 'POSCO Holdings', '2024', '2024', 37.79, '37.79', '8 POSCO Holdings 37.79', 'https://worldsteel.org/example');
            """
        )


def test_query_is_read_only_and_returns_rows(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "worldsteel.sqlite"
    _make_db(db_path)
    monkeypatch.setenv("WORLDSTEEL_DB_PATH", str(db_path))
    server = _load_worldsteel_server()

    output = server.query(
        "SELECT row_label, period, value FROM worldsteel_values WHERE row_label = 'POSCO Holdings'",
        limit=5,
    )

    assert json.loads(output) == [{"row_label": "POSCO Holdings", "period": "2024", "value": 37.79}]


def test_query_rejects_writes(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "worldsteel.sqlite"
    _make_db(db_path)
    monkeypatch.setenv("WORLDSTEEL_DB_PATH", str(db_path))
    server = _load_worldsteel_server()

    try:
        server.query("DROP TABLE worldsteel_values")
    except ValueError as exc:
        assert "Only SELECT or WITH" in str(exc)
    else:
        raise AssertionError("write query should fail")


def test_worldsteel_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["worldsteel"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/worldsteel_server.py"]
    assert server.cwd == "."
