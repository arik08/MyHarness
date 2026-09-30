# MyHarness 최적화 검토 — 2026-09-30

## 범위와 판단 기준

코드를 수정하기 전에 현재 작업트리의 Python 런타임·모델 요청·프롬프트·MCP/스킬 로딩·세션 저장·Node/SSE·React 스트리밍·번들을 검토했다. 기존 미커밋 변경은 검토 기준에 포함하되 이번 최적화 변경과 구분한다. 8월의 `PERFORMANCE_STABILITY_AUDIT.md`는 참고 자료이며, 당시 결함·수치를 현재 결함으로 그대로 인용하지 않는다.

우선순위는 요청 빈도, 사용자 대기 시간/토큰 비용, 재현 근거, 변경 위험으로 정한다. 코드에서 확인한 제한, 로컬 계측, 실제 공급자의 usage 증거를 구분한다. 캐시 키가 같거나 테스트가 통과했다는 이유만으로 실제 cache hit 또는 모델 응답속도 향상을 주장하지 않는다.

## 수정 전 측정

- `.myharness/logs/prompt-cache-diagnostics.jsonl`에서 input usage가 있는 137건을 집계했다. 기록 시각은 2026-09-16~2026-09-30 (Asia/Seoul)이며, 오늘의 새 모델 호출로 얻은 결과가 아니다.
- 모델별 `sum(cached_input_tokens) / sum(input_tokens)`는 `gpt-5.6-luna` 83.92% (76건), `gpt-6-luna` 90.32% (37건), `gpt-6.1-sol` 86.53% (24건)이다. 단순 요청별 비율의 평균이 아니다.
- 해당 기록의 provider는 모두 `responses`여서 Codex/P-GPT를 구분할 수 없고 캐시 모드·도구 개수도 기록되지 않는다. 따라서 이 비율은 P-GPT의 보장된 성능으로 해석할 수 없다. 최초 요청·warmup 여부를 모두 구분할 수도 없다.
- 현재 저장소에서 기본 `Settings()`로 프롬프트를 5회 생성했다: 480.99, 424.98, 454.04, 430.08, 434.64ms. 본문은 60,413자, 로컬 추정 15,200 tokens다. API를 호출하지 않았고 프롬프트/대화 원문·인증값을 출력하지 않았다.
- 5회 생성 중 환경 탐지는 10회, 회당 중앙값 198.37ms였다. 스킬 구간은 5회, 중앙값 33.63ms였고 프로젝트 지침 로딩은 중앙값 0.81ms였다. 환경 탐지에서 Git subprocess를 실행하며 기본 프롬프트를 불필요하게 두 번 생성한다.
- 기존 빌드의 entry JS는 1,270,304 bytes (압축 전)다. Mermaid/PDF/html2canvas는 별도 chunk다. 원본 크기만으로 페이지 로딩 지연을 단정하지 않는다.

## 우선순위

