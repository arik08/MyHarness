$ErrorActionPreference = "Stop"
$script:StopRequested = $false
$script:CurrentServerProcess = $null
$script:RestartCount = 0
$script:KeyHandlingEnabled = $env:MYHARNESS_SERVER_KEY_HANDLING -ne "0"
$script:LogDirectory = if ($env:MYHARNESS_LOGS_DIR) { $env:MYHARNESS_LOGS_DIR } else { Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".myharness\logs" }
$script:LauncherLog = Join-Path $script:LogDirectory "myharness-web-launcher.log"
$script:FrontendWebDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\frontend\web"))
. (Join-Path $PSScriptRoot "local_env.ps1")
. (Join-Path $PSScriptRoot "launcher_process_tree.ps1")

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

function Open-LauncherLock {
    param([Parameter(Mandatory = $true)][int]$Port)

    if (-not (Test-Path -LiteralPath $script:LogDirectory)) {
        New-Item -ItemType Directory -Path $script:LogDirectory -Force | Out-Null
    }
    $lockPath = Join-Path $script:LogDirectory "server-$Port.lock"
    try {
        return [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch [System.IO.IOException] {
        Write-Host "[INFO] Another MyHarness backend supervisor already owns port $serverPort. Exiting this duplicate launcher."
        Write-LauncherLog "duplicate_server_supervisor" @{ port = $serverPort }
        exit 0
    }
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $processIds = @(Stop-MyHarnessProcessTrees -RootProcessIds @($ProcessId))
    Wait-MyHarnessRuntimeStopped -ProcessIds $processIds -Ports @()
}

function Stop-ListeningPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $ownerPid = netstat -ano -p tcp |
        ForEach-Object {
            if ($_ -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
                $Matches[1]
            }
        } |
        Select-Object -First 1
    if (-not $ownerPid) {
        return
    }

    $ownerPid = [int]$ownerPid
    if ($ownerPid -eq $PID) {
        return
    }

    Write-Host "[INFO] Port $Port is already in use by PID $ownerPid. Closing the existing process and starting fresh..."
    Write-LauncherLog "port_process_closing" @{ port = $Port; owner_pid = $ownerPid }
    Stop-ProcessTree -ProcessId $ownerPid
    Start-Sleep -Milliseconds 500

    $stillListening = netstat -ano -p tcp |
        Where-Object { $_ -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+\d+\s*$") } |
        Select-Object -First 1
    if ($stillListening) {
        throw "Port $Port is still in use after trying to close PID $ownerPid."
    }
}

function Stop-ServerProcess {
    param([Parameter(Mandatory = $true)]$Process)

    $processIds = @(Stop-MyHarnessProcessTrees -RootProcessIds @([int]$Process.Id))
    Wait-MyHarnessRuntimeStopped -ProcessIds $processIds -Ports @($serverPort)
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

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverPort = Get-MyHarnessConfiguredPort -RepoRoot $repoRoot
$env:PORT = [string]$serverPort
$script:LauncherLock = Open-LauncherLock -Port $serverPort

while (-not $script:StopRequested) {
    Stop-ListeningPort -Port $serverPort
    Write-Host "[INFO] Starting node server.mjs..."
    Write-LauncherLog "server_starting" @{ restart_count = $script:RestartCount }
    $process = Start-Process -FilePath "node.exe" -ArgumentList @("server.mjs") -WorkingDirectory $script:FrontendWebDirectory -NoNewWindow -PassThru
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
