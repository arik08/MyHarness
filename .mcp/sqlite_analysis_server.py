"""Small read-only SQLite MCP server for local analysis tests."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "analysis_samples.sqlite"
MAX_ROWS = 200

server = FastMCP("myharness-sqlite-analysis")


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"SQLite database not found: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def rows_to_json(rows: list[sqlite3.Row]) -> str:
    return json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2)


def assert_read_only(sql: str) -> None:
    stripped = sql.strip().rstrip(";")
    if not re.match(r"(?is)^(select|with)\b", stripped):
        raise ValueError("Only SELECT or WITH queries are allowed.")
    blocked = r"(?is)\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum)\b"
    if re.search(blocked, stripped):
        raise ValueError("Query contains a blocked write or configuration keyword.")


@server.tool()
def list_tables() -> str:
    """List available SQLite tables with row counts and source URLs."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT table_name, row_count, source, url
            FROM dataset_sources
            ORDER BY table_name
            """
        ).fetchall()
    return rows_to_json(rows)


@server.tool()
def describe_table(table_name: str) -> str:
    """Return SQLite column metadata for one table."""
    safe_table = table_name.strip()
    with connect() as conn:
        known = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (safe_table,),
        ).fetchone()
        if known is None:
            raise ValueError(f"Unknown table: {safe_table}")
        rows = conn.execute(f'PRAGMA table_info("{safe_table}")').fetchall()
    return rows_to_json(rows)


@server.tool()
def sample_rows(table_name: str, limit: int = 5) -> str:
    """Return a small sample from one table."""
    safe_table = table_name.strip()
    safe_limit = max(1, min(int(limit), MAX_ROWS))
    with connect() as conn:
        known = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (safe_table,),
        ).fetchone()
        if known is None:
            raise ValueError(f"Unknown table: {safe_table}")
        rows = conn.execute(f'SELECT * FROM "{safe_table}" LIMIT ?', (safe_limit,)).fetchall()
    return rows_to_json(rows)


@server.tool()
def query(sql: str, limit: int = 50) -> str:
    """Run a read-only SQL query and return JSON rows."""
    assert_read_only(sql)
    safe_limit = max(1, min(int(limit), MAX_ROWS))
    with connect() as conn:
        rows = conn.execute(f"SELECT * FROM ({sql.strip().rstrip(';')}) LIMIT ?", (safe_limit,)).fetchall()
    return rows_to_json(rows)


@server.resource("sqlite-analysis://overview", name="SQLite analysis overview")
def overview() -> str:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT table_name, row_count, source, url
            FROM dataset_sources
            ORDER BY table_name
            """
        ).fetchall()
    return rows_to_json(rows)


if __name__ == "__main__":
    server.run("stdio")
