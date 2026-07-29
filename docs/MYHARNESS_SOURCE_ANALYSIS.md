# MyHarness 소스코드 상세 분석

작성일: 2026-06-11

## 1. 전체 성격

MyHarness는 OpenHarness 계열의 Python agent runtime을 기반으로, 사내 업무 사용자가 브라우저에서 AI Agent를 쉽게 실행하고 관찰할 수 있도록 확장한 애플리케이션입니다. 단순 CLI 도구가 아니라, 다음 세 축이 함께 움직이는 통합 시스템입니다.

- Python agent runtime: 모델 호출, 도구 실행, 권한 검사, 세션/상태 저장, MCP, 스킬, 플러그인, hook을 담당합니다.
- Node 웹 서버: React 정적 UI 제공, 워크스페이스/세션/산출물 API 제공, Python backend session 프로세스 관리, SSE streaming 중계를 담당합니다.
- React 웹 UI: 채팅, 워크플로우 타임라인, 산출물 미리보기, 설정, 워크스페이스/히스토리, 도움말/모달, 스킬/MCP/plugin 선택 UX를 담당합니다.

실행 관점에서는 `run_myharness_web.bat` 또는 `run_myharness_web_dev.bat`가 Windows 환경을 준비하고, `frontend/web/server.mjs`가 웹 진입점이 되며, 실제 agent 대화는 `src/myharness/ui/runtime.py`가 조립한 `QueryEngine`을 통해 흘러갑니다.

## 2. 저장소 구조

주요 디렉터리의 역할은 다음과 같습니다.

| 경로 | 역할 |
|---|---|
| `src/myharness/` | Python agent runtime 본체 |
| `frontend/web/` | React UI, Node web server, frontend tests |
| `frontend/terminal/` | 패키징 대상 terminal frontend 자산 |
| `.myharness/` | 프로젝트-local 설정, 인증, 데이터, 로그 |
| `.skills/` | 프로그램 수준 MyHarness skill |
| `.mcp/` | 프로그램 수준 MCP 설정 및 일부 MCP server 구현 |
| `.plugins/` | 프로그램 수준 plugin |
| `Playground/` | 사용자가 선택하는 workspace 및 생성 산출물 위치 |
| `tests/` | Python runtime 단위/통합 테스트 |
| `scripts/` | 설치, 런처, 검증, E2E, UTF-8 guard 등 운영 스크립트 |

패키징은 `pyproject.toml`의 `hatchling` 설정을 따릅니다. Python 패키지는 `src/myharness`이고, 빌드 시 `frontend/web/dist`, `frontend/web/server.mjs`, web package metadata, terminal frontend 일부가 wheel 안의 `_web`, `_frontend` 자원으로 포함됩니다.

## 3. 실행 진입점

### 3.1 Python CLI

`pyproject.toml`은 다음 console script를 등록합니다.

- `myharness = myharness.cli:app`
- `myh = myharness.cli:app`
- `oh = myharness.cli:app`

`src/myharness/cli.py`는 Typer 기반 CLI 진입점입니다. CLI는 단순 실행 명령만 갖는 것이 아니라, slash command dry-run, MCP 설정 진단, skill/tool/command 추천, auth/provider 관련 보조 기능까지 포함합니다. 따라서 CLI 수정은 Textual/터미널 UX뿐 아니라 web backend host가 의존하는 상태/명령 처리에도 영향을 줄 수 있습니다.

### 3.2 Windows 런처

루트의 `Installer.bat`, `run_myharness_web.bat`, `run_myharness_web_dev.bat`와 `scripts/run_myharness_web_server.ps1`, `scripts/run_myharness_web_dev.ps1`이 Windows 배포/실행을 담당합니다.

현재 README 기준으로 일반 실행은 `http://localhost:4273`, 개발 UI는 `http://127.0.0.1:4173`을 사용합니다. 런처는 프로젝트-local `.myharness/` 폴더를 기본 설정/데이터 위치로 사용하므로, 사용자 홈 설정과 섞이지 않는 휴대형 배포 모델에 가깝습니다.

### 3.3 Node web server

`frontend/web/server.mjs`는 단일 파일이지만 책임 범위가 넓습니다.

- React 정적 파일 제공
- `Playground/` workspace 목록, 생성, 변경 API
- 산출물 목록/본문/미리보기 API
- client upload 저장
- backend session 생성/종료/재연결
- SSE event 중계 및 replay
- shell preference, port, workspace scope, POSCO certificate 등 환경 설정
- web usage stats, runtime log 저장

