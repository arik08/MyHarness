"""Load a realistic World Bank WDI-only relational dataset into SQLite."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DB_PATH = Path(".mcp/data/analysis_samples.sqlite")
DATA_DIR = DB_PATH.parent

START_YEAR = 1960
END_YEAR = dt.date.today().year - 1
USER_AGENT = "MyHarness SQLite MCP World Bank loader"
WDI_API_DOC_URL = "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392"

WDI_INDICATORS = {
    # GDP and national accounts.
    "NY.GDP.MKTP.CD": "GDP (current US$)",
    "NY.GDP.MKTP.KD": "GDP (constant 2015 US$)",
    "NY.GDP.MKTP.KD.ZG": "GDP growth (annual %)",
    "NY.GDP.PCAP.CD": "GDP per capita (current US$)",
    "NY.GDP.PCAP.KD": "GDP per capita (constant 2015 US$)",
    "NY.GDP.PCAP.KD.ZG": "GDP per capita growth (annual %)",
    "NY.GDP.MKTP.PP.CD": "GDP, PPP (current international $)",
    "NY.GDP.PCAP.PP.CD": "GDP per capita, PPP (current international $)",
    "NY.GDP.DEFL.ZS": "GDP deflator (base year varies by country)",
    # Population, prices, exchange rates.
    "SP.POP.TOTL": "Population, total",
    "SP.POP.GROW": "Population growth (annual %)",
    "FP.CPI.TOTL.ZG": "Inflation, consumer prices (annual %)",
    "PA.NUS.FCRF": "Official exchange rate (LCU per US$, period average)",
    # External sector and investment.
    "NE.EXP.GNFS.ZS": "Exports of goods and services (% of GDP)",
    "NE.IMP.GNFS.ZS": "Imports of goods and services (% of GDP)",
    "NE.TRD.GNFS.ZS": "Trade (% of GDP)",
    "BN.CAB.XOKA.GD.ZS": "Current account balance (% of GDP)",
    "BX.KLT.DINV.WD.GD.ZS": "Foreign direct investment, net inflows (% of GDP)",
    "NE.GDI.TOTL.ZS": "Gross capital formation (% of GDP)",
    # Sector structure and labor.
    "NV.AGR.TOTL.ZS": "Agriculture, forestry, and fishing, value added (% of GDP)",
    "NV.IND.MANF.CD": "Manufacturing, value added (current US$)",
    "NV.IND.MANF.ZS": "Manufacturing, value added (% of GDP)",
    "NV.IND.TOTL.CD": "Industry (including construction), value added (current US$)",
    "NV.IND.TOTL.ZS": "Industry (including construction), value added (% of GDP)",
    "NV.SRV.TOTL.ZS": "Services, value added (% of GDP)",
    "SL.UEM.TOTL.ZS": "Unemployment, total (% of total labor force)",
    # Materials, manufacturing trade, and industrial upgrading.
    "TM.VAL.MMTL.ZS.UN": "Ores and metals imports (% of merchandise imports)",
    "TX.VAL.MMTL.ZS.UN": "Ores and metals exports (% of merchandise exports)",
    "TM.VAL.MANF.ZS.UN": "Manufactures imports (% of merchandise imports)",
    "TX.VAL.MANF.ZS.UN": "Manufactures exports (% of merchandise exports)",
    "TX.VAL.TECH.MF.ZS": "High-technology exports (% of manufactured exports)",
    "TX.VAL.TECH.CD": "High-technology exports (current US$)",
    # Energy intensity, electricity, and decarbonization context.
    "EG.USE.PCAP.KG.OE": "Energy use (kg of oil equivalent per capita)",
    "EG.USE.COMM.GD.PP.KD": "Energy use (kg of oil equivalent) per $1,000 GDP (constant 2021 PPP)",
    "EG.ELC.ACCS.ZS": "Access to electricity (% of population)",
    "EG.USE.ELEC.KH.PC": "Electric power consumption (kWh per capita)",
    "EG.FEC.RNEW.ZS": "Renewable energy consumption (% of total final energy consumption)",
    "EG.ELC.COAL.ZS": "Electricity production from coal sources (% of total)",
    "EG.ELC.NGAS.ZS": "Electricity production from natural gas sources (% of total)",
    "EG.ELC.RNEW.ZS": "Renewable electricity output (% of total electricity output)",
    # Freight, logistics, and financial risk.
    "IS.SHP.GOOD.TU": "Container port traffic (TEU: 20 foot equivalent units)",
    "IS.AIR.GOOD.MT.K1": "Air transport, freight (million ton-km)",
    "IS.RRS.GOOD.MT.K6": "Railways, goods transported (million ton-km)",
    "FB.AST.NPER.ZS": "Bank nonperforming loans to total gross loans (%)",
    "FR.INR.LEND": "Lending interest rate (%)",
}

TABLE_DESCRIPTIONS = {
    "dataset_sources": "Inventory of tables exposed through the SQLite MCP database, with row counts and source references.",
    "data_dictionary_tables": "Human-readable descriptions for tables in this SQLite database.",
    "data_dictionary_columns": "Human-readable descriptions for columns in this SQLite database.",
    "dim_region": "World Bank region dimension, including the special Aggregates region used for aggregate economies.",
    "dim_income_group": "World Bank income-group dimension such as high income, low income, and aggregates.",
    "dim_lending_type": "World Bank lending-type dimension used to classify economies by lending eligibility.",
    "dim_country": "World Bank country/economy dimension. Includes sovereign economies and aggregate groups such as WLD and income regions.",
    "dim_source": "World Bank source dimension for indicator metadata. WDI indicators usually point to World Development Indicators.",
    "dim_indicator_topic": "Many-to-many bridge from WDI indicators to World Bank topic categories.",
    "dim_indicator": "World Bank indicator metadata, including names, source notes, source organization, and expected loader label.",
    "fact_indicator_observation": "Annual World Bank WDI observations by economy, indicator, and year. Null values are retained to preserve realistic panel sparsity.",
    "etl_run": "One-row load audit table recording the WDI extraction window and row counts for the generated database.",
}

COLUMN_DESCRIPTIONS = {
    ("dataset_sources", "table_name"): "SQLite table name exposed by the MCP server.",
    ("dataset_sources", "source"): "Human-readable source name for the table contents.",
    ("dataset_sources", "url"): "Primary source or documentation URL for the table contents.",
    ("dataset_sources", "local_file"): "Local source artifact used for loading, or a note when rows were downloaded directly from an API.",
    ("dataset_sources", "row_count"): "Number of rows present in the table at load time.",
    ("data_dictionary_tables", "table_name"): "SQLite table name described by this dictionary row.",
    ("data_dictionary_tables", "description"): "Plain-language explanation of the table purpose and grain.",
    ("data_dictionary_columns", "table_name"): "SQLite table containing the described column.",
    ("data_dictionary_columns", "column_name"): "Column name within the table.",
    ("data_dictionary_columns", "description"): "Plain-language explanation of the column meaning.",
    ("dim_region", "region_code"): "World Bank region code from the country API.",
    ("dim_region", "region_name"): "World Bank region name. The value Aggregates marks aggregate economy rows.",
    ("dim_region", "iso2_code"): "World Bank ISO2-like region code when supplied by the API.",
    ("dim_income_group", "income_group_code"): "World Bank income-level code from the country API.",
    ("dim_income_group", "income_group_name"): "World Bank income-level label, for example High income or Lower middle income.",
    ("dim_income_group", "iso2_code"): "World Bank ISO2-like income-group code when supplied by the API.",
    ("dim_lending_type", "lending_type_code"): "World Bank lending-type code from the country API.",
    ("dim_lending_type", "lending_type_name"): "World Bank lending-type label, for example IBRD, IDA, Blend, or Aggregates.",
    ("dim_lending_type", "iso2_code"): "World Bank ISO2-like lending-type code when supplied by the API.",
    ("dim_country", "country_code"): "World Bank economy identifier, usually ISO3 for countries and synthetic codes for aggregates such as WLD.",
    ("dim_country", "iso2_code"): "Two-letter economy code supplied by the World Bank API.",
    ("dim_country", "country_name"): "World Bank economy or aggregate display name.",
    ("dim_country", "region_code"): "Foreign key to dim_region. Aggregates use the region code for World Bank aggregate rows.",
    ("dim_country", "income_group_code"): "Foreign key to dim_income_group.",
    ("dim_country", "lending_type_code"): "Foreign key to dim_lending_type.",
    ("dim_country", "capital_city"): "Capital city for country rows when supplied; usually null for aggregates.",
    ("dim_country", "longitude"): "Longitude of the capital city when supplied by the World Bank country API.",
    ("dim_country", "latitude"): "Latitude of the capital city when supplied by the World Bank country API.",
    ("dim_country", "is_aggregate"): "1 when the row is a World Bank aggregate group, 0 for individual economies/countries.",
    ("dim_source", "source_id"): "Numeric World Bank source identifier from indicator metadata.",
    ("dim_source", "source_name"): "World Bank source name, usually World Development Indicators.",
    ("dim_indicator_topic", "indicator_code"): "Foreign key to dim_indicator.",
    ("dim_indicator_topic", "topic_id"): "World Bank topic identifier attached to the indicator.",
    ("dim_indicator_topic", "topic_name"): "World Bank topic name attached to the indicator.",
    ("dim_indicator", "indicator_code"): "World Bank WDI indicator code, for example NY.GDP.MKTP.CD.",
    ("dim_indicator", "indicator_name"): "Official indicator name returned by the World Bank API.",
    ("dim_indicator", "unit"): "Unit string returned by indicator metadata, often blank because units are embedded in the indicator name.",
    ("dim_indicator", "source_id"): "Foreign key to dim_source.",
    ("dim_indicator", "source_note"): "Official World Bank explanatory definition and methodology note for the indicator.",
    ("dim_indicator", "source_organization"): "Organizations or statistical sources cited by World Bank for the indicator.",
    ("dim_indicator", "expected_name"): "Loader-maintained label used to document why this indicator was selected.",
    ("fact_indicator_observation", "country_code"): "Economy code for the observed value; joins to dim_country.country_code.",
    ("fact_indicator_observation", "indicator_code"): "WDI indicator code for the observed value; joins to dim_indicator.indicator_code.",
    ("fact_indicator_observation", "year"): "Calendar year reported by the World Bank API.",
    ("fact_indicator_observation", "value"): "Numeric observation value from the World Bank API. Null is retained when the API reports no value.",
    ("fact_indicator_observation", "unit"): "Observation-level unit string from the API, usually blank for WDI indicators.",
    ("fact_indicator_observation", "decimal_places"): "World Bank API decimal field for the observation.",
    ("fact_indicator_observation", "obs_status"): "World Bank API observation status code or note. Blank statuses are stored as null.",
    ("fact_indicator_observation", "loaded_at"): "UTC timestamp when the observation row was loaded into SQLite.",
    ("etl_run", "run_id"): "Synthetic primary key for the ETL run.",
    ("etl_run", "started_at"): "UTC timestamp when the load started.",
    ("etl_run", "completed_at"): "UTC timestamp when the load completed.",
    ("etl_run", "source_name"): "Source system used for the load.",
    ("etl_run", "start_year"): "First WDI observation year requested by the loader.",
    ("etl_run", "end_year"): "Last WDI observation year requested by the loader.",
    ("etl_run", "indicator_count"): "Number of WDI indicators requested by the loader.",
    ("etl_run", "country_count"): "Number of country/economy dimension rows loaded.",
    ("etl_run", "observation_count"): "Number of fact observation rows loaded, including null-valued observations.",
}


def request_json(url: str, timeout: int = 90) -> Any:
    last_error: Exception | None = None
    for attempt in range(4):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            if attempt == 3:
                break
            time.sleep(1 + attempt)
    raise RuntimeError(f"Failed to fetch {url}") from last_error


def paged_world_bank_rows(url: str) -> list[dict[str, Any]]:
    first = request_json(url)
    if not isinstance(first, list) or len(first) < 2:
        raise ValueError(f"Unexpected World Bank API response: {url}")

    meta = first[0]
    rows = list(first[1] or [])
    pages = int(meta.get("pages") or 1)
    if pages <= 1:
        return rows

    separator = "&" if "?" in url else "?"
    for page in range(2, pages + 1):
        payload = request_json(f"{url}{separator}page={page}")
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError(f"Unexpected World Bank API response page {page}: {url}")
        rows.extend(payload[1] or [])
    return rows


def world_bank_country_url() -> str:
    return "https://api.worldbank.org/v2/country/all?format=json&per_page=400"


def world_bank_indicator_metadata_url(indicator_code: str) -> str:
    encoded = urllib.parse.quote(indicator_code, safe="")
    return f"https://api.worldbank.org/v2/indicator/{encoded}?format=json&per_page=1"


def world_bank_observation_url(indicator_code: str) -> str:
    encoded = urllib.parse.quote(indicator_code, safe="")
    return (
        f"https://api.worldbank.org/v2/country/all/indicator/{encoded}"
        f"?format=json&date={START_YEAR}:{END_YEAR}&per_page=20000"
    )


def empty_to_none(value: Any) -> Any:
    if value == "":
        return None
    return value


def nested_id(item: dict[str, Any], key: str) -> str | None:
    return empty_to_none((item.get(key) or {}).get("id"))


def nested_value(item: dict[str, Any], key: str) -> str | None:
    return empty_to_none((item.get(key) or {}).get("value"))


def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP VIEW IF EXISTS v_worldbank_latest_country_values;
        DROP TABLE IF EXISTS fact_indicator_observation;
        DROP TABLE IF EXISTS dim_country;
        DROP TABLE IF EXISTS dim_indicator;
        DROP TABLE IF EXISTS dim_indicator_topic;
        DROP TABLE IF EXISTS dim_source;
        DROP TABLE IF EXISTS dim_region;
        DROP TABLE IF EXISTS dim_income_group;
        DROP TABLE IF EXISTS dim_lending_type;
        DROP TABLE IF EXISTS data_dictionary_columns;
        DROP TABLE IF EXISTS data_dictionary_tables;
        DROP TABLE IF EXISTS etl_run;
        DROP TABLE IF EXISTS dataset_sources;

        CREATE TABLE dataset_sources (
            table_name TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            url TEXT NOT NULL,
            local_file TEXT NOT NULL,
            row_count INTEGER NOT NULL
        );

        CREATE TABLE data_dictionary_tables (
            table_name TEXT PRIMARY KEY,
            description TEXT NOT NULL
        );

        CREATE TABLE data_dictionary_columns (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            description TEXT NOT NULL,
            PRIMARY KEY (table_name, column_name),
            FOREIGN KEY (table_name) REFERENCES data_dictionary_tables(table_name)
        );

        CREATE TABLE dim_region (
            region_code TEXT PRIMARY KEY,
            region_name TEXT NOT NULL,
            iso2_code TEXT
        );

        CREATE TABLE dim_income_group (
            income_group_code TEXT PRIMARY KEY,
            income_group_name TEXT NOT NULL,
            iso2_code TEXT
        );

        CREATE TABLE dim_lending_type (
            lending_type_code TEXT PRIMARY KEY,
            lending_type_name TEXT NOT NULL,
            iso2_code TEXT
        );

        CREATE TABLE dim_country (
            country_code TEXT PRIMARY KEY,
            iso2_code TEXT,
            country_name TEXT NOT NULL,
            region_code TEXT REFERENCES dim_region(region_code),
            income_group_code TEXT REFERENCES dim_income_group(income_group_code),
            lending_type_code TEXT REFERENCES dim_lending_type(lending_type_code),
            capital_city TEXT,
            longitude REAL,
            latitude REAL,
            is_aggregate INTEGER NOT NULL CHECK (is_aggregate IN (0, 1))
        );

        CREATE TABLE dim_source (
            source_id INTEGER PRIMARY KEY,
            source_name TEXT NOT NULL
        );

        CREATE TABLE dim_indicator_topic (
            indicator_code TEXT NOT NULL,
            topic_id INTEGER NOT NULL,
            topic_name TEXT NOT NULL,
            PRIMARY KEY (indicator_code, topic_id)
        );

        CREATE TABLE dim_indicator (
            indicator_code TEXT PRIMARY KEY,
            indicator_name TEXT NOT NULL,
            unit TEXT,
            source_id INTEGER REFERENCES dim_source(source_id),
            source_note TEXT,
            source_organization TEXT,
            expected_name TEXT NOT NULL
        );

        CREATE TABLE fact_indicator_observation (
            country_code TEXT NOT NULL REFERENCES dim_country(country_code),
            indicator_code TEXT NOT NULL REFERENCES dim_indicator(indicator_code),
            year INTEGER NOT NULL,
            value REAL,
            unit TEXT,
            decimal_places INTEGER,
            obs_status TEXT,
            loaded_at TEXT NOT NULL,
            PRIMARY KEY (country_code, indicator_code, year)
        );

        CREATE TABLE etl_run (
            run_id INTEGER PRIMARY KEY,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            source_name TEXT NOT NULL,
            start_year INTEGER NOT NULL,
            end_year INTEGER NOT NULL,
            indicator_count INTEGER NOT NULL,
            country_count INTEGER,
            observation_count INTEGER
        );

        CREATE INDEX idx_fact_indicator_year ON fact_indicator_observation(indicator_code, year);
        CREATE INDEX idx_fact_country_year ON fact_indicator_observation(country_code, year);
        CREATE INDEX idx_country_aggregate ON dim_country(is_aggregate);
        """
    )


