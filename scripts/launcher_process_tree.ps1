function Get-MyHarnessProcessTreeIds {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$RootProcessIds
    )

    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $processIds = @($RootProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    do {
        $previousCount = $processIds.Count
        $childIds = @(
            $processes |
                Where-Object {
                    $processIds -contains [int]$_.ParentProcessId -and
                    $processIds -notcontains [int]$_.ProcessId
                } |
                Select-Object -ExpandProperty ProcessId
        )
        $processIds = @($processIds + $childIds | Sort-Object -Unique)
    } while ($processIds.Count -gt $previousCount)

    return $processIds
}

function Stop-MyHarnessProcessTrees {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$RootProcessIds
    )

    $rootIds = @($RootProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($rootIds.Count -eq 0) {
        return @()
    }

    $treeIds = @(Get-MyHarnessProcessTreeIds -RootProcessIds $rootIds)
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
        foreach ($rootId in $rootIds) {
            if ($null -eq (Get-Process -Id $rootId -ErrorAction SilentlyContinue)) {
                continue
            }
            try {
                $taskkillArguments = @("/PID", ([string]$rootId), "/T", "/F")
                & $taskkill @taskkillArguments 2>$null | Out-Null
            }
            catch {
                # The explicit per-PID fallback below handles native kill failures.
            }
        }
    }

    # Catch descendants that appeared while taskkill was running, including
    # children whose launcher parent exited just before the reset began.
    $treeIds = @(
        $treeIds + @(Get-MyHarnessProcessTreeIds -RootProcessIds $rootIds) |
            Sort-Object -Unique
    )
    for ($index = $treeIds.Count - 1; $index -ge 0; $index--) {
        Stop-Process -Id $treeIds[$index] -Force -ErrorAction SilentlyContinue
    }

    return $treeIds
}

function Get-MyHarnessListeningPorts {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$Ports
    )

    $requestedPorts = @($Ports | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    if ($requestedPorts.Count -eq 0) {
        return @()
    }

    return @(
        netstat -ano -p tcp |
            ForEach-Object {
                if ($_ -match "^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+\d+\s*$") {
                    $port = [int]$Matches[1]
                    if ($requestedPorts -contains $port) {
                        $port
                    }
                }
            } |
            Sort-Object -Unique
    )
}

function Wait-MyHarnessRuntimeStopped {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$ProcessIds,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$Ports,
        [int]$TimeoutSeconds = 5
    )

    $trackedProcessIds = @($ProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $runningProcessIds = @(
            $trackedProcessIds |
                Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) }
        )
        $listeningPorts = @(Get-MyHarnessListeningPorts -Ports $Ports)
        if ($runningProcessIds.Count -eq 0 -and $listeningPorts.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    throw (
        "MyHarness cold reset could not fully stop the previous runtime. " +
        "Processes: $($runningProcessIds -join ', '); ports: $($listeningPorts -join ', ')."
    )
}
