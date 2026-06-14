"""Mermaid syntax preflight for human-facing artifacts."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess

from myharness.utils.windows_subprocess import hidden_subprocess_kwargs


_MARKDOWN_MERMAID_RE = re.compile(
    r"(?ms)^ {0,3}(`{3,}|~{3,})[ \t]*(?:mermaid|mmd)\b[^\n]*\n(.*?)\n {0,3}\1[ \t]*$"
)
_MERMAID_EXTENSIONS = {".html", ".htm", ".md", ".markdown", ".mmd"}


@dataclass(frozen=True)
class MermaidDiagram:
    """One Mermaid source block found in an artifact."""

    index: int
    origin: str
    source: str


@dataclass(frozen=True)
class MermaidPreflightError:
    """A parser error for one Mermaid source block."""

    diagram: MermaidDiagram
    message: str


class _MermaidHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.diagrams: list[str] = []
        self._capturing_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._capturing_depth:
            self._capturing_depth += 1
            return
        class_value = next((value or "" for name, value in attrs if name.lower() == "class"), "")
        classes = {part.strip().lower() for part in class_value.split()}
        if "mermaid" in classes:
            self._capturing_depth = 1
            self._parts = []

    def handle_endtag(self, tag: str) -> None:
        del tag
        if not self._capturing_depth:
            return
        self._capturing_depth -= 1
        if self._capturing_depth == 0:
            source = "".join(self._parts).strip()
            if source:
                self.diagrams.append(source)
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._capturing_depth:
            self._parts.append(data)


def extract_mermaid_diagrams(content: str) -> list[MermaidDiagram]:
    """Extract Mermaid sources from Markdown fences and HTML Mermaid elements."""

    text = str(content or "")
    diagrams: list[MermaidDiagram] = []
    for match in _MARKDOWN_MERMAID_RE.finditer(text):
        source = match.group(2).strip()
        if source:
            diagrams.append(MermaidDiagram(len(diagrams) + 1, "markdown fence", source))

    if re.search(r"class\s*=\s*['\"][^'\"]*\bmermaid\b", text, flags=re.IGNORECASE):
        parser = _MermaidHtmlParser()
        try:
            parser.feed(text)
            parser.close()
        except Exception:
            return diagrams
        for source in parser.diagrams:
            diagrams.append(MermaidDiagram(len(diagrams) + 1, "HTML .mermaid element", source))

    return diagrams


def mermaid_preflight_errors(path: Path, content: str) -> list[MermaidPreflightError]:
    """Return parser errors for Mermaid diagrams that should be checked before writing."""

    if path.suffix.lower() not in _MERMAID_EXTENSIONS and "mermaid" not in content.lower():
        return []
    diagrams = extract_mermaid_diagrams(content)
    if not diagrams:
        return []
    return _run_mermaid_preflight(diagrams)


def format_mermaid_preflight_errors(
    path: Path,
    errors: list[MermaidPreflightError],
    *,
    action: str,
) -> str:
    lines = [
        f"Mermaid preflight failed; {path.name} was not {action}.",
        "Fix the Mermaid syntax and call the file tool again.",
        "",
    ]
    for error in errors:
        lines.append(
            f"Diagram {error.diagram.index} ({error.diagram.origin}): {_first_error_line(error.message)}"
        )
    return "\n".join(lines).rstrip()


def _run_mermaid_preflight(diagrams: list[MermaidDiagram]) -> list[MermaidPreflightError]:
    node = shutil.which("node")
    script = _find_mermaid_validator_script()
    if not node or not script:
        return []

    payload = {
        "diagrams": [
            {"index": diagram.index, "origin": diagram.origin, "source": diagram.source}
            for diagram in diagrams
        ]
    }
    try:
        completed = subprocess.run(
            [node, str(script)],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            check=False,
            cwd=script.parent.parent,
            encoding="utf-8",
            timeout=12,
            **hidden_subprocess_kwargs(),
        )
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return []
    if completed.returncode != 0:
        return []
    try:
        result = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return []

    by_index = {diagram.index: diagram for diagram in diagrams}
    errors: list[MermaidPreflightError] = []
    for item in result.get("errors") or []:
        index = item.get("index")
        diagram = by_index.get(index)
        if not diagram:
            continue
        errors.append(MermaidPreflightError(diagram, str(item.get("message") or "Parse error")))
    return errors


def _find_mermaid_validator_script() -> Path | None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        for candidate in (
            parent / "frontend" / "web" / "scripts" / "validate_mermaid.mjs",
            parent / "_web" / "scripts" / "validate_mermaid.mjs",
        ):
            if candidate.exists():
                return candidate
    return None


def _first_error_line(message: str) -> str:
    for line in str(message or "").replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if stripped:
            return stripped
    return "Parse error"
