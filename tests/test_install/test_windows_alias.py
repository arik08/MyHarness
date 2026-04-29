"""Installer regressions for Windows command aliases."""

from __future__ import annotations

from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib


def test_pyproject_exposes_myh_console_script():
    data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    scripts = data["project"]["scripts"]
    assert scripts["myharness"] == "myharness.cli:app"
    assert scripts["myh"] == "myharness.cli:app"
    assert scripts["oh"] == "myharness.cli:app"


def test_powershell_installer_recommends_myharness_for_windows():
    script = Path("scripts/install.ps1").read_text(encoding="utf-8")
    assert "myharness.exe" in script
    assert "Launch (PowerShell):     myharness" in script
    assert "Out-Host" in script


def test_powershell_installer_falls_back_when_myharness_exe_missing():
    """Older installs may not expose the preferred `myharness` console script.

    When `myharness.exe` is absent from the venv, the installer must still pick a
    working launcher (`myh.exe` or `oh.exe`) and guide the user to it
    rather than telling them to run a binary that doesn't exist (issue #144).
    """
    script = Path("scripts/install.ps1").read_text(encoding="utf-8")
    # Every launcher produced by the pyproject `[project.scripts]` table is
    # probed during verification.
    assert "myh.exe" in script
    assert "myharness.exe" in script
    assert "oh.exe" in script
    # Fallback guidance for users on a release without the preferred alias.
    assert "Launch (PowerShell):     myh" in script
    assert "Launch (PowerShell):     oh.exe" in script
