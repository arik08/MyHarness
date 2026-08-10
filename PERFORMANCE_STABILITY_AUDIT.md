# MyHarness 성능·안정성 심층 감사

- 감사 기준일: 2026-08-10 (Asia/Seoul)
- 대상: Python 에이전트 런타임, 도구 실행, hook, background/bridge process, 세션 저장, Node 중계 서버, SSE/replay, React 상태·스트리밍 렌더링
- 목적: 느려짐, 멈춤, 프로세스 종료, 메모리·디스크 증가, 재접속/재시작 폭주를 코드·테스트·실제 로컬 데이터로 분리 진단하고 수정 순서를 정하는 것
- 구현 상태: 이 문서를 코드 수정 전에 먼저 생성한 뒤, 최우선 항목인 **P0-1 단일 도구 예외 격리**를 구현하고 전체 회귀까지 완료함

## 1. 핵심 결론

가장 먼저 고쳐야 할 결함은 `QueryEngine`의 단일 tool call 예외가 오류 결과로 변환되지 않고 백엔드 실행 경계를 탈출하는 문제다. 같은 도구 예외라도 tool call이 여러 개면 격리되지만 하나면 격리되지 않는 비대칭이 존재한다. 기존 `_BoomTool`을 이용한 무수정 동적 재현에서 `RuntimeError("boom")`이 엔진 밖으로 탈출했다. 이 예외는 `QueryEngine -> Runtime.handle_line -> backend_host` 경로를 따라 백엔드 프로세스를 종료시킬 수 있다.

두 번째로 즉시 다뤄야 할 결함은 shell timeout이 자식 프로세스 트리를 종료하지 못하고 부모 PID만 종료하는 문제다. Windows 실제 `BashTool` 경로에서 60초짜리 자식 프로세스를 만든 명령에 1초 timeout을 주었을 때 부모는 종료됐지만 자식이 stdout pipe를 계속 쥐고 있어 tool이 반환하지 않았다. 외부에서 식별된 자식을 종료한 뒤에야 5.866초에 반환했다. 이것은 단순한 정리 누락이 아니라 timeout이 무효화되는 실제 hang이며, orphan process와 자원 고갈까지 유발한다.

프런트엔드에서는 대용량 `write_file`/`save_skill` 입력을 스트리밍할 때 누적 JSON 전체를 매 flush마다 다시 훑고, 미리보기 backlog 전체를 50ms마다 배열·문자열로 재생성한다. 정상적인 대용량 HTML·스킬 작성 경로에서 초선형 CPU/GC 비용이 발생할 구조다. 다만 이 항목은 코드 복잡도와 테스트 공백은 확정됐지만 실제 Chrome profile로 long task·메모리 증가를 아직 계측하지 않았으므로, 재현이 끝난 두 백엔드 결함보다 한 단계 낮게 배치한다.

운영 로그에는 자동 복구가 실패를 증폭했을 가능성을 보여 주는 흔적도 있다. 2026-08-06 00:58:01~01:00:57 UTC(09:58:01~10:00:57 KST)에 두 Node 서버 PID에 걸쳐 `shutting_down=false`, exit code 1인 backend session 종료가 45회 기록됐고, 단일 PID `117592`에서는 40회가 연속됐다. 현재 UI의 session ID가 사라지면 즉시 새 backend를 시작하는 경로에는 지수 backoff나 circuit breaker가 없다. 다만 로그만으로 45회의 생성 원인이 모두 이 UI 경로였다고 단정하지는 않는다.

## 2. 판정 기준

### 우선순위

| 등급 | 의미 |
|---|---|
| P0 | 정상 또는 현실적인 입력으로 전체 작업/백엔드/탭이 멈추거나 종료될 수 있으며 즉시 수정 필요 |
| P1 | 장기 실행, 대용량 사용, 일시 장애에서 큰 성능 저하·메모리 증가·복구 폭주를 만들 수 있어 다음 묶음에서 수정 필요 |
| P2 | 영향이 제한적이거나 조건부이지만 누적되면 체감 문제로 발전하는 항목 |
| P3 | 장기 유지보수·관측성 부채. 단독 장애 가능성은 낮음 |

### 근거 강도

| 표기 | 의미 |
|---|---|
| 재현 확정 | 현재 코드의 실제 실행 경로로 현상을 재현함 |
| 로그 확정 | 저장소의 실제 운영 로그/데이터에서 발생 흔적을 확인함 |
| 코드 확정 | 잘못된 제어 흐름·무상한 자료구조·누락된 timeout 등 코드만으로 성립함 |
| 고위험 추정 | 구조상 위험은 강하지만 실제 부하·브라우저 profile이 아직 없음 |
| 과거 흔적 | 로그에는 많지만 현재 코드에 완화가 들어갔을 수 있어 현행 결함으로 단정하지 않음 |

## 3. 우선순위 요약

