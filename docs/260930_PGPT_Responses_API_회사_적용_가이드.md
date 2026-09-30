# P-GPT provider Responses API 회사 적용 가이드

> 작성일: **2026-09-30 (KST)** · 파일명 날짜: **260930**
>
> 대상: 이 문서와 함께 제공되는 MyHarness 프로그램을 조사·수정할 회사 에이전트
>
> 회사 제공 형태: **ZIP으로 다운로드하여 압축 해제한 프로그램. Git과 `.git` 이력이 없는 환경**
>
> 작성자가 조사한 개발본: `main`, `7e9d9928c4e33eb7edf463a05f07ff443f75a10d`
>
> 검증 구분: 소스·Git 변경과 로컬 회귀 테스트를 확인했습니다. 이번 조사에서 회사 P-GPT 실호출은 수행하지 않았습니다.

## 1. 회사 에이전트가 수행할 작업

**P-GPT의 모든 활성 모델 실행을 Responses API로 유지하고, 제공된 프로그램에서 빠진 부분만 적용한 뒤 회사 환경에서 검증합니다.** 일반 대화뿐 아니라 도구 결과를 보내는 후속 요청, 컨텍스트 압축용 의미 요약, 캐시 사전 준비, 세션 복원 후 요청까지 같은 계약을 적용합니다.

제공된 프로그램에는 이미 전환 코드가 들어 있을 수 있습니다. 먼저 아래 파일과 완료 기준을 확인하십시오. 이미 구현된 항목은 다시 교체하지 말고 실연결·회귀 검증을 수행합니다. 파일명이나 설정 표시만 Responses로 바꾸는 것은 완료가 아닙니다.

### ZIP으로 받은 프로그램에서 시작하기

1. ZIP을 압축 해제하고 `pyproject.toml`, `src`, `frontend`가 있는 폴더를 **프로그램 루트**로 삼습니다. 아래 경로는 모두 이 폴더 기준입니다.
2. 전달받은 ZIP 파일명·다운로드일과 작업 폴더를 기록합니다. 원본 ZIP을 보관하고, 수정할 소스 파일은 변경 전에 별도 작업 폴더에 백업합니다.
3. 에디터의 파일 열기·전체 검색으로 아래 파일과 심볼을 조사합니다. 회사에서 커밋 조회·Git 설치·Git 저장소 생성을 할 필요는 없습니다.
4. 아래 점검표에서 구현 여부를 판단한 뒤 빠진 부분을 수정합니다. 다운로드 날짜나 클래스 하나의 존재만으로 전환 완료를 판단하지 않습니다.

| ZIP 소스에서 확인할 내용 | 상태 판단·조치 |
|---|---|
| P-GPT factory가 `OpenAIResponsesClient`를 직접 반환 | 기본 전환이 반영된 상태. 도구·요약·재개와 오류 경로를 계속 검증 |
| factory가 `OpenAICompatibleClient`와 `enable_gpt56_responses`를 사용 | 일부 모델에만 위임하는 이전 구조. 4.1절대로 활성 P-GPT 경로를 전환 |
| `OpenAIResponsesClient` 자체가 없음 | 4절의 transport·메시지·저장/압축 의존성을 함께 구현하고 관련 테스트 추가 |
| 기본/저장 URL이 `/s01a01-gpt/v1` | 3.3절의 공식 경로와 알려진 오타 보정 적용 |
| `response_item`, `origin`, `phase` 보존이 없음 | 4.4절의 item 저장·복원·replay 계약 보완 |
| 공개 summary의 delta/done 또는 `summary_id` 전파가 없음 | 해당 모델의 summary 지원을 확인하고 5절의 연계를 보완 |
| 문서에 나오는 테스트 파일이 ZIP에 없음 | 대응하는 동작 테스트를 작성하여 실행. 테스트가 없거나 0개 선택된 상태는 검증 완료가 아님 |

### 처음 읽을 파일

| 순서 | 파일과 확인할 심볼 | 읽는 목적 |
|---|---|---|
| 1 | [src/myharness/ui/runtime.py](../src/myharness/ui/runtime.py) — `_resolve_api_client_from_settings`, `build_runtime`, `refresh_runtime_client` | P-GPT가 실제로 어느 client를 생성하는지, 시작·설정 변경 시 같은 factory를 쓰는지 확인 |
| 2 | [src/myharness/api/codex_client.py](../src/myharness/api/codex_client.py) — `OpenAIResponsesClient`, `CodexApiClient`, `_convert_messages_to_codex`, `_convert_tools_to_codex` | Responses 요청·응답·도구·재시도 구현의 본체 |
| 3 | [src/myharness/api/pgpt_auth.py](../src/myharness/api/pgpt_auth.py) — `build_pgpt_auth_token`, `resolve_pgpt_employee_no`, `resolve_pgpt_company_code` | 기존 회사 인증 조합을 유지할 기준 |
| 4 | [src/myharness/api/registry.py](../src/myharness/api/registry.py) — `PGPT_BASE_URL`, `normalize_pgpt_base_url`; [src/myharness/config/settings.py](../src/myharness/config/settings.py) — `default_provider_profiles`, `BUILTIN_MODEL_POLICIES` | URL·프로필·모델 선택값의 기준 |
| 5 | [src/myharness/engine/messages.py](../src/myharness/engine/messages.py); [src/myharness/services/session_storage.py](../src/myharness/services/session_storage.py) | Responses item을 저장·복원·재전송할 때 정보가 유지되는지 확인 |
| 6 | [src/myharness/services/compact/__init__.py](../src/myharness/services/compact/__init__.py) — `compact_conversation`, `auto_compact_if_needed`; [src/myharness/engine/query.py](../src/myharness/engine/query.py) — `run_query` | 요약·도구 후속 요청도 선택된 Responses client를 사용하는지 확인 |

