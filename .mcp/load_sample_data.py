"""Download compact public analysis datasets and load them into SQLite."""

from __future__ import annotations

import csv
import datetime as dt
import json
import sqlite3
import time
import urllib.parse
import urllib.request
from collections import defaultdict
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

SEOUL_LINE9 = {
    "url": "https://data.seoul.go.kr/dataList/OA-22441/L/1/datasetView.do",
    "download_url": "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false",
    "file": "seoul_line9_2025.csv",
    "source": "Seoul Open Data Plaza - Seoul Metro Line 9 phase 2-3 hourly passengers",
    "post_data": {
        "infId": "OA-22441",
        "seq": "2",
        "seqNo": "",
        "infSeq": "2",
    },
}

WDI_INDICATORS = {
    "NY.GDP.MKTP.CD": "GDP (current US$)",
    "NY.GDP.PCAP.CD": "GDP per capita (current US$)",
    "NY.GDP.MKTP.PP.CD": "GDP, PPP (current international $)",
    "NY.GDP.PCAP.PP.CD": "GDP per capita, PPP (current international $)",
    "NY.GDP.MKTP.PP.KD": "GDP, PPP (constant 2021 international $)",
    "NY.GDP.PCAP.PP.KD": "GDP per capita, PPP (constant 2021 international $)",
    "NY.GDP.MKTP.KD.ZG": "GDP growth (annual %)",
    "SP.POP.TOTL": "Population, total",
    "SP.DYN.LE00.IN": "Life expectancy at birth, total (years)",
    "FP.CPI.TOTL.ZG": "Inflation, consumer prices (annual %)",
    "SL.UEM.TOTL.ZS": "Unemployment, total (% of total labor force)",
    "NE.TRD.GNFS.ZS": "Trade (% of GDP)",
}

WDI_GDP_LONG_INDICATORS = {
    "NY.GDP.MKTP.CD": "gdp_current_usd",
    "NY.GDP.PCAP.CD": "gdp_per_capita_current_usd",
    "NY.GDP.MKTP.PP.CD": "gdp_ppp_current_international",
    "NY.GDP.PCAP.PP.CD": "gdp_per_capita_ppp_current_international",
    "NY.GDP.MKTP.PP.KD": "gdp_ppp_constant_2021_international",
    "NY.GDP.PCAP.PP.KD": "gdp_per_capita_ppp_constant_2021_international",
    "NY.GDP.MKTP.KD.ZG": "gdp_growth_annual_pct",
}


def request_bytes(url: str, data: dict[str, str] | None = None, timeout: int = 60) -> bytes:
    payload = None if data is None else urllib.parse.urlencode(data).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "MyHarness MCP sample loader",
            },
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
            if attempt == 2:
                break
            time.sleep(1 + attempt)
    raise RuntimeError(f"Failed to fetch {url}") from last_error


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(request_bytes(url))


def download_post(url: str, form_data: dict[str, str], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(request_bytes(url, form_data, timeout=120))


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


def parse_int(value: str) -> int:
    return int((value or "0").replace(",", ""))


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
            tuple(
                coerce(row.get(original_column), sql_type)
                for original_column, sql_type in zip(original_columns, sql_types, strict=True)
            )
            for row in rows
        ],
    )


def insert_dataset_source(
    conn: sqlite3.Connection,
    table_name: str,
    source: str,
    url: str,
    local_file: str,
    row_count: int,
) -> None:
    conn.execute(
        """
        INSERT INTO dataset_sources(table_name, source, url, local_file, row_count)
        VALUES (?, ?, ?, ?, ?)
        """,
        (table_name, source, url, local_file, row_count),
    )


