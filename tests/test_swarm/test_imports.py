"""Import regression tests for swarm startup."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_create_default_tool_registry_does_not_import_mailbox_eagerly():
    # A cold import belongs in a fresh interpreter. Removing live modules here
    # splits their identity from references already collected by other tests.
    source_root = Path(__file__).resolve().parents[2] / "src"
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
sys.path.insert(0, sys.argv[1])
from myharness.platforms import get_platform
from myharness.tools import create_default_tool_registry
registry = create_default_tool_registry()
command_tool = "cmd" if get_platform() == "windows" else "bash"
assert registry.get(command_tool) is not None
assert "myharness.swarm.mailbox" not in sys.modules
assert "myharness.swarm.lockfile" not in sys.modules
""", str(source_root)],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
