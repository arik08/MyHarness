from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "utf8_guard.py"


def _run_guard(*paths: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *(str(path) for path in paths)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def test_utf8_guard_accepts_valid_utf8_korean(tmp_path: Path) -> None:
    good = tmp_path / "good.md"
    good.write_text("\ubcf8\ubb38 \uc218\uc815\n", encoding="utf-8")

    result = _run_guard(good)

    assert result.returncode == 0
    assert "OK:" in result.stdout


def test_utf8_guard_rejects_invalid_utf8(tmp_path: Path) -> None:
    bad = tmp_path / "bad.md"
    bad.write_bytes(b"\xff\xfe")

    result = _run_guard(bad)

    assert result.returncode == 1
    assert "invalid UTF-8" in result.stdout


def test_utf8_guard_rejects_repeated_question_hangul_markers(tmp_path: Path) -> None:
    bad = tmp_path / "bad.tsx"
    bad.write_text("?\uac00 ?\ub098 ?\ub2e4\n", encoding="utf-8")

    result = _run_guard(bad)

    assert result.returncode == 1
    assert "mojibake markers" in result.stdout
