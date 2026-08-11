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


def test_web_server_launcher_stops_and_verifies_the_full_process_tree() -> None:
    script = _read_launcher("run_myharness_web_server.ps1")
    stop_server = _function_body(script, "Stop-ServerProcess")

    assert 'launcher_process_tree.ps1' in script
    assert "Stop-MyHarnessProcessTrees" in stop_server
    assert "Wait-MyHarnessRuntimeStopped" in stop_server
    assert "HasExited" not in stop_server.split("[Console]::add_CancelKeyPress", 1)[0]


def test_shared_launcher_process_tree_helper_tracks_and_verifies_descendants() -> None:
    helper = _read_launcher("launcher_process_tree.ps1")
    get_tree = _function_body(helper, "Get-MyHarnessProcessTreeIds")
    stop_trees = _function_body(helper, "Stop-MyHarnessProcessTrees")
    wait_stopped = _function_body(helper, "Wait-MyHarnessRuntimeStopped")

    assert "Get-CimInstance Win32_Process" in get_tree
    assert "ParentProcessId" in get_tree
    assert "taskkill.exe" in stop_trees
    assert '"/PID", ([string]$rootId), "/T", "/F"' in stop_trees
    assert "Stop-Process -Id $treeIds[$index] -Force" in stop_trees
    assert "Get-Process -Id $_ -ErrorAction SilentlyContinue" in wait_stopped
    assert "Get-MyHarnessListeningPorts" in wait_stopped
    assert "could not fully stop the previous runtime" in wait_stopped


def test_dev_launcher_stops_and_verifies_all_tracked_processes() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    stop_all = _function_body(script, "Stop-All")

    assert 'launcher_process_tree.ps1' in script
    assert "$script:BackendProcess.Id" in stop_all
    assert "$script:ViteProcess.Id" in stop_all
    assert "Stop-MyHarnessProcessTrees" in stop_all
    assert "Wait-MyHarnessRuntimeStopped" in stop_all
    assert "HasExited" not in stop_all


def test_dev_launcher_uses_port_scoped_lock_before_reclaiming_ports() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    open_lock = _function_body(script, "Open-DevLauncherLock")
    start_backend = _function_body(script, "Start-BackendLauncher")

    assert '"dev-$Port.lock"' in open_lock
    assert "[System.IO.FileShare]::None" in open_lock
    assert "Another MyHarness dev launcher already owns backend port $Port" in open_lock
    assert "$script:LockDirectory" in open_lock
    assert "$script:LogDirectory" not in open_lock
    assert "Get-CimInstance Win32_Process" not in script
    assert "$script:DevLauncherLock = Open-DevLauncherLock -Port $backendPort" in script
    assert "Test-BackendSupervisorLockAvailable -Port $backendPort" in start_backend
    assert start_backend.index("Test-BackendSupervisorLockAvailable") < start_backend.index("Stop-ListeningPort")


def test_web_server_supervisor_uses_exclusive_per_port_lock() -> None:
    script = _read_launcher("run_myharness_web_server.ps1")
    open_lock = _function_body(script, "Open-LauncherLock")

    assert '"server-$Port.lock"' in script
    assert "[System.IO.FileShare]::None" in script
    assert "Another MyHarness backend supervisor already owns port $serverPort" in script
    assert "$script:LockDirectory" in open_lock
    assert "$script:LogDirectory" not in open_lock


def test_windows_launchers_pin_child_processes_to_frontend_web_directory() -> None:
    dev_script = _read_launcher("run_myharness_web_dev.ps1")
    server_script = _read_launcher("run_myharness_web_server.ps1")

    assert '$script:FrontendWebDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\\frontend\\web"))' in dev_script
    assert dev_script.count("-WorkingDirectory $script:FrontendWebDirectory") >= 2
    assert '$script:FrontendWebDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\\frontend\\web"))' in server_script
    assert 'Start-Process -FilePath "node.exe" -ArgumentList @("server.mjs") -WorkingDirectory $script:FrontendWebDirectory' in server_script


def test_dev_launcher_restart_has_no_fixed_multi_second_pause() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    restart_block = re.search(
        r"if \(Test-LauncherKey -Key \$key -ExpectedKey R .*?\) \{(?P<body>.*?)^\s*\}",
        script,
        flags=re.MULTILINE | re.DOTALL,
    )

    assert restart_block, "restart key block not found"
    assert "Start-Sleep -Seconds" not in restart_block.group("body")


def test_launchers_accept_lowercase_and_korean_restart_keys() -> None:
    for script_name in ("run_myharness_web_server.ps1", "run_myharness_web_dev.ps1"):
        script = _read_launcher(script_name)

        assert '-ExpectedKey R -Characters @("r", "R", ([string][char]0x3131))' in script
        assert '"KeyChar", "Character"' in script


