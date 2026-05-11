import base64
import json
from pathlib import Path

from scripts.select_default_provider_profile import (
    codex_oauth_usable,
    select_default_profile,
    update_settings_active_profile,
)


def _jwt_with_exp(exp: int) -> str:
    payload = json.dumps({"exp": exp}).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"header.{encoded}.signature"


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