| 순위 | 등급 | 항목 | 근거 | 사용자 영향 | 상태 |
|---:|---|---|---|---|---|
| 1 | P0 | 단일 tool 예외가 backend 실행 경계를 탈출 | 재현 확정 | 대화 중단, backend 종료·재시작 | **수정·전체 회귀 완료** |
| 2 | P0 | shell timeout이 process tree를 못 죽여 무기한 hang/orphan | 재현 확정 | 취소·timeout 무효, 작업 멈춤, 자원 누수 | 후속 즉시 수정 |
| 3 | P0/P1 | 대용량 tool input preview의 초선형 파싱·복사 | 코드 확정, browser profile 미실시 | 입력 지연, 탭 정지, GC/RSS 급증 가능 | 계측 후 구조 개선 |
| 4 | P1 | backend crash 후 무제한 즉시 재시작 | 로그 확정 + 코드 확정 | 수초 간격 crash loop, CPU/로그 폭주 | backoff/circuit breaker 필요 |
| 5 | P1 | Prompt/Agent hook timeout 무효 및 retry event 처리 오류 | 코드 확정 | hook 무한 대기 또는 AttributeError crash | 계약 통합 필요 |
| 6 | P1 | transient SSE 오류를 대화 실패로 처리 | 코드 확정 | 오류 메시지 누적, busy 상태 오판 | 연결 상태 분리 필요 |
| 7 | P1 | SSE slow consumer backpressure와 byte budget 부재 | 코드 확정 | Node RSS 증가, event loop stall | client별 상한 필요 |
| 8 | P1/P2 | Node/Python process 첫 session 목록·복원 때 모든 snapshot을 migration 검사 | 로컬 데이터 계측 + 코드 확정 | 첫 history/restore 지연, 반복 재시작 시 재발 | durable migration fast-path 필요 |
| 9 | P1/P2 | turn마다 canonical full snapshot 전체를 다시 read/serialize/write | 코드 확정 | 장기 대화 종료 지연, 디스크 쓰기 증가 | delta/index 또는 비동기 durable writer 검토 |
| 10 | P1 | background task 완료 레코드·lock·로그 무상한 누적 | 코드 확정 | 메모리/목록 정렬/프로토콜/디스크 증가 | retention 필요 |
| 11 | P1 | bridge session 충돌·종료 lifecycle 누락 | 코드 확정 | child/copy task 고아화, 같은 ID 충돌 | UUID + aclose 필요 |
| 12 | P1/P2 | backend stdout 동기 write+flush | 고위험 추정, 저속 parent 미재현 | parent가 느릴 때 event loop 전체 정지 | bounded writer 필요 |
| 13 | P1 | mutation lock 해제가 React host에만 존재 | 코드 확정 | headless 경로에서 최대 300초 대기 | engine request 수명으로 이동 |
| 14 | P1 | 취소된 `to_thread` mutation은 계속 실행 | 코드 확정 위험 | lock 해제 뒤 이전 쓰기와 새 쓰기 경합 | 실제 종료까지 ownership 유지 |
| 15 | P1 | session view 전체 대화를 브라우저에서 무상한 보존 | 코드 확정 | 세션 전환마다 heap 증가 | LRU/byte budget 필요 |
| 16 | P1 | 새 EventSource 생성 시 replay cursor 유실 | 코드 확정 | 전체 대화 replay·렌더 재수행 | cursor 전달 필요 |
| 17 | P1/P2 | assistant streaming의 전역 rerender·pending 복사·live-tail 재파싱 | 코드 확정, 부하 미계측 | 장문 응답에서 버벅임 | batching/context 분리 필요 |
| 18 | P2 | request/line/steering queue 무상한 | 코드 확정 | flood 시 메모리 증가 | control 우선 bounded queue |
| 19 | P2 | provider 중간 출력 후 전체 stream 재시도 | 코드 확정 | 텍스트·tool args 중복 | 출력 시작 후 retry 금지/reset |
| 20 | P2 | 잘못된 idle env 값을 task 생성 뒤 파싱 | 코드 확정 | producer task 고아화 | 생성 전 검증 |
| 21 | P2 | HTML preview message listener 해제 누락 | 코드 확정 | iframe/session 전환 후 closure 누적 | 전역 dispatcher/cleanup |
| 22 | P2 | busy 동안 60fps 자동 스크롤 polling | 코드 확정 | thinking/tool 대기 중 CPU 사용 | 변화 기반 재개 |
| 23 | P2/P3 | runtime log 동기 append 및 rotation 부재 | 코드 확정 + 5.97MB 실데이터 | event loop I/O, 디스크 장기 증가 | buffered writer + rotation |
| 24 | P3 | compaction checkpoint 목록 무상한 | 코드 확정 | 매우 긴 세션 metadata 증가 | 최근 N개 + 집계 |

## 4. P0-1 — 단일 tool call 예외가 backend를 종료시킬 수 있음

### 수정 전 증거

아래 line은 이 문서를 처음 만들기 직전의 코드와 동적 재현 기준이다. 현재 코드는 뒤의 “구현 결과”처럼 이미 수정돼 있다.

- `src/myharness/engine/query.py:1091-1109`: tool call이 하나면 `_execute_tool_call(...)`을 직접 `await`하며 `Exception` 경계가 없다.
- `src/myharness/engine/query.py:1122-1138`: tool call이 여러 개일 때만 내부 `_run()`이 `except Exception`으로 실패를 `ToolResultBlock`으로 변환한다.
- `src/myharness/engine/query.py:1286-1305`: `_execute_tool_call()`은 `tool.execute()`가 던진 임의 예외를 그대로 전파한다.
- `src/myharness/engine/query_engine.py:253-270`: 상위 계층은 `BaseException`을 기록한 뒤 다시 던진다.
- `src/myharness/ui/runtime.py:874-897`: `handle_line()`은 `MaxTurnsExceeded`만 별도로 처리하며 일반 tool 예외를 복구하지 않는다.
- `src/myharness/ui/backend_host.py:1524-1549`: active request는 `_process_line()`의 `CancelledError`만 처리한다. 일반 예외는 host run loop를 벗어나 최상위 cleanup 후 프로세스 종료로 이어질 수 있다.
- `tests/test_engine/test_query_engine.py:2532-2595`: `_BoomTool` 회귀 테스트가 있지만 복수 tool call에만 적용돼 단일 경로의 비대칭을 놓친다.

