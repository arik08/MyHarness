param(
    [string]$Url = "http://127.0.0.1:5173",
    [string]$WaitForSelector = "body",
    [string]$ViewportSize = "1366,768",
    [switch]$Headed,
    [int]$TimeoutMs = 30000
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$checksRoot = Join-Path $repoRoot ".myharness\ui-checks"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$runName = "run-$timestamp-$suffix"
$runRoot = Join-Path $checksRoot $runName
$profileRoot = Join-Path $checksRoot "profiles\$runName"
$testPath = Join-Path $runRoot "ui-check.spec.mjs"
$stdoutPath = Join-Path $runRoot "playwright.out.log"
$stderrPath = Join-Path $runRoot "playwright.err.log"

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null

$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }
if (-not $npm) {
    $npmCommand = Get-Command "npm" -ErrorAction SilentlyContinue
    $npm = if ($npmCommand) { $npmCommand.Source } else { $null }
}
if (-not $npm) {
    throw "npm was not found on PATH."
}

$testSource = @'
import { chromium, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.MYHARNESS_UI_CHECK_URL;
const waitForSelector = process.env.MYHARNESS_UI_CHECK_WAIT_FOR_SELECTOR || "body";
const profileDir = process.env.MYHARNESS_UI_CHECK_PROFILE_DIR;
const runDir = process.env.MYHARNESS_UI_CHECK_RUN_DIR;
const headed = process.env.MYHARNESS_UI_CHECK_HEADED === "1";
const timeoutMs = Number(process.env.MYHARNESS_UI_CHECK_TIMEOUT_MS || "30000");
const [width, height] = (process.env.MYHARNESS_UI_CHECK_VIEWPORT || "1366,768")
  .split(",")
  .map((part) => Number(part.trim()));

test("isolated UI smoke check", async () => {
  const consoleMessages = [];
  const pageErrors = [];
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: { width, height },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.on("console", (message) => {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    });
    page.on("pageerror", (error) => {
      pageErrors.push({ message: error.message, stack: error.stack || "" });
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
    await page.screenshot({ path: path.join(runDir, "screenshot.png"), fullPage: true });
    await writeFile(
      path.join(runDir, "console.json"),
      JSON.stringify({ consoleMessages, pageErrors }, null, 2),
      "utf8",
    );

    const seriousConsole = consoleMessages.filter((message) =>
      ["error", "warning"].includes(message.type),
    );
    if (pageErrors.length || seriousConsole.length) {
      throw new Error(
        `UI check found ${pageErrors.length} page errors and ${seriousConsole.length} console warnings/errors.`,
      );
    }
  } finally {
    await context.close();
  }
});
'@

Set-Content -Path $testPath -Value $testSource -Encoding UTF8

$env:MYHARNESS_UI_CHECK_URL = $Url
$env:MYHARNESS_UI_CHECK_WAIT_FOR_SELECTOR = $WaitForSelector
$env:MYHARNESS_UI_CHECK_PROFILE_DIR = $profileRoot
$env:MYHARNESS_UI_CHECK_RUN_DIR = $runRoot
$env:MYHARNESS_UI_CHECK_HEADED = if ($Headed) { "1" } else { "0" }
$env:MYHARNESS_UI_CHECK_TIMEOUT_MS = [string]$TimeoutMs
$env:MYHARNESS_UI_CHECK_VIEWPORT = $ViewportSize

$arguments = @(
    "exec",
    "--yes",
    "--package",
    "@playwright/test",
    "--",
    "playwright",
    "test",
    "ui-check.spec.mjs",
    "--reporter=line"
)

$process = Start-Process -FilePath $npm `
    -ArgumentList $arguments `
    -WorkingDirectory $runRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -NoNewWindow `
    -PassThru `
    -Wait

Write-Host "[INFO] UI check run: $runRoot"
Write-Host "[INFO] Isolated profile: $profileRoot"
Write-Host "[INFO] Screenshot: $(Join-Path $runRoot "screenshot.png")"
Write-Host "[INFO] Console log: $(Join-Path $runRoot "console.json")"

if ($process.ExitCode -ne 0) {
    Write-Host "[ERROR] Playwright exited with code $($process.ExitCode)."
    Write-Host "[ERROR] stdout: $stdoutPath"
    Write-Host "[ERROR] stderr: $stderrPath"
    exit $process.ExitCode
}

exit 0