def create_seoul_line9_tables(conn: sqlite3.Connection, path: Path) -> dict[str, int]:
    for table in [
        "seoul_line9_monthly_hourly",
        "seoul_line9_daily",
        "seoul_line9_stations",
        "seoul_line9_calendar",
    ]:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')

    conn.execute(
        """
        CREATE TABLE seoul_line9_stations (
            station_id INTEGER PRIMARY KEY,
            line_id TEXT NOT NULL,
            station_code TEXT NOT NULL,
            station_name TEXT NOT NULL,
            UNIQUE(line_id, station_code)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE seoul_line9_calendar (
            service_date TEXT PRIMARY KEY,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            day INTEGER NOT NULL,
            day_of_week TEXT NOT NULL,
            is_weekend INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE seoul_line9_daily (
            service_date TEXT NOT NULL REFERENCES seoul_line9_calendar(service_date),
            station_id INTEGER NOT NULL REFERENCES seoul_line9_stations(station_id),
            ride_direction TEXT NOT NULL,
            total_passengers INTEGER NOT NULL,
            PRIMARY KEY(service_date, station_id, ride_direction)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE seoul_line9_monthly_hourly (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            station_id INTEGER NOT NULL REFERENCES seoul_line9_stations(station_id),
            ride_direction TEXT NOT NULL,
            hour INTEGER NOT NULL,
            passengers INTEGER NOT NULL,
            PRIMARY KEY(year, month, station_id, ride_direction, hour)
        )
        """
    )

    station_ids: dict[tuple[str, str], int] = {}
    station_rows: dict[int, tuple[int, str, str, str]] = {}
    calendar_dates: set[str] = set()
    daily_totals: defaultdict[tuple[str, int, str], int] = defaultdict(int)
    monthly_hourly: defaultdict[tuple[int, int, int, str, int], int] = defaultdict(int)
    hours = list(range(24))

    with path.open("r", encoding="cp949", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        if len(header) < 30:
            raise ValueError(f"Unexpected Seoul Line 9 CSV shape: {len(header)} columns")

        for row in reader:
            service_date = row[1]
            line_id = row[2]
            station_code = row[3]
            station_name = row[4]
            ride_direction = row[5]
            counts = [parse_int(value) for value in row[6:30]]

            station_key = (line_id, station_code)
            station_id = station_ids.get(station_key)
            if station_id is None:
                station_id = len(station_ids) + 1
                station_ids[station_key] = station_id
                station_rows[station_id] = (station_id, line_id, station_code, station_name)

            parsed = dt.date.fromisoformat(service_date)
            calendar_dates.add(service_date)
            daily_totals[(service_date, station_id, ride_direction)] += sum(counts)
            for hour, passengers in zip(hours, counts, strict=True):
                monthly_hourly[(parsed.year, parsed.month, station_id, ride_direction, hour)] += passengers

    conn.executemany(
        """
        INSERT INTO seoul_line9_stations(station_id, line_id, station_code, station_name)
        VALUES (?, ?, ?, ?)
        """,
        [station_rows[key] for key in sorted(station_rows)],
    )
    conn.executemany(
        """
        INSERT INTO seoul_line9_calendar(service_date, year, month, day, day_of_week, is_weekend)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                service_date,
                parsed.year,
                parsed.month,
                parsed.day,
                parsed.strftime("%A"),
                1 if parsed.weekday() >= 5 else 0,
            )
            for service_date in sorted(calendar_dates)
            for parsed in [dt.date.fromisoformat(service_date)]
        ],
    )
    conn.executemany(
        """
        INSERT INTO seoul_line9_daily(service_date, station_id, ride_direction, total_passengers)
        VALUES (?, ?, ?, ?)
        """,
        [
            (service_date, station_id, ride_direction, passengers)
            for (service_date, station_id, ride_direction), passengers in daily_totals.items()
        ],
    )
    conn.executemany(
        """
        INSERT INTO seoul_line9_monthly_hourly(year, month, station_id, ride_direction, hour, passengers)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (year, month, station_id, ride_direction, hour, passengers)
            for (year, month, station_id, ride_direction, hour), passengers in monthly_hourly.items()
        ],
    )

    return {
        "seoul_line9_calendar": len(calendar_dates),
        "seoul_line9_stations": len(station_rows),
        "seoul_line9_daily": len(daily_totals),
        "seoul_line9_monthly_hourly": len(monthly_hourly),
    }


def world_bank_country_url() -> str:
    return "https://api.worldbank.org/v2/country/all?format=json&per_page=400"


def world_bank_indicator_url(indicator_id: str) -> str:
    return (
        f"https://api.worldbank.org/v2/country/all/indicator/{indicator_id}"
        "?format=json&date=2020:2024&per_page=20000"
    )


def world_bank_long_indicator_url(indicator_id: str) -> str:
    return f"https://api.worldbank.org/v2/country/all/indicator/{indicator_id}?format=json&per_page=20000"