기존 배경 문서는 [2026-09-16 구현 결과](CODEX_CONTEXT_COMPACTION_IMPLEMENTATION_20260916.md), 상세 설계·회사 제공 예제는 [2026-09-16 검토 보고서](CODEX_CONTEXT_COMPACTION_REVIEW_20260916.md)를 참고합니다. 검토 보고서의 “아직 구현하지 않았다”는 문장은 당시 분석 상태이며, 예제의 오래된 URL은 아래 최신 기준으로 확인해야 합니다. 실제 적용 판단은 제공된 소스와 이 문서의 완료 기준을 우선합니다.

## 2. 개발본의 Git 변경 이력: 적용 배경 참고

아래 이력은 작성자가 개발 환경에서 조사한 근거입니다. **회사 에이전트는 커밋을 조회하지 않고 이 문서의 변경 설명과 ZIP 안의 실제 파일·함수를 대조하여 작업합니다.**

| 커밋 | 날짜(KST) | 관련 변경 | 회사 적용 시 의미 |
|---|---|---|---|
| `6527516` | 2026-08-07 | `OpenAIResponsesClient` 추가 | 클래스가 존재하는 것만으로 P-GPT 전체 전환이 완료된 것은 아님 |
| `75691f7` | 2026-09-16 | P-GPT factory가 `OpenAICompatibleClient` 대신 `OpenAIResponsesClient`를 직접 생성. item 보존, completed-only/JSON 응답, EOF·부분 출력 처리, 압축·캐시 회계 보완 | 전환의 핵심 커밋. 단, 이 커밋 당시 기본 URL의 오타가 있으므로 이것만 적용하면 안 됨 |
| `c14c40f` | 2026-09-17 | 공식 기본 URL을 `/s0la01-gpt/v1`로 교정. 저장된 `/s01a01-gpt/v1` 보정, P-GPT flat 설정 인식, 프로필 전환 시 목적지 설정 상속 | 전환 코드와 함께 필요한 설정·엔드포인트 보완 |
| `087d4b1` | 2026-09-30 | P-GPT 허용 모델에 `gpt-6-sol`, `gpt-6-luna` 추가 | 모델 선택 정책 변경. 실제 회사 배포에서 사용 가능한지는 별도 확인 |
| `7e9d992` | 2026-09-30 | reasoning summary delta/done 처리와 `summary_id` 전파. SSE `event:` 처리, `reasoning.summary` 옵션 거부 복구, incomplete 사유 구분 | 오늘 기준 스트리밍·게이트웨이 호환성 보완 |

개발본의 커밋에는 다른 UI·업무 기능 변경도 섞여 있습니다. 회사에서는 아래 파일·동작 단위로 필요한 변경만 적용하십시오. 제공된 ZIP에 추가 개선이 포함되어 있으면 그 구현을 보존하면서 계약 충족 여부를 확인합니다. 작업 결과에는 수정한 파일과 수정 전·후 동작을 기록합니다.

## 3. 프로필·인증·URL 계약

### 3.1 설정 이름과 실제 transport를 구분하십시오

조사한 개발본의 P-GPT 내장 프로필은 다음과 같습니다.

```text
active_profile = "p-gpt"
profile.provider = "openai"
profile.api_format = "openai"
profile.auth_source = "pgpt_api_key"
profile.base_url = "http://pgpt.posco.com/s0la01-gpt/v1"
```

화면에서 P-GPT라고 부르더라도 내부 프로필의 `provider`는 `openai`입니다. 회사 인증 경로는 `auth_source == "pgpt_api_key"`로 구분합니다. `provider="pgpt"` 또는 `api_format="responses"`라는 새 설정값을 임의로 도입하지 마십시오. 실제 API 선택은 runtime factory와 client가 결정합니다.