이 파일은 web app의 API gateway이자 process supervisor입니다. 변경 시 frontend API type, session replay 모듈, Python backend protocol을 함께 확인해야 합니다.

## 4. Python runtime 아키텍처

### 4.1 RuntimeBundle 조립

`src/myharness/ui/runtime.py`는 headless/Textual/web backend가 공유하는 runtime assembly 계층입니다. 핵심 산출물은 `RuntimeBundle`입니다.

`RuntimeBundle`은 다음 객체들을 묶습니다.

- `api_client`: Anthropic, OpenAI-compatible, Codex, Copilot, P-GPT 등 provider별 client
- `mcp_manager`: MCP server 연결 관리자
- `tool_registry`: builtin tool 및 MCP tool adapter registry
- `app_state`: UI/세션 상태 저장소
- `hook_executor`: hook 실행기
- `engine`: 대화 루프를 소유하는 `QueryEngine`
- `commands`: slash command registry
- `session_backend`: 세션 저장 backend
- `settings_overrides`: CLI/UI에서 들어온 provider/model/base_url 등 runtime overlay

중요한 설계 포인트는 settings를 매번 단순히 disk에서 다시 읽지 않고, CLI/UI override와 project preferences를 합쳐 현재 session의 effective settings를 계산한다는 점입니다. provider/model 관련 버그는 `Settings`, `apply_project_preferences_to_settings`, `RuntimeBundle.current_settings()`를 함께 봐야 합니다.

### 4.2 Provider client 선택

`_resolve_api_client_from_settings()`는 provider와 `api_format`에 따라 실제 client를 선택합니다.

- `copilot`: `CopilotClient`
- `openai_codex`: `CodexApiClient`
- `anthropic_claude`: OAuth 형태의 `AnthropicApiClient`
- `openai` / `openai_compat`: `OpenAICompatibleClient`
- P-GPT profile: `pgpt_api_key` 인증 정보를 employee number와 결합해 token을 만들고, raw SSE, prompt cache option, usage-with-tools 옵션을 켭니다.

P-GPT/OpenAI-compatible 동작은 `src/myharness/api/openai_client.py`, `src/myharness/api/pgpt_auth.py`, `src/myharness/api/pricing.py`, `src/myharness/config/settings.py`와 함께 연결됩니다. 캐시 히트 표시나 비용 추정 버그는 API usage payload와 local pricing 계산을 분리해서 봐야 합니다.

### 4.3 QueryEngine

`src/myharness/engine/query_engine.py`의 `QueryEngine`은 대화 이력과 tool-aware model loop의 소유자입니다.

주요 책임은 다음과 같습니다.

- 사용자 메시지 append
- conversation message sanitize
- user goal 기억
- `HookEvent.USER_PROMPT_SUBMIT` 실행
- `QueryContext` 구성
- coordinator mode context 삽입
- `run_query()` streaming event를 받아 assistant turn 완료 시 이력 반영
- usage/cost tracker 누적
- pending tool result continuation 판단

`QueryEngine` 자체는 orchestrator이고, 실제 모델 호출과 도구 실행 루프는 `src/myharness/engine/query.py`의 `run_query()`가 담당합니다.

### 4.4 run_query 루프

`src/myharness/engine/query.py`는 agent loop의 핵심입니다. 이 파일은 다음 정책을 포함합니다.

- 모델 stream event를 `AssistantTextDelta`, `ToolInputDelta`, `ToolExecutionStarted`, `ToolExecutionCompleted`, `AssistantTurnComplete` 등 내부 event로 변환
- tool schema 선택 및 모델 요청 구성
- output truncation 감지 후 continuation prompt 적용
- context 초과 시 reactive/auto compact
- permission checker와 mutation lock 기반 도구 실행 보호
- pending async agent가 있을 때 최종 산출물 작성성 도구 차단
- web search/fetch evidence 추적
- tool failure 학습 후보 기록
- final artifact marker 자동 삽입

이 계층은 “모델이 무엇을 할 수 있는가”를 실질적으로 제한하는 곳입니다. 프롬프트만 바꿔도 해결되지 않는 tool-use 정책, 비동기 worker 완료 전 최종 보고서 생성 차단, 긴 출력 이어쓰기, compact 관련 버그는 이 파일에서 시작하는 것이 맞습니다.

## 5. 도구 시스템

### 5.1 Tool registry

