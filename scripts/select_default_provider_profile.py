"""Select the launcher default provider profile.

The Windows web launchers call this before starting the backend so machines
with a usable Codex OAuth login default to the Codex subscription profile. If
Codex credentials are absent or clearly expired, the launcher falls back to the
P-GPT profile.
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
    exp = data.get("exp")
    return exp if isinstance(exp, int) else None


def codex_oauth_usable(*, codex_home: Path | None = None, now: int | None = None) -> bool:
    home = codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    auth_path = home / "auth.json"
    if not auth_path.exists():
        return False

    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
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


def select_default_profile(*, codex_home: Path | None = None, now: int | None = None) -> str:
    return "codex" if codex_oauth_usable(codex_home=codex_home, now=now) else "p-gpt"


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
    args = parser.parse_args()

    profile = select_default_profile(codex_home=args.codex_home)
    update_settings_active_profile(args.settings, profile)
    print(profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
