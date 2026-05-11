from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read_launcher(name: str) -> str:
    return (ROOT / "scripts" / name).read_text(encoding="utf-8")


def _function_body(script: str, function_name: str) -> str:
    match = re.search(
        rf"function {re.escape(function_name)} \{{(?P<body>.*?)(?=^function |\Z)",
        script,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert match, f"{function_name} not found"
    return match.group("body")


def test_web_server_launcher_stops_process_trees_without_wmi_recursion() -> None:
    script = _read_launcher("run_myharness_web_server.ps1")
    stop_tree = _function_body(script, "Stop-ProcessTree")
    stop_server = _function_body(script, "Stop-ServerProcess")

    assert "taskkill" in stop_tree.lower()
    assert "Get-CimInstance" not in stop_tree
    assert "WaitForExit(5000)" not in stop_server


def test_dev_launcher_restart_has_no_fixed_multi_second_pause() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    restart_block = re.search(
        r"if \(Test-LauncherKey -Key \$key -ExpectedKey R\) \{(?P<body>.*?)^\s*\}",
        script,
        flags=re.MULTILINE | re.DOTALL,
    )

    assert restart_block, "restart key block not found"
    assert "Start-Sleep -Seconds" not in restart_block.group("body")


def test_dev_launcher_exposes_vite_and_enables_backend_entry_redirect() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    start_vite = _function_body(script, "Start-ViteServer")
    start_backend = _function_body(script, "Start-BackendLauncher")

    assert '"--host", "0.0.0.0"' in start_vite
    assert 'MYHARNESS_DEV_UI_REDIRECT = "1"' in start_backend
    assert "MYHARNESS_DEV_UI_PORT" in start_backend