def create_world_bank_tables(conn: sqlite3.Connection) -> dict[str, int]:
    for table in [
        "world_bank_gdp_long",
        "world_bank_indicator_values",
        "world_bank_countries",
        "world_bank_indicators",
    ]:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')

    conn.execute(
        """
        CREATE TABLE world_bank_countries (
            economy_code TEXT PRIMARY KEY,
            economy_name TEXT NOT NULL,
            iso2_code TEXT,
            region TEXT,
            admin_region TEXT,
            income_level TEXT,
            lending_type TEXT,
            capital_city TEXT,
            longitude REAL,
            latitude REAL,
            is_aggregate INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE world_bank_indicators (
            indicator_id TEXT PRIMARY KEY,
            indicator_name TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE world_bank_indicator_values (
            economy_code TEXT NOT NULL REFERENCES world_bank_countries(economy_code),
            indicator_id TEXT NOT NULL REFERENCES world_bank_indicators(indicator_id),
            year INTEGER NOT NULL,
            value REAL,
            PRIMARY KEY(economy_code, indicator_id, year)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE world_bank_gdp_long (
            economy_code TEXT NOT NULL REFERENCES world_bank_countries(economy_code),
            year INTEGER NOT NULL,
            gdp_current_usd REAL,
            gdp_per_capita_current_usd REAL,
            gdp_ppp_current_international REAL,
            gdp_per_capita_ppp_current_international REAL,
            gdp_ppp_constant_2021_international REAL,
            gdp_per_capita_ppp_constant_2021_international REAL,
            gdp_growth_annual_pct REAL,
            PRIMARY KEY(economy_code, year)
        )
        """
    )

    country_rows: dict[str, dict[str, Any]] = {}
    country_name_to_code: dict[str, str] = {}
    country_payload = json.loads(request_bytes(world_bank_country_url()).decode("utf-8"))
    if not isinstance(country_payload, list) or len(country_payload) < 2:
        raise ValueError("Unexpected World Bank country API response")

    for item in country_payload[1]:
        code = item.get("id")
        if not code:
            continue
        region = (item.get("region") or {}).get("value") or None
        country_rows[code] = {
            "economy_code": code,
            "economy_name": item.get("name") or code,
            "iso2_code": item.get("iso2Code") or None,
            "region": region,
            "admin_region": (item.get("adminregion") or {}).get("value") or None,
            "income_level": (item.get("incomeLevel") or {}).get("value") or None,
            "lending_type": (item.get("lendingType") or {}).get("value") or None,
            "capital_city": item.get("capitalCity") or None,
            "longitude": float(item["longitude"]) if item.get("longitude") else None,
            "latitude": float(item["latitude"]) if item.get("latitude") else None,
            "is_aggregate": 1 if region == "Aggregates" else 0,
        }
        country_name_to_code[item.get("name") or code] = code

    def economy_code_for_item(item: dict[str, Any]) -> str | None:
        economy_name = (item.get("country") or {}).get("value") or ""
        economy_code = item.get("countryiso3code") or country_name_to_code.get(economy_name)
        economy_code = economy_code or (item.get("country") or {}).get("id")
        if not economy_code:
            return None
        country_rows.setdefault(
            economy_code,
            {
                "economy_code": economy_code,
                "economy_name": economy_name or economy_code,
                "iso2_code": None,
                "region": None,
                "admin_region": None,
                "income_level": None,
                "lending_type": None,
                "capital_city": None,
                "longitude": None,
                "latitude": None,
                "is_aggregate": 1,
            },
        )
        return economy_code

    value_rows: list[tuple[str, str, int, float | None]] = []
    for indicator_id in WDI_INDICATORS:
        payload = json.loads(request_bytes(world_bank_indicator_url(indicator_id)).decode("utf-8"))
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError(f"Unexpected World Bank API response for {indicator_id}")
        for item in payload[1]:
            economy_code = economy_code_for_item(item)
            if economy_code is None:
                continue
            value_rows.append((economy_code, indicator_id, int(item["date"]), item.get("value")))

    gdp_long_by_key: dict[tuple[str, int], dict[str, float | None]] = {}
    for indicator_id, column_name in WDI_GDP_LONG_INDICATORS.items():
        payload = json.loads(request_bytes(world_bank_long_indicator_url(indicator_id)).decode("utf-8"))
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError(f"Unexpected World Bank API response for {indicator_id}")
        for item in payload[1]:
            economy_code = economy_code_for_item(item)
            if economy_code is None:
                continue
            year = int(item["date"])
            if year < 1960:
                continue
            gdp_long_by_key.setdefault((economy_code, year), {})[column_name] = item.get("value")

    conn.executemany(
        """
        INSERT INTO world_bank_countries(
            economy_code, economy_name, iso2_code, region, admin_region, income_level,
            lending_type, capital_city, longitude, latitude, is_aggregate
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["economy_code"],
                row["economy_name"],
                row["iso2_code"],
                row["region"],
                row["admin_region"],
                row["income_level"],
                row["lending_type"],
                row["capital_city"],
                row["longitude"],
                row["latitude"],
                row["is_aggregate"],
            )
            for row in sorted(country_rows.values(), key=lambda value: value["economy_code"])
        ],
    )
    conn.executemany(
        "INSERT INTO world_bank_indicators(indicator_id, indicator_name) VALUES (?, ?)",
        sorted(WDI_INDICATORS.items()),
    )
    conn.executemany(
        """
        INSERT INTO world_bank_indicator_values(economy_code, indicator_id, year, value)
        VALUES (?, ?, ?, ?)
        """,
        value_rows,
    )
    gdp_long_rows = [
        (
            economy_code,
            year,
            values.get("gdp_current_usd"),
            values.get("gdp_per_capita_current_usd"),
            values.get("gdp_ppp_current_international"),
            values.get("gdp_per_capita_ppp_current_international"),
            values.get("gdp_ppp_constant_2021_international"),
            values.get("gdp_per_capita_ppp_constant_2021_international"),
            values.get("gdp_growth_annual_pct"),
        )
        for (economy_code, year), values in sorted(gdp_long_by_key.items())
        if any(value is not None for value in values.values())
    ]

    conn.executemany(
        """
        INSERT INTO world_bank_gdp_long(
            economy_code, year, gdp_current_usd, gdp_per_capita_current_usd,
            gdp_ppp_current_international, gdp_per_capita_ppp_current_international,
            gdp_ppp_constant_2021_international, gdp_per_capita_ppp_constant_2021_international,
            gdp_growth_annual_pct
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        gdp_long_rows,
    )

    return {
        "world_bank_countries": len(country_rows),
        "world_bank_indicators": len(WDI_INDICATORS),
        "world_bank_indicator_values": len(value_rows),
        "world_bank_gdp_long": len(gdp_long_rows),
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.unlink(missing_ok=True)

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute(
            """
            CREATE TABLE dataset_sources (
                table_name TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                url TEXT NOT NULL,
                local_file TEXT NOT NULL,
                row_count INTEGER NOT NULL
            )
            """
        )

        for table, spec in DATASETS.items():
            path = DATA_DIR / str(spec["file"])
            download(str(spec["url"]), path)
            rows = load_rows(path, str(spec["format"]))
            create_table(conn, table, rows)
            insert_dataset_source(
                conn,
                table,
                str(spec["source"]),
                str(spec["url"]),
                str(path.relative_to(ROOT)),
                len(rows),
            )
            print(f"loaded {table}: {len(rows)} rows")

        seoul_path = DATA_DIR / str(SEOUL_LINE9["file"])
        download_post(str(SEOUL_LINE9["download_url"]), dict(SEOUL_LINE9["post_data"]), seoul_path)
        for table, row_count in create_seoul_line9_tables(conn, seoul_path).items():
            insert_dataset_source(
                conn,
                table,
                SEOUL_LINE9["source"],
                SEOUL_LINE9["url"],
                str(seoul_path.relative_to(ROOT)),
                row_count,
            )
            print(f"loaded {table}: {row_count} rows")
        seoul_path.unlink(missing_ok=True)

        for table, row_count in create_world_bank_tables(conn).items():
            insert_dataset_source(
                conn,
                table,
                "World Bank World Development Indicators API",
                "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392",
                "downloaded from API during load",
                row_count,
            )
            print(f"loaded {table}: {row_count} rows")

        conn.commit()
        conn.execute("VACUUM")
        print(f"sqlite db: {DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
