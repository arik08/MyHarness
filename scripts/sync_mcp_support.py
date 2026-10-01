"""Bundle canonical helper code so copied MCPs do not depend on host shims.

Run with --check in validation; without it refreshes generated package copies.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/myharness/mcp"


def sync(*, check: bool = False) -> list[str]:
    mismatches = []
    for runtime in sorted((ROOT / ".skills/mcp").glob("*/runtime")):
        if runtime.parent.name.startswith("posco-"):
            continue
        files = ["official_data.py", "skill_resources.py"]
        if (runtime / "bootstrap.py").exists():
            files += ["node_fetch.cjs", "node_http_bridge.py"]
        outputs = {"__init__.py": b'"""Generated MCP support; refresh with scripts/sync_mcp_support.py."""\n'}
        for name in files:
            outputs[name] = (SOURCE / name).read_bytes()
        for name, content in outputs.items():
            destination = runtime / "_myharness_mcp_support" / name
            if destination.exists() and destination.read_bytes() == content:
                continue
            mismatches.append(str(destination.relative_to(ROOT)))
            if not check:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
    return mismatches


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    differences = sync(check=args.check)
    if args.check and differences:
        raise SystemExit("MCP support copies are stale; run python scripts/sync_mcp_support.py\n" + "\n".join(differences))
    print(f"MCP support {'verified' if args.check else 'updated'} ({len(differences)} changed files)")