### 동적 재현

기존 `FakeApiClient`, `_BoomTool`, 단일 `ToolUseBlock`을 사용해 코드를 수정하지 않고 실행했다. 결과는 `RuntimeError: boom`이었고, 대화 메시지는 user turn만 남았다. provider가 요구하는 대응 `tool_result`도 생성되지 않았다. 즉 “도구 실패를 대화 안의 오류 결과로 바꾸고 모델이 복구하게 한다”는 계약이 단일 호출에서 깨진다.

### 왜 1순위인가

도구 종류와 무관하게 Python 예외 하나면 발생할 수 있고, 영향 범위가 해당 tool call이 아니라 backend process 전체다. 파일·shell·MCP·플러그인 도구는 OS, 네트워크, 파싱 예외를 현실적으로 발생시킨다. 동일 실패가 호출 개수에 따라 crash 또는 정상 오류 결과로 달라지는 점도 사용자 입장에서 비결정적인 “튕김”으로 보인다.

### 최소 안전 수정

1. 단일·복수 호출이 동일한 `_execute_tool_call_safely()` 경계를 사용하게 한다.
2. `Exception`만 포착하고 `asyncio.CancelledError`와 다른 `BaseException`은 계속 전파한다.
3. 실패를 동일한 `tool_use_id`, `name`의 길이 제한된 error `ToolResultBlock`으로 변환한다.
4. 예외는 stack trace와 함께 logger에 남기되 provider에 내부 traceback 전체를 노출하지 않는다.
5. tool result를 conversation에 추가한 뒤 provider loop를 계속해 모델이 실패를 설명하거나 대안을 택할 수 있게 한다.

### 완료 조건

- 단일 `_BoomTool`이 backend 밖으로 예외를 던지지 않는다.
- 오류 `ToolResultBlock` 뒤 다음 provider 응답까지 진행해 assistant 완료 이벤트가 나온다.
- 동일 실패 뒤 같은 `QueryEngine` 인스턴스가 다음 요청도 처리한다.
- 복수 호출의 기존 동작·결과 순서가 유지된다.
- cancellation은 오류 결과로 바뀌지 않고 계속 cancellation으로 전파된다.

### 구현 결과 — 2026-08-10

- `src/myharness/engine/query.py:1167`에 private `_execute_tool_call_safely()` 경계를 추가했다.
- 단일 호출(`query.py:1101`)과 복수 호출(`query.py:1125`)이 같은 경계를 사용한다. 호출 개수에 따른 crash/복구 비대칭을 제거했다.
- `Exception`만 error `ToolResultBlock`으로 변환하므로 `asyncio.CancelledError`를 포함한 `BaseException` 계열은 계속 전파된다.
- provider에 전달하는 exception detail은 2,000자로 제한했고, exception의 `__str__` 자체가 실패해도 안전한 fallback을 사용한다. 이 두 방어는 코드 검산으로 확인했으며 경계값 전용 테스트는 후속 보강 대상이다.
- `tests/test_engine/test_query_engine.py:2533`에 단일 `_BoomTool` 회귀를 추가했다. error completion, provider 요청 안의 대응 tool result, 정상 assistant recovery, 같은 engine의 다음 사용자 요청 처리까지 검증한다.
- 집중 회귀 3개(단일 실패·복수 실패·취소), query engine 56개, 전체 Python 1,400개가 통과했다.

## 5. P0-2 — process tree 미종료로 timeout 자체가 무기한 정지

### 증거

- `src/myharness/utils/shell.py:52-121`: local shell process 생성 시 POSIX session/process group이나 Windows Job Object를 만들지 않는다.
- `src/myharness/tools/bash_tool.py:83-103,122-134`: timeout 후 부모 `process.kill()`/`terminate()`만 호출하고 `process.wait()`를 제한 없이 기다린다.
- `src/myharness/utils/subprocess_output.py:48-67`: timeout/cancel cleanup도 부모 PID만 kill한 뒤 제한 없이 wait한다. command hook이 이 함수를 공유한다.
- `src/myharness/tasks/manager.py:167-187,453-509`: background task stop/close/aclose 역시 단일 PID 종료와 일부 무제한 wait를 사용한다. `_watch_process():253-286`도 부모 종료 후 descendant가 stdout을 잡고 있으면 reader를 무기한 기다릴 수 있다.
- `src/myharness/bridge/session_runner.py:22-29`: bridge session도 같은 패턴이다. `BridgeSessionManager._copy_output():91-102` 역시 pipe EOF가 오지 않으면 copy task가 남을 수 있다.
- 기존 timeout 테스트는 단일 fake process나 단일 `sleep`만 다루며 grandchild가 pipe handle을 상속하는 실제 회귀가 없다.

### Windows 실제 재현 기록

`BashTool(timeout_seconds=1)`이 실행한 부모 Python이 60초 자식 Python을 만들도록 했다.

