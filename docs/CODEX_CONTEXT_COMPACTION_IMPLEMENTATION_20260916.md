# Responses 전환 및 컨텍스트 압축 구현 결과

기준: [검토 보고서](CODEX_CONTEXT_COMPACTION_REVIEW_20260916.md), 사용자 제공 P-GPT Responses 예제, 사용자 확정 272K/1M 모드 정책.

## 적용한 동작

| 검토 항목 | 구현 |
|---|---|
| Responses 통일 | P-GPT 런타임이 `OpenAIResponsesClient`를 직접 생성합니다. Codex와 P-GPT 모두 일반 대화·도구 후속 요청·의미 요약·캐시 사전 준비에서 Responses를 사용합니다. 활성 두 provider에는 Chat Completions fallback이 없습니다. 비활성 legacy adapter의 독립 구현/테스트는 삭제하지 않았습니다. |
| 회사 연결 계약 | 기존 Base64 인증 조합과 환경별 설정을 유지합니다. 기본 경로는 공식 `/s0la01-gpt/v1`로 통일하고, 저장된 오타 경로 `/s01a01-gpt/v1`만 보정합니다. 임의 사용자 URL은 유지합니다. |
| 272K 비용 모드 | 명목 자동 압축 기준을 231,200에서 **264,000**으로 변경했습니다. 272,000까지 8,000토큰 여유를 둡니다. |
| 1M 전체 모드 | 명목 기준 **1,000,000**을 유지합니다. 실제 배포 창과 요청 출력 예약량 때문에 더 작은 입력 예산이 필요하면 압축을 앞당깁니다. 입력 1M과 최대 출력 128K를 동시에 보장한다는 뜻은 아닙니다. |
| 전체 요청 예산 | 시스템 지침·도구 스키마·이미지·불투명 상태를 포함합니다. 마지막 서버 입력 사용량에 신규 항목을 더하고, 이미 계상한 정적 접두부를 중복 가산하지 않습니다. 새 compaction 경계 뒤에는 이전 창의 사용량을 재사용하지 않습니다. |
| 실제 전송 직전 검사 | steering을 압축 전과 압축 중 도착 후에 반영하고 다시 예산을 검사합니다. 출력 예약을 더해 물리 창을 넘는 것으로 추정되는 요청은 전송하지 않고 제한된 반응형 복구로 넘어갑니다. |
| 원본 보존 | 요약 전에 사용자 원문을 archive에 보관하고, 세션 ID가 있는 실제 세션에서는 role/item 전체 기록을 검색 가능한 session document로 저장합니다. 저장 실패 시 원문을 잘라내지 않습니다. |
| 신규 도구 일반화 | 대량 도구 출력의 외부화에서 도구명 허용 목록을 제거했습니다. 신규 MCP에도 크기 기준을 적용하고 call ID·오류 여부·원문 참조를 유지합니다. |
| 의미 요약 우선 | 정상 자동 압축에서 앞/뒤 자르기·160자 발췌·파괴적 microcompact를 먼저 적용하지 않습니다. 이 legacy helper들은 정상 자동 경로에서 제외했습니다. |
| 요약 내용 | 목표, 제약과 승인 범위, 확정/제안 구분, 근거와 검증 시점, 남은 작업, 산출물, 실행 중 작업, 복구 참조와 원래 role을 보존하도록 합니다. 별도 reasoning scratchpad 출력을 요구하지 않습니다. |
| 품질·실패 판정 | length/max_tokens 종료, 도구 호출, 빈 응답을 정상 요약으로 채택하지 않습니다. 자동 압축 no-op/증가 결과도 거부합니다. 수동 `/compact` 실패 때 단순 발췌로 몰래 대체하지 않습니다. 취소·실패 시 기존 기록을 유지합니다. |
| 압축 후 재팽창 방지 | 과거 assistant 답변 전체를 보조 첨부로 재주입하던 경로를 짧은 미리보기와 원문 참조로 변경했습니다. |
| provider별 전략 | 기존 Codex inline compaction 지원 경로를 사용하며 거부된 선택 옵션은 해당 client에서 비활성화합니다. P-GPT의 미확인 native 기능은 기본 활성화하지 않고 Responses 의미 요약을 사용합니다. transport 오류를 Chat Completions로 우회하지 않습니다. |
| 응답 복원 | SSE와 JSON Responses를 처리하고 completed.output을 최종 기준으로 사용합니다. completed-only 회사 예제와 item-done+completed 중복 경로를 모두 처리합니다. 정상 완료 없는 EOF를 성공으로 처리하지 않습니다. 부분 출력 이후 자동 재요청도 하지 않습니다. |
| 프로토콜 보존 | Text/상태/도구 항목의 순서와 메시지 경계, phase, 원래 item ID와 call ID를 보존합니다. compaction 이전 접두부 제거 후 이전 텍스트를 다시 붙이지 않습니다. |
| native lifecycle | 완료 이벤트와 replacement state 검증 이후에만 compact_end를 내보냅니다. 다중/미완료 compaction과 중간 EOF를 성공으로 채택하지 않습니다. |
| 재개·모델 전환 | 새 필드는 기본값이 있어 이전 snapshot도 읽습니다. 상태에 endpoint/model 출처를 기록하고 호환되지 않거나 출처 없는 legacy opaque 상태는 원래 가시 기록에서 재구성합니다. 세션 ID가 있으면 전환 전 기록도 보관합니다. |
| 캐시 계측 | input/prompt 토큰 상세의 cache read/write 값을 `UsageSnapshot`과 기존 UI 집계로 전달합니다. reasoning_tokens는 output에 다시 더하지 않습니다. bounded JSONL 로그에 실제 사용량·적중률·접두부 해시를 남깁니다. 원문과 인증정보는 로그에 기록하지 않습니다. |
| 관측 | 압축 체크포인트에 전후 크기, 요약 요청 사용량, 소요 시간과 실패 기록을 남깁니다. 1M 규모 요청의 조기 timeout을 줄이기 위해 의미 요약 제한 시간을 180초로 조정했습니다. |
| 장기 메모리 | 세션 작업 상태와 영구 기억을 분리하는 지침을 추가했습니다. 새 메모리 생성/조회에 source·verified_at·scope를 지원합니다. 확인하지 않은 항목의 verified_at을 자동으로 채우지 않습니다. 인덱스 우선 조회를 유지하고 매 턴 자동 추출 LLM은 추가하지 않았습니다. |

