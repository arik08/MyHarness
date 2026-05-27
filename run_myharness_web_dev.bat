@echo off
setlocal EnableExtensions

title MyHarness Web Dev

cd /d "%~dp0"

set "MYHARNESS_LOCAL_ENV=%CD%\myharness.local.env"
if exist "%MYHARNESS_LOCAL_ENV%" call :load_local_env "%MYHARNESS_LOCAL_ENV%"

if "%PORT%"=="" set "PORT=4273"
if "%MYHARNESS_DEV_PORT%"=="" (
  if "%MYHARNESS_WEB_PORT%"=="" (
    if "%VITE_PORT%"=="" (
      set "MYHARNESS_DEV_PORT=4173"
    ) else (
      set "MYHARNESS_DEV_PORT=%VITE_PORT%"
    )
  ) else (
    set "MYHARNESS_DEV_PORT=%MYHARNESS_WEB_PORT%"
  )
)
set "MYHARNESS_WEB_PORT=%MYHARNESS_DEV_PORT%"
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%MYHARNESS_CONFIG_DIR%"=="" set "MYHARNESS_CONFIG_DIR=%CD%\.myharness"
if "%MYHARNESS_DATA_DIR%"=="" set "MYHARNESS_DATA_DIR=%MYHARNESS_CONFIG_DIR%\data"
if "%MYHARNESS_LOGS_DIR%"=="" set "MYHARNESS_LOGS_DIR=%MYHARNESS_CONFIG_DIR%\logs"
set "MYHARNESS_HOME=%MYHARNESS_CONFIG_DIR%"
set "MYHARNESS_SETTINGS=%MYHARNESS_CONFIG_DIR%\settings.json"

call :configure_posco_cert

echo.
echo ============================================================
echo   MyHarness Web Dev
echo ============================================================
echo.
echo   Preferred React dev UI: http://127.0.0.1:%MYHARNESS_DEV_PORT%
echo   Backend/dev entry: http://localhost:%PORT%
echo   Other PCs: use http://THIS_PC_IP:%PORT% to enter dev mode
echo   Config:       %MYHARNESS_CONFIG_DIR%
echo   Logs:         %MYHARNESS_LOGS_DIR%
echo.
echo   This starts both the backend server and Vite HMR dev server.
echo   Backend PORT must be unique. If the preferred React port is unavailable, the launcher will pick another port.
echo   Open the React dev UI URL printed below while developing.
echo   Press Q or Ctrl+C in this window to stop both servers.
echo   Press R in this window to restart both servers.
echo   Press T in this window to hard reset both servers.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js or open this from a terminal where node is available.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Install Node.js with npm, or open this from a terminal where npm is available.
  echo.
  pause
  exit /b 1
)

echo [INFO] Preparing project-local runtime directories...
if not exist "%MYHARNESS_CONFIG_DIR%" mkdir "%MYHARNESS_CONFIG_DIR%"
if not exist "%MYHARNESS_DATA_DIR%" mkdir "%MYHARNESS_DATA_DIR%"
if not exist "%MYHARNESS_LOGS_DIR%" mkdir "%MYHARNESS_LOGS_DIR%"
if not exist "Playground" mkdir "Playground"
if not exist "Playground\Default" mkdir "Playground\Default"
if not exist "Playground\shared\Default" mkdir "Playground\shared\Default"
if not exist "%MYHARNESS_SETTINGS%" (
  > "%MYHARNESS_SETTINGS%" echo {
  >> "%MYHARNESS_SETTINGS%" echo   "active_profile": "p-gpt"
  >> "%MYHARNESS_SETTINGS%" echo }
)

echo [INFO] Checking Python package dependencies...
set "PYTHONPATH=%CD%\src;%PYTHONPATH%"
call :find_bootstrap_python
if errorlevel 1 (
  echo [ERROR] No usable Python 3.10+ was found.
  echo Tried MYHARNESS_PYTHON, PYTHON, python, and python3.
  echo Install Python 3.10+ or run Installer.bat after setting MYHARNESS_PYTHON.
  echo.
  pause
  exit /b 1
)
echo [INFO] Using Python: %MYHARNESS_BOOTSTRAP_PYTHON% %MYHARNESS_BOOTSTRAP_PYTHON_ARGS%

call :select_default_provider_profile
if /i "%MYHARNESS_SELECTED_PROFILE%"=="p-gpt" (
  call :ensure_pgpt_env
) else (
  echo [INFO] Codex OAuth is available. Skipping P-GPT environment setup.
)

call :upgrade_posco_bundle
if errorlevel 1 (
  echo.
  echo [ERROR] POSCO CA bundle setup failed.
  pause
  exit /b 1
)

"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import importlib.util, sys; required=['myharness','anthropic','openai','tiktoken','rich','prompt_toolkit','textual','typer','pydantic','httpx','feedparser','mcp','pyperclip','yaml','questionary','watchfiles','croniter']; missing=[name for name in required if importlib.util.find_spec(name) is None]; sys.exit(1 if missing else 0)" >nul 2>nul
if errorlevel 1 (
  echo [INFO] Missing Python dependencies detected. Installing now...
  "%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -m pip install -e .
  if errorlevel 1 (
    echo.
    echo [ERROR] Python dependency installation failed.
    echo Run Installer.bat and try again.
    pause
    exit /b 1
  )
) else (
  echo [INFO] Python dependencies are already available.
)