- parent PID: `162084`
- child PID: `116080`
- CIM에서 child의 `ParentProcessId=162084` 확인
- 1초 timeout 뒤 부모는 죽었지만 child가 stdout handle을 계속 보유
- `_terminate_process()`의 무제한 `await process.wait()`에서 반환 불가
- 5.0초에 정확히 식별한 child를 외부 cleanup한 뒤 5.866초에야 `timed_out=true`로 반환
- 이전 probe의 child PID `97308`, `127624`까지 포함해 종료 후 잔존 probe process 0을 확인

위 PID와 시간은 감사 중 수행한 격리 probe의 기록이다. 현재 네 PID는 모두 존재하지 않는다. 아직 자동화된 grandchild 회귀가 없으므로 P0-2를 “수정 완료”로 판정할 수는 없다.

### 수정 방향

- POSIX: process를 새 session/process group으로 만들고 TERM 후 bounded wait, 필요 시 KILL을 group 전체에 전달한다.
- Windows: process tree 전체를 수명 단위로 관리한다. 표준 라이브러리만 유지한다면 bounded `taskkill /PID /T /F`와 부모 fallback을 공용 helper로 제공하되, 부모가 먼저 자연 종료된 뒤 descendant만 pipe를 잡는 edge까지 보장하려면 kill-on-close Job Object가 더 강한 해법이다.
- `process.wait()`와 pipe drain 모두 반드시 별도 상한을 둔다.
- `BashTool`, `communicate_bounded`/hook, `BackgroundTaskManager`, bridge가 같은 helper와 종료 계약을 사용한다.
- 실제 grandchild가 stdout/stderr를 상속하는 회귀 테스트를 Windows와 POSIX에 둔다.
- 완료 판정에는 BashTool 총 반환 시간 상한과 descendant 소멸, `communicate_bounded` timeout/cancel, background `stop_task`/`aclose`, bridge kill을 모두 포함한다.
- kill helper 자체가 실패해도 wait/pipe drain이 무기한 되지 않아야 하며, Docker/sandbox process에 로컬 process-group 처리를 잘못 적용하지 않아야 한다.
- Windows에서는 부모가 먼저 자연 종료된 뒤 descendant만 pipe를 보유하는 edge도 별도로 검증해야 한다.

## 6. P0/P1 — 대용량 tool input preview의 초선형 처리

### 확정된 경로

- `frontend/web/src/hooks/workflowEventCoalescer.ts:34-42,78-99`: 120ms 동안 tool input delta를 문자열로 합친다.
- `frontend/web/src/state/reducer.ts:2552-2599`: 매 flush마다 전체 누적 buffer를 다시 합치고 draft를 재생성한다.
- `frontend/web/src/state/reducer.ts:1012-1070,1132-1175`: 같은 buffer의 문자열 필드를 반복 탐색하고, `raw += char` 뒤 다시 문자별 decode한다.
- `frontend/web/src/components/WorkflowPanel.tsx:631-654`: 50ms마다 pending 전체를 `Array.from()`, 두 번의 `slice().join()`으로 재구성한다.
- backlog가 1,400자 이상이어도 tick당 제거량은 최대 8자다. 80,000자를 8자/50ms로 비우면 약 500초가 필요하다.
- `WorkflowPanel.tsx:500-510,903-912`: 실행 중 80,000자를 넘으면 48,000자 tail만 preview한다. 반대로 완료 상태는 `:715-721,984-987`에서 전체 내용을 즉시 렌더하므로 완료 전환 순간의 큰 DOM 반영도 별도 위험이다.

### 위험

N바이트를 작은 delta로 받으면 이미 처리한 prefix를 반복 탐색하므로 총 작업량이 `O(N²/chunk)`에 가까워진다. 동시에 reducer 전역 state 교체, preview string 복사, React commit, GC가 겹친다. HTML 보고서·스킬처럼 큰 파일 작성은 예외 입력이 아니라 MyHarness의 정상 핵심 사용 경로다.

### 검증과 수정

1. 100KB/500KB/1MB content를 1~4KB delta로 주입해 Chrome long task, scripting/GC, INP, heap, React commit 수를 측정한다.
2. tool-call별 parse cursor와 JSON escape 상태를 보존해 새 delta만 해석한다.
3. preview backlog는 string 전체 재생성 대신 chunk deque + head offset으로 소비한다.
4. backlog 크기에 비례해 reveal 양을 늘리고 정해진 최대 시간 안에 따라잡게 한다.
5. 실행 중/완료 workflow metadata 모두에 byte budget을 둔다.

## 7. P1 상세 항목

### 7.1 backend crash의 즉시 재시작 폭주 가능성

`frontend/web/src/hooks/useBackendSession.ts:54-125`는 session ID가 없으면 바로 live session을 찾거나 새 session을 시작한다. shutdown event가 reducer에서 session ID를 비우면 같은 effect가 다시 실행된다. 재시작 횟수, 지수 backoff, 일정 시간 내 실패 circuit breaker가 없다.

2026-08-10 측정 시점의 `.myharness/logs/myharness-web-runtime.log`에는 다음이 있다.

- 파일 크기: 약 5.98MB. 앱 실행 중 계속 증가하는 파일이므로 정확한 byte 값은 측정 순간마다 달라진다.
- 전체 `backend_session_exit`: 132회
- `code=1, shutting_down=false`: 56회
- 2026-08-06 00:58:01.751~01:00:57.751 UTC: 두 PID 합계 45회, PID `117592` 단독 40회 연속 비정상 종료

