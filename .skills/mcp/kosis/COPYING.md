# kosis 폴더 복사 및 실행

이 MCP 폴더에는 실행 코드, 호환 지원 모듈, SKILL.md와 함수별 설명서가 함께 들어 있습니다.
원래 MyHarness의 src·scripts·설치기를 복사할 필요가 없습니다. POSCO 더미는 이 이식 검증에서 제외했습니다.

1. 이 폴더 전체를 복사합니다. `runtime/_myharness_mcp_support`와 `skills/kosis/references`를 빠뜨리지 않습니다.
2. 기존 실행 환경에 의존성이 있으면 그대로 사용합니다. 새 환경은 Python 3.11 이상을 준비하고, **이 폴더에서** `python runtime/prepare.py`를 한 번 실행합니다. 준비 스크립트는 현재 Python 환경에 requirements.txt를 설치합니다. 설치 없이 확인만 하려면 `python runtime/prepare.py --check`를 사용합니다.
3. Node 기반 MCP는 Node.js 22 이상이 필요합니다. 한국 법령 MCP는 준비 단계에서 npm과 네트워크로 잠금 파일의 의존성을 설치하고 호환 패치를 적용합니다. 다른 OS로 옮길 때 기존 node_modules를 재사용하지 말고 해당 컴퓨터에서 준비합니다.
4. 대상 프로그램에 mcp.json을 등록하고, 작업 디렉터리를 **복사한 이 MCP 폴더**로 지정합니다. command의 python은 2번에서 준비한 Python이어야 합니다. 경로를 자동 해석하지 않는 클라이언트는 args를 복사한 위치의 절대경로로 설정합니다.
5. API 키·권한과 프록시·인증서는 대상 컴퓨터 설정을 사용합니다. mcp.json의 env는 기존 설정이므로 필요하면 대상 환경에 맞게 조정합니다. 저장소 루트의 API_KEY.env 자동 로딩은 원래 앱 기능이며, 다른 앱에서는 env 주입으로 대신합니다. 프로그램을 다시 연결한 뒤 조회합니다.

함수 사용법: [SKILL.md](skills/kosis/SKILL.md), [함수별 입력 형식·실수 예방](skills/kosis/references/function-inputs.md).
MCP 리소스를 지원하지 않는 호스트도 이 두 파일을 에이전트 설명서로 로드할 수 있습니다.
Python·Node 실행기, 인터넷 접근, 각 기관의 API 사용 권한은 복사 파일에 포함되는 항목이 아닙니다.