def test_launchers_do_not_keep_separate_hard_reset_key() -> None:
    for script_name in ("run_myharness_web_server.ps1", "run_myharness_web_dev.ps1"):
        script = _read_launcher(script_name)

        assert "ExpectedKey T" not in script
        assert "keyboard_t" not in script


def test_launchers_show_full_restart_shortcut_on_r_only() -> None:
    backend_batch = (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8")
    dev_batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")
    dev_script = _read_launcher("run_myharness_web_dev.ps1")

    assert "Press R in this window to full restart the server." in backend_batch
    assert "Press R in this window to full restart both servers." in dev_batch
    assert "Press R in this window to full restart both servers." in dev_script
    assert "Press T in this window" not in backend_batch
    assert "Press T in this window" not in dev_batch
    assert "Press T in this window" not in dev_script


def test_dev_restart_clears_backend_and_vite_ports() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    restart_all = _function_body(script, "Restart-All")

    assert "Stop-All" in restart_all
    assert 'Stop-ListeningPort -Port $backendPort -Label "backend"' in restart_all
    assert 'Stop-ListeningPort -Port $script:VitePort -Label "Vite dev"' in restart_all
    assert "Start-BackendLauncher" in restart_all
    assert "Start-ViteServer" in restart_all


def test_dev_unexpected_exits_use_full_restart() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    backend_exit_tail = script[script.index("Backend launcher exited") :]
    vite_exit_tail = script[script.index("Vite dev server exited") :]

    assert "Full restarting in 2 seconds" in script
    assert "Restart-All" in backend_exit_tail[:300]
    assert "Restart-All" in vite_exit_tail[:300]


def test_backend_unexpected_exit_clears_port_before_restart() -> None:
    script = _read_launcher("run_myharness_web_server.ps1")

    assert "full restarting server in 3 seconds" in script
    assert "Stop-ListeningPort -Port $serverPort" in script[script.index("server_exited_unexpectedly") :]
    assert "$process.WaitForExit()" in script
    assert "$process.Refresh()" in script
    assert 'if ($null -eq $exitCode) { "unknown" }' in script


def test_dev_launcher_disables_vite_stdin_shortcuts() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    start_vite = _function_body(script, "Start-ViteServer")

    assert '$env:CI = "true"' in start_vite
    assert "Remove-Item Env:\\CI" in start_vite


def test_dev_launcher_exposes_vite_and_enables_backend_entry_redirect() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    start_vite = _function_body(script, "Start-ViteServer")
    start_backend = _function_body(script, "Start-BackendLauncher")

    assert '"--host", "0.0.0.0"' in start_vite
    assert 'MYHARNESS_DEV_UI_REDIRECT = "1"' in start_backend
    assert "MYHARNESS_DEV_UI_PORT" in start_backend


def test_dev_launcher_derives_react_dev_ui_from_backend_port() -> None:
    batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")
    script = _read_launcher("run_myharness_web_dev.ps1")
    vite_config = (ROOT / "frontend" / "web" / "vite.config.ts").read_text(encoding="utf-8")

    assert 'set "MYHARNESS_DEV_PORT=auto"' in batch
    assert 'if /I "%MYHARNESS_DEV_PORT%"=="auto" set /A MYHARNESS_DEV_PORT=PORT+100' in batch
    assert 'set "MYHARNESS_WEB_PORT=%MYHARNESS_DEV_PORT%"' in batch
    requested_port = _function_body(script, "Get-RequestedVitePort")
    assert '[string]($BackendPort + 100)' in requested_port
    assert 'Vite dev port $port must be different from backend port $BackendPort.' in requested_port
    assert "configuredDevPort(repoRoot, backendPort)" in vite_config
    assert "xfwd: true" in vite_config


def test_web_launchers_prefer_folder_local_env_before_environment_fallbacks() -> None:
    backend_batch = (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8")
    dev_batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")

    for batch in (backend_batch, dev_batch):
        assert "MYHARNESS_DOTENV" not in batch
        assert 'set "MYHARNESS_LOCAL_ENV=%CD%\\myharness.local.env"' in batch
        assert 'if exist "%MYHARNESS_LOCAL_ENV%" call :load_local_env "%MYHARNESS_LOCAL_ENV%"' in batch
        assert batch.index("call :load_local_env") < batch.index('if "%PORT%"=="" set "PORT=4174"')
        assert 'if not "%%~A"=="" if not "%%~B"=="" set "%%~A=%%~B"' in batch
        assert 'if not "%%~B"=="" if not defined %%~A set "%%~A=%%~B"' in batch


def test_direct_launchers_read_backend_port_from_folder_local_env() -> None:
    dev_script = _read_launcher("run_myharness_web_dev.ps1")
    server_script = _read_launcher("run_myharness_web_server.ps1")

    for script in (dev_script, server_script):
        assert '. (Join-Path $PSScriptRoot "local_env.ps1")' in script
        assert "Get-MyHarnessConfiguredPort -RepoRoot $repoRoot" in script
    assert "$env:PORT = [string]" in script


def test_direct_launchers_allow_isolated_runs_to_ignore_folder_local_port() -> None:
    local_env = _read_launcher("local_env.ps1")

    assert '$env:MYHARNESS_IGNORE_LOCAL_ENV -ne "1"' in local_env
    assert local_env.index("MYHARNESS_IGNORE_LOCAL_ENV") < local_env.index("Get-MyHarnessLocalEnvValue -RepoRoot $RepoRoot -Name \"PORT\"")


def test_launchers_close_busy_backend_ports_by_default() -> None:
    dev_script = _read_launcher("run_myharness_web_dev.ps1")
    server_script = _read_launcher("run_myharness_web_server.ps1")

    assert "Closing the existing process and starting fresh" in dev_script
    assert "Closing the existing process and starting fresh" in server_script


def test_windows_launchers_avoid_hanging_tcp_connection_cmdlet() -> None:
    batch_launchers = (
        (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8"),
        (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8"),
    )
    powershell_launchers = (
        _read_launcher("run_myharness_web_dev.ps1"),
        _read_launcher("run_myharness_web_server.ps1"),
    )

    for launcher in (*batch_launchers, *powershell_launchers):
        assert "Get-NetTCPConnection" not in launcher

    for launcher in powershell_launchers:
        assert "netstat -ano -p tcp" in launcher


def test_batch_launchers_delegate_port_reclamation_to_powershell_supervisors() -> None:
    backend_batch = (ROOT / "run_myharness_web.bat").read_text(encoding="utf-8")
    dev_batch = (ROOT / "run_myharness_web_dev.bat").read_text(encoding="utf-8")
    server_script = _read_launcher("run_myharness_web_server.ps1")
    dev_script = _read_launcher("run_myharness_web_dev.ps1")

    for batch in (backend_batch, dev_batch):
        assert "MYHARNESS_PORT_PID" not in batch
        assert "taskkill /PID" not in batch

    assert "Stop-ListeningPort -Port $serverPort" in server_script
    assert 'Stop-ListeningPort -Port $backendPort -Label "backend"' in dev_script


def test_web_launchers_disable_keyring_probing() -> None:
    for name in ("run_myharness_web.bat", "run_myharness_web_dev.bat"):
        launcher = (ROOT / name).read_text(encoding="utf-8")

        assert 'set "MYHARNESS_DISABLE_KEYRING=1"' in launcher


def test_installer_verifies_bundled_national_assembly_mcp() -> None:
    installer = (ROOT / "Installer.bat").read_text(encoding="utf-8")

    assert "Node.js 20.19 or newer is required." in installer
    assert 'if not exist ".skills\\mcp\\national-assembly\\runtime\\index.js"' in installer
    assert 'if not exist ".skills\\mcp\\national-assembly\\runtime\\244.index.js"' in installer
    assert 'node --check ".skills\\mcp\\national-assembly\\runtime\\index.js"' in installer
    assert 'node --check ".skills\\mcp\\national-assembly\\runtime\\244.index.js"' in installer
    assert "git clone" not in installer
    assert 'pushd ".skills\\mcp\\national-assembly\\runtime"' not in installer


def test_installer_updates_existing_web_dependencies_without_npm_ci() -> None:
    installer = (ROOT / "Installer.bat").read_text(encoding="utf-8")

    assert 'call :install_web_dependencies' in installer
    assert 'if exist "node_modules" goto install_web_dependencies_incremental' in installer
    assert 'call npm ci' in installer
    assert '[WARN] npm ci failed. Retrying with npm install...' in installer
    assert installer.count('call npm install') >= 1


def test_installer_installs_every_dependency_it_verifies() -> None:
    installer = (ROOT / "Installer.bat").read_text(encoding="utf-8").lower()
    install_line = next(
        line for line in installer.splitlines() if "-m pip install markitdown" in line
    )

    for package in (
        "markitdown",
        "pymupdf",
        "mammoth",
        "markdownify",
        "beautifulsoup4",
        "openpyxl",
        "svglib",
        "reportlab",
        "pillow",
        "numpy",
        "requests",
        "curl_cffi",
    ):
        assert package in install_line


def test_dev_vite_port_falls_forward_without_killing_preferred_port() -> None:
    script = _read_launcher("run_myharness_web_dev.ps1")
    resolve_vite = _function_body(script, "Resolve-VitePort")

    assert "Stop-ListeningPort" not in resolve_vite
    assert "Searching for the next usable port" in resolve_vite
