$ErrorActionPreference = "Stop"
$script:StopRequested = $false
$script:BackendProcess = $null
$script:ViteProcess = $null

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    & taskkill.exe /PID $ProcessId /T /F >$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ChildProcess {
    param($Process)

    if (-not $Process -or $Process.HasExited) {
        return
    }

    Stop-ProcessTree -ProcessId $Process.Id
    try {
        $Process.Refresh()
    }
    catch {
        # Process handles can become invalid immediately after taskkill.
    }
    if (-not $Process.HasExited) {
        $Process.WaitForExit(1000) | Out-Null
    }
}

function Test-ClosePortProcessEnabled {
    return $env:MYHARNESS_CLOSE_PORT_PROCESS -eq "1"
}

function Stop-ListeningPort {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) {
        return
    }

    $ownerPid = [int]$connection.OwningProcess
    if ($ownerPid -eq $PID) {
        return
    }

    if (-not (Test-ClosePortProcessEnabled)) {
        throw "Port $Port for $Label is already in use by PID $ownerPid. Edit this folder's myharness.local.env and choose another PORT/MYHARNESS_DEV_PORT, or set MYHARNESS_CLOSE_PORT_PROCESS=1 to intentionally close that process."
    }

    Write-Host "[INFO] Port $Port for $Label is already in use by PID $ownerPid. MYHARNESS_CLOSE_PORT_PROCESS=1, closing the existing process..."
    Stop-ProcessTree -ProcessId $ownerPid
    Start-Sleep -Milliseconds 500

    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($stillListening) {
        throw "Port $Port is still in use after trying to close PID $ownerPid."
    }
}

function Test-CanListenOnPort {
    param(
        [Parameter(Mandatory = $true)][string]$HostAddress,
        [Parameter(Mandatory = $true)][int]$Port
    )

    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($HostAddress), $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    }
    catch {
        if ($listener) {
            $listener.Stop()
        }
        return $false
    }
}

function Get-RequestedVitePort {
    $rawPort = if ($env:MYHARNESS_DEV_PORT) {
        $env:MYHARNESS_DEV_PORT
    }
    elseif ($env:MYHARNESS_WEB_PORT) {
        $env:MYHARNESS_WEB_PORT
    }
    elseif ($env:VITE_PORT) {
        $env:VITE_PORT
    }
    else {
        "4173"
    }

    try {
        $port = [int]$rawPort
    }
    catch {
        throw "Invalid Vite dev port '$rawPort'. Set MYHARNESS_DEV_PORT to a number from 1 to 65535."
    }

    if ($port -lt 1 -or $port -gt 65535) {
        throw "Invalid Vite dev port '$rawPort'. Set MYHARNESS_DEV_PORT to a number from 1 to 65535."
    }

    return $port
}

function Resolve-VitePort {
    param([Parameter(Mandatory = $true)][int]$PreferredPort)

    if (Test-CanListenOnPort -HostAddress "0.0.0.0" -Port $PreferredPort) {
        return $PreferredPort
    }

    Write-Host "[WARN] Vite dev port $PreferredPort is unavailable. Searching for the next usable port..."
    $lastPort = [Math]::Min(65535, $PreferredPort + 200)
    for ($candidate = $PreferredPort + 1; $candidate -le $lastPort; $candidate++) {
        if (Test-CanListenOnPort -HostAddress "0.0.0.0" -Port $candidate) {
            Write-Host "[INFO] Using fallback Vite dev port $candidate."
            return $candidate
        }
    }

    throw "No usable Vite dev port found between $PreferredPort and $lastPort."
}

function Stop-All {
    Stop-ChildProcess -Process $script:ViteProcess
    Stop-ChildProcess -Process $script:BackendProcess
}

function Read-LauncherKey {
    try {
        if ($Host.UI.RawUI.KeyAvailable) {
            return $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        }
    }
    catch {
        # Fall back below for hosts that do not expose RawUI.
    }

    try {
        if ([Console]::KeyAvailable) {
            return [Console]::ReadKey($true)
        }
    }
    catch {
        # Some hosts do not expose an interactive console. Key polling is best effort.
    }

    return $null
}

function Test-LauncherKey {
    param(
        $Key,
        [Parameter(Mandatory = $true)][ConsoleKey]$ExpectedKey
    )

    if ($null -eq $Key) {
        return $false
    }
    if ($Key.PSObject.Properties.Name -contains "Key") {
        return $Key.Key -eq $ExpectedKey
    }
    if ($Key.PSObject.Properties.Name -contains "VirtualKeyCode") {
        return $Key.VirtualKeyCode -eq [int]$ExpectedKey
    }

    return $false
}