def load_data_dictionary(conn: sqlite3.Connection) -> None:
    conn.executemany(
        "INSERT INTO data_dictionary_tables(table_name, description) VALUES (?, ?)",
        sorted(TABLE_DESCRIPTIONS.items()),
    )
    conn.executemany(
        """
        INSERT INTO data_dictionary_columns(table_name, column_name, description)
        VALUES (?, ?, ?)
        """,
        [
            (table_name, column_name, description)
            for (table_name, column_name), description in sorted(COLUMN_DESCRIPTIONS.items())
        ],
    )


def load_countries(conn: sqlite3.Connection) -> int:
    payload = request_json(world_bank_country_url())
    if not isinstance(payload, list) or len(payload) < 2:
        raise ValueError("Unexpected World Bank country API response")

    countries = payload[1] or []
    regions: dict[str, tuple[str, str, str | None]] = {}
    income_groups: dict[str, tuple[str, str, str | None]] = {}
    lending_types: dict[str, tuple[str, str, str | None]] = {}
    country_rows = []

    for item in countries:
        code = item.get("id")
        if not code:
            continue

        region_code = nested_id(item, "region")
        income_code = nested_id(item, "incomeLevel")
        lending_code = nested_id(item, "lendingType")
        region_name = nested_value(item, "region")
        income_name = nested_value(item, "incomeLevel")
        lending_name = nested_value(item, "lendingType")

        if region_code:
            regions[region_code] = (
                region_code,
                region_name or region_code,
                empty_to_none((item.get("region") or {}).get("iso2code")),
            )
        if income_code:
            income_groups[income_code] = (
                income_code,
                income_name or income_code,
                empty_to_none((item.get("incomeLevel") or {}).get("iso2code")),
            )
        if lending_code:
            lending_types[lending_code] = (
                lending_code,
                lending_name or lending_code,
                empty_to_none((item.get("lendingType") or {}).get("iso2code")),
            )

        country_rows.append(
            (
                code,
                empty_to_none(item.get("iso2Code")),
                item.get("name") or code,
                region_code,
                income_code,
                lending_code,
                empty_to_none(item.get("capitalCity")),
                as_float(item.get("longitude")),
                as_float(item.get("latitude")),
                1 if region_name == "Aggregates" else 0,
            )
        )

    conn.executemany(
        "INSERT INTO dim_region(region_code, region_name, iso2_code) VALUES (?, ?, ?)",
        sorted(regions.values()),
    )
    conn.executemany(
        """
        INSERT INTO dim_income_group(income_group_code, income_group_name, iso2_code)
        VALUES (?, ?, ?)
        """,
        sorted(income_groups.values()),
    )
    conn.executemany(
        """
        INSERT INTO dim_lending_type(lending_type_code, lending_type_name, iso2_code)
        VALUES (?, ?, ?)
        """,
        sorted(lending_types.values()),
    )
    conn.executemany(
        """
        INSERT INTO dim_country(
            country_code, iso2_code, country_name, region_code, income_group_code,
            lending_type_code, capital_city, longitude, latitude, is_aggregate
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        sorted(country_rows),
    )
    return len(country_rows)


def load_indicator_metadata(conn: sqlite3.Connection) -> None:
    sources: dict[int, tuple[int, str]] = {}
    indicator_rows = []
    topic_rows = []

    for indicator_code, expected_name in WDI_INDICATORS.items():
        payload = request_json(world_bank_indicator_metadata_url(indicator_code))
        if not isinstance(payload, list) or len(payload) < 2 or not payload[1]:
            raise ValueError(f"Unexpected World Bank indicator metadata for {indicator_code}")
        item = payload[1][0]
        source = item.get("source") or {}
        source_id = int(source.get("id") or 0)
        sources[source_id] = (source_id, source.get("value") or "World Bank")
        indicator_rows.append(
            (
                indicator_code,
                item.get("name") or expected_name,
                empty_to_none(item.get("unit")),
                source_id,
                empty_to_none(item.get("sourceNote")),
                empty_to_none(item.get("sourceOrganization")),
                expected_name,
            )
        )
        for topic in item.get("topics") or []:
            topic_id = int(topic.get("id") or 0)
            topic_rows.append((indicator_code, topic_id, topic.get("value") or str(topic_id)))

    conn.executemany("INSERT INTO dim_source(source_id, source_name) VALUES (?, ?)", sorted(sources.values()))
    conn.executemany(
        """
        INSERT INTO dim_indicator(
            indicator_code, indicator_name, unit, source_id, source_note,
            source_organization, expected_name
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        indicator_rows,
    )
    conn.executemany(
        """
        INSERT INTO dim_indicator_topic(indicator_code, topic_id, topic_name)
        VALUES (?, ?, ?)
        """,
        sorted(set(topic_rows)),
    )


def load_observations(conn: sqlite3.Connection) -> int:
    loaded_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    observation_rows: list[tuple[str, str, int, float | None, str | None, int | None, str | None, str]] = []

    for indicator_code in WDI_INDICATORS:
        rows = paged_world_bank_rows(world_bank_observation_url(indicator_code))
        for item in rows:
            country_code = item.get("countryiso3code")
            if not country_code:
                continue
            year = int(item["date"])
            obs_status = empty_to_none(item.get("obs_status"))
            observation_rows.append(
                (
                    country_code,
                    indicator_code,
                    year,
                    item.get("value"),
                    empty_to_none(item.get("unit")),
                    item.get("decimal"),
                    obs_status,
                    loaded_at,
                )
            )
        print(f"downloaded {indicator_code}: {len(rows)} rows")

    conn.executemany(
        """
        INSERT OR REPLACE INTO fact_indicator_observation(
            country_code, indicator_code, year, value, unit, decimal_places, obs_status, loaded_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        observation_rows,
    )
    return len(observation_rows)


def insert_dataset_source(conn: sqlite3.Connection, table_name: str, row_count: int) -> None:
    conn.execute(
        """
        INSERT INTO dataset_sources(table_name, source, url, local_file, row_count)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            table_name,
            "World Bank World Development Indicators API",
            WDI_API_DOC_URL,
            "downloaded from API during load",
            row_count,
        ),
    )