if not exist "frontend\web\node_modules\.package-lock.json" (
  echo [INFO] Missing web dependencies detected. Installing now...
  pushd "frontend\web"
  if exist "package-lock.json" (
    call npm ci
    if errorlevel 1 (
      echo [WARN] npm ci failed. Retrying with npm install...
      call npm install
    )
  ) else (
    call npm install
  )
  if errorlevel 1 (
    popd
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  popd
) else (
  echo [INFO] Web dependencies are already available.
)

call :free_port "%PORT%" "backend"
if errorlevel 1 exit /b 1

echo [INFO] Starting development servers...
echo.

pushd "frontend\web"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_myharness_web_dev.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo.
echo [INFO] Dev servers stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:free_port
set "CHECK_PORT=%~1"
set "PORT_LABEL=%~2"
set "MYHARNESS_PORT_PID="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort ([int]'%CHECK_PORT%') -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { Write-Output $conn.OwningProcess }"`) do (
  set "MYHARNESS_PORT_PID=%%A"
)
if "%MYHARNESS_PORT_PID%"=="" exit /b 0
echo [INFO] Port %CHECK_PORT% for %PORT_LABEL% is already in use by PID %MYHARNESS_PORT_PID%.
echo [INFO] Closing the existing process and starting MyHarness fresh...
taskkill /PID %MYHARNESS_PORT_PID% /T /F >nul 2>nul
timeout /t 1 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort ([int]'%CHECK_PORT%') -State Listen -ErrorAction SilentlyContinue) { exit 0 } exit 1" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo [ERROR] Port %CHECK_PORT% is still in use after trying to close PID %MYHARNESS_PORT_PID%.
  pause
  exit /b 1
)
exit /b 0

:load_local_env
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~1") do (
  if not "%%~A"=="" if not "%%~B"=="" if not defined %%~A set "%%~A=%%~B"
)
exit /b 0

:find_bootstrap_python
set "MYHARNESS_BOOTSTRAP_PYTHON="
set "MYHARNESS_BOOTSTRAP_PYTHON_ARGS="
if not "%MYHARNESS_PYTHON%"=="" (
  call :try_bootstrap_python "%MYHARNESS_PYTHON%" ""
  if not errorlevel 1 exit /b 0
)
if not "%PYTHON%"=="" (
  call :try_bootstrap_python "%PYTHON%" ""
  if not errorlevel 1 exit /b 0
)
call :try_bootstrap_python "python" ""
if not errorlevel 1 exit /b 0
call :try_bootstrap_python "python3" ""
if not errorlevel 1 exit /b 0
exit /b 1

:try_bootstrap_python
set "PY_CANDIDATE=%~1"
set "PY_CANDIDATE_ARGS=%~2"
"%PY_CANDIDATE%" %PY_CANDIDATE_ARGS% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 exit /b 1
set "MYHARNESS_BOOTSTRAP_PYTHON=%PY_CANDIDATE%"
set "MYHARNESS_BOOTSTRAP_PYTHON_ARGS=%PY_CANDIDATE_ARGS%"
exit /b 0

:configure_posco_cert
if not exist "C:\POSCO_CA.crt" exit /b 0
set "POSCO_CA_CERT=C:\POSCO_CA.crt"
set "POSCO_CA_BUNDLE=%CD%\certs\posco-ca-bundle.pem"
if exist "%POSCO_CA_BUNDLE%" (
  set "SSL_CERT_FILE=%POSCO_CA_BUNDLE%"
  set "REQUESTS_CA_BUNDLE=%POSCO_CA_BUNDLE%"
  set "CURL_CA_BUNDLE=%POSCO_CA_BUNDLE%"
  set "PIP_CERT=%POSCO_CA_BUNDLE%"
)
set "NODE_EXTRA_CA_CERTS=C:\POSCO_CA.crt"
set "npm_config_cafile=C:\POSCO_CA.crt"
if "%NODE_OPTIONS%"=="" (
  set "NODE_OPTIONS=--tls-cipher-list=DEFAULT@SECLEVEL=1"
) else (
  set "NODE_OPTIONS=--tls-cipher-list=DEFAULT@SECLEVEL=1 %NODE_OPTIONS%"
)
echo [INFO] POSCO certificate detected: C:\POSCO_CA.crt
echo [INFO] Node TLS compatibility mode enabled for POSCO CA.
exit /b 0

:upgrade_posco_bundle
if not exist "C:\POSCO_CA.crt" exit /b 0
echo [INFO] Building POSCO Python CA bundle...
"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% "%CD%\scripts\build_posco_ca_bundle.py"
if errorlevel 1 exit /b 1
set "POSCO_CA_BUNDLE=%CD%\certs\posco-ca-bundle.pem"
set "SSL_CERT_FILE=%POSCO_CA_BUNDLE%"
set "REQUESTS_CA_BUNDLE=%POSCO_CA_BUNDLE%"
set "CURL_CA_BUNDLE=%POSCO_CA_BUNDLE%"
set "PIP_CERT=%POSCO_CA_BUNDLE%"
set "NODE_EXTRA_CA_CERTS=C:\POSCO_CA.crt"
set "npm_config_cafile=C:\POSCO_CA.crt"
exit /b 0

