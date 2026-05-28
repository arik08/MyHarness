"""Tests for the public worldsteel data loader."""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path
from types import ModuleType


def _load_worldsteel_loader() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "load_worldsteel_data.py"
    spec = importlib.util.spec_from_file_location("worldsteel_loader_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_numeric_lines_keeps_section_indicator_and_values() -> None:
    loader = _load_worldsteel_loader()
    text = """
    ### World crude steel production
    1950 to 2024
    ### million tonnes, crude steel production
    Years World
    2010 1 435
    2011 1 540
    ### Top 50 steel-producing companies 2024
    ### million tonnes, crude steel production
    8 POSCO Holdings 37.79
    """

    rows = loader.parse_numeric_observations(
        text,
        publication_year=2025,
        source_id=1,
        min_year=2010,
    )

    year_rows = [row for row in rows if row.period == "2010"]
    assert year_rows[0].indicator == "World crude steel production"
    assert year_rows[0].unit == "million tonnes, crude steel production"
    assert year_rows[0].row_label == "World"
    assert year_rows[0].value == 1435.0

    posco_rows = [row for row in rows if row.row_label == "POSCO Holdings"]
    assert posco_rows[0].indicator == "Top 50 steel-producing companies 2024"
    assert posco_rows[0].period == "2024"
    assert posco_rows[0].value == 37.79


def test_build_database_writes_sources_and_observations(tmp_path) -> None:
    loader = _load_worldsteel_loader()
    db_path = tmp_path / "worldsteel.sqlite"
    sources = [
        loader.SourceDocument(
            publication_year=2025,
            title="World Steel in Figures 2025",
            url="https://worldsteel.org/example",
            source_type="html",
            text="### World crude steel production\n### million tonnes\n2010 1 435\n",
        )
    ]

    loader.build_database(db_path, sources, min_year=2010)

    with sqlite3.connect(db_path) as conn:
        source_count = conn.execute("SELECT COUNT(*) FROM dataset_sources").fetchone()[0]
        value_count = conn.execute("SELECT COUNT(*) FROM worldsteel_values").fetchone()[0]
        row = conn.execute(
            """
            SELECT indicator, period, value, source_url
            FROM worldsteel_values
            WHERE period = '2010'
            """
        ).fetchone()

    assert source_count == 1
    assert value_count == 1
    assert row == (
        "World crude steel production",
        "2010",
        1435.0,
        "https://worldsteel.org/example",
    )