`src/myharness/tools/__init__.py`의 `create_default_tool_registry()`가 builtin tool 목록을 구성합니다.

주요 builtin tool 범주는 다음과 같습니다.

- shell: Windows에서는 `CmdTool`, 그 외는 `BashTool`
- file: read/write/edit/notebook edit, glob, grep
- agent coordination: agent, send_message, team create/delete
- task: task create/get/list/stop/output/update
- MCP: auth, list resources, read resource, MCP tool adapter
- knowledge/document: skill, tool_search, session_document_search/read, conversation_history_search
- web: web_fetch, web_search
- UI/workflow: ask_user_question, todo_write, plan/worktree enter/exit
- operations: cron, config, sleep, remote trigger, image generation, brief, LSP

`task_worker=True`일 때는 worker가 자기 자신 안에서 다시 agent/team을 남발하지 않도록 tool set이 축소됩니다. 비동기 agent나 worker 관련 기능을 고칠 때 이 분기를 잊으면 도구 노출 범위가 달라질 수 있습니다.

### 5.2 ToolExecutionContext

각 tool은 `BaseTool` 계열로 등록되고, 실행 시 현재 cwd, permission, metadata, MCP manager 등 runtime context를 받습니다. 파일/쉘/네트워크 도구는 보안과 UX 영향이 크므로 permission checker, path validator, network guard와 함께 보아야 합니다.

### 5.3 Session document 도구

긴 입력과 큰 tool output을 직접 축약해 잃어버리지 않기 위해 `src/myharness/services/session_documents.py`, `session_document_search`, `session_document_read`, compact 서비스가 분리되어 있습니다. MyHarness는 raw/recoverable data 보존이 중요한 구조라, 긴 텍스트를 단순 summary로만 치환하는 수정은 위험합니다.

## 6. MCP, skill, plugin 확장 모델

### 6.1 MCP

`src/myharness/mcp/client.py`의 `McpClientManager`는 stdio와 streamable HTTP MCP server를 연결합니다.

주요 기능은 다음과 같습니다.

- server config별 pending/connected/failed status 관리
- `connect_all()`, `reconnect_all()`, `ensure_server_config()` 지원
- connected server의 tools/resources 목록화
- MCP tool call 결과를 문자열로 직렬화
- MCP resource read 결과를 문자열로 직렬화
- 상대 `cwd`는 config의 `_cwd_base` 기준으로 resolve 가능

`.mcp/`에는 `worldbank`, `kosis`, `ecos`, `eia`, `comtrade`, `vector-db`, `korean-law`, `posco-connectors` 같은 프로그램-level MCP 설정/서버가 있습니다. MyHarness에서는 MCP를 직접 대량 노출하기보다 skill-mcp source로 감싸 UI와 `/help`에서 MCP 범주로 보이게 하는 정책도 있습니다.

### 6.2 Skill

`src/myharness/skills/`는 skill 탐색, 로딩, 표시, routing, state를 담당합니다. README 기준 skill 탐색 위치는 프로그램 폴더 `.skills/`, workspace `.skills/`, 사용자-level skill 위치입니다.

중요한 정책은 다음과 같습니다.

- UI 번역은 원본 `SKILL.md`가 아니라 i18n/매핑 계층에서 처리합니다.
- program-level skill은 앱 폴더를 이동/복사해도 함께 유지되는 배포 단위입니다.
- learned skill은 `src/myharness/learning/`과 결합되어 반복 실패를 재사용 가능한 지침으로 축적하는 방향입니다.

### 6.3 Plugin, hook

`src/myharness/plugins/`와 `src/myharness/hooks/`는 plugin manifest, loader, installer, hook registry/executor/hot reload를 제공합니다. RuntimeBundle은 현재 settings와 workspace 기준으로 visible plugins를 다시 계산합니다. plugin/hook 관련 문제는 disk config, project workspace, runtime overlay가 함께 얽힐 수 있습니다.

## 7. 상태, 세션, 기록

Python 쪽 상태는 다음 계층으로 나뉩니다.

- `src/myharness/state/`: AppState와 store
- `src/myharness/services/session_storage.py`: session persistence
- `src/myharness/services/session_backend.py`: session backend abstraction
- `src/myharness/services/session_documents.py`: 긴 입력/문서 보존
- `src/myharness/engine/messages.py`: conversation message model
- `src/myharness/engine/cost_tracker.py`: usage/cost 누적