## 참고 구현과 보류 유지

Codex 고정 커밋 `2aff7208fe95f331d9bb966bbd265c36ee5ecebf`의 `session/turn.rs`, `context_manager/history.rs`, `compact.rs`, `compact_remote_v2.rs`, compact resume/fork 테스트에서 실행 순서·완료 판정·관측 예산·재개 불변 조건을 참고했습니다. Rust 소스를 복사하거나 SDK로 엔진을 교체하지 않았습니다.

보고서에서 보류한 내부 CompactionTrigger 무조건 사용, 요약 없는 새 창 초기화, Rust 포팅, 매 턴 장기 메모리 추출은 도입하지 않았습니다. `/responses/compact`는 미확인 P-GPT 기능으로 호출하지 않습니다. 현재 필요한 전략은 지원되는 inline 경로와 일반 Responses 의미 요약입니다.

## 검증 및 운영 경계

- 회사 예제 형태의 completed-only SSE, JSON 응답, item-done 중복, cache read/write, EOF, 선택 compaction 거부와 Responses 유지 fixture를 추가했습니다.
- 원문 중간 제약 보관, 잘린 요약 거부, 신규 MCP 대량 출력 재조회, 두 차례 의미 압축 후 snapshot 재개, phase/item 순서, 작은 창의 과대 override를 검증합니다.
- 압축 중 새 지시, 취소, provider/model 변경과 legacy opaque 상태 재구성을 검사합니다.
- 기존 관련 테스트와 UTF-8 검사를 실행합니다. 최종 테스트 수치는 아래 실행 결과에 기록합니다.
- **실제 회사 P-GPT 호출 및 실제 272K/1M 장시간 업무 품질·캐시 A/B 측정은 수행하지 않았습니다.** 로컬 fixture 통과는 회사 게이트웨이의 모든 선택 옵션 지원을 증명하지 않습니다.
- 이미지/불투명 상태는 모델별 정확한 tokenizer 계약이 없는 부분에서 추정합니다. 추정 여유와 서버 overflow 복구를 사용하므로 정확히 264K에서만 발동하거나 가격 경계를 절대 넘지 않는다고 보장하지 않습니다.
- 압축은 손실 요약입니다. 원문 회수와 중단/재개 계약을 검증했지만 실제 LLM의 모든 제약·숫자 보존율은 업무 corpus로 후속 측정해야 합니다. 캐시율 자체의 상승도 아직 측정한 결과가 아닙니다.

GPT-6 Astra 관련 공식 가이드는 Chat Completions 자체도 지원하되 **도구 호출은 Responses가 필요**하다고 설명합니다. 따라서 “GPT-6는 모든 호출에서 Responses만 지원”과 구분합니다. 이번 전환 방향은 사용자의 확정 요구 및 에이전트 도구 호출에 맞습니다. [공식 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)

### 실행 결과

- API 전체, 압축, 세션 저장, query engine, 컨텍스트 모드, 런타임/캐시 사전 준비, 명령, 메모리, 설정 회귀: **455 passed, 1 deselected (30.69s)**.
- 최종 메시지·명령 흐름·도구·Responses 계약·런타임 연계 확인: **67 passed (6.85s)**. 앞 회귀 집합과 일부 겹치므로 합산한 고유 테스트 수로 표현하지 않습니다.
- 제외한 1개는 `test_checked_in_project_settings_default_to_pgpt`입니다. 사용자의 기존 작업트리 설정은 Codex인데 이 검사는 프로젝트 설정 파일이 P-GPT로 선택되어 있어야 한다고 가정합니다. 첫 확장 실행에서 이 차이로 실패한 사실을 확인했으며, 테스트 통과를 위해 사용자 모드 선택을 변경하지 않았습니다.
- `python scripts/utf8_guard.py --changed`: **71개 UTF-8 텍스트 파일 확인 통과**. 기존 다른 작업의 변경 파일도 검사 범위에 포함됩니다.
- `git diff --check`: 통과. Windows 줄바꿈 변환 안내 외에 공백 오류 없음.
- commit/push 및 회사 API 실호출은 수행하지 않았습니다.
