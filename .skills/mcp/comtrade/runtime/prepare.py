"""Prepare this copied MCP package without a host application checkout."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check without installing anything")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is required")
    package = Path(__file__).resolve().parents[1]
    requirements = package / "requirements.txt"
    if not args.check:
        subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(requirements)], check=True)
    # The packages include their own helper code; no myharness import is needed.
    import httpx
    if (package / "runtime/server.py").exists():
        import mcp.server.fastmcp
        import yaml
        import defusedxml
        import pydantic
    if (package / "runtime/bootstrap.py").exists():
        node = shutil.which("node")
        if not node:
            raise SystemExit("Node.js 22 or newer is required")
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if int(version.lstrip("v").split(".")[0]) < 22:
            raise SystemExit("Node.js 22 or newer is required")
    if (package / "runtime/package-lock.json").exists():
        if not args.check:
            # Explicit preparation must rebuild dependencies for the destination OS.
            (package / "runtime/node_modules/.myharness-lock-sha256").unlink(missing_ok=True)
            subprocess.run([sys.executable, str(package / "runtime/bootstrap.py"), "--prepare"], check=True)
        if not (package / "runtime/node_modules/korean-law-mcp/build/index.js").is_file():
            raise SystemExit("Run python runtime/prepare.py to prepare the locked Node dependencies")
    print(f"{package.name}: local runtime dependencies ready")


if __name__ == "__main__":
    main()