웹 쪽은 `frontend/web/modules/sessionReplay.js`와 `server.mjs`의 raw event 저장/재생 로직이 핵심입니다. 브라우저가 중간에 끊겼다가 다시 들어와도 in-progress state를 되살리는 UX가 이 계층에 의존합니다.

세션/히스토리 버그를 볼 때는 다음 순서가 좋습니다.

1. Node server의 session map과 raw event append/replay
2. Python backend protocol event
3. React `useBackendSession`, reducer, selectors
4. Sidebar history ordering과 workspace filter

## 8. Web UI 구조

`frontend/web/src/`는 React 19 + TypeScript + Vite 기반입니다.

주요 계층은 다음과 같습니다.

- `main.tsx`, `App.tsx`: app bootstrap
- `state/`: reducer, selectors, app-state provider
- `api/`: server API 호출, SSE event 처리, history/session/settings/workspaces/messages/artifacts
- `hooks/`: backend session, workspace data, workflow event coalescing, message auto-follow
- `components/`: AppShell, Sidebar, ChatPanel, Composer, MessageList, MarkdownMessage, ArtifactPanel, ArtifactPreview, WorkflowPanel, ModalHost, SettingsModal, TodoDock 등
- `utils/`: artifacts, clipboard, history, prompt token, runtime preferences, settings label, help text
- `types/`: backend/UI type 정의

UI의 중심 흐름은 대략 다음과 같습니다.

1. `App`이 workspace/session/settings 초기 상태를 잡습니다.
2. `useWorkspaceData`가 workspace 파일/히스토리를 불러옵니다.
3. `useBackendSession`이 message submit, EventSource, reconnect/replay를 관리합니다.
4. reducer가 streaming text, tool events, workflow events, artifact cards, modal state를 갱신합니다.
5. `ChatPanel`/`MessageList`/`WorkflowPanel`/`ArtifactPanel`이 같은 상태를 서로 다른 시각으로 보여줍니다.

이 구조에서는 “실제 대화 이벤트가 어떻게 표시되는가”가 여러 컴포넌트에 분산됩니다. 예를 들어 Markdown/source chip/rendering 문제는 `MarkdownMessage`, `StreamingTextRenderer`, message list tests, CSS를 함께 봐야 하고, workflow 중복/누락은 `workflowEventCoalescer`, `WorkflowPanel`, reducer를 같이 봐야 합니다.

## 9. 산출물과 workspace 모델

기본 workspace는 `Playground/shared/<project-name>/`입니다. 환경변수로 IP별 scope를 켜면 `Playground/<client-ip>/<project-name>/` 구조가 됩니다.

산출물 미리보기는 Node server와 React panel이 함께 담당합니다.

- server는 artifact extension별 MIME/encoding/kind를 판정합니다.
- HTML, Markdown, text, JSON, CSV, 이미지, PDF, Office/zip 계열 파일을 구분합니다.
- artifact list는 `.git`, `.myharness`, `.mcp`, `.skills`, `node_modules`, `dist`, `Playground` 등 noisy directory를 skip합니다.
- React `ArtifactPanel`/`ArtifactPreview`는 실제 표시, iframe preview, text viewer, image/pdf preview를 담당합니다.

최종 assistant 답변에 생성 파일명이 포함되면 file card가 나타나고 오른쪽 panel에서 열리는 UX는 MyHarness의 핵심 가치입니다. 따라서 파일명 파싱, path normalize, workspace 경계 검증, preview 가능 MIME 판단은 사용자 경험에 직접 연결됩니다.

## 10. 권한, 안전, 네트워크

권한 계층은 `src/myharness/permissions/`에 있고, agent loop에서는 permission checker와 mutation lock이 도구 실행 전에 관여합니다.

안전 관련 주요 축은 다음과 같습니다.

- file/shell mutation은 permission mode와 mutation lock을 거칩니다.
- sandbox 계층은 Docker backend, path validator, Dockerfile, session adapter로 분리됩니다.
- web fetch/search는 network guard와 URL validation을 사용합니다.
- Windows subprocess는 콘솔 창/포커스 이슈가 생기기 쉬워 별도 유틸과 런처 정책을 확인해야 합니다.
- POSCO/company network 환경은 certificate bundle, TLS/proxy, MCP connector config와 연결됩니다.

보안/운영 관점에서 가장 중요한 경계는 workspace path normalization, credentials 저장 위치, MCP stdio command/cwd/env, HTML preview iframe, shell command 실행입니다.

## 11. 비동기 agent, swarm, task

MyHarness는 단일 assistant loop만이 아니라 worker/agent coordination을 지원합니다.