| 순서 | 우선순위 | 항목 | 현재 근거 | 첫 작업/완료 조건 |
|---:|---|---|---|---|
| 1 | P1 | 시스템 끝에만 놓인 explicit 캐시 경계 | 활성 P-GPT `OpenAIResponsesClient._request_body`와 호환 Chat Completions `_completion_params`에서 `mode=explicit`, 시스템/developer 끝에만 breakpoint. 누적 대화·도구 결과는 경계 뒤에 있어 캐시 재사용 대상이 확장되지 않음 | 공통 지침의 explicit 경계와 implicit 대화 경계를 함께 사용. 현대 GPT 계열, 옛 모델, 비GPT, 옵션 거부 fallback, 새 세션·tool follow-up·restore를 검증 |
| 2 | P1 | 기본 프롬프트의 환경 탐지 중복 | `build_runtime_system_prompt`가 custom prompt가 없으면 동일 `build_system_prompt`를 다시 호출. 로컬 5회에 환경 탐지 10회 | 한 번만 생성. custom/coordinator/task-worker 동작과 생성 내용 보존. 실제 생성 시간 재측정 |
| 3 | P1 | 캐시 진단의 공급자·모드 구분 누락 | `CodexApiClient._write_cache_diagnostic`가 모두 `responses`로 기록. P-GPT subclass도 상속 | Codex/API Responses/P-GPT 구분, 요청의 실제 옵션·도구/입력 항목 수 기록. 프롬프트·사용자 메시지·인증값 기록 금지 |
| 4 | P2 | 환경·reasoning 설정이 긴 공통 지침 앞에 위치 | Environment가 base 뒤, Effort/Passes가 스킬·프로젝트 지침 앞. 캐시 키가 전체 system prompt의 해시라 날짜/작업경로/설정 변경으로 재분리됨 | 안정 지침과 runtime context를 명시적으로 분리. 역할·우선순위·환경 정확성·workspace 격리 검증 후 적용. API의 hidden reasoning 설정 변경도 cache에 영향을 줄 수 있으므로 effort 변경 간 hit를 보장하지 않음 |
| 5 | P2 | 대용량 tool input preview의 반복 전체 탐색 | `reducer.ts::workflowDraftFromBuffer`가 누적 JSON에 대해 old/new/content/patch/path 등을 반복 추출, 이벤트마다 전체 buffer 갱신. frontend 관련 파일에는 기존 변경이 있음 | 100KB/1MB write/edit/patch/save_skill과 신규 도구의 browser long task/입력지연 계측 후 점진 파서·flush 개선. 최종 저장 내용을 유지 |
| 6 | P2 | 느린 SSE 소비자와 동기 runtime 로그 | Node `writeSseEvent`가 `write()` 반환값을 처리하지 않고 `runtimeLog`는 `appendFileSync` | 연결별 byte budget/replay 복구, 로그 순서·종료 flush 보존. 실제 slow-consumer 재현과 회귀 후 변경 |
| 7 | P2 | 세션별 스킬/플러그인 재탐색·MCP 준비 | registry에서 디렉터리/파일을 다시 읽음. Node의 각 backend는 별도 Python 프로세스. MCP는 이미 동시 연결·web background 연결을 사용 | registry fingerprint와 invalidation을 설계. 새 스킬/활성화 변경/플러그인 업데이트가 즉시 반영되는 조건 유지. 현재 스킬 구간 약 34ms로 2번보다 영향이 작음 |
| 8 | P2 | idle 스트리밍 tail의 지속 RAF·상태 복사 | auto-follow loop가 활성 tail 동안 매 frame layout을 읽음. 세션 view와 workflow 입력/출력을 함께 보관 | settled 상태 RAF 정지·변화 시 재개 및 메모리 계측. 사용자가 승인한 스크롤 움직임과 세션 복원 보존 |
| 9 | P3 | entry 번들·snapshot 전체 저장의 추가 최적화 | entry chunk 약 1.27MB, snapshot은 전체 모델 대화와 복원 정보를 유지. 둘 다 단순 삭제/분할로 계약이 깨질 수 있음 | cold load/저장 병목을 측정한 뒤 적용. PDF/Mermaid는 이미 지연 로딩이므로 별도 chunk를 전부 초기 비용으로 합산하지 않음 |

추가 관측: 수정 후 첫 5회 계측 중 한 번은 Git 환경 탐지의 5초 timeout을 만나 5,109.19ms가 걸렸다. 이후 같은 프로세스의 교차 비교 7쌍에서는 재현되지 않았다. PATH의 Codex Git wrapper와 설치된 Git을 각각 4회 점검했을 때도 정상 응답했다. 이 느린 꼬리의 원인은 확정하지 않았으며, 중복 제거가 subprocess 지연 자체까지 해결한 것으로 보고하지 않는다. 환경 탐지의 시간 제한/비동기화는 후속 P2 조사 대상이다.

## 이미 있는 장치

