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


def test_dev_launcher_defaults_react_dev_ui_to_4173() -> None:
    batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")
    script = _read_launcher("run_myharness_web_dev.ps1")
    vite_config = (ROOT / "frontend" / "web" / "vite.config.ts").read_text(encoding="utf-8")

    assert 'set "MYHARNESS_DEV_PORT=4173"' in batch
    assert 'set "MYHARNESS_WEB_PORT=%MYHARNESS_DEV_PORT%"' in batch
    assert '"4173"' in _function_body(script, "Get-RequestedVitePort")
    assert "process.env.MYHARNESS_DEV_PORT || process.env.MYHARNESS_WEB_PORT || process.env.VITE_PORT || 4173" in vite_config


def test_web_launchers_load_folder_local_env_before_defaults() -> None:
    backend_batch = (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8")
    dev_batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")

    for batch in (backend_batch, dev_batch):
        assert 'set "MYHARNESS_LOCAL_ENV=%CD%\\myharness.local.env"' in batch
        assert 'if exist "%MYHARNESS_LOCAL_ENV%" call :load_local_env "%MYHARNESS_LOCAL_ENV%"' in batch
        assert batch.index("call :load_local_env") < batch.index('if "%PORT%"=="" set "PORT=4273"')


def test_launchers_do_not_close_busy_ports_by_default() -> None:
    backend_batch = (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8")
    dev_batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")
    dev_script = _read_launcher("run_myharness_web_dev.ps1")

    assert 'if /i "%MYHARNESS_CLOSE_PORT_PROCESS%"=="1"' in backend_batch
    assert 'if /i "%MYHARNESS_CLOSE_PORT_PROCESS%"=="1"' in dev_batch
    assert "To run copies side-by-side" in backend_batch
    assert "To run copies side-by-side" in dev_batch
    assert "MYHARNESS_CLOSE_PORT_PROCESS -eq \"1\"" in dev_script
    assert "Edit this folder's myharness.local.env" in dev_script
    assert "MYHARNESS_DEV_PORT=4174" in dev_batch


def test_dev_vite_port_falls_forward_without_killing_preferred_port() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    resolve_vite = _function_body(script, "Resolve-VitePort")

    assert "Stop-ListeningPort" not in resolve_vite
    assert "Searching for the next usable port" in resolve_vite