약 3초 cadence의 실제 종료 기록과 현재 자동 bootstrap 경로는 crash loop 위험을 강하게 뒷받침하지만, 로그에는 각 새 session의 요청 원인이 없어 UI가 45회를 모두 만들었다고 확정할 수는 없다. 마지막 `shutting_down=false` 비정상 종료도 8월 6일이므로 현행 build에서 동일 원인이 재현됐다는 뜻은 아니다. 최소 수정은 session/workspace 단위 실패 횟수와 마지막 정상 생존 시간을 추적하고, 짧은 실패는 exponential backoff+jitter, 한계 초과는 자동 재시작 중단과 명시적 수동 재시작 버튼을 제공하는 것이다. 최초 crash의 stderr fingerprint도 마지막 한 건만이 아니라 반복 묶음으로 남겨야 한다.

### 7.2 Prompt/Agent hook timeout과 event contract 불일치

- `src/myharness/hooks/schemas.py:20-29,42-49`: PromptHook/AgentHook은 각각 기본 30/60초 timeout을 선언한다.
- `src/myharness/hooks/executor.py:182-225`: `_run_prompt_like_hook()`은 timeout을 적용하지 않고 provider stream을 직접 순회한다.
- `src/myharness/hooks/executor.py:204-210`: complete가 아닌 모든 event에 `.text`가 있다고 가정한다.
- `src/myharness/api/client.py:80-90`: `ApiRetryEvent`에는 `text`가 없다.

따라서 stalled stream은 선언 timeout을 무시하고, transient retry event는 `AttributeError`를 만들 수 있다. `asyncio.timeout()`으로 전체 stream 수명을 제한하고 text delta만 누적하며 retry/status event를 별도 처리해야 한다.

### 7.3 SSE 오류 상태와 backend 오류의 혼합

- `frontend/web/src/api/events.ts:8-23`: native EventSource에 연결 상태/onopen 계약이 없다.
- `frontend/web/src/hooks/useBackendSession.ts:141-146`: 모든 `onerror`를 일반 backend `error`로 dispatch한다.
- `frontend/web/src/state/reducer.ts:3169-3185`: 일반 error는 메시지를 추가하고 `busy=false`, workflow 실패로 바꾼다.

브라우저의 자동 reconnect 중 transient network error도 실제 대화 실패처럼 보이고 반복할 때 메시지·DOM이 누적될 수 있다. `backend_error`와 `stream_connection_state`를 분리하고 transient 상태는 단일 deduped banner로 표시해야 한다.

### 7.4 SSE backpressure와 replay byte budget 부재

- `frontend/web/server.mjs:5274-5290`: `response.write()` 반환값을 무시하고 모든 client에 즉시 쓴다.
- `frontend/web/server.mjs:6052-6061`: full replay를 동기 `for` loop로 연속 write한다.
- `frontend/web/modules/sessionReplay.js:1-2,37-41,144-151`: raw 400건, stable 1,000건 제한은 byte가 아니라 event 개수 기준이다.

느린 client는 Node writable buffer를 키우고, 큰 tool output 한 건은 건수 제한을 우회한다. client별 queued byte 상한, `drain`, slow client 종료, replay byte budget, bounded batch가 필요하다.

### 7.5 Node/Python process 첫 session 접근의 full migration scan

현재 steady-state history 목록은 metadata fast path를 이미 사용한다. `frontend/web/server.mjs:4034-4056`은 snapshot보다 새 metadata가 있으면 작은 `.meta`를 읽고, fingerprint cache도 재사용한다. `server.mjs:4095-4142`의 목록 정렬은 이 compact item을 사용한다. title/pin mutation도 metadata를 함께 갱신하며 관련 Node 회귀 테스트가 통과했다. 따라서 “매 pagination마다 full JSON을 전부 파싱한다”는 초기 가설은 현행 코드에는 맞지 않는다.

남은 문제는 process-local migration이다. `migrateWorkspaceSessionStorage()`(`server.mjs:3982-4011`)은 Node process마다 첫 history 요청에서 모든 `session-*.json`에 `migrateNamedSessionSnapshot()`을 호출한다. 이 함수는 metadata가 이미 있어도 full snapshot을 다시 read/parse/normalize하고 metadata를 기록한다(`server.mjs:3941-3953`). `migratedSessionDirectories`는 메모리 Set이라 Node 재시작 후 사라진다.

Python의 `list_session_snapshots()`와 `load_session_snapshot()`도 먼저 `migrate_session_snapshots()`를 호출한다. 이 경로 역시 process-local `_MIGRATED_SESSION_DIRS`만 사용해 새 Python process의 첫 접근에서는 `.meta` 존재 여부와 무관하게 canonical snapshot을 전수 read/parse한다(`src/myharness/services/session_storage.py:788-867`). Python metadata에는 아직 `pinned`가 없으므로 이를 authoritative index로 확장할 때 동시 갱신 계약을 함께 보완해야 한다.

현재 workspace에는 full session 243개, 합계 69,277,189 bytes, 최대 4,617,448 bytes가 있다. 단순 sequential read+`JSON.parse`만 한 warm-cache lower-bound가 226.7~258.4ms다. 실제 migration은 normalize, compare, stat, metadata write까지 수행하고 cold disk/antivirus 영향을 받는다. runtime 로그처럼 process 재시작이 잦으면 “한 번뿐인” 비용이 반복된다.