- tools는 엔진 및 공급자에서 이름순으로 정렬하며, 정상 턴의 전체 tool schema preset을 유지한다. 도구를 요청마다 임의로 줄이면 캐시 prefix를 깨뜨릴 수 있으므로 단순 pruning을 우선하지 않는다.
- `runtime._runtime_system_prompt`는 일반 요청마다 프롬프트를 재생성하지 않고 explicit 설정/스킬 변경 때만 갱신한다.
- token estimation은 encoding cache와 4,096개 count cache를 사용한다. 전체 토큰을 매번 새로 tokenize한다고 판단하면 안 된다.
- Node history migration은 현재 `.meta`가 있으면 full snapshot read를 피한다. 목록은 제한된 병렬도·metadata/fingerprint cache·pagination을 사용한다.
- provider HTTP client는 connection pool을 재사용하고, 출력이 시작된 뒤 stream 전체를 자동 retry하지 않는 보호가 있다.
- MCP는 동시 연결과 web background 연결이 이미 구현돼 있다. 연결 완료 시 시스템/tool prefix가 갱신될 수 있어 이 준비 단계와 모델 지연을 나눠 측정해야 한다.
- warmup은 background지만 backend session마다 별도 요청을 한다. 같은 prefix의 중복 예열 제거는 실제 비용·계정 격리·TTL을 확인한 뒤 판단한다. cache ratio만 올리려고 예열 요청을 늘리지 않는다.

## 첫 수정 묶음

우선순위 1~3을 적용한다. UI 파서·SSE·저장 구조를 동시에 리팩터링하지 않는다. 첫 묶음의 검증은 요청 payload와 공통 prefix/복원/도구 결과의 보존, 선택 옵션 거부 시 정상 응답, custom/coordinator 프롬프트 동작, 로컬 프롬프트 생성 시간, 관련 Python 회귀·정적 검사·UTF-8 검사다.

실제 P-GPT의 cache hit/첫 토큰 시간은 회사 OA 네트워크의 새 usage/latency 계측이 있어야 확정할 수 있다. 이번 local mock/transport 검증은 그 증거를 대신하지 않는다. 코드 검토만으로 확정하지 못한 브라우저 CPU·SSE 부하 경로는 후속 작업으로 남긴다.

## 캐시 동작의 참고 근거

