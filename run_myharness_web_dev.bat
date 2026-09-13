@echo off
chcp 65001 >nul
setlocal EnableExtensions

title MyHarness Web Dev

cd /d "%~dp0"

set "MYHARNESS_LOCAL_ENV=%CD%\myharness.local.env"
if exist "%MYHARNESS_LOCAL_ENV%" call :load_local_env "%MYHARNESS_LOCAL_ENV%"
set "MYHARNESS_API_KEY_ENV=%CD%\API_KEY.env"
if exist "%MYHARNESS_API_KEY_ENV%" call :load_local_env "%MYHARNESS_API_KEY_ENV%"

if "%PORT%"=="" set "PORT=4174"
if "%MYHARNESS_DEV_PORT%"=="" (
  if "%MYHARNESS_WEB_PORT%"=="" (
    if "%VITE_PORT%"=="" (
      set "MYHARNESS_DEV_PORT=auto"
    ) else (
      set "MYHARNESS_DEV_PORT=%VITE_PORT%"
    )
  ) else (
    set "MYHARNESS_DEV_PORT=%MYHARNESS_WEB_PORT%"
  )
)
if /I "%MYHARNESS_DEV_PORT%"=="auto" set /A MYHARNESS_DEV_PORT=PORT+100
set "MYHARNESS_WEB_PORT=%MYHARNESS_DEV_PORT%"
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%MYHARNESS_CONFIG_DIR%"=="" set "MYHARNESS_CONFIG_DIR=%CD%\.myharness"
if "%MYHARNESS_DATA_DIR%"=="" set "MYHARNESS_DATA_DIR=%MYHARNESS_CONFIG_DIR%\data"
if "%MYHARNESS_LOGS_DIR%"=="" set "MYHARNESS_LOGS_DIR=%MYHARNESS_CONFIG_DIR%\logs"
set "MYHARNESS_HOME=%MYHARNESS_CONFIG_DIR%"
set "MYHARNESS_SETTINGS=%MYHARNESS_CONFIG_DIR%\settings.json"
set "MYHARNESS_DISABLE_KEYRING=1"

call :configure_posco_cert

echo.
echo [시작] MyHarness 개발 서버 준비 중...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js를 찾을 수 없습니다.
  echo Node.js 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [오류] npm을 찾을 수 없습니다.
  echo npm이 포함된 Node.js를 설치하세요.
  echo.
  pause
  exit /b 1
)

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

set "PYTHONPATH=%CD%\src;%PYTHONPATH%"
call :find_bootstrap_python
if errorlevel 1 (
  echo [오류] Python 3.10 이상을 찾을 수 없습니다.
  echo MYHARNESS_PYTHON 또는 Python 설치 경로를 확인하세요.
  echo Python 설치 후 Installer.bat을 실행하세요.
  echo.
  pause
  exit /b 1
)

call :select_default_provider_profile
if /i "%MYHARNESS_SELECTED_PROFILE%"=="p-gpt" (
  call :ensure_pgpt_env
)

call :upgrade_posco_bundle
if errorlevel 1 (
  echo.
  echo [오류] POSCO 인증서 설정에 실패했습니다.
  pause
  exit /b 1
)

"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import importlib.util, sys; required=['myharness','anthropic','openai','tiktoken','rich','prompt_toolkit','textual','typer','pydantic','httpx','feedparser','mcp','pyperclip','yaml','questionary','watchfiles','croniter']; missing=[name for name in required if importlib.util.find_spec(name) is None]; sys.exit(1 if missing else 0)" >nul 2>nul
if errorlevel 1 (
  echo [안내] 필요한 Python 패키지를 설치합니다...
  "%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -m pip install -e .
  if errorlevel 1 (
    echo.
    echo [오류] Python 패키지 설치에 실패했습니다.
    echo Installer.bat 실행 후 다시 시도하세요.
    pause
    exit /b 1
  )
)

if not exist "frontend\web\node_modules\.package-lock.json" (
  echo [안내] 필요한 웹 패키지를 설치합니다...
  pushd "frontend\web"
  if exist "package-lock.json" (
    call npm ci
    if errorlevel 1 (
      echo [주의] npm ci 실패 · npm install로 재시도합니다...
      call npm install
    )
  ) else (
    call npm install
  )
  if errorlevel 1 (
    popd
    echo.
    echo [오류] 웹 패키지 설치에 실패했습니다.
    pause
    exit /b 1
  )
  popd
)

echo.

pushd "frontend\web"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_myharness_web_dev.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo.
echo [안내] 개발 서버가 종료되었습니다. 코드: %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:load_local_env
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~1") do (
  if not "%%~A"=="" if not "%%~B"=="" set "%%~A=%%~B"
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
call :try_bootstrap_python "py" "-3"
if not errorlevel 1 exit /b 0
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
"%PY_CANDIDATE%" %PY_CANDIDATE_ARGS% -m pip --version >nul 2>nul
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
exit /b 0