수정 방향은 Node와 Python 모두 storage version과 metadata fingerprint가 일치하는 파일을 full read 전에 건너뛰는 durable marker, 새 snapshot 저장 시 항상 versioned metadata 기록, 실제 legacy 파일만 bounded/lazy migration하는 것이다.

### 7.6 turn마다 canonical full snapshot 재작성

현행 `src/myharness/services/session_storage.py:415-504`는 full snapshot을 두 벌 쓰지 않는다. canonical `session-<id>.json` 한 벌만 full write하고, client latest는 작은 pointer로 저장한다(`:492-502`). 이 구조와 metadata fast path는 이미 올바른 보호 장치다.

남은 비용은 session이 커질수록 매 turn 기존 canonical file을 read해 pin/created metadata를 복원하고, 전체 messages/history를 다시 serialize한 뒤 full canonical file을 atomic replace한다는 점이다. `backend_host`는 event loop block을 피하려 thread로 offload하지만 line completion은 durability를 위해 완료를 기다린다. 첫 대화의 title 생성 후 추가 저장도 별도 지연 요인이 될 수 있다.

따라서 우선 1/10/50MB snapshot의 read/serialize/write/title latency를 계측해야 한다. 그 결과가 임계치를 넘으면 metadata를 full snapshot 밖의 authoritative index로 옮겨 기존 full read를 없애고, ordered durable writer 또는 append+checkpoint를 검토한다. 이미 구현된 canonical file, pointer, atomic replace, crash recovery는 유지해야 한다.

### 7.7 완료 background task와 로그의 무상한 누적

`src/myharness/tasks/manager.py:34-45,247-287`은 완료 때 process/waiter 일부만 제거하고 task record, input/output lock, generation 등을 process lifetime 동안 보존한다. `list_tasks()`는 매번 전체 copy+sort한다. 개별 log는 rotation으로 약 32MB까지 제한되지만 task 수 전체 상한과 오래된 log 삭제가 없다.

running task는 무조건 보존하고 terminal task만 최근 N개 또는 byte/time budget으로 유지해야 한다. eviction 때 모든 연관 map과 log/backup을 같은 함수에서 제거해야 한다.

### 7.8 bridge lifecycle 누락

`src/myharness/bridge/manager.py:34-50,91-102`는 같은 session ID를 검사하지 않고 map을 덮어쓰며 완료 후에도 sessions/commands/output paths를 보존한다. `/bridge spawn` ID는 UTC `HHMMSS`뿐이라 같은 초에 충돌할 수 있다. runtime close에도 bridge manager `aclose()`가 없다.

UUID/monotonic ID, duplicate atomic reject, generation-safe map cleanup, 모든 child terminate/kill/reap과 copy task cancel/await를 포함한 `aclose()`가 필요하다.

### 7.9 stdout protocol의 동기 write+flush

`src/myharness/ui/backend_host.py:4123-4134`는 asyncio lock 안에서 `sys.stdout.buffer.write()`와 `flush()`를 동기 실행한다. Node parent가 느리거나 pipe를 일시적으로 못 읽으면 backend event loop가 멈춰 cancel, provider drain, heartbeat가 함께 정지할 수 있다. tool input delta는 assistant delta와 달리 backend에서 충분히 coalesce되지 않는다.

순서를 보존하는 단일 writer와 bounded queue가 필요하며, progress/delta는 합치되 completion/error 같은 critical event는 버리면 안 된다. 느린 stdout consumer를 둔 통합 시험으로 cancel latency와 queue 상한을 확인해야 한다.

### 7.10 mutation lock 수명 불일치와 취소 race

- `src/myharness/engine/query.py:1270-1284`: mutation tool 실행 중 lock을 얻지만 엔진 자체 release가 없다.
- `src/myharness/ui/backend_host.py:2579-2594`: release는 React backend request finally에만 있다.
- direct/headless `Runtime.handle_line()` 경로는 이 release를 공유하지 않는다.
- `asyncio.to_thread`로 시작한 file mutation은 coroutine cancel 후에도 worker thread에서 계속 실행될 수 있지만 host finally는 lock을 먼저 푼다.

lock ownership을 engine request context로 옮기고 성공/예외/취소 모두 실제 mutation 종료 뒤 release해야 한다. atomic temp+replace와 barrier 기반 cancellation 회귀가 필요하다.

### 7.11 브라우저 session view 무상한 보존

`frontend/web/src/state/reducer.ts:2126-2170`의 `liveSessionViewsBySessionId`는 messages와 workflow input/output를 session별로 보존하지만 LRU/byte eviction이 없다. 현재 경로는 live session뿐 아니라 read-only history view도 cache하며, `:3528-3542`의 history row 삭제도 cached view를 제거하지 않는다. background 완료 답변 복원을 위해 cache 자체는 필요하므로 전체 초기화가 아니라 non-busy saved/read-only session을 대상으로 한 LRU+byte budget이 필요하다.

### 7.12 EventSource 교체 때 cursor 유실

서버는 `Last-Event-ID`와 `lastEventId` query를 지원하지만(`frontend/web/server.mjs:5297-5299`), client의 새 EventSource 생성 API는 cursor를 전달하지 않는다(`frontend/web/src/api/events.ts:8-10`). 동일 EventSource의 native reconnect는 브라우저가 cursor를 보존하지만, missed-completion poll 등으로 객체가 교체되면 incremental resume 대신 full `clear_transcript + replayState`가 발생할 수 있다. 마지막 `MessageEvent.lastEventId`를 저장해 새 URL에 전달해야 한다.