기준 허용 모델은 `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-sol`, `gpt-6-luna`이며 기본 모델은 `gpt-5.6-luna`입니다. `gpt-6.1-sol`은 이 Git 기준에서 Codex 목록에만 있습니다. P-GPT 목록에 자동으로 추가하지 않습니다. 회사 배포의 `/v1/models` 또는 회사 제공 모델 목록으로 실제 가용성을 확인한 뒤 정책을 맞춥니다.

### 3.2 기존 Base64 인증을 유지하십시오

`build_pgpt_auth_token()`은 다음 JSON을 UTF-8로 직렬화하고 Base64 인코딩합니다.

```json
{"apiKey":"<개인 API 키>","companyCode":"30","systemCode":"<직번 또는 발급된 시스템 코드>"}
```

이 토큰을 `OpenAIResponsesClient(api_key=token, ...)`에 전달하며 HTTP 헤더는 `Authorization: Bearer <token>`입니다. raw API 키만 Bearer로 보내거나, Personal API용 `empNo`·`compNo` 필드로 바꾸지 않습니다. P-GPT client는 Codex JWT 해석이나 `chatgpt-account-id` 헤더를 사용하지 않습니다.

| 값 | 현재 프로그램의 조회 규칙 |
|---|---|
| API 키 | 활성 P-GPT 프로필의 `Settings.resolve_auth()` 경로. `PGPT_API_KEY` 또는 기존 credentials 저장 기능 사용 |
| 직번/시스템 코드 | `PGPT_EMPLOYEE_NO` → `PGPT_SYSTEM_CODE` → `POSCO_EMP_NO` → 저장된 `employee_no` → 저장된 `system_code` |
| 회사 코드 | `PGPT_COMPANY_CODE` → `POSCO_COMP_NO` → 저장값 → 기본 `"30"` |

별도 시스템 코드를 써야 하는 환경에서 `PGPT_EMPLOYEE_NO`와 `PGPT_SYSTEM_CODE`를 함께 설정하면 현재는 앞의 값이 우선합니다. 회사 인증 방식과 실제 선택값을 확인하십시오. 기존 저장값이나 회사 코드 override를 전환 작업 중 일괄 덮어쓰지 않습니다.

자격증명은 회사 프로그램의 기존 설정 UI·실행기·환경변수·credentials 저장 기능으로 등록합니다. [run_myharness_web.bat](../run_myharness_web.bat)의 P-GPT 설정 흐름도 참고할 수 있습니다. API 키·Base64 토큰은 문서·커밋·검증 로그에 기록하지 않습니다.

### 3.3 경로는 소문자 L이 들어간 `s0la01`입니다

- 기본 base URL: `http://pgpt.posco.com/s0la01-gpt/v1`
- 실제 Responses 요청: `POST http://pgpt.posco.com/s0la01-gpt/v1/responses`
- 알려진 과거 오타: `/s01a01-gpt/v1`
- `normalize_pgpt_base_url()`은 알려진 공식 호스트·오타 경로만 교정합니다. 사용자 지정 게이트웨이는 보존합니다.

`OpenAIResponsesClient.__init__()`은 base URL 끝에 `/responses`를 붙이고, 이미 `/responses`로 끝나면 중복 추가하지 않습니다. `/chat/completions`가 들어 있는 operation URL을 base URL로 넣지 마십시오. 프로필에 회사 URL이 실제 반영되는지 확인하고, P-GPT 토큰으로 공용 OpenAI 기본 URL을 호출하지 않도록 대상 경로를 확인합니다.

## 4. 파일별 수정·점검 내용

### 4.1 런타임 생성: 모델명 분기를 없애고 직접 Responses client를 사용

`ui/runtime.py::_resolve_api_client_from_settings()`의 이전 P-GPT 경로는 아래 형태였습니다.

```python
return OpenAICompatibleClient(
    api_key=api_key,
    base_url=settings.base_url,
    raw_stream=_pgpt_raw_sse_enabled(),
    enable_gpt56_responses=True,
    # 기타 Chat Completions 옵션
)
```

이 구조는 특정 모델만 Responses에 위임하고 Chat Completions로 돌아갈 수 있습니다. 기준 구현은 인증 토큰 생성 후 다음 client를 직접 반환합니다.

```python
return OpenAIResponsesClient(
    api_key=api_key,  # 바로 위에서 build_pgpt_auth_token()으로 만든 토큰
    base_url=settings.base_url,
    timeout=settings.timeout,
    prompt_cache_retention=os.environ.get("MYHARNESS_PROMPT_CACHE_RETENTION"),
)
```

위 코드는 변경 핵심을 보여 주는 발췌입니다. 제공된 factory에 추가된 유효한 옵션·자원 관리 코드는 유지합니다.

`raw_stream`, `include_usage_with_tools`, `enable_gpt56_responses` 등 이전 adapter용 인수를 새 client에 그대로 넘기지 않습니다. `MYHARNESS_PGPT_RAW_SSE`가 남아 있어도 P-GPT 실행이 Chat Completions로 되돌아가지 않아야 합니다.