def record_sources(conn: sqlite3.Connection) -> None:
    for (table_name,) in conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> 'dataset_sources'
        ORDER BY name
        """
    ).fetchall():
        row_count = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        if table_name.startswith("data_dictionary_"):
            conn.execute(
                """
                INSERT INTO dataset_sources(table_name, source, url, local_file, row_count)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    table_name,
                    "MyHarness-authored metadata for the World Bank SQLite dataset",
                    "local:.mcp/load_sample_data.py",
                    ".mcp/load_sample_data.py",
                    row_count,
                ),
            )
        else:
            insert_dataset_source(conn, table_name, row_count)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.unlink(missing_ok=True)

    started_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=DELETE")
        create_schema(conn)
        load_data_dictionary(conn)
        conn.execute(
            """
            INSERT INTO etl_run(
                run_id, started_at, source_name, start_year, end_year, indicator_count
            )
            VALUES (1, ?, ?, ?, ?, ?)
            """,
            (
                started_at,
                "World Bank World Development Indicators API",
                START_YEAR,
                END_YEAR,
                len(WDI_INDICATORS),
            ),
        )

        country_count = load_countries(conn)
        print(f"loaded dim_country: {country_count} rows")
        load_indicator_metadata(conn)
        print(f"loaded dim_indicator: {len(WDI_INDICATORS)} rows")
        observation_count = load_observations(conn)
        print(f"loaded fact_indicator_observation: {observation_count} rows")

        completed_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
        conn.execute(
            """
            UPDATE etl_run
            SET completed_at = ?, country_count = ?, observation_count = ?
            WHERE run_id = 1
            """,
            (completed_at, country_count, observation_count),
        )
        record_sources(conn)

        conn.commit()
        conn.execute("VACUUM")
        print(f"sqlite db: {DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