function Start-BackendLauncher {
    Stop-ListeningPort -Port $backendPort -Label "backend"
    Write-Host "[INFO] Starting MyHarness backend launcher on http://localhost:$env:PORT ..."
    $previousKeyHandling = $env:MYHARNESS_SERVER_KEY_HANDLING
    $previousDevUiRedirect = $env:MYHARNESS_DEV_UI_REDIRECT
    $previousDevUiPort = $env:MYHARNESS_DEV_UI_PORT
    try {
        $env:MYHARNESS_SERVER_KEY_HANDLING = "0"
        $env:MYHARNESS_DEV_UI_REDIRECT = "1"
        $env:MYHARNESS_DEV_UI_PORT = [string]$script:VitePort
        return Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "scripts\run_myharness_web_server.ps1")
        ) -NoNewWindow -PassThru
    }
    finally {
        if ($null -eq $previousKeyHandling) {
            Remove-Item Env:\MYHARNESS_SERVER_KEY_HANDLING -ErrorAction SilentlyContinue
        }
        else {
            $env:MYHARNESS_SERVER_KEY_HANDLING = $previousKeyHandling
        }
        if ($null -eq $previousDevUiRedirect) {
            Remove-Item Env:\MYHARNESS_DEV_UI_REDIRECT -ErrorAction SilentlyContinue
        }
        else {
            $env:MYHARNESS_DEV_UI_REDIRECT = $previousDevUiRedirect
        }
        if ($null -eq $previousDevUiPort) {
            Remove-Item Env:\MYHARNESS_DEV_UI_PORT -ErrorAction SilentlyContinue
        }
        else {
            $env:MYHARNESS_DEV_UI_PORT = $previousDevUiPort
        }
    }
}

function Start-ViteServer {
    Stop-ListeningPort -Port $script:VitePort -Label "Vite dev"
    Write-Host "[INFO] Starting Vite React dev server on http://0.0.0.0:$script:VitePort ..."
    return Start-Process -FilePath "node.exe" -ArgumentList @("node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", ([string]$script:VitePort), "--strictPort") -NoNewWindow -PassThru
}

[Console]::add_CancelKeyPress({
    param($sender, $eventArgs)

    $eventArgs.Cancel = $true
    $script:StopRequested = $true
    Write-Host ""
    Write-Host "[INFO] Stop requested. Stopping backend and Vite dev server..."
    Stop-All
})

$backendPort = if ($env:PORT) { [int]$env:PORT } else { 4273 }
$preferredVitePort = Get-RequestedVitePort
Stop-ListeningPort -Port $backendPort -Label "backend"
$script:VitePort = Resolve-VitePort -PreferredPort $preferredVitePort
$env:MYHARNESS_DEV_PORT = [string]$script:VitePort
$env:MYHARNESS_WEB_PORT = [string]$script:VitePort
$env:VITE_PORT = [string]$script:VitePort

$script:BackendProcess = Start-BackendLauncher

Start-Sleep -Seconds 2

$script:ViteProcess = Start-ViteServer

Write-Host ""
Write-Host "MyHarness dev mode is ready:"
Write-Host "  Local React dev UI: http://127.0.0.1:$script:VitePort"
Write-Host "  Backend entry:      http://localhost:$env:PORT"
Write-Host "  Network entry:      use http://<this PC IP>:$env:PORT from another PC"
Write-Host ""
Write-Host "Keep this window open while developing."
Write-Host "If the backend or Vite exits unexpectedly, this launcher will restart it."
Write-Host "Press Q or Ctrl+C in this window to stop both servers."
Write-Host "Press R in this window to restart both servers."
Write-Host ""

try {
    while (-not $script:StopRequested) {
        Start-Sleep -Milliseconds 200

        if ($script:BackendProcess.HasExited) {
            if ($script:BackendProcess.ExitCode -eq 0) {
                $script:StopRequested = $true
                Stop-ChildProcess -Process $script:ViteProcess
                break
            }

            Write-Host "[WARN] Backend launcher exited with code $($script:BackendProcess.ExitCode). Restarting in 2 seconds..."
            Start-Sleep -Seconds 2
            $script:BackendProcess = Start-BackendLauncher
        }
        if ($script:ViteProcess.HasExited) {
            Write-Host "[WARN] Vite dev server exited with code $($script:ViteProcess.ExitCode). Restarting in 2 seconds..."
            Start-Sleep -Seconds 2
            $script:ViteProcess = Start-ViteServer
        }

        try {
            $key = Read-LauncherKey
            if (Test-LauncherKey -Key $key -ExpectedKey Q) {
                $script:StopRequested = $true
                Write-Host "[INFO] Stop requested. Stopping backend and Vite dev server..."
                Stop-All
                break
            }
            if (Test-LauncherKey -Key $key -ExpectedKey R) {
                Write-Host "[INFO] Restart requested. Restarting backend and Vite dev server..."
                Stop-All
                $script:BackendProcess = Start-BackendLauncher
                $script:ViteProcess = Start-ViteServer
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
}
catch {
    Write-Host "[ERROR] $_"
    Stop-All
    exit 1
}

Stop-All
exit 0
