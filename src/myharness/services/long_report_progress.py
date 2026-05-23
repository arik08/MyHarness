"""Progress state helpers for long report generation."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from myharness.api.usage import UsageSnapshot


_NUMERIC_PROGRESS_KEYS = (
    "document_written_tokens",
    "usage_input_tokens",
    "usage_output_tokens",
    "usage_total_tokens",
    "section_index",
    "section_total",
    "continuation_index",
)

_TEXT_PROGRESS_KEYS = (
    "phase",
    "phase_label",
    "section_title",
    "section_summary",
    "last_updated_at",
)


def _resolve_report_path(cwd: Path, report_path: str | Path) -> Path:
    path = Path(report_path).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def long_report_progress_state_path(cwd: Path, report_path: str | Path) -> Path:
    resolved = _resolve_report_path(cwd, report_path)
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:24]
    return cwd.resolve() / ".myharness" / "long-report-progress" / f"{digest}.json"


def write_long_report_progress_state(
    cwd: Path,
    report_path: str | Path,
    *,
    usage: UsageSnapshot,
    document_written_tokens: int = 0,
    phase: str = "",
    phase_label: str = "",
    outline_sections: list[dict[str, object]] | None = None,
    section_index: int = 0,
    section_total: int = 0,
    section_title: str = "",
    section_summary: str = "",
    continuation_index: int = 0,
) -> None:
    state_path = long_report_progress_state_path(cwd, report_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    written_tokens = max(0, int(document_written_tokens or 0))
    state: dict[str, Any] = {
        "document_written_tokens": written_tokens,
        "usage_input_tokens": usage.input_tokens,
        "usage_output_tokens": usage.output_tokens,
        "usage_total_tokens": usage.total_tokens,
        "last_updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if phase:
        state["phase"] = str(phase).strip()
    if phase_label:
        state["phase_label"] = str(phase_label).strip()
    if outline_sections:
        state["outline_sections"] = _normalize_outline_sections(outline_sections)
    if section_index > 0:
        state["section_index"] = max(0, int(section_index or 0))
    if section_total > 0:
        state["section_total"] = max(0, int(section_total or 0))
    if section_title:
        state["section_title"] = str(section_title).strip()
    if section_summary:
        state["section_summary"] = str(section_summary).strip()
    if continuation_index > 0:
        state["continuation_index"] = max(0, int(continuation_index or 0))
    state_path.write_text(
        json.dumps(state, ensure_ascii=False),
        encoding="utf-8",
    )


def _normalize_outline_sections(value: list[dict[str, object]]) -> list[dict[str, object]]:
    sections: list[dict[str, object]] = []
    for item in value[:30]:
        if not isinstance(item, dict):
            continue
        title = _clean_progress_text(item.get("title"))
        if not title:
            continue
        section: dict[str, object] = {"title": title}
        intent = _clean_progress_text(item.get("intent") or item.get("section_intent"))
        if intent:
            section["intent"] = intent
        analysis_angle = _clean_progress_text(item.get("analysis_angle") or item.get("analysis"))
        if analysis_angle:
            section["analysis_angle"] = analysis_angle
        key_points = _clean_key_points(item.get("key_points") or item.get("keyPoints"))
        if key_points:
            section["key_points"] = key_points
        sections.append(section)
    return sections


def _clean_key_points(value: object) -> list[str]:
    if isinstance(value, list):
        return [_clean_progress_text(item, limit=140) for item in value if _clean_progress_text(item, limit=140)][:5]
    text = _clean_progress_text(value, limit=260)
    return [text] if text else []


def _clean_progress_text(value: object, *, limit: int = 360) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[:limit - 3]}..."


def read_long_report_progress_state(cwd: Path, report_path: str | Path) -> dict[str, Any]:
    try:
        raw = json.loads(long_report_progress_state_path(cwd, report_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key in _NUMERIC_PROGRESS_KEYS:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        try:
            number = int(value) if value is not None else 0
        except (TypeError, ValueError):
            continue
        if number >= 0:
            result[key] = number
    for key in _TEXT_PROGRESS_KEYS:
        text = _clean_progress_text(raw.get(key))
        if text:
            result[key] = text
    outline_sections = raw.get("outline_sections")
    if isinstance(outline_sections, list):
        normalized = _normalize_outline_sections(outline_sections)
        if normalized:
            result["outline_sections"] = normalized
    return result
