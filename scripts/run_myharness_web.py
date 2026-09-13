"""Start the local web app on macOS/Linux without sourcing credential files."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    for filename in ("API_KEY.env", "myharness.local.env"):
        path = root / filename
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key.isidentifier() and value:
                os.environ[key] = value
    config = root / ".myharness"
    config.mkdir(exist_ok=True)
    for key, value in {
        "MYHARNESS_HOME": config,
        "MYHARNESS_CONFIG_DIR": config,
        "MYHARNESS_DATA_DIR": config / "data",
        "MYHARNESS_LOGS_DIR": config / "logs",
        "MYHARNESS_SETTINGS": config / "settings.json",
        "MYHARNESS_PYTHON": sys.executable,
        "PYTHON": sys.executable,
    }.items():
        os.environ[key] = str(value)
    os.environ.setdefault("HOST", "127.0.0.1")
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js was not found on PATH.")
    os.execv(node, [node, str(root / "frontend/web/server.mjs")])


if __name__ == "__main__":
    main()
