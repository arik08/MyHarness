import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.select_default_provider_profile import (
    codex_oauth_usable,
    select_default_profile,
    update_settings_active_profile,
)


def _jwt_with_exp(exp: int) -> str:
    payload = json.dumps({"exp": exp}).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"header.{encoded}.signature"


def test_selects_pgpt_when_codex_oauth_access_token_is_present(tmp_path: Path):
    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": _jwt_with_exp(2_000_000_000)}}),
        encoding="utf-8",
    )

    assert codex_oauth_usable(codex_home=codex_home, now=1_800_000_000)
    assert select_default_profile(codex_home=codex_home, now=1_800_000_000) == "p-gpt"


def test_selects_pgpt_when_codex_oauth_is_missing_or_expired(tmp_path: Path):
    assert select_default_profile(codex_home=tmp_path / "missing") == "p-gpt"

    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": _jwt_with_exp(1_700_000_000)}}),
        encoding="utf-8",
    )

    assert select_default_profile(codex_home=codex_home, now=1_800_000_000) == "p-gpt"


def test_update_settings_preserves_existing_fields(tmp_path: Path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        json.dumps({"model": "gpt-5.5", "active_profile": "p-gpt"}),
        encoding="utf-8",
    )

    updated = update_settings_active_profile(settings_path, "codex")

    assert updated["active_profile"] == "codex"
    assert updated["model"] == "gpt-5.5"
    assert json.loads(settings_path.read_text(encoding="utf-8"))["active_profile"] == "codex"


@pytest.mark.skipif(os.name != "nt", reason="Windows batch invocation")
@pytest.mark.parametrize("launcher", ["run_myharness_web.bat", "run_myharness_web_dev.bat"])
@pytest.mark.parametrize("valid_settings", [True, False])
def test_batch_profile_setup_quotes_paths_and_keeps_errors(tmp_path: Path, launcher: str, valid_settings: bool):
    root = Path(__file__).resolve().parents[2]
    work = tmp_path / "project with spaces"
    (work / "scripts").mkdir(parents=True)
    (work / "scripts" / "select_default_provider_profile.py").write_bytes(
        (root / "scripts" / "select_default_provider_profile.py").read_bytes()
    )
    settings = work / "settings.json"
    original = '{"model": "keep-me", "active_profile": "codex"}' if valid_settings else '{broken'
    settings.write_text(original, encoding="utf-8")
    source = (root / launcher).read_text(encoding="utf-8")
    body = source.split("\n:select_default_provider_profile\n", 1)[1].split("\n:ensure_pgpt_env", 1)[0]
    batch = work / "check.bat"
    batch.write_text(
        '@echo off\nchcp 65001 >nul\n'
        f'set "MYHARNESS_BOOTSTRAP_PYTHON={sys.executable}"\n'
        'set "MYHARNESS_BOOTSTRAP_PYTHON_ARGS="\n'
        f'set "MYHARNESS_SETTINGS={settings}"\n'
        f'set "MYHARNESS_LOGS_DIR={work}"\n' + body,
        encoding="utf-8",
    )
    result = subprocess.run(["cmd.exe", "/d", "/c", str(batch)], cwd=work, capture_output=True, timeout=15)
    assert result.returncode == 0
    log = (work / "provider-setup.log").read_text(encoding="utf-8")
    if valid_settings:
        assert json.loads(settings.read_text(encoding="utf-8")) == {"model": "keep-me", "active_profile": "p-gpt"}
        assert log == ""
        assert b"provider-setup.log" not in result.stdout
    else:
        assert settings.read_text(encoding="utf-8") == original
        assert "JSONDecodeError" in log
        assert b"provider-setup.log" in result.stdout
