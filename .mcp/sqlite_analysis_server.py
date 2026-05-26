"""Read-only World Bank WDI SQLite MCP server for RDB analysis tests."""

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

server = FastMCP("worldbank-rdb")


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"SQLite database not found: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def rows_to_json(rows: list[sqlite3.Row]) -> str:
    return json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2)


def dicts_to_json(rows: list[dict[str, Any]]) -> str:
    return json.dumps(rows, ensure_ascii=False, indent=2)


def assert_read_only(sql: str) -> None:
    stripped = sql.strip().rstrip(";")
    if not re.match(r"(?is)^(select|with)\b", stripped):
        raise ValueError("Only SELECT or WITH queries are allowed.")
    blocked = r"(?is)\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum)\b"
    if re.search(blocked, stripped):
        raise ValueError("Query contains a blocked write or configuration keyword.")


@server.tool()
def list_tables() -> str:
    """List available SQLite tables with row counts, source URLs, and table descriptions."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT
                s.table_name,
                s.row_count,
                s.source,
                s.url,
                d.description AS table_description
            FROM dataset_sources AS s
            LEFT JOIN data_dictionary_tables AS d
                ON d.table_name = s.table_name
            ORDER BY s.table_name
            """
        ).fetchall()
    return rows_to_json(rows)


@server.tool()
def describe_table(table_name: str) -> str:
    """Return SQLite column metadata plus data-dictionary descriptions for one table."""
    safe_table = table_name.strip()
    with connect() as conn:
        known = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (safe_table,),
        ).fetchone()
        if known is None:
            raise ValueError(f"Unknown table: {safe_table}")
        description_rows = conn.execute(
            """
            SELECT column_name, description
            FROM data_dictionary_columns
            WHERE table_name = ?
            """,
            (safe_table,),
        ).fetchall()
        descriptions = {row["column_name"]: row["description"] for row in description_rows}
        rows = [
            {**dict(row), "description": descriptions.get(row["name"])}
            for row in conn.execute(f'PRAGMA table_info("{safe_table}")').fetchall()
        ]
    return dicts_to_json(rows)


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


@server.resource("worldbank-rdb://overview", name="World Bank RDB overview")
def overview() -> str:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT
                s.table_name,
                s.row_count,
                s.source,
                s.url,
                d.description AS table_description
            FROM dataset_sources AS s
            LEFT JOIN data_dictionary_tables AS d
                ON d.table_name = s.table_name
            ORDER BY s.table_name
            """
        ).fetchall()
    return rows_to_json(rows)


if __name__ == "__main__":
    server.run("stdio")