`build_runtime()`뿐 아니라 `refresh_runtime_client()`도 같은 factory를 사용해야 합니다. 웹의 `ui/backend_host.py`, 터미널의 `ui/app.py`·`ui/textual_app.py`, 자동 실행의 `autopilot/service.py`가 이 런타임을 사용하는 경로를 함께 점검합니다. 분리 실행하는 에이전트도 활성 P-GPT 프로필을 상속하는지 확인하십시오.

`api/openai_client.py::OpenAICompatibleClient`에는 비활성 legacy 구현과 테스트가 남아 있습니다. 이를 전부 삭제하는 것은 이번 전환의 필수 작업이 아닙니다. **활성 P-GPT가 그 fallback에 진입하지 않는지**를 검증합니다.

### 4.2 요청·도구·대화 재전송

`api/codex_client.py`의 기존 변환 함수를 재사용합니다. 앱 내부 `ApiMessageRequest`와 `ConversationMessage` 계약을 유지하고 provider 경계에서 변환합니다.

| 항목 | Responses 전송 계약 |
|---|---|
| 대화 | `messages` 대신 `input` item 배열. 현재 구현은 `store=False`와 로컬 기록 재전송 방식 |
| 시스템 지침 | 요청의 `instructions`와 별도로 앱 시스템 프롬프트를 developer input item으로 보존하는 기존 구현 유지 |
| 사용자 텍스트·이미지 | `input_text`, `input_image` |
| assistant 텍스트 | 개별 `message` item의 경계·원래 메타데이터·`phase`를 보존 |
| 도구 스키마 | `type="function"`, `name`, `description`, `parameters`를 같은 item에 둠. 기존 `input_schema`에서 변환 |
| 도구 요청 | `function_call`의 item `id`, 실행 연계용 `call_id`, `name`, JSON `arguments` 보존 |
| 도구 결과 | `function_call_output`, 같은 `call_id`, 문자열 `output` |
| 출력 한도 | P-GPT 요청의 `max_output_tokens = request.max_tokens` |
| opaque 상태 | reasoning/compaction item은 `ResponsesStateBlock`으로 보존하여 순서대로 재전송 |

`function_call.id`와 `call_id`를 혼동하지 마십시오. 도구 실행·결과 연결은 `call_id` 기준입니다. 신규 MCP 도구도 동일한 변환을 사용합니다. 현재 `_convert_tools_to_codex()`는 MCP의 선택 인자가 강제로 필수화되지 않도록 `strict=False`를 전달합니다. 모든 도구에 임의로 strict schema를 강제하지 않습니다.

이번 전환에서 `previous_response_id`와 `store=True` 기반의 서버 대화 저장 방식을 새로 도입할 필요는 없습니다. 현재의 로컬 snapshot·수동 replay 방식을 유지합니다.

### 4.3 SSE·JSON·완료 판정·실패 처리

`CodexApiClient._stream_once()`와 `_iter_sse_events()`는 P-GPT subclass에서도 공유됩니다. 다음 응답 형태를 모두 처리해야 합니다.

1. `response.output_text.delta`와 `response.output_item.done` 후 `response.completed`가 오는 일반 SSE.
2. 중간 item 이벤트 없이 `response.completed.response.output`만 오는 회사 게이트웨이 SSE.
3. `Content-Type: application/json`으로 반환되는 `object="response"` 응답.
4. JSON 안에 `type`이 없고 SSE의 `event: response.completed` 헤더에 이벤트 종류가 있는 응답.

최종 `response.output`이 있는 경우 이를 최종 메시지의 기준으로 사용하여 item-done과 completed가 같은 텍스트·도구를 중복 추가하지 않도록 합니다. 본문 중간의 `delta`만 있었거나 `[DONE]`·EOF만 도착한 경우 정상 완료로 취급하지 않습니다.

- malformed 도구 arguments나 object가 아닌 arguments, 유효하지 않은 call ID/name은 오류로 처리합니다. 잘못된 JSON을 정상 빈 인자로 숨기지 않습니다.
- `response.incomplete`의 `max_output_tokens`는 `length`로, 다른 사유는 해당 사유로 전달합니다. 잘린 응답을 정상 요약으로 채택하지 않습니다.
- provider 이벤트가 하나라도 소비자에게 전달된 이후에는 자동 재요청으로 같은 출력·도구 실행을 반복하지 않습니다. 출력 전 일시적 연결 장애의 제한된 재시도는 유지합니다.
- `/responses` 미지원·404·인증 실패는 원인을 표시합니다. `/chat/completions`로 자동 우회하여 성공으로 보고하지 않습니다.

선택 옵션 거부는 transport 미지원과 구분합니다. `_disable_unsupported_cache_options()`는 오류 메시지가 지목하는 `prompt_cache_key`, `prompt_cache_retention`, `prompt_cache_options`/breakpoint, `context_management`, `include`, `text`, `reasoning.summary` 등을 해당 client에서 비활성화하고 **같은 `/responses`**로 제한적으로 재시도합니다. 임의의 400 오류나 필수 필드 오류를 무조건 무시하는 처리를 추가하지 않습니다.