[OpenAI 공식 prompt caching 가이드](https://developers.openai.com/api/docs/guides/prompt-caching)를 2026-09-30 확인했다. GPT-5.6 이후 implicit 모드는 최신 eligible user/tool/developer message까지 경계를 두고 explicit 경계와 함께 쓸 수 있다. explicit-only 모드는 표시한 경계만 사용한다. 이전 모델은 retention/implicit 동작이 다르다. 실제 P-GPT gateway가 각 옵션을 받아들이는지는 별도 확인 대상이다.

캐시 비율은 최적화의 한 지표다. 최종 목표는 같은 업무를 완료하는 데 드는 uncached input, 실제 비용, 첫 표시까지의 시간, 총 소요 시간, UI 반응성의 개선이며, 입력을 불필요하게 늘려 비율만 높이지 않는다.

implicit 모드는 후속 턴에서 재사용할 누적 입력을 캐시에 쓴다. 같은 입력을 다시 사용하지 않는 일회성 작업에서는 cache write 비용이 증가할 수 있으므로, 실제 개선 여부는 모델별 cache read/write 및 업무 전체 비용으로 평가한다.

## 첫 묶음 구현 결과

- API 키 기반 Responses와 캐시를 활성화한 Chat Completions에서 GPT-5.6 이후 모델에 `implicit` 모드와 공통 system/developer의 `explicit` 경계를 함께 적용했다. 새 모델명/공급자 접두어도 동일한 모델 계열 규칙으로 판정한다. Codex subscription의 요청 캐시 방식이나 gateway server-compaction 지원 범위는 확대하지 않았다.
- 기본 프롬프트 생성의 중복 호출을 제거했다. custom/coordinator/task-worker 분기는 유지했다.
- 진단 로그가 `codex`, `openai-responses`, `P-GPT`를 구분하고 실제 cache options/retention, 도구 수, input item 수, 거부된 옵션을 기록한다. 인증값·프롬프트·대화 원문은 기록하지 않는다.
- 같은 프로세스에서 기존 중복 탐지 경로와 새 경로를 번갈아 실행해 7쌍을 비교했다. 중앙값 **451.92 → 242.24ms (46.40% 감소)**, 7쌍 모두 생성 프롬프트가 완전히 같았다. 이는 프롬프트 준비 구간의 로컬 측정이며 전체 앱 시작 시간·모델 지연의 46% 개선을 뜻하지 않는다.
- 측정 JSON은 ignored `.myharness/ui-checks/optimization-20260930/`에 저장했다.
- 수정 전 회귀에서 시스템만 캐시하는 모드와 환경 탐지 2회를 확인했고, 수정 후 API·프롬프트·warmup/runtime 집중 회귀 275건이 통과했다.
- 엔진·압축·카탈로그 시작·플러그인 도구 추가 회귀: 109건 통과. 마지막 예열 회귀 추가와 P-GPT factory 진단 라벨 확인 후 관련 30건 재검증 통과. 테스트 실행 간 중복이 있으므로 이 숫자를 고유 테스트 총합으로 더하지 않는다.
- 변경 Python 파일의 Ruff, `python scripts/utf8_guard.py --changed`, `git diff --check` 통과. 프런트엔드 코드를 이번 묶음에서 수정하지 않았으며 browser CPU profile/실제 P-GPT latency는 별도 미검증이다.

검증 명령:

```text
python -m pytest tests/test_api/test_prompt_cache_policy.py tests/test_prompts/test_runtime_prompt_performance.py tests/test_api/test_openai_client.py tests/test_api/test_codex_client.py tests/test_api/test_responses_contract.py tests/test_api/test_responses_progress.py tests/test_api/test_stream_retry_boundaries.py tests/test_prompts tests/test_ui/test_runtime_prefix_cache.py tests/test_ui/test_runtime_api_key.py -q
python -m pytest tests/test_engine/test_query_engine.py tests/test_services/test_compact.py tests/test_ui/test_runtime_catalog_startup.py tests/test_ui/test_runtime_plugin_tools.py -q
python -m pytest tests/test_api/test_prompt_cache_policy.py tests/test_ui/test_runtime_api_key.py -q
python scripts/utf8_guard.py --changed
git diff --check
```

첫 묶음에서는 실제 P-GPT 요청을 새로 실행하거나 사용 중인 서버를 재시작하지 않았다. 이후 사용자의 4~9번 진행 지시에 따라 아래 작업을 단계별로 적용·검증했다. 공급자 usage에 나타난 cache ratio 개선은 여전히 미측정이다.

## 후속 4~9번 적용 결과

| 순서 | 적용 내용 | 보존·회귀 확인 |
|---:|---|---|
| 4 | 공통 지침·스킬·프로젝트 지침 뒤에 Environment와 실행 설정을 배치했다. 런타임 요청과 예열에 동일한 workspace scope를 사용해 날짜/세션 설정 변화로 routing key가 바뀌는 것을 줄였다. scope를 지정하지 않은 외부 호출자는 기존 prompt hash를 유지한다 | 메시지 역할과 실제 환경값 유지, 날짜/branch/effort/fast mode 변경, 작업공간·도구 schema 격리, 예열과 실제 요청의 key 일치. 공급자가 정확한 token prefix를 다시 비교하며 cache hit를 보장하지 않는다 |
| 5 | 매 delta마다 전체 JSON을 재탐색하던 preview를 새로 들어온 구간만 처리하는 파서로 바꿨다. edit의 줄 접두어도 누적한다 | write/edit/patch/skill 및 이름이 새로 생긴 MCP 도구, 분할된 escape/Unicode/CRLF, nested field, 불완전 입력, immutable state, prototype 이름을 가진 key, canonical tool input 및 최종 내용 보존 |
| 6 | SSE id/data를 한 frame으로 쓰고 연결별 drain 대기와 8MiB 대기열 제한을 적용했다. 느린 연결만 종료하고 기존 replay cursor로 복구한다. 로그는 event-loop batch/64KiB 단위로 묶고 종료 시 flush한다 | 거짓 write 반환값의 frame을 중복 전송하지 않음, UTF-8 byte 제한, 정상 연결 격리, 중간 종료, 9MiB 단일 replay, 10,000개 frame의 부분 drain/추가 입력 순서, 로그 순서·파일 오류·종료 flush |
| 7 | 스킬 파일의 stat fingerprint를 기준으로 읽기·파싱 결과를 최대 256개 재사용한다. 프로젝트와 plugin source를 분리한다 | 디렉터리는 계속 탐색하며 새 파일·삭제·수정·atomic 교체를 반영한다. 활성화 설정과 카탈로그를 통째로 TTL 캐싱하지 않았다. 기존 MCP 병렬 연결/lifecycle을 유지한다 |
| 8 | tail이 멈추고 스크롤이 목표에 도달하면 RAF를 종료한다. 실제 텍스트·workflow·크기 변화 때 다시 시작한다 | 기존 가속·감속·lead 값 유지, 늦은 ResizeObserver 변경, restore/read-only, 사용자의 위쪽 wheel, 수동 위치 유지, 최신 응답 이동 |
| 9 | 산출물 상세 preview를 열 때 불러오도록 분리했다. 공통 상수·타입은 작은 별도 모듈로 옮겼다. 청크 로딩 실패는 즉시 오류를 표시하고 화면 새로고침으로 복구한다 | 상세·목록 전환, source/preview, 편집·capture·닫기, 실패 후 대화 재연결과 정상 preview. snapshot은 측정 후 기존 형식을 유지했다 |

### 로컬 성능 측정

아래 수치는 동일 PC의 로컬 준비/처리 구간이다. API 첫 토큰 시간, 업무 전체 완료 시간, 공급자 비용의 개선율로 해석하지 않는다.

- 프롬프트 준비: 앞서 기록한 paired 7회 중앙값 **451.92 → 242.24ms**.
- 스킬 50개를 반복 로드한 10회 중앙값: **28.34 → 11.39ms**, 약 60% 감소. 첫 cold load는 각각 64.03/94.83ms로, cold startup이 빨라졌다는 증거는 없다. 추가로 parsed cache를 매번 비우고 순서를 번갈아 실행한 12쌍은 중앙값 **28.009 → 28.782ms**였다. fingerprint 확인의 cache-miss 부담은 약 0.77ms이며 50개 스킬 내용은 매 쌍 일치했다. 이 추가 측정은 OS 파일 캐시까지 비운 물리적 cold I/O 측정은 아니다.
- reducer benchmark는 각 JSON을 2,048자씩 실제 `appReducer`에 전달하고 복원된 본문이 원본과 같은지 확인했다. 큰 입력의 본문은 약 **916,674자 / UTF-8 1.92MB**다. edit는 old/new 각각 이 크기다. benchmark의 `size=1_000_000`은 반복 횟수를 정하는 명목 값이며 실제 본문이 정확히 100만자는 아니다.

| 큰 입력 preview | 변경 전 누적 reducer 시간 | 변경 후 | 변경 후 단일 delta 최대 |
|---|---:|---:|---:|
| 신규 MCP write | 2,567.91ms | 30.85ms | 1.12ms |
| edit old/new | 29,574.44ms | 294.83ms | 3.48ms |
| apply_patch | 4,024.70ms | 124.03ms | 3.54ms |
| save_skill | 3,796.35ms | 253.24ms | 10.33ms |

- 5,000개 로그를 한 burst로 기록한 합성 측정: per-line mkdir/append **1,312.45ms → batch/flush 2.00ms**. 평상시 request latency를 같은 비율로 개선했다는 의미는 아니다. 디스크 쓰기 자체는 순서·종료 보존을 위해 batch 단위의 동기 쓰기다.
- 9번 적용 직전/직후 build의 entry JS: **1,273,765 → 1,187,800 bytes (6.75% 감소)**, gzip **379,539 → 357,906 bytes (5.70% 감소)**. 분리한 ArtifactPreview chunk는 87,574 bytes다. 이후 동시 작업 변경을 포함한 마지막 build는 entry 1,191,867 / gzip 358,950 bytes다. Mermaid/PDF/html2canvas는 이미 지연 로딩 중이었고, 초기 수식 표시를 바꾸는 추가 분할은 적용하지 않았다.
- 저장은 240개 모델 메시지와 암호화된 Responses 연속 상태를 포함한 약 1.84MB snapshot으로 확인했다. 5회 save 중앙값 **27.98ms** (첫 실행 70.43ms, 나머지 26.56~29.73ms), 최신 세션 pointer **84 bytes**, 모든 메시지와 암호화 상태 round-trip 일치. 이미 full snapshot 중복 쓰기가 제거되어 있어 저장 형식 변경·모델 메시지 pruning·추가 debounce는 적용하지 않았다.

### 검증 결과와 실제 화면

- 4번 API/프롬프트/쿼리/예열 관련 291건, 7번 스킬/plugin/설정/카탈로그 관련 62건, 저장/복구 관련 73건의 단계별 Python 검사가 통과했다. 마지막 통합 집중 회귀는 **440건 통과**다. 서로 겹치는 검사를 합산하지 않는다.
- 마지막 전체 React/Vitest: **75 files / 1,319 tests 통과**. TypeScript와 production build 통과. 마지막 빌드 때 추가된 다른 작업의 테스트 fixture 두 곳에서 필수 `createdAt` 누락과 EventSource mock cast 오류를 발견해 fixture만 최소 보정했다. 일부 기존 React 테스트의 `act` 경고와 Vite의 큰 chunk 경고는 남아 있다.
- SSE/log의 마지막 집중 Node 검사 **7건 통과**. 앞서 serverSecurity/sessionReplay/sessionReplaySpool 통합 100건 중 98건 통과, 1건 skip, history pin 목록의 messageCount 기대값 1건 실패했다. 해당 검사는 단독 재실행과 이후 **연속 3회 재실행 모두 통과**했다. 최초 실패의 원인은 확정하지 않아 전체 100건이 모두 통과했다고 보고하지 않는다.
- Codex 내장 브라우저에서 별도 port 43197과 격리 설정·mock backend를 사용했다. 실제 production React/Node/SSE를 거쳐 큰 tool input과 65행 답변을 표시하고, HTML preview/source 전환, 수식, refresh/replay, 즉시 진행 상태를 확인했다. 실제 P-GPT/유료 모델 호출은 없다.
- 스트리밍 중 수동으로 위로 스크롤한 뒤 메시지 높이는 **9,287 → 11,599px**로 증가했지만 scrollTop은 **5,954.40px로 그대로 유지**됐다. 최신 응답 이동도 확인했다.
- preview 청크 요청을 브라우저에서 일부러 차단해 오류 화면을 확인했다. 같은 URL의 dynamic import 실패가 브라우저에 캐시되어 단순 재시도로 복구되지 않는 점을 발견하고 복구 버튼을 `화면 새로고침`으로 바꿨다. 차단 해제 후 이 버튼으로 새로고침하고 기존 대화를 replay한 뒤 실제 iframe 제목 `성능 검증 보고서`를 확인했다.
- 정상 preview 검사 시 console error 0건, 가로 overflow 없음. 실패 주입 단계의 네트워크 실패는 의도된 결과다. 화면·fixture·측정 도구는 ignored `.myharness/ui-checks/optimization-20260930/` 아래에 두었다.

### 남은 확인 범위

- **실제 P-GPT cache ratio/첫 토큰/비용은 미검증**이다. 회사 OA 환경에서 공급자별 진단과 실제 usage를 비교해야 한다. workspace routing key와 안정 prefix를 보존한 테스트는 실제 cache hit 증거를 대신하지 않는다.
- **Mermaid 테마 오류 수정 완료 (2026-10-01):** `color-mix`, `oklch` 등 브라우저 CSS 색상을 Mermaid가 이해하는 RGB/알파 색상으로 변환하도록 공통 렌더러를 수정했다. 변환 캐시는 최대 64개로 제한했다. 실제 Mermaid 초기화로 수정 전 실패를 재현하고 수정 후 통과를 확인했으며, 관련 286개 테스트·프론트엔드 빌드·UTF-8 검사를 통과했다. Codex 내장 브라우저에서 채팅과 HTML 산출물 미리보기 모두 실제 SVG 표시를 확인했고 console error는 없었다. 모델 응답은 로컬 fixture를 사용했으며 Mermaid 라이브러리와 브라우저 렌더링은 실제 코드로 검증했다. 화면 증거: `.myharness/ui-checks/optimization-20260930/browser-mermaid-fixed.jpg`.
- 한 번 관측한 Git 환경 탐지 timeout과 최초 history pin 검사 실패의 원인은 확정하지 않았다. 장시간·다중 실제 사용자 부하 전체를 검증한 것으로 해석하지 않는다.
- 임시 검증 서버와 브라우저 탭은 종료하고 QA 프로젝트는 ignored 검사 폴더로 옮겨 보존했다. 사용 중인 서버는 재시작하지 않았고, 변경은 작업트리에 남겼다. 런타임 변경은 서버 재시작 후 반영된다. commit/push 및 PATCH_NOTES 수정은 하지 않았다.