:upgrade_posco_bundle
if not exist "C:\POSCO_CA.crt" exit /b 0
echo [안내] POSCO 인증서를 준비합니다...
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
for /f "usebackq delims=" %%P in (`""%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% "%CD%\scripts\select_default_provider_profile.py" --settings "%MYHARNESS_SETTINGS%" 2>"%MYHARNESS_LOGS_DIR%\provider-setup.log""`) do (
  set "MYHARNESS_SELECTED_PROFILE=%%P"
)
if "%MYHARNESS_SELECTED_PROFILE%"=="" (
  set "MYHARNESS_SELECTED_PROFILE=p-gpt"
  echo [주의] 기본 모델 설정 실패 · 상세: %MYHARNESS_LOGS_DIR%\provider-setup.log
)
exit /b 0

:ensure_pgpt_env
if exist "%MYHARNESS_CONFIG_DIR%\credentials.json" (
  for /f "usebackq tokens=1,* delims==" %%A in (`"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import json, os; from pathlib import Path; p=Path(os.environ.get('MYHARNESS_CONFIG_DIR') or '.myharness')/'credentials.json'; data=json.loads(p.read_text(encoding='utf-8')); pgpt=data.get('pgpt') if isinstance(data.get('pgpt'), dict) else {}; print('PGPT_API_KEY=' + str(pgpt.get('api_key') or '')); print('PGPT_EMPLOYEE_NO=' + str(pgpt.get('employee_no') or pgpt.get('system_code') or '')); print('PGPT_COMPANY_CODE=' + str(pgpt.get('company_code') or ''))" 2^>nul`) do (
    if not "%%~B"=="" if not defined %%~A set "%%~A=%%~B"
  )
)
set "PGPT_ENV_MISSING="
if "%PGPT_API_KEY%"=="" set "PGPT_ENV_MISSING=1"
if "%PGPT_EMPLOYEE_NO%"=="" set "PGPT_ENV_MISSING=1"
if "%PGPT_ENV_MISSING%"=="" exit /b 0

echo.
echo [안내] P-GPT 인증 정보가 필요합니다.
echo        필수 항목: PGPT_API_KEY, PGPT_EMPLOYEE_NO
echo        저장 위치: %MYHARNESS_CONFIG_DIR%\credentials.json
echo        PGPT_API_KEY를 비워 두면 건너뜁니다.
echo.
echo.
echo [안내] 입력값은 .myharness\credentials.json 및
echo        Windows 사용자 환경 변수에 저장됩니다.
echo.
if not "%PGPT_API_KEY%"=="" goto pgpt_employee_no
set "PGPT_API_KEY_INPUT="
set /p "PGPT_API_KEY_INPUT=PGPT_API_KEY: "
if "%PGPT_API_KEY_INPUT%"=="" (
  echo [안내] P-GPT 설정을 건너뜁니다.
  exit /b 0
)
set "PGPT_API_KEY=%PGPT_API_KEY_INPUT%"
setx PGPT_API_KEY "%PGPT_API_KEY_INPUT%" >nul
if errorlevel 1 echo [주의] PGPT_API_KEY 환경 변수 저장 실패.

:pgpt_employee_no
if not "%PGPT_EMPLOYEE_NO%"=="" goto pgpt_env_done
set "PGPT_EMPLOYEE_NO_INPUT="
set /p "PGPT_EMPLOYEE_NO_INPUT=PGPT_EMPLOYEE_NO: "
if "%PGPT_EMPLOYEE_NO_INPUT%"=="" (
  echo [안내] P-GPT 설정을 건너뜁니다.
  exit /b 0
)
set "PGPT_EMPLOYEE_NO=%PGPT_EMPLOYEE_NO_INPUT%"
setx PGPT_EMPLOYEE_NO "%PGPT_EMPLOYEE_NO_INPUT%" >nul
if errorlevel 1 echo [주의] PGPT_EMPLOYEE_NO 환경 변수 저장 실패.

:pgpt_env_done
call :save_pgpt_credentials
echo [안내] P-GPT 설정 완료.
exit /b 0

:save_pgpt_credentials
if "%PGPT_API_KEY%"=="" exit /b 0
if "%PGPT_EMPLOYEE_NO%"=="" exit /b 0
"%MYHARNESS_BOOTSTRAP_PYTHON%" %MYHARNESS_BOOTSTRAP_PYTHON_ARGS% -c "import json, os; from pathlib import Path; p=Path(os.environ.get('MYHARNESS_CONFIG_DIR') or '.myharness')/'credentials.json'; data=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}; pgpt=data.get('pgpt') if isinstance(data.get('pgpt'), dict) else {}; values={'api_key': os.environ.get('PGPT_API_KEY','').strip(), 'employee_no': os.environ.get('PGPT_EMPLOYEE_NO','').strip(), 'company_code': os.environ.get('PGPT_COMPANY_CODE','').strip() or '30'}; pgpt.update({k:v for k,v in values.items() if v}); data['pgpt']=pgpt; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')" >nul 2>nul
exit /b 0