### 4.4 세션 저장·재개·컨텍스트 압축

메시지 모델에서 다음 필드를 유지하십시오. 이전 snapshot에 필드가 없어도 읽을 수 있도록 기본값을 유지합니다.

```text
TextBlock.response_item
ToolUseBlock.response_item
ResponsesStateBlock.item / origin
ConversationMessage.phase
ConversationMessage.context_input_tokens / context_prefix_tokens
```

`_convert_messages_to_codex()`는 텍스트를 하나로 합치거나 상태 블록을 앞으로 몰지 않고 원래 item 순서대로 replay해야 합니다. native compaction item이 있다면 이전 접두부를 제거한 뒤 옛 텍스트를 다시 붙이지 않습니다. endpoint/model 출처가 달라진 opaque 상태의 처리도 확인합니다. 관련 코드는 [engine/query.py](../src/myharness/engine/query.py)의 `run_query()`에서 `state_origin`·`ResponsesStateBlock.origin`을 비교하는 경로를 함께 조사합니다.

**P-GPT의 Responses 지원과 native server compaction 지원은 별개입니다.** 기준 `OpenAIResponsesClient.supports_server_compaction()`은 `False`입니다. P-GPT 요청에서 Codex용 `reasoning.context`를 제거하고, 미확인 `context_management`나 `/responses/compact`를 필수 기능으로 활성화하지 않습니다.

`services/compact/__init__.py::compact_conversation()`은 전달받은 `api_client.stream_message()`로 의미 요약을 수행합니다. 따라서 P-GPT의 요약 요청도 Responses를 사용해야 합니다. 요약 실패·length 종료·취소 때 원래 기록을 보존하고, 기존 원문 archive·session document 저장과 도구 쌍 보존을 회귀시키지 않습니다.

272K/1M 정책·장기 메모리 전체를 새로 설계하는 것은 이번 전환의 선행 작업이 아닙니다. 제공된 구현을 유지하면서 Responses 상태·예산·재개 계약에 필요한 의존 파일을 함께 반영합니다.

### 4.5 usage·캐시 회계

`_usage_from_response()` → [api/usage.py](../src/myharness/api/usage.py)의 `UsageSnapshot` → 기존 집계/UI 흐름을 유지합니다.

- 입력·출력: `input_tokens`/`output_tokens`, 회사 호환 필드 `prompt_tokens`/`completion_tokens`.
- 캐시 읽기: `input_tokens_details.cached_tokens` 또는 `prompt_tokens_details.cached_tokens`.
- 캐시 쓰기: 기존 `cache_write_tokens`·`cache_creation_input_tokens`와 token details의 대응 필드.
- reasoning token은 output token에 다시 가산하지 않습니다. 요약 요청·캐시 준비 등 보조 호출의 사용량도 기존 회계 계약에 맞게 확인합니다.

Git 기준 P-GPT `_request_body()`는 GPT-5.6·GPT-6 계열에 explicit `prompt_cache_options`와 developer item의 breakpoint를 붙이는 경로가 있습니다. 이는 `/responses` 자체의 필수 조건이 아닙니다. 회사 옵션 지원을 확인하고, 거부될 때 해당 옵션만 빼는 복구가 동작해야 합니다.

캐시 진단 로그의 기준 provider 값 `responses`만으로 Codex와 P-GPT 성능을 구분할 수는 없습니다. 실측 없이 캐시율·속도 향상을 전환 효과로 단정하지 않습니다. 진행 중인 캐시 최적화가 함께 제공되면 관련 helper/import 의존성까지 확인하십시오.

## 5. 오늘의 추론 요약 스트리밍 보완

이 항목은 기본 Responses 전환 이후의 2026-09-30 변경입니다. 공개 reasoning summary를 받는 회사 모델에서 진행 메모가 완료 때까지 밀리지 않도록 합니다. summary를 제공하지 않거나 선택 옵션을 거부하는 모델도 일반 답변은 동작해야 합니다.

