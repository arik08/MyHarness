import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.select_default_provider_profile import (
    codex_oauth_usable,
    pgpt_credentials_usable,
    select_default_profile,
    update_settings_active_profile,
)


def _jwt_with_exp(exp: int) -> str:
    payload = json.dumps({"exp": exp}).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"header.{encoded}.signature"


@pytest.fixture(autouse=True)
def isolate_credentials(tmp_path, monkeypatch):
    for name in ("PGPT_API_KEY", "PGPT_EMPLOYEE_NO", "PGPT_SYSTEM_CODE", "POSCO_EMP_NO"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing-codex"))


def test_selects_codex_when_codex_oauth_access_token_is_present(tmp_path: Path):
    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": _jwt_with_exp(2_000_000_000)}}),
        encoding="utf-8",
    )

    assert codex_oauth_usable(codex_home=codex_home, now=1_800_000_000)
    assert select_default_profile(codex_home=codex_home, now=1_800_000_000) == "codex"


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
@pytest.mark.parametrize("saved_profile", ["codex", "p-gpt", "custom-provider"])
def test_batch_profile_setup_quotes_paths_and_keeps_errors(tmp_path: Path, monkeypatch, launcher: str, valid_settings: bool, saved_profile: str):
    # Both providers are available, but normal startup must honor the user.
    monkeypatch.setenv("PGPT_API_KEY", "test-key")
    monkeypatch.setenv("PGPT_EMPLOYEE_NO", "123")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "auth.json").write_text(json.dumps({"tokens": {"access_token": _jwt_with_exp(4_000_000_000)}}), encoding="utf-8")
    root = Path(__file__).resolve().parents[2]
    work = tmp_path / "project with spaces"
    (work / "scripts").mkdir(parents=True)
    (work / "scripts" / "select_default_provider_profile.py").write_bytes(
        (root / "scripts" / "select_default_provider_profile.py").read_bytes()
    )
    settings = work / "settings.json"
    original = json.dumps({"model": "keep-me", "active_profile": saved_profile}) if valid_settings else '{broken'
    settings.write_text(original, encoding="utf-8")
    source = (root / launcher).read_text(encoding="utf-8")
    body = source.split("\n:select_default_provider_profile\n", 1)[1].split("\n:ensure_pgpt_env", 1)[0]
    body = body.replace("exit /b 0", "echo Selected: %MYHARNESS_SELECTED_PROFILE%\nexit /b 0")
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
        assert settings.read_text(encoding="utf-8") == original
        assert saved_profile.encode() in result.stdout
        assert log == ""
        assert b"provider-setup.log" not in result.stdout
    else:
        assert settings.read_text(encoding="utf-8") == original
        assert "JSONDecodeError" in log
        assert b"provider-setup.log" in result.stdout


@pytest.mark.parametrize("employee_field", ["employee_no", "system_code"])
def test_pgpt_credentials_file_takes_priority_over_codex(tmp_path, employee_field):
    (tmp_path / "auth.json").write_text(json.dumps({"tokens": {"access_token": "test-token"}}), encoding="utf-8")
    credentials = tmp_path / "credentials.json"
    credentials.write_text(json.dumps({"pgpt": {"api_key": "test-key", employee_field: "123"}}), encoding="utf-8")
    assert codex_oauth_usable(codex_home=tmp_path)
    assert select_default_profile(codex_home=tmp_path, credentials_path=credentials) == "p-gpt"


@pytest.mark.parametrize("employee_env", ["PGPT_EMPLOYEE_NO", "PGPT_SYSTEM_CODE", "POSCO_EMP_NO"])
def test_pgpt_environment_requires_key_and_employee(tmp_path, monkeypatch, employee_env):
    credentials = tmp_path / "missing.json"
    monkeypatch.setenv("PGPT_API_KEY", "test-key")
    assert not pgpt_credentials_usable(credentials_path=credentials)
    monkeypatch.setenv(employee_env, "123")
    assert pgpt_credentials_usable(credentials_path=credentials)
    assert select_default_profile(credentials_path=credentials) == "p-gpt"


@pytest.mark.parametrize("payload", ["{broken", "[]", "null", '{"tokens": []}', '{"pgpt": []}'])
def test_unusable_credentials_preserve_existing_profile(tmp_path, payload):
    (tmp_path / "auth.json").write_text(payload, encoding="utf-8")
    credentials = tmp_path / "credentials.json"
    credentials.write_text(payload, encoding="utf-8")
    assert select_default_profile(codex_home=tmp_path, credentials_path=credentials, fallback_profile="custom-provider") == "custom-provider"


@pytest.mark.skipif(os.name != "nt", reason="Windows installer invocation")
@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("available", ["codex", "both", "neither"])
def test_installer_command_resets_and_runtime_loads_profile(tmp_path, monkeypatch, existing, available):
    from myharness.config.settings import load_settings

    root = Path(__file__).resolve().parents[2]
    settings = tmp_path / "settings with spaces.json"
    if existing:
        settings.write_text('{"active_profile":"custom-provider","max_tokens":4096}', encoding="utf-8")
    codex_home = tmp_path / "codex with spaces"
    codex_home.mkdir()
    if available != "neither":
        (codex_home / "auth.json").write_text(json.dumps({"tokens": {"access_token": _jwt_with_exp(4_000_000_000)}}), encoding="utf-8")
    if available == "both":
        monkeypatch.setenv("PGPT_API_KEY", "test-key")
        monkeypatch.setenv("PGPT_EMPLOYEE_NO", "123")
    expected = "codex" if available == "codex" else "p-gpt"
    env = {**os.environ, "CODEX_HOME": str(codex_home), "MYHARNESS_SETTINGS": str(settings)}
    source = (root / "Installer.bat").read_text(encoding="utf-8")
    command = next(line for line in source.splitlines() if 'select_default_provider_profile.py" --settings' in line)
    command = command.replace('"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS%', f'"{sys.executable}"')
    command = command.replace('%MYHARNESS_PROJECT_DIR%', str(root)).replace('%MYHARNESS_SETTINGS%', str(settings))
    batch = tmp_path / "installer provider check.bat"
    batch.write_text("@echo off\n" + command + "\n", encoding="utf-8")
    result = subprocess.run(["cmd.exe", "/d", "/c", str(batch)], env=env, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == expected.encode()
    data = json.loads(settings.read_text(encoding="utf-8"))
    assert data["active_profile"] == expected
    if existing:
        assert data["max_tokens"] == 4096
    resolved = load_settings(config_path=settings)
    assert resolved.active_profile == expected
    assert resolved.provider == ("openai_codex" if expected == "codex" else "openai")
