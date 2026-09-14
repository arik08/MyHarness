from pathlib import Path
from types import SimpleNamespace
import subprocess

import pytest

from myharness.tools import mermaid_preflight as m


@pytest.mark.parametrize("tag", ["<br>", "<br/>", "<br />", "<img src='x'>"])
def test_html_void_tags_do_not_swallow_diagrams(tag):
    source = f'flowchart TD\nA["hello{tag}world"] --> B["done"]'
    diagrams = m.extract_mermaid_diagrams(f'<pre class="mermaid">{source}</pre><div class="mermaid">flowchart TD\nC --> D</div>')
    assert [d.source for d in diagrams] == [source, "flowchart TD\nC --> D"]


def test_raw_mmd_is_validated(monkeypatch):
    seen = []
    monkeypatch.setattr(m, "_run_mermaid_preflight", lambda diagrams: seen.extend(diagrams) or [])
    m.mermaid_preflight_errors(Path("flow.mmd"), "flowchart TD\nA[broken")
    assert seen[0].source == "flowchart TD\nA[broken"


@pytest.mark.parametrize("result", [
    SimpleNamespace(returncode=1, stderr="missing dependency", stdout=""),
    SimpleNamespace(returncode=0, stderr="", stdout="not json"),
    SimpleNamespace(returncode=0, stderr="", stdout='{}'),
    SimpleNamespace(returncode=0, stderr="", stdout='{"ok":false,"errors":[]}'),
])
def test_validator_failure_blocks_write(monkeypatch, result):
    monkeypatch.setattr(m.shutil, "which", lambda _: "node")
    monkeypatch.setattr(m, "_find_mermaid_validator_script", lambda: Path("validator.mjs"))
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: result)
    errors = m.mermaid_preflight_errors(Path("flow.mmd"), "flowchart TD\nA --> B")
    assert "validation unavailable" in errors[0].message


def test_missing_node_blocks_validation(monkeypatch):
    monkeypatch.setattr(m.shutil, "which", lambda _: None)
    assert m.mermaid_preflight_errors(Path("flow.mmd"), "flowchart TD\nA --> B")


def test_timeout_blocks_validation(monkeypatch):
    monkeypatch.setattr(m.shutil, "which", lambda _: "node")
    monkeypatch.setattr(m, "_find_mermaid_validator_script", lambda: Path("validator.mjs"))
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("node", 12)
    monkeypatch.setattr(m.subprocess, "run", timeout)
    assert m.mermaid_preflight_errors(Path("flow.mmd"), "flowchart TD\nA --> B")


def test_diagnostic_preserves_error_location():
    error = m.MermaidPreflightError(m.MermaidDiagram(1, "file", ""), "Parse error\nA[broken\n ^ expected bracket")
    assert "A[broken\n ^ expected bracket" in m.format_mermaid_preflight_errors(Path("a.mmd"), [error], action="written")
