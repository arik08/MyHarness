"""Select installer/launcher defaults from locally configured credentials.

Preserve the saved selection unless the installer requests --reset.
Prefer P-GPT when both providers are configured. This is an offline readiness
check, not a guarantee of network access or server-side authorization.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path
from typing import Any


def _decode_jwt_exp(access_token: str) -> int | None:
    parts = access_token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except Exception:
        return None
    exp = data.get("exp") if isinstance(data, dict) else None
    return exp if isinstance(exp, int) else None


def codex_oauth_usable(*, codex_home: Path | None = None, now: int | None = None) -> bool:
    home = codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    auth_path = home / "auth.json"
    if not auth_path.exists():
        return False

    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False

    tokens = payload.get("tokens")
    access_token = ""
    if isinstance(tokens, dict):
        access_token = str(tokens.get("access_token", "") or "").strip()
    if not access_token:
        access_token = str(payload.get("OPENAI_API_KEY", "") or "").strip()
    if not access_token:
        return False

    exp = _decode_jwt_exp(access_token)
    if exp is not None:
        current = int(time.time()) if now is None else now
        return exp > current + 60
    return True


def pgpt_credentials_usable(*, credentials_path: Path) -> bool:
    try:
        payload = json.loads(credentials_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = {}
    stored = payload.get("pgpt", {}) if isinstance(payload, dict) else {}
    if not isinstance(stored, dict):
        stored = {}
    api_key = os.environ.get("PGPT_API_KEY") or stored.get("api_key")
    employee_no = (
        os.environ.get("PGPT_EMPLOYEE_NO")
        or os.environ.get("PGPT_SYSTEM_CODE")
        or os.environ.get("POSCO_EMP_NO")
        or stored.get("employee_no")
        or stored.get("system_code")
    )
    return all(isinstance(value, str) and bool(value.strip()) for value in (api_key, employee_no))


def select_default_profile(
    *, codex_home: Path | None = None, now: int | None = None,
    credentials_path: Path | None = None, fallback_profile: str = "p-gpt",
) -> str:
    if credentials_path is None:
        config_dir = os.environ.get("MYHARNESS_CONFIG_DIR") or os.environ.get("MYHARNESS_HOME") or "~/.myharness"
        credentials_path = Path(config_dir).expanduser() / "credentials.json"
    if pgpt_credentials_usable(credentials_path=credentials_path):
        return "p-gpt"
    if codex_oauth_usable(codex_home=codex_home, now=now):
        return "codex"
    return fallback_profile


def update_settings_active_profile(settings_path: Path, active_profile: str) -> dict[str, Any]:
    settings: dict[str, Any] = {}
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        if not isinstance(settings, dict):
            settings = {}
    settings["active_profile"] = active_profile
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return settings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", required=True, type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--reset", action="store_true", help="Reset the saved provider using credential detection (installer only).")
    args = parser.parse_args()

    existing = json.loads(args.settings.read_text(encoding="utf-8")) if args.settings.exists() else {}
    fallback = existing.get("active_profile") if isinstance(existing, dict) else None
    if not args.reset and isinstance(fallback, str) and fallback.strip():
        print(fallback)
        return 0
    profile = select_default_profile(
        codex_home=args.codex_home,
        credentials_path=args.settings.parent / "credentials.json",
    )
    update_settings_active_profile(args.settings, profile)
    print(profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
