"""Download small public analysis datasets and load them into SQLite."""

from __future__ import annotations

import csv
import json
import sqlite3
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "analysis_samples.sqlite"

DATASETS = {
    "cars": {
        "url": "https://cdn.jsdelivr.net/npm/vega-datasets@3.2.1/data/cars.json",
        "file": "cars.json",
        "format": "json",
        "source": "vega-datasets cars.json",
    },
    "flights_airport": {
        "url": "https://cdn.jsdelivr.net/npm/vega-datasets@3.2.1/data/flights-airport.csv",
        "file": "flights-airport.csv",
        "format": "csv",
        "source": "vega-datasets flights-airport.csv",
    },
    "gapminder_health_income": {
        "url": "https://cdn.jsdelivr.net/npm/vega-datasets@3.2.1/data/gapminder-health-income.csv",
        "file": "gapminder-health-income.csv",
        "format": "csv",
        "source": "vega-datasets gapminder-health-income.csv",
    },
    "unemployment_industries": {
        "url": "https://cdn.jsdelivr.net/npm/vega-datasets@3.2.1/data/unemployment-across-industries.json",
        "file": "unemployment-across-industries.json",
        "format": "json",
        "source": "vega-datasets unemployment-across-industries.json",
    },
}


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "MyHarness MCP sample loader"})
    with urllib.request.urlopen(request, timeout=60) as response:
        destination.write_bytes(response.read())


def normalize_name(value: str) -> str:
    clean = "".join(ch.lower() if ch.isalnum() else "_" for ch in value.strip())
    clean = "_".join(part for part in clean.split("_") if part)
    return clean or "column"


def infer_sql_type(values: list[Any]) -> str:
    non_empty = [value for value in values if value not in (None, "")]
    if not non_empty:
        return "TEXT"
    if all(isinstance(value, bool) for value in non_empty):
        return "INTEGER"
    if all(_is_int(value) for value in non_empty):
        return "INTEGER"
    if all(_is_float(value) for value in non_empty):
        return "REAL"
    return "TEXT"


def _is_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        return str(int(str(value))).strip() == str(value).strip()
    except (TypeError, ValueError):
        return False


def _is_float(value: Any) -> bool:
    try:
        float(str(value))
        return True
    except (TypeError, ValueError):
        return False


def coerce(value: Any, sql_type: str) -> Any:
    if value in (None, ""):
        return None
    if sql_type == "INTEGER":
        return int(value)
    if sql_type == "REAL":
        return float(value)
    return str(value)


def load_rows(path: Path, fmt: str) -> list[dict[str, Any]]:
    if fmt == "json":
        return json.loads(path.read_text(encoding="utf-8"))
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def create_table(conn: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise ValueError(f"{table} has no rows")

    original_columns = list(rows[0].keys())
    columns = [normalize_name(column) for column in original_columns]
    sql_types = [
        infer_sql_type([row.get(original_column) for row in rows[:250]])
        for original_column in original_columns
    ]

    conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    column_defs = ", ".join(
        f'"{column}" {sql_type}' for column, sql_type in zip(columns, sql_types, strict=True)
    )
    conn.execute(f'CREATE TABLE "{table}" ({column_defs})')

    placeholders = ", ".join("?" for _ in columns)
    column_sql = ", ".join(f'"{column}"' for column in columns)
    conn.executemany(
        f'INSERT INTO "{table}" ({column_sql}) VALUES ({placeholders})',
        [
            tuple(coerce(row.get(original_column), sql_type) for original_column, sql_type in zip(original_columns, sql_types, strict=True))
            for row in rows
        ],
    )


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS dataset_sources (
                table_name TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                url TEXT NOT NULL,
                local_file TEXT NOT NULL,
                row_count INTEGER NOT NULL
            )
            """
        )
        conn.execute("DELETE FROM dataset_sources")

        for table, spec in DATASETS.items():
            path = DATA_DIR / str(spec["file"])
            download(str(spec["url"]), path)
            rows = load_rows(path, str(spec["format"]))
            create_table(conn, table, rows)
            conn.execute(
                """
                INSERT INTO dataset_sources(table_name, source, url, local_file, row_count)
                VALUES (?, ?, ?, ?, ?)
                """,
                (table, spec["source"], spec["url"], str(path.relative_to(ROOT)), len(rows)),
            )
            print(f"loaded {table}: {len(rows)} rows")

        conn.commit()
        print(f"sqlite db: {DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