관련 모듈은 다음과 같습니다.

- `src/myharness/tasks/`: local shell/agent task, task manager, stop task
- `src/myharness/swarm/`: registry, mailbox, lockfile, in-process/subprocess backend, team lifecycle, worktree, permission sync
- `src/myharness/tools/task_*`: task tool surface
- `src/myharness/tools/agent_tool.py`, `send_message_tool.py`, `team_*_tool.py`: agent/team coordination
- `src/myharness/ui/async_agents.py`: UI/runtime 쪽 async agent 지원

`run_query()`에는 pending worker가 남아 있을 때 최종 산출물 작성 도구를 막는 로직이 있습니다. 이는 “worker 결과를 보지 않고 최종 보고서를 만드는” 실패를 줄이는 장치입니다. worker 도구나 최종 산출물 정책을 바꿀 때는 이 보호 로직과 UI timeline 표시를 함께 검증해야 합니다.

## 12. 설정과 project preferences

설정 파일은 프로젝트-local `.myharness/settings.json`을 중심으로 움직입니다. provider/profile은 `src/myharness/config/settings.py`, path는 `src/myharness/config/paths.py`, workspace별 preference는 `src/myharness/project_preferences.py`가 담당합니다.

설정 변경이 적용되는 경로는 한 군데가 아닙니다.

- 런처 환경변수
- `.myharness/settings.json`
- `.myharness/credentials.json`
- browser localStorage runtime preferences
- web shared runtime preferences
- workspace `.myharness/preferences.json`
- CLI/UI runtime overrides

따라서 “모델이 왜 이 값으로 열리는가”, “provider가 왜 다시 나타나는가”, “base_url이 왜 바뀌지 않는가” 류의 문제는 저장 설정과 live runtime overlay를 동시에 확인해야 합니다.

## 13. 테스트와 검증

Python 테스트는 `tests/` 아래가 비교적 넓게 구성되어 있습니다.

- API/provider: `tests/test_api/`
- MCP: `tests/test_mcp/`
- runtime/UI: `tests/test_ui/`
- tools: `tests/test_tools/`
- session/services: `tests/test_services/`
- skills/plugins/hooks: `tests/test_skills/`, `tests/test_plugins/`, `tests/test_hooks/`
- swarm/tasks: `tests/test_swarm/`, `tests/test_tasks/`
- scripts/install: `tests/test_scripts/`, `tests/test_install/`

Frontend 테스트는 `frontend/web/tests/*.test.mjs`와 `frontend/web/src/**/__tests__`에 나뉘어 있습니다. `package.json` 기준 검증 명령은 다음입니다.

```bat
cd frontend/web && npm run typecheck && npm run build && npm test
python -m compileall src
python scripts/utf8_guard.py --changed
```

UI 변경은 단위 테스트 통과만으로 충분하지 않습니다. AGENTS.md 지침상 실제 Codex 앱 화면 점검으로 주요 화면, 텍스트 겹침/잘림, 콘솔 오류를 확인해야 합니다.

## 14. 변경 시 영향 범위 가이드

자주 생기는 변경 유형별로 먼저 볼 파일은 다음과 같습니다.

| 변경 유형 | 우선 확인 파일 |
|---|---|
| provider/profile/model 설정 | `src/myharness/config/settings.py`, `src/myharness/ui/runtime.py`, `frontend/web/src/utils/runtimePreferences.ts`, `frontend/web/server.mjs` |
| P-GPT/OpenAI-compatible 호출 | `src/myharness/api/openai_client.py`, `src/myharness/api/pgpt_auth.py`, `src/myharness/api/pricing.py`, `src/myharness/ui/runtime.py` |
| tool 노출/실행 정책 | `src/myharness/tools/__init__.py`, `src/myharness/engine/query.py`, `src/myharness/permissions/` |
| MCP 연결/표시 | `src/myharness/mcp/client.py`, `src/myharness/mcp/config.py`, `src/myharness/tools/mcp_tool.py`, `.mcp/*.json` |
| skill 표시/라우팅 | `src/myharness/skills/`, `src/myharness/tools/skill_tool.py`, `frontend/web/src/utils/helpText.ts` |
| streaming chat 표시 | `frontend/web/src/hooks/useBackendSession.ts`, `frontend/web/src/state/reducer.ts`, `frontend/web/src/components/StreamingAssistantMessage.tsx`, `MarkdownMessage.tsx` |
| session restore/history | `frontend/web/modules/sessionReplay.js`, `frontend/web/src/components/Sidebar.tsx`, `frontend/web/src/api/history.ts`, `src/myharness/services/session_storage.py` |
| artifact preview | `frontend/web/server.mjs`, `frontend/web/src/components/ArtifactPanel.tsx`, `ArtifactPreview.tsx`, `frontend/web/modules/projectFiles.js` |
| slash command | `src/myharness/commands/registry.py`, `src/myharness/cli.py`, `frontend/web/src/components/CommandHelpMessage.tsx` |
| Windows launcher | `run_myharness_web.bat`, `run_myharness_web_dev.bat`, `scripts/run_myharness_web*.ps1`, `Installer.bat` |