| 계층 | 참고할 파일·심볼 | 적용할 계약 |
|---|---|---|
| API 이벤트 | [api/client.py](../src/myharness/api/client.py) — `ApiReasoningSummaryEvent`; `api/codex_client.py::_stream_once` | `response.reasoning_summary_text.delta/done` 즉시 처리. 같은 item의 누적 요약과 안정적인 `summary_id` 전달. completed-only 응답에서도 공개 요약 회수 |
| 엔진 | [engine/stream_events.py](../src/myharness/engine/stream_events.py) — `ReasoningSummaryEvent`; `engine/query.py::run_query` | `summary_id`를 중간에 누락하지 않음 |
| 웹 backend·history | [ui/protocol.py](../src/myharness/ui/protocol.py) — `BackendEvent`; [ui/backend_host.py](../src/myharness/ui/backend_host.py) | `reasoning_summary`에 ID 전달. 같은 ID의 history 메모는 갱신하여 중복 누적 방지 |
| frontend | [frontend/web/src/types/backend.ts](../frontend/web/src/types/backend.ts), [types/ui.ts](../frontend/web/src/types/ui.ts), [state/reducer.ts](../frontend/web/src/state/reducer.ts) — `applyProviderSummary` | 같은 summary ID의 진행 메모를 갱신. 실시간 수신과 history 복원에 같은 규칙 사용 |
| 표시 | [components/AsideWorkflowTimeline.tsx](../frontend/web/src/components/AsideWorkflowTimeline.tsx) 및 기존 workflow 표시 | 답변·도구 동작을 유지하면서 갱신되는 공개 요약 표시 |

이벤트만 추가하고 backend/history/frontend 연계를 생략하면 화면에는 변화가 없거나 메모가 반복될 수 있습니다. 내부 추론 원문을 새로 출력하게 만들지 않고 provider가 공개한 summary만 처리합니다.

## 6. 권장 작업 순서

1. ZIP 파일명·다운로드일·작업 폴더를 기록하고, 원본 ZIP과 수정 대상 소스를 보관합니다. 실제 P-GPT client 타입·프로필·URL과 1절 점검표로 미적용 항목을 표시합니다.
2. factory·인증·URL·요청/응답 parser를 맞춥니다. 메시지 모델·snapshot·압축 helper 의존성도 함께 확인합니다. 기존 사용자 설정은 보존합니다.
3. 일반 대화와 도구 호출 후속 요청을 mock transport로 검증합니다. 모델명·도구명 예외 목록을 늘리는 방식으로 전환하지 않습니다.
4. EOF·부분 출력·잘못된 arguments·선택 옵션 거부·신규 도구·snapshot replay를 검증합니다.
5. 오늘의 summary 이벤트 연계를 적용해야 하는 버전이면 API → 엔진 → backend/history → frontend 순으로 반영하고 화면을 확인합니다.
6. 회사 OA 환경의 실제 자격증명과 배포 모델로 연결·도구·재개·요약을 검증한 뒤, 결과와 남은 미검증 범위를 보고합니다.

## 7. 검증 방법과 완료 기준

### 7.1 먼저 실행할 로컬 회귀 테스트

프로그램에서 사용하는 Python 환경으로 **압축 해제한 프로그램 루트**에서 실행합니다. `tests` 폴더와 아래 테스트 파일이 들어 있는지 먼저 확인합니다.

```powershell
python -m pytest tests/test_api/test_pgpt_auth.py tests/test_api/test_responses_contract.py tests/test_api/test_responses_progress.py tests/test_api/test_codex_client.py tests/test_api/test_stream_retry_boundaries.py tests/test_ui/test_runtime_api_key.py -q
```

이번 문서 작성 중 위 집합은 작성자의 개발본에서 **123 passed (10.44s)**였습니다. 이 수치는 작성 시점의 테스트 결과이며 회사 서버 지원을 증명하지 않습니다. 회사 에이전트는 제공받은 ZIP 프로그램에서 다시 실행해야 합니다.

추가로 backend의 `provider_summary` 테스트는 **2 passed, 159 deselected (3.13s)**였고, 이 문서의 최소 probe는 모의 HTTP로 runtime factory·회사 토큰 구성·`/responses` 경로·최종 출력까지 실행했습니다. 문서의 파일 링크와 예시 Python 문법도 확인했습니다. 이 추가 확인에도 실제 네트워크 호출은 포함되지 않습니다.

| 테스트 파일 | 주요 확인 항목 |
|---|---|
| `tests/test_api/test_pgpt_auth.py` | Base64 payload 키와 환경변수·credentials 선택 |
| `tests/test_ui/test_runtime_api_key.py` | 실제 P-GPT runtime의 Responses client 생성, legacy raw-SSE flag 무관, 인증 누락 표시 |
| `tests/test_api/test_responses_contract.py` | SSE·JSON·completed-only·중복 item, 캐시 회계, phase/snapshot, EOF, 신규 MCP 출력 회수, 의미 압축 후 재개 |
| `tests/test_api/test_codex_client.py` | 요청·도구·cache prefix·응답·자원 종료 등 공유 Responses transport 계약 |
| `tests/test_api/test_responses_progress.py` | 응답/item 완료 전 summary 전달, 같은 ID, completed-only 복원, SSE event 헤더, 옵션 거부, 여러 모델·`future-model` |
| `tests/test_api/test_stream_retry_boundaries.py` | 부분 출력 재실행 방지, 출력 전 일시 장애 재시도. Codex 공통 transport와 legacy 경로 포함 |

