"""Cold-start coverage: runtime choices must not wait for engine/SDK imports."""

import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def test_cli_emits_runtime_choices_before_importing_engine(tmp_path):
    script = """
import builtins, runpy, sys
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == 'myharness.ui.app':
        assert 'anthropic' not in sys.modules
        assert 'openai' not in sys.modules
        raise SystemExit(0)
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
sys.argv = ['myharness', '--backend-only', '--cwd', sys.argv[1],
            '--active-profile', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'low']
runpy.run_module('myharness', run_name='__main__')
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=tmp_path,
        env={
            **os.environ,
            "PYTHONPATH": str(ROOT / "src"),
            "MYHARNESS_CONFIG_DIR": str(tmp_path / "config"),
            "MYHARNESS_DATA_DIR": str(tmp_path / "data"),
            "PYTHONUTF8": "1",
        },
        capture_output=True, text=True, encoding="utf-8", timeout=20,
    )
    assert result.returncode == 0, result.stderr
    events = [json.loads(line.removeprefix("OHJSON:")) for line in result.stdout.splitlines() if line.startswith("OHJSON:")]
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "state_snapshot"
    assert event["state"]["active_profile"] == "codex"
    assert event["state"]["model"] == "gpt-5.6-sol"
    assert event["state"]["effort"] == "low"
    assert event["state"]["runtime_options"]["models_by_provider"]["codex"]
    assert "ready" not in event["state"]


def test_api_public_exports_keep_original_identity():
    import importlib
    import myharness.api as api

    for name in api.__all__:
        module = importlib.import_module(f"myharness.api.{api._EXPORT_MODULES[name]}")
        assert getattr(api, name) is getattr(module, name)