:select_default_provider_profile
set "MYHARNESS_SELECTED_PROFILE="
for /f "usebackq delims=" %%P in (`"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% "%CD%\scripts\select_default_provider_profile.py" --settings "%MYHARNESS_SETTINGS%" 2^>nul`) do (
  set "MYHARNESS_SELECTED_PROFILE=%%P"
)
if "%MYHARNESS_SELECTED_PROFILE%"=="" (
  set "MYHARNESS_SELECTED_PROFILE=p-gpt"
  echo [WARN] Could not auto-select provider profile. Falling back to P-GPT.
)
echo [INFO] Default provider profile: %MYHARNESS_SELECTED_PROFILE%
exit /b 0

:ensure_pgpt_env
if exist "%MYHARNESS_CONFIG_DIR%\credentials.json" (
  for /f "usebackq tokens=1,* delims==" %%A in (`"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import json, os; from pathlib import Path; p=Path(os.environ.get('MYHARNESS_CONFIG_DIR') or '.myharness')/'credentials.json'; data=json.loads(p.read_text(encoding='utf-8')); pgpt=data.get('pgpt') if isinstance(data.get('pgpt'), dict) else {}; print('PGPT_API_KEY=' + str(pgpt.get('api_key') or '')); print('PGPT_EMPLOYEE_NO=' + str(pgpt.get('employee_no') or pgpt.get('system_code') or '')); print('PGPT_COMPANY_CODE=' + str(pgpt.get('company_code') or ''))" 2^>nul`) do (
    if not "%%~B"=="" set "%%~A=%%~B"
  )
)
set "PGPT_ENV_MISSING="
if "%PGPT_API_KEY%"=="" set "PGPT_ENV_MISSING=1"
if "%PGPT_EMPLOYEE_NO%"=="" set "PGPT_ENV_MISSING=1"
if "%PGPT_ENV_MISSING%"=="" exit /b 0

echo.
echo [INFO] P-GPT credentials are not fully configured.
echo        Required for P-GPT: PGPT_API_KEY, PGPT_EMPLOYEE_NO
echo        Saved credentials are also read from %MYHARNESS_CONFIG_DIR%\credentials.json
echo        Leave PGPT_API_KEY empty to skip this setup.
echo.
echo.
echo [INFO] Values entered here will be saved to this project's .myharness\credentials.json
echo        and to your Windows user environment with setx.
echo.
if not "%PGPT_API_KEY%"=="" goto pgpt_employee_no
set "PGPT_API_KEY_INPUT="
set /p "PGPT_API_KEY_INPUT=PGPT_API_KEY: "
if "%PGPT_API_KEY_INPUT%"=="" (
  echo [INFO] Skipping P-GPT environment setup.
  exit /b 0
)
set "PGPT_API_KEY=%PGPT_API_KEY_INPUT%"
setx PGPT_API_KEY "%PGPT_API_KEY_INPUT%" >nul
if errorlevel 1 echo [WARN] Failed to permanently save PGPT_API_KEY with setx.

:pgpt_employee_no
if not "%PGPT_EMPLOYEE_NO%"=="" goto pgpt_env_done
set "PGPT_EMPLOYEE_NO_INPUT="
set /p "PGPT_EMPLOYEE_NO_INPUT=PGPT_EMPLOYEE_NO: "
if "%PGPT_EMPLOYEE_NO_INPUT%"=="" (
  echo [INFO] Skipping P-GPT environment setup.
  exit /b 0
)
set "PGPT_EMPLOYEE_NO=%PGPT_EMPLOYEE_NO_INPUT%"
setx PGPT_EMPLOYEE_NO "%PGPT_EMPLOYEE_NO_INPUT%" >nul
if errorlevel 1 echo [WARN] Failed to permanently save PGPT_EMPLOYEE_NO with setx.

:pgpt_env_done
call :save_pgpt_credentials
echo [INFO] P-GPT environment setup finished.
exit /b 0

:save_pgpt_credentials
if "%PGPT_API_KEY%"=="" exit /b 0
if "%PGPT_EMPLOYEE_NO%"=="" exit /b 0
"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import json, os; from pathlib import Path; p=Path(os.environ.get('MYHARNESS_CONFIG_DIR') or '.myharness')/'credentials.json'; data=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}; pgpt=data.get('pgpt') if isinstance(data.get('pgpt'), dict) else {}; values={'api_key': os.environ.get('PGPT_API_KEY','').strip(), 'employee_no': os.environ.get('PGPT_EMPLOYEE_NO','').strip(), 'company_code': os.environ.get('PGPT_COMPANY_CODE','').strip() or '30'}; pgpt.update({k:v for k,v in values.items() if v}); data['pgpt']=pgpt; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')" >nul 2>nul
exit /b 0