회사 수정분에서는 추가로 **P-GPT client의 허용 모델별 `/responses` 유지**, 미지원 endpoint에서 `/chat/completions` 호출 0회, 잘못된 tool arguments, 새로운 tool name의 call ID 왕복을 직접 검사하십시오. 공통 superclass 테스트를 통과했다는 이유만으로 P-GPT의 실연결·모든 모델 경로까지 완료로 보고하지 않습니다.

메시지·압축·설정 의존 파일도 수정했다면 범위를 넓힙니다.

```powershell
python -m pytest tests/test_engine/test_messages.py tests/test_services/test_compact.py tests/test_services/test_compaction_stress_regressions.py tests/test_config/test_settings.py -q
```

summary UI도 변경했다면 Python backend와 frontend 회귀를 확인합니다. `-k provider_summary`는 공개 요약 전달과 같은 ID의 history 갱신 테스트를 선택합니다.

```powershell
python -m pytest tests/test_ui/test_react_backend.py -k provider_summary -q
```

`frontend/web`에서:

```powershell
npm.cmd run test:react -- src/state/__tests__/reducer.test.ts src/components/__tests__/WorkflowPanel.test.tsx src/components/__tests__/workflowCallPath.test.tsx
npm.cmd run build
```

마지막으로 프로그램 루트에서 **검사할 경로를 직접 지정하여** UTF-8을 검사합니다. 아래 예시는 Python 소스·테스트·문서·frontend를 검사하며, 실제 전달된 폴더와 수정 범위에 맞춰 경로를 지정할 수 있습니다.

```powershell
python scripts/utf8_guard.py src tests docs frontend/web/src frontend/web/styles.css
```

`utf8_guard.py`의 `--changed`·`--all`과 경로 없는 기본 실행은 Git으로 파일 목록을 구합니다. 회사 ZIP 환경에서는 위와 같이 명시적인 경로를 사용하십시오. 출력의 `checked ... text file(s)`가 예상 파일 수를 포함하는지 확인합니다. **`checked 0`은 검사 완료가 아닙니다.**

원본 백업과 수정 파일을 비교하여 변경 범위를 검토하고, 수정 파일 목록·변경 요약·테스트 결과를 기록합니다. 회사 작업의 검증 절차에는 Git 명령이 필요하지 않습니다.

테스트가 현재 회사 설정이나 기존 무관한 변경 때문에 실패하면 원인과 테스트명을 기록합니다. 테스트 통과를 위해 사용자 기본 provider를 몰래 바꾸거나 의미 있는 검사를 제거하지 않습니다.

### 7.2 실제 회사 연결 확인용 최소 probe

다음은 **회사 OA 환경에서 실행할 예시**입니다. 기존 방식으로 자격증명을 등록하고 회사 배포에서 사용할 모델을 선택한 후, 필요하면 로컬 점검용 `.myharness/ui-checks/pgpt_responses_probe.py`에 저장하여 `python`으로 실행합니다. 이 폴더의 점검 로그와 임시 파일은 프로그램을 다시 ZIP으로 전달할 때 제외합니다. 이 문서 작성 중에는 실호출하지 않았습니다.

```python
import asyncio

from myharness.api.client import ApiMessageCompleteEvent, ApiMessageRequest
from myharness.api.codex_client import OpenAIResponsesClient
from myharness.config.settings import load_settings
from myharness.engine.messages import ConversationMessage
from myharness.ui.runtime import _resolve_api_client_from_settings


async def main():
    settings = load_settings().merge_cli_overrides(
        active_profile="p-gpt"
    ).materialize_active_profile()
    client = _resolve_api_client_from_settings(settings)
    try:
        assert isinstance(client, OpenAIResponsesClient)
        assert client._url.endswith("/responses")
        print("client:", type(client).__name__)
        print("endpoint:", client._url)  # 인증 헤더·토큰은 출력하지 않음
        print("model:", settings.model)
        completed = None
        request = ApiMessageRequest(
            model=settings.model,
            system_prompt="사용자의 연결 확인 문구를 한 줄로 출력하세요.",
            messages=[ConversationMessage.from_user_text(
                "PGPT Responses OK를 그대로 출력하세요."
            )],
            max_tokens=2048,
            reasoning_effort="low",
        )
        async for event in client.stream_message(request):
            if isinstance(event, ApiMessageCompleteEvent):
                completed = event
        assert completed is not None, "완료 이벤트 없음"
        assert completed.stop_reason == "stop", completed.stop_reason
        assert "PGPT Responses OK" in completed.message.text
        print("result:", completed.message.text)
        print("usage:", completed.usage)
    finally:
        await client.aclose()


asyncio.run(main())
```

이 probe는 **실제 runtime factory·인증·URL·단순 완료 응답**을 확인합니다. 도구 호출·UI·세션 재개·긴 문맥 검증을 대신하지 않습니다. incomplete/length가 나오면 출력 한도·추론 옵션·배포 지원을 확인하고 정상 성공으로 바꾸어 보고하지 않습니다.