### 7.13 assistant streaming 렌더 증폭

assistant delta마다 reducer(`reducer.ts:2922-2948`)가 messages와 workflow state를 새로 만들고, 단일 AppState Context의 소비자들이 다시 렌더 대상이 된다. `StreamingTextRenderer.tsx:236-270`은 RAF마다 pending 전체를 배열화한다. 다만 stable Markdown chunk는 memoization되므로 “매 frame마다 완료된 전체 Markdown을 모두 parse”하는 것은 아니다. 정확한 비용은 전체 visible text의 split/source-number scan과 live tail·새 chunk의 parse/sanitize 반복이다. terminal frontend에는 이미 50ms/384자 batching 선례가 있다.

웹도 짧은 시간/byte 기준 batching, chunk queue, 완료 message row memoization, 고빈도 stream state의 context 분리를 검토해야 한다. 다만 backend가 assistant delta를 약 120ms 단위로 이미 coalesce하는 현재 경로를 고려해 실제 React profiler 후 변경 폭을 정해야 한다.

## 8. P2/P3와 조건부 위험

### 8.1 무상한 backend 요청 queue

`backend_host.py:1314-1317`의 line/followup/steering queue는 `maxsize`가 없다. 단순 bounded queue에서 stdin reader를 막으면 cancel/shutdown도 못 읽으므로 control message용 예약 용량 또는 우선 queue가 필요하다.

### 8.2 중간 출력 뒤 provider stream retry

provider client는 전체 stream attempt를 재시도하지만 이미 받은 delta는 즉시 UI로 전달된다. 일부 text/tool args 뒤 transient error가 나면 새 attempt의 앞부분이 중복될 수 있다. 첫 외부 delta 뒤에는 자동 retry를 중지하거나 명시적 `stream_reset` 계약이 필요하다.

### 8.3 잘못된 idle timeout env와 producer task

`engine/query.py:398-456`은 producer task를 만든 뒤 idle env float를 파싱하고 그 다음부터 cleanup `try/finally`에 들어간다. 잘못된 env 값이면 producer가 bounded queue가 찰 때까지 남을 수 있다. config는 task 생성 전에 검증해야 한다.

### 8.4 HTML preview listener 누수

`MarkdownMessage.tsx:1338-1376`는 preview마다 `window.message` listener를 추가하지만 iframe/component가 제거될 때 cleanup하지 않는다. 이후 message가 오면 `isConnected` 검사로 self-remove하지만, 다음 message가 오지 않으면 closure가 frame을 보존할 수 있다. 전역 dispatcher와 token map 또는 React lifecycle 기반 cleanup이 필요하다.

### 8.5 busy 중 60fps 자동 스크롤

`useMessageAutoFollow.ts:156-205`는 streaming assistant 또는 active workflow tail 상태에서 실제 내용 변화가 멈춰도 매 frame layout 값을 읽는다. 모든 busy 상태에 적용되는 것은 아니지만 긴 thinking/tool tail에서는 지속될 수 있다. target이 일정 시간 안정되면 RAF를 끄고 ResizeObserver나 실제 stream 변화 때 다시 켜야 한다.

### 8.6 runtime log와 raw diagnostic I/O

Node runtime log는 동기 `appendFileSync`이며 현재 5.97MB까지 자랐고 rotation이 없다. P-GPT raw SSE diagnostic도 opt-in 경로에서는 delta마다 동기 lock/stat/open/write를 수행한다. 둘 다 buffered writer, rotation, sampling과 별도 diagnostic flag가 필요하다.

### 8.7 compaction checkpoint retention

compaction checkpoint persisted list는 append만 하고 상한이 없다. 실제 compaction이 일어날 때만 증가하므로 P3이지만 최근 N개와 aggregate counter로 제한하는 것이 안전하다.

## 9. 과거 로그와 현행 결함을 구분해야 하는 항목

2026-08-10 측정 시 runtime log에는 `server_process_start` 약 7,958회, `server_process_exit` 7,500회, `server_listen_port_in_use` 7,466회가 있다. 그러나 port-in-use 기록 대부분은 2026-08-05 이전의 launcher 동작에서 발생했고 이후 port ownership/launch guard 변경이 들어간 이력이 있다. 8월 5일 이후에도 4회가 있으며 마지막은 `2026-08-09T19:54:14.526Z`(2026-08-10 04:54:14 KST), port 4174다. 따라서 “완전히 해결”이나 “현재도 7,466회 재현” 어느 쪽으로도 과장하면 안 된다.

대신 다음을 해야 한다.

1. 현행 launcher로 동일 port 동시 실행을 별도 격리 재현한다.
2. 로그에 schema/version 또는 app commit을 남겨 수정 전후를 분리한다.
3. rotation과 집계 counter를 도입해 과거 storm이 현재 진단을 압도하지 않게 한다.

## 10. 이미 존재하는 보호 장치

다음은 감사 중 확인한 안전장치이며, 해당 영역을 무상한 것으로 과장하면 안 된다.

