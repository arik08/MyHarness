@echo off
setlocal

title OpenHarness Installer

cd /d "%~dp0"

set "OPENHARNESS_HOME=%USERPROFILE%\.openharness"
set "OPENHARNESS_VENV=%OPENHARNESS_HOME%\venv"
set "OPENHARNESS_DATA_DIR=%OPENHARNESS_HOME%\data"
set "OPENHARNESS_LOGS_DIR=%OPENHARNESS_HOME%\logs"

echo.
echo ============================================================
echo   OpenHarness Installer
echo ============================================================
echo.
echo   Project: %CD%
echo   User home data: %OPENHARNESS_HOME%
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python launcher py.exe was not found on PATH.
  echo Install Python 3.10+ first, then run this installer again.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js LTS first, then run this installer again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Install Node.js with npm first, then run this installer again.
  echo.
  pause
  exit /b 1
)

echo [INFO] Preparing user directories...
if not exist "%OPENHARNESS_HOME%" mkdir "%OPENHARNESS_HOME%"
if not exist "%OPENHARNESS_DATA_DIR%" mkdir "%OPENHARNESS_DATA_DIR%"
if not exist "%OPENHARNESS_DATA_DIR%\memory" mkdir "%OPENHARNESS_DATA_DIR%\memory"
if not exist "%OPENHARNESS_DATA_DIR%\sessions" mkdir "%OPENHARNESS_DATA_DIR%\sessions"
if not exist "%OPENHARNESS_DATA_DIR%\tasks" mkdir "%OPENHARNESS_DATA_DIR%\tasks"
if not exist "%OPENHARNESS_LOGS_DIR%" mkdir "%OPENHARNESS_LOGS_DIR%"

if not exist "%OPENHARNESS_VENV%\Scripts\python.exe" (
  echo [INFO] Creating Python virtual environment...
  py -3 -m venv "%OPENHARNESS_VENV%"
  if errorlevel 1 (
    echo.
    echo [ERROR] Failed to create Python virtual environment.
    pause
    exit /b 1
  )
)

echo [INFO] Upgrading pip...
call "%OPENHARNESS_VENV%\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to upgrade pip.
  pause
  exit /b 1
)

echo [INFO] Installing OpenHarness Python package...
call "%OPENHARNESS_VENV%\Scripts\python.exe" -m pip install -e .
if errorlevel 1 (
  echo.
  echo [ERROR] Python package installation failed.
  pause
  exit /b 1
)

echo [INFO] Installing web dependencies...
pushd "frontend\web"
if exist "package-lock.json" (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  popd
  echo.
  echo [ERROR] Web dependency installation failed.
  pause
  exit /b 1
)
popd

echo.
echo [OK] OpenHarness is installed for this Windows user.
echo.
echo   Config: %OPENHARNESS_HOME%\settings.json
echo   Data:   %OPENHARNESS_DATA_DIR%
echo   Logs:   %OPENHARNESS_LOGS_DIR%
echo   Venv:   %OPENHARNESS_VENV%
echo.
echo Run:
echo   run_openharness_web.bat
echo.
pause
exit /b 0