### 7.3 회사 환경에서 반드시 확인할 동작

| 시나리오 | 완료 기준 |
|---|---|
| 허용 모델별 짧은 대화와 후속 대화 | P-GPT URL의 `/responses` 사용. 이전 요청 내용을 이어서 이해하고 정상 완료 |
| 실제 도구 1회·연속 호출 및 새 도구 | 모델 요청 → 앱 실행 → 같은 call ID의 결과 → 최종 답변. 결과가 중복 실행되거나 누락되지 않음 |
| summary 제공 모델 | 응답 완료 전에 공개 진행 메모가 갱신되고, 같은 ID의 메모가 중복되지 않음 |
| summary 없음/옵션 거부 모델 | 일반 답변·도구 호출은 유지. 거부된 선택 옵션만 비활성화 |
| 세션 저장·재시작·복원 | item 순서·phase·도구 쌍 유지. 모델/provider 변경 후 비호환 opaque 상태를 그대로 보내지 않음 |
| `/compact` 또는 자동 의미 요약 | 요약 요청도 `/responses`. 요약 실패·취소·length 종료 시 기존 기록 보존 |
| 인증 누락·401·URL 오류·Responses 미지원 | 실제 원인 표시. Chat Completions로 우회하지 않음 |
| 스트림 중단·취소 | 완료를 가장하지 않으며 부분 출력 이후 중복 요청·도구 실행 없음 |
| usage와 캐시 | 제공된 필드가 기존 회계·화면에 반영되고 중복 합산 없음. 필드 누락과 실제 cache hit 0을 구분하여 기록 |
| 웹 화면 | 변경 후 backend를 재시작하고 내장 브라우저에서 답변·도구·진행 메모·history 복원을 직접 확인 |

옵션 지원은 모델명이나 공용 OpenAI API 문서만으로 확대 추정하지 않습니다. `/responses` 기본 지원, 공개 summary, cache 옵션, encrypted state, native compaction은 회사 게이트웨이에서 각각 확인하고 결과를 분리하여 기록합니다.

## 8. 회사 에이전트에게 전달할 작업 지시문

아래 문구를 이 문서와 전체 프로그램을 전달할 때 함께 사용할 수 있습니다.

```text
회사 프로그램은 Git 이력이 없는 ZIP 압축 해제본입니다.
제공된 MyHarness 프로그램과 docs/260930_PGPT_Responses_API_회사_적용_가이드.md를 읽고,
P-GPT provider의 Responses API 전환이 실제 실행 경로 전체에서 유지되는지 조사해 주세요.
커밋 해시는 작성자의 조사 근거로만 참고하고, ZIP 안의 실제 파일·함수로 구현 상태를 판단하세요.
ZIP 파일명·다운로드일·작업 폴더를 기록하고 원본 ZIP과 수정 대상 소스를 보관하세요.

먼저 ui/runtime.py의 factory, api/codex_client.py의 OpenAIResponsesClient,
pgpt_auth.py, registry.py/settings.py, engine/messages.py와 session/compact 경로를 비교하세요.
이미 구현된 부분은 보존하고 미적용·잘못 적용된 부분만 수정하세요.
프로필 이름·Base64 인증·회사 URL을 유지하고 모든 활성 P-GPT 모델과 도구 후속 요청,
요약·캐시 준비·세션 복원까지 /responses를 사용하도록 하세요.
Chat Completions 자동 fallback을 활성화하지 마세요.

오늘의 공개 reasoning summary 보완이 필요하면 summary_id를 API부터 history와 frontend까지
연결하고, 실제 완료 전 화면 갱신과 중복 없는 복원을 확인하세요.
Responses 지원과 native compaction/캐시/summary 선택 옵션 지원은 구분하세요.

문서의 로컬 회귀·오류·신규 도구 검증을 수행하고, 회사 OA 환경과 준비된 자격증명으로
실연결·도구 호출·재개·요약을 검증하세요. 준비되지 않은 항목은 미검증으로 명시하세요.
변경 파일, 변경 이유, 실행한 검증과 결과, 모델·옵션별 확인 결과, 남은 항목을 보고하세요.
UTF-8 검사에서는 utf8_guard.py에 검사할 경로를 직접 지정하고 실제 검사 파일 수를 확인하세요.
API 키와 토큰은 출력하거나 공유 파일에 포함하지 말고, 무관한 변경은 보존하세요.
수정 파일과 원본 백업을 비교해 변경 목록과 검증 결과를 보고하세요.
```

회사 작업의 완료 보고에는 **① ZIP 파일명·다운로드일·작업 폴더와 변경 파일, ② 자동 테스트 결과, ③ 실제 회사 호출 모델·응답 형태·옵션 지원, ④ 실제 화면 확인, ⑤ 남은 미검증 항목**을 구분해 적습니다.
