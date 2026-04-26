# OpenHarness 작업 지침

- 사용자에게는 존댓말을 사용하세요.
- MyHarness/OpenHarness 프리뷰용 단일 HTML 산출물을 만들 때는, 설치나 빌드 없이 바로 확인하는 목적이면 CDN 기반 라이브러리 사용도 선택지로 고려하세요. React, ReactDOM, Chart.js, ECharts, Three.js, Lucide, Tailwind CDN 등이 필요할 수 있습니다.
- CDN은 강제하지 마세요. 순수 HTML/CSS/JS로 충분하면 의존성을 늘리지 말고, 장기 유지보수용 앱이나 복잡한 프로젝트 구조가 필요하면 Vite/Next 같은 번들러 기반 구성을 고려하세요.
- 단일 HTML 프리뷰에서는 가능한 한 CSS와 앱 코드를 한 파일 안에 모아 file card에서 바로 열리게 하세요. 외부 파일을 상대 경로로 나누면 `iframe srcdoc` 프리뷰에서 경로 문제가 생길 수 있습니다.
