function Get-MyHarnessLocalEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $envPath = Join-Path $RepoRoot "myharness.local.env"
    if (-not (Test-Path -LiteralPath $envPath)) {
        return $null
    }

    foreach ($rawLine in [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            continue
        }
        if ($line -match ("^\s*" + [regex]::Escape($Name) + "\s*=\s*(.*?)\s*$")) {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Get-MyHarnessConfiguredPort {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [int]$Fallback = 4174
    )

    $rawPort = $null
    if ($env:MYHARNESS_IGNORE_LOCAL_ENV -ne "1") {
        $rawPort = Get-MyHarnessLocalEnvValue -RepoRoot $RepoRoot -Name "PORT"
    }
    if (-not $rawPort) {
        $rawPort = $env:PORT
    }
    if (-not $rawPort) {
        $rawPort = [string]$Fallback
    }

    $port = 0
    if (-not [int]::TryParse($rawPort, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "Invalid PORT '$rawPort'. Set PORT to a number from 1 to 65535 in myharness.local.env."
    }
    return $port
}
