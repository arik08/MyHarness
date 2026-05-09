from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

TEXT_SUFFIXES = {
    "",
    ".bat",
    ".cmd",
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".ps1",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yml",
    ".yaml",
}

EXCLUDED_PARTS = {
    ".git",
    ".mypy_cache",
    ".myharness",
    ".myharness-venv",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "Playground",
    "__pycache__",
}

QUESTION_HANGUL_RE = re.compile(r"\?[\uac00-\ud7a3]")


@dataclass(frozen=True)
class Finding:
    path: Path
    message: str


def _repo_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _run_git(args: list[str]) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def _changed_files() -> list[Path]:
    names = set(_run_git(["diff", "--name-only"]))
    names.update(_run_git(["diff", "--name-only", "--cached"]))
    names.update(_run_git(["ls-files", "--others", "--exclude-standard"]))
    return sorted((ROOT / name).resolve() for name in names)


def _tracked_files() -> list[Path]:
    return sorted((ROOT / name).resolve() for name in _run_git(["ls-files"]))


def _is_excluded(path: Path) -> bool:
    try:
        parts = path.resolve().relative_to(ROOT).parts
    except ValueError:
        parts = path.parts
    return any(part in EXCLUDED_PARTS for part in parts)


def _candidate_files(paths: list[Path]) -> list[Path]:
    candidates: list[Path] = []
    for path in paths:
        if not path.exists() or _is_excluded(path):
            continue
        if path.is_dir():
            for child in path.rglob("*"):
                if child.is_file() and not _is_excluded(child):
                    candidates.append(child)
            continue
        if path.is_file():
            candidates.append(path)
    return sorted(set(candidates))


def _is_text_candidate(path: Path, data: bytes) -> bool:
    if b"\0" in data:
        return False
    return path.suffix.lower() in TEXT_SUFFIXES


def check_file(path: Path) -> tuple[Finding | None, bool]:
    data = path.read_bytes()
    if not _is_text_candidate(path, data):
        return None, False

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        return Finding(path, f"invalid UTF-8 at byte {exc.start}"), True

    if "\ufffd" in text:
        return Finding(path, "contains Unicode replacement characters"), True

    question_hangul_hits = len(QUESTION_HANGUL_RE.findall(text))
    if question_hangul_hits >= 3:
        return (
            Finding(
                path,
                f"suspicious '?'+Hangul mojibake markers ({question_hangul_hits} hits)",
            ),
            True,
        )

    return None, True


def check_paths(paths: list[Path]) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    checked = 0
    for path in _candidate_files(paths):
        finding, was_text = check_file(path)
        if was_text:
            checked += 1
        if finding is not None:
            findings.append(finding)
    return findings, checked


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Check text files for UTF-8 decode errors and common Korean mojibake "
            "caused by shell encoding mistakes."
        )
    )
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument(
        "--all",
        action="store_true",
        help="scan all tracked files instead of changed files",
    )
    parser.add_argument(
        "--changed",
        action="store_true",
        help="scan changed, staged, and untracked files",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.all:
        paths = _tracked_files()
    elif args.paths:
        paths = [(Path.cwd() / path).resolve() if not path.is_absolute() else path for path in args.paths]
    else:
        paths = _changed_files()

    findings, checked = check_paths(paths)
    for finding in findings:
        print(f"{_repo_path(finding.path)}: {finding.message}")

    if findings:
        print(
            "Encoding guard failed. Re-read with explicit UTF-8 before rewriting "
            "and avoid PowerShell default Get-Content/Set-Content for non-ASCII files."
        )
        return 1

    print(f"OK: checked {checked} UTF-8 text file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