- provider producer queue는 128개로 제한되고 consumer cleanup에서 producer를 cancel/gather한다.
- multi-tool 동시성은 기본 8, 최대 32이며 pending task를 finally에서 cancel한다.
- MCP tool에는 기본 120초 timeout이 있다.
- backend assistant delta는 약 120ms 단위로 coalesce된다.
- session history event는 host에서 1,000개 cap이 있고 저장 시 tool output/input 일부를 truncate/coalesce한다.
- session persistence는 canonical full snapshot 한 벌과 작은 latest pointer를 사용하며, history 목록은 metadata fast path와 fingerprint cache를 사용한다.
- 개별 background task log는 rotation으로 약 32MB까지 제한된다. 문제는 task 개수 전체 retention이다.
- runtime은 일반 MCP/provider를 닫고 backend host는 top-level에서 task manager를 닫는다. bridge와 process-tree semantics가 빠져 있는 것이 문제다.

## 11. 검증 현황

### 전체 baseline과 최종 회귀

- 수정 전 Python baseline: `python -m pytest -q` -> **1,395 passed, 19 skipped**, 219.57초
- 수정 후 현재 전체 Python: `python -m pytest -q` -> **1,400 passed, 19 skipped**, 191.20초
- 현재 Node server tests: **88/88 passed**
- 현재 Vitest: **663/663 passed**
- 변경 파일 Ruff: 통과
- `python scripts/utf8_guard.py --changed`: 통과

초기 Vitest 묶음 실행에서는 Composer focus 테스트 한 건이 실패했지만 동일 테스트 단독 실행은 1/1 통과했고, 최종 current-state 전체 실행에서는 해당 테스트를 포함해 663/663이 통과했다. 따라서 현재 재현되는 frontend 실패는 없다.

### 집중 frontend baseline

- session replay Node tests: 11/11 passed
- `useBackendSession`, `MessageList`, `ChatPanel`: 167/167 passed

이 결과는 기존 작은 입력과 정상 reconnect 동작을 보장할 뿐, 1MB tool input, slow SSE consumer, 100KB assistant stream, 수십 session heap retention을 검증하지 않는다.

### 데이터/로그 계측

- full session JSON: 243개, 합계 69,277,189 bytes, 최대 4,617,448 bytes
- session meta: 58개, 합계 10,999 bytes
- legacy/full JSON 순차 read+parse warm-cache lower-bound: 226.7~258.4ms. 현재 steady-state 목록은 metadata fast path지만 Node process 최초 migration은 full scan함
- runtime log: 약 5.98MB(실행 중 증가)
- 비정상 backend exit(`code=1`, `shutting_down=false`): 56회
- 약 176초 동안의 비정상 exit: 두 PID 합계 45회, 단일 PID 최장 40회

## 12. 구현 순서

### Phase 0 — 즉시

1. **P0-1 단일 tool 예외 격리: 완료**
2. **P0-1 단위·엔진 생존·전체 회귀: 완료**
3. P0-2 공용 process-tree lifecycle helper와 실제 grandchild 회귀: 다음 작업

### Phase 1 — crash/hang 증폭 차단

1. Prompt/Agent hook timeout/retry contract
2. backend restart exponential backoff/circuit breaker
3. SSE connection state와 backend error 분리
4. mutation lock/cancellation ownership 정리
5. bridge/background child cleanup과 retention

### Phase 2 — 대용량 성능

1. 1MB tool-input Chrome profile
2. incremental JSON field decoder + chunk queue preview
3. assistant delta batching/memoization
4. history migration durable fast-path와 대형 canonical snapshot write 계측
5. SSE byte backpressure/replay budget

### Phase 3 — 장기 운영

1. session/task/view/log retention budget
2. stdout writer와 request queue backpressure
3. structured metrics: request latency, save latency, queue depth, SSE writable length, restart count, event-loop delay
4. fault injection/load test를 CI의 느린 별도 job으로 추가

## 13. 관측성 요구사항

현재는 사용자 체감 “느림”이 provider latency, tool latency, save latency, frontend render latency 중 어디서 발생했는지 한 번에 나누기 어렵다. 다음 지표를 같은 `request_id/session_id`로 연결해야 한다.

- provider first-event, first-visible-token, complete 시간
- tool별 queue/start/end/timeout/cancel 시간과 process-tree cleanup 결과
- snapshot serialize/write/title generation 시간과 bytes
- backend stdout queue depth/blocked duration
- SSE client 수, `writableLength`, dropped/disconnected slow client 수, replay bytes
- browser reducer dispatch/React commit/long-task/preview backlog/heap
- backend crash fingerprint, 연속 실패 횟수, restart backoff 상태

로그에는 payload 본문이나 credential을 넣지 말고 type, byte count, duration, hashed fingerprint만 기록해야 한다.

## 14. 완료 정의

이번 감사의 최우선 수정은 다음 모두가 증명돼야 완료로 본다.

- 보고서가 코드 변경보다 먼저 repository root에 존재한다.
- 단일 tool exception 재현 테스트가 수정 전 실패 의미를 포착하고 수정 후 통과한다.
- 오류가 bounded `ToolResultBlock`으로 provider에 전달되고 최종 assistant 응답까지 진행한다.
- 같은 `QueryEngine`이 다음 요청을 처리하고, cancellation과 multi-tool ordering이 회귀하지 않는다.
- 관련 Python 집중 테스트, 전체 Python suite, UTF-8 guard가 통과한다.
- 기존 unrelated worktree 변경은 보존한다.
- 구현·검증 결과를 이 문서의 상태와 검증 섹션에 다시 기록한다. **완료**

UI를 수정하는 후속 Phase에서는 테스트 통과만으로 끝내지 않고 Codex 앱의 실제 브라우저 화면에서 주요 화면, 텍스트 겹침/잘림, console error, long task를 직접 확인해야 한다.