## 15. 설계상 강점

- Python runtime과 web UI가 분리되어 있어 CLI/Textual/headless/web 재사용성이 높습니다.
- `RuntimeBundle`이 provider, tool, MCP, plugin, hook, state를 한 번에 조립해 세션 단위의 의미가 명확합니다.
- tool registry가 중앙화되어 agent가 사용할 수 있는 기능을 추적하기 쉽습니다.
- MCP, skill, plugin, hook이 별도 확장 축으로 나뉘어 있어 사내 기능 추가에 유리합니다.
- workspace와 프로젝트-local `.myharness/` 구조 덕분에 PC 이동/복사 배포가 쉽습니다.
- session document와 replay 구조가 있어 긴 입력, 중간 이탈, streaming 복귀 같은 실제 업무 UX를 고려합니다.
- 테스트가 provider, MCP, tools, UI, scripts까지 넓게 분산되어 회귀 방어 면적이 큽니다.

## 16. 주요 리스크와 관리 포인트

- `frontend/web/server.mjs`가 매우 많은 책임을 갖습니다. API 추가, path handling, session lifecycle 변경이 서로 영향을 줄 수 있습니다.
- provider 설정은 disk settings, runtime override, localStorage, project preference가 겹쳐 원인 추적이 복잡할 수 있습니다.
- streaming event는 Python protocol, Node SSE, React reducer, component rendering을 모두 지나므로 중간 state 보존 테스트가 중요합니다.
- UI 표시 정책은 `MarkdownMessage`, `StreamingTextRenderer`, CSS, artifact card, source chip 등 여러 위치에 흩어져 있습니다.
- MCP stdio server는 command/cwd/env/TLS/proxy 영향을 많이 받습니다. 회사망 환경에서는 인증서와 상대 cwd 처리까지 함께 봐야 합니다.
- 산출물 미리보기는 편리하지만 HTML iframe, 경로 normalize, 파일 크기 제한, workspace boundary가 안전 핵심입니다.
- Windows 런처/서브프로세스는 콘솔 flash, focus stealing, Python 버전 선택, port collision 같은 운영 UX 리스크가 큽니다.

## 17. 유지보수 원칙 제안

- 구조적 영향이 있는 변경은 CodeGraph로 호출자/사용처를 먼저 확인합니다.
- UI 변경은 테스트 후 실제 화면 점검까지 합니다.
- provider/profile 관련 변경은 저장 설정과 live runtime 상태를 모두 확인합니다.
- 긴 입력/문서/도구 출력은 원문 회수 가능성을 우선 보존합니다.
- MCP는 직접 도구를 많이 노출하기보다 skill-mcp 라우팅 정책과 `/help` 표시 정책을 유지합니다.
- 새 기능은 `QueryEngine`보다 가능하면 tool, command, service, frontend API 같은 좁은 계층에 둡니다.
- `server.mjs`에 기능을 추가할 때는 모듈화 후보를 함께 검토합니다.
- 한글/비ASCII 파일 수정 후에는 `python scripts/utf8_guard.py --changed`로 인코딩을 확인합니다.

## 18. 빠른 mental model

MyHarness를 한 문장으로 보면 다음과 같습니다.

> 브라우저 UI가 Node server에 요청을 보내고, Node server가 workspace/session/artifact를 관리하면서 Python backend session을 띄우며, Python runtime은 provider client와 tool registry를 조립해 `QueryEngine`/`run_query()`에서 모델 streaming과 도구 실행을 반복하고, 그 event가 다시 SSE로 React reducer에 들어가 채팅/워크플로우/산출물 UI로 표시되는 구조입니다.

이 mental model을 기준으로 보면 대부분의 버그는 어느 경계에서 상태가 변형되었는지 추적할 수 있습니다.
