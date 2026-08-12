"""Apply the small MyHarness compatibility patch, then start korean-law-mcp."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


RUNTIME = Path(__file__).resolve().parent


def _replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f"Unsupported korean-law-mcp runtime: patch anchor missing in {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


def apply_compatibility_patch(runtime: Path = RUNTIME) -> None:
    package = runtime / "node_modules" / "korean-law-mcp" / "build"
    _replace_once(
        package / "tools" / "search.js",
        "let xmlText = await apiClient.searchLaw(input.query, input.apiKey, input.display);",
        "let xmlText = await apiClient.searchLaw(input.query, input.apiKey, Math.max(input.display, 50));",
    )
    annex_path = package / "tools" / "annex.js"
    if "const normalizeName = (value)" not in annex_path.read_text(encoding="utf-8"):
        _replace_once(
            annex_path,
            """    // 쿼리에서 단어 추출
    const queryWords = queryName.split(/\\s+/).filter((w) => w.length > 0);""",
            """    // 법제처 별표 검색은 부분 LIKE 결과를 섞으므로 정확한 관련법령명을 먼저 고른다.
    const normalizeName = (value) => String(value || \"\").replace(/<[^>]+>/g, \"\").replace(/\\s+/g, \"\").trim();
    const queryKey = normalizeName(queryName);
    const exact = annexList.filter((annex) => normalizeName(annex.관련자치법규명 || annex.관련법령명 || annex.관련행정규칙명) === queryKey);
    if (exact.length > 0)
        return exact;
    // 쿼리에서 단어 추출
    const queryWords = queryName.split(/\\s+/).filter((w) => w.length > 0);""",
        )
    _replace_once(
        package / "tools" / "annex.js",
        """    if (exact.length > 0)
        return exact;
    // 쿼리에서 단어 추출""",
        """    if (exact.length > 0)
        return exact;
    // 관련법령명이 있는 결과가 모두 불일치하면 부분 LIKE 오탐이므로 버린다.
    if (queryKey && annexList.some((annex) => normalizeName(annex.관련자치법규명 || annex.관련법령명 || annex.관련행정규칙명)))
        return [];
    // 쿼리에서 단어 추출""",
    )


def main() -> int:
    apply_compatibility_patch()
    entrypoint = RUNTIME / "node_modules" / "korean-law-mcp" / "build" / "index.js"
    return subprocess.call(["node", str(entrypoint)])


if __name__ == "__main__":
    raise SystemExit(main())
