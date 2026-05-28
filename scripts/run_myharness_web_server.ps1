$ErrorActionPreference = "Stop"
$script:StopRequested = $false
$script:CurrentServerProcess = $null
$script:RestartCount = 0
$script:KeyHandlingEnabled = $env:MYHARNESS_SERVER_KEY_HANDLING -ne "0"
$script:LogDirectory = if ($env:MYHARNESS_LOGS_DIR) { $env:MYHARNESS_LOGS_DIR } else { Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".myharness\logs" }
$script:LauncherLog = Join-Path $script:LogDirectory "myharness-web-launcher.log"

function Write-LauncherLog {
    param(
        [Parameter(Mandatory = $true)][string]$Event,
        [hashtable]$Details = @{}
    )

    try {
        if (-not (Test-Path -LiteralPath $script:LogDirectory)) {
            New-Item -ItemType Directory -Path $script:LogDirectory -Force | Out-Null
        }
        $entry = [ordered]@{
            ts = (Get-Date).ToUniversalTime().ToString("o")
            event = $Event
            pid = $PID
        }
        foreach ($key in $Details.Keys) {
            $entry[$key] = $Details[$key]
        }
        Add-Content -LiteralPath $script:LauncherLog -Value ($entry | ConvertTo-Json -Compress) -Encoding UTF8
    }
    catch {
        # Logging must never be the reason the launcher exits.
    }
}

function Clear-ConsoleInputBuffer {
    $discarded = 0

    try {
        while ($true) {
            $key = Read-LauncherKey
            if ($null -eq $key) {
                break
            }
            $discarded += 1
        }
    }
    catch {
        # Some hosts do not expose an interactive console. Key polling is best effort.
    }

    return $discarded
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
        [Parameter(Mandatory = $true)][ConsoleKey]$ExpectedKey,
        [string[]]$Characters = @()
    )

    if ($null -eq $Key) {
        return $false
    }
    if ($Key.PSObject.Properties.Name -contains "Key") {
        if ($Key.Key -eq $ExpectedKey) {
            return $true
        }
    }
    if ($Key.PSObject.Properties.Name -contains "VirtualKeyCode") {
        if ($Key.VirtualKeyCode -eq [int]$ExpectedKey) {
            return $true
        }
    }
    foreach ($propertyName in @("KeyChar", "Character")) {
        if ($Key.PSObject.Properties.Name -contains $propertyName) {
            $character = [string]$Key.$propertyName
            if ($Characters -contains $character) {
                return $true
            }
        }
    }

    return $false
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    try {
        & taskkill.exe /PID $ProcessId /T /F >$null 2>$null
        $taskkillExitCode = $LASTEXITCODE
    }
    catch {
        $taskkillExitCode = 1
    }

    if ($taskkillExitCode -ne 0) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ListeningPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) {
        return
    }

    $ownerPid = [int]$connection.OwningProcess
    if ($ownerPid -eq $PID) {
        return
    }

    Write-Host "[INFO] Port $Port is already in use by PID $ownerPid. Closing the existing process and starting fresh..."
    Write-LauncherLog "port_process_closing" @{ port = $Port; owner_pid = $ownerPid }
    Stop-ProcessTree -ProcessId $ownerPid
    Start-Sleep -Milliseconds 500

    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($stillListening) {
        throw "Port $Port is still in use after trying to close PID $ownerPid."
    }
}

function Stop-ServerProcess {
    param([Parameter(Mandatory = $true)]$Process)

    if ($Process.HasExited) {
        return
    }

    Stop-ProcessTree -ProcessId $Process.Id
    try {
        $Process.Refresh()
    }
    catch {
        # Process handles can become invalid immediately after taskkill.
    }
    if (-not $Process.HasExited -and -not $Process.WaitForExit(1000)) {
        Write-Host "[WARN] Server process did not exit cleanly; continuing restart."
    }
}

[Console]::add_CancelKeyPress({
    param($sender, $eventArgs)

    $eventArgs.Cancel = $true
    $script:StopRequested = $true
    Write-Host ""
    Write-Host "[INFO] Stop requested. Stopping server..."
    Write-LauncherLog "stop_requested" @{ reason = "ctrl_c" }

    if ($script:CurrentServerProcess -and -not $script:CurrentServerProcess.HasExited) {
        Stop-ServerProcess -Process $script:CurrentServerProcess
    }
})

while (-not $script:StopRequested) {
    $serverPort = if ($env:PORT) { [int]$env:PORT } else { 4273 }
    Stop-ListeningPort -Port $serverPort
    Write-Host "[INFO] Starting node server.mjs..."
    Write-LauncherLog "server_starting" @{ restart_count = $script:RestartCount }
    $process = Start-Process -FilePath "node.exe" -ArgumentList @("server.mjs") -NoNewWindow -PassThru
    $script:CurrentServerProcess = $process
    Write-LauncherLog "server_started" @{ child_pid = $process.Id; restart_count = $script:RestartCount }
    $hardResetRequested = $false
    $exitCode = 0

    try {
        while (-not $script:StopRequested -and -not $process.HasExited) {
            Start-Sleep -Milliseconds 150

            try {
                if ($script:KeyHandlingEnabled) {
                    $key = Read-LauncherKey
                    if (Test-LauncherKey -Key $key -ExpectedKey R -Characters @("r", "R", ([string][char]0x3131))) {
                        $discardedKeys = Clear-ConsoleInputBuffer
                        Write-Host ""
                        Write-Host "[INFO] Full restart requested. Stopping server and clearing the port..."
                        Write-LauncherLog "hard_reset_requested" @{ reason = "keyboard_r"; child_pid = $process.Id; discarded_keys = $discardedKeys }
                        $hardResetRequested = $true
                        Stop-ServerProcess -Process $process
                        Stop-ListeningPort -Port $serverPort
                        break
                    }
                    if (Test-LauncherKey -Key $key -ExpectedKey Q) {
                        $discardedKeys = Clear-ConsoleInputBuffer
                        Write-Host ""
                        Write-Host "[INFO] Stop requested. Stopping server..."
                        Write-LauncherLog "stop_requested" @{ reason = "keyboard_q"; child_pid = $process.Id; discarded_keys = $discardedKeys }
                        $script:StopRequested = $true
                        Stop-ServerProcess -Process $process
                        break
                    }
                }
            }
            catch {
                Start-Sleep -Milliseconds 500
            }
        }

        if ($process.HasExited) {
            $exitCode = $process.ExitCode
        }
    }
    finally {
        Stop-ServerProcess -Process $process
        if ($script:CurrentServerProcess -eq $process) {
            $script:CurrentServerProcess = $null
        }
    }

    if ($script:StopRequested) {
        exit 0
    }

    if ($hardResetRequested) {
        Clear-ConsoleInputBuffer | Out-Null
        Write-Host "[INFO] Full restarting server..."
        continue
    }

    Write-Host "[WARN] Server process exited with code $exitCode."
    Write-Host "[INFO] Keeping launcher alive; full restarting server in 3 seconds. Press Q or Ctrl+C to stop."
    Write-LauncherLog "server_exited_unexpectedly" @{ child_pid = $process.Id; exit_code = $exitCode; restart_count = $script:RestartCount }
    Start-Sleep -Seconds 3
    Stop-ListeningPort -Port $serverPort
    $script:RestartCount += 1
}

exit 0
