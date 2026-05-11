"""Progress state helpers for long report generation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from myharness.api.usage import UsageSnapshot


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
) -> None:
    state_path = long_report_progress_state_path(cwd, report_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    written_tokens = max(0, int(document_written_tokens or 0))
    state_path.write_text(
        json.dumps(
            {
                "document_written_tokens": written_tokens,
                "usage_input_tokens": usage.input_tokens,
                "usage_output_tokens": usage.output_tokens,
                "usage_total_tokens": usage.total_tokens,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def read_long_report_progress_state(cwd: Path, report_path: str | Path) -> dict[str, int]:
    try:
        raw = json.loads(long_report_progress_state_path(cwd, report_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    result: dict[str, int] = {}
    for key in ("document_written_tokens", "usage_input_tokens", "usage_output_tokens", "usage_total_tokens"):
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        try:
            number = int(value) if value is not None else 0
        except (TypeError, ValueError):
            continue
        if number >= 0:
            result[key] = number
    return result
