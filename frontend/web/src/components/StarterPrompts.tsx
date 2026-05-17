import { useAppState } from "../state/app-state";
import type { ReactNode } from "react";

type StarterPrompt = {
  category: string;
  title: string;
  prompt: string;
  icon: IconName;
};

type IconName =
  | "report"
  | "competitor"
  | "disclosure"
  | "video"
  | "data"
  | "spreadsheet"
  | "workflow"
  | "code"
  | "model";

const starterPrompts: StarterPrompt[] = [
  {
    category: "보고서 작성",
    title: "주제 조사 보고서",
    prompt: "[포스코 관련 국내외 언론기사 동향]에 대해 최근 3개월의 자료를 조사하고, 보고서로 작성해줘",
    icon: "report",
  },
  {
    category: "경쟁사 분석",
    title: "경쟁사 이슈 비교",
    prompt: "(주)포스코의 해외 주요 경쟁사를 정의하고, 포스코를 포함한 각 회사별 올해 주요 이슈를 뉴스 기사 기반으로 분석해줘.",
    icon: "competitor",
  },
  {
    category: "공시 분석",
    title: "DART 공시 분석",
    prompt: "[포스코]의 DART 공시정보를 기반으로 최근 실적, 주요 사업, 투자·리스크 요인을 분석해줘",
    icon: "disclosure",
  },
  {
    category: "영상 분석",
    title: "유튜브 내용 분석",
    prompt: "[YouTube 링크]에서 설명하는 내용을 정리해줘",
    icon: "video",
  },
  {
    category: "데이터 분석",
    title: "표 데이터 보고서",
    prompt: "아래 숫자 데이터를 분석해서 주요 추세, 이상치, 원인 가설, 의사결정 포인트를 정리하고 HTML 보고서로 작성해줘.\n\n[표 데이터 붙여넣기]",
    icon: "data",
  },
  {
    category: "엑셀 모델",
    title: "투자수익성 모델",
    prompt: "[포스코의 인도 일관제철소] 투자와 관련해 투자수익성 검토 모델을 엑셀로 만들어줘.",
    icon: "spreadsheet",
  },
  {
    category: "Workflow",
    title: "업무 흐름 다이어그램",
    prompt: "[포스코 투자관리그룹]의 주요 업무를 조사하고, workflow diagram을 포함하여 전반적인 업무 흐름과 세부 사항을 정리해줘.",
    icon: "workflow",
  },
  {
    category: "프로그램",
    title: "AI 지렁이 게임",
    prompt: "최신 최적화 알고리즘이 반영된 인공지능 지렁이 게임을 HTML로 만들어줘. 먹이는 5개, 이동속도는 정상 수준의 5배, 죽으면 1초 뒤 자동 재시작되게 해줘, 벽은 통과할 수 없어.",
    icon: "code",
  },
  {
    category: "3D 모델",
    title: "태양계 시뮬레이터",
    prompt: "태양계 행성 궤도 3D 시뮬레이터를 HTML로 만들어줘. 행성들이 태양 주변을 공전하고, 속도 조절·일시정지·행성 이름 표시 기능을 포함해줘.",
    icon: "model",
  },
];

export function StarterPrompts() {
  const { dispatch } = useAppState();

  function applyPrompt(prompt: string) {
    dispatch({ type: "set_draft", value: prompt });
    window.requestAnimationFrame(() => {
      const input = document.getElementById("promptInput") as HTMLTextAreaElement | null;
      input?.focus();
      input?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  return (
    <div className="starter-prompts" aria-label="예시 질문">
      <div className="starter-prompt-grid">
        {starterPrompts.map((item) => (
          <button
            className="starter-prompt-button"
            type="button"
            key={`${item.category}-${item.title}`}
            data-tooltip={item.prompt}
            onClick={() => applyPrompt(item.prompt)}
          >
            <span className="starter-prompt-icon" aria-hidden="true">
              <StarterPromptIcon name={item.icon} />
            </span>
            <span className="starter-prompt-copy">
              <span className="starter-prompt-category">{item.category}</span>
              <span className="starter-prompt-title">{item.title}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StarterPromptIcon({ name }: { name: IconName }) {
  const path = iconPaths[name];
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      {path}
    </svg>
  );
}

const iconPaths: Record<IconName, ReactNode> = {
  report: (
    <>
      <path d="M7 3.5h7l3 3v14H7z" />
      <path d="M14 3.5v4h4" />
      <path d="M9.5 12h5" />
      <path d="M9.5 15.5h5" />
    </>
  ),
  competitor: (
    <>
      <path d="M4 18.5V9l5-3 5 3v9.5" />
      <path d="M14 18.5V8.5l3-2 3 2v10" />
      <path d="M8.5 18.5v-4" />
      <path d="M17 18.5v-3" />
    </>
  ),
  disclosure: (
    <>
      <path d="M7 4h10v16H7z" />
      <path d="M9.5 8h5" />
      <path d="M9.5 11.5h5" />
      <path d="M9.5 15h2.5" />
      <path d="M15 15l2 2 3-4" />
    </>
  ),
  video: (
    <>
      <rect x="4" y="6" width="12" height="12" rx="2" />
      <path d="m16 10 4-2.5v9L16 14" />
      <path d="m9.5 10 3 2-3 2z" />
    </>
  ),
  data: (
    <>
      <path d="M5 5h14" />
      <path d="M5 10h14" />
      <path d="M5 15h14" />
      <path d="M8 5v14" />
      <path d="M14 5v14" />
    </>
  ),
  spreadsheet: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M5 9h14" />
      <path d="M5 14h14" />
      <path d="M10 4v16" />
      <path d="M15 4v16" />
    </>
  ),
  workflow: (
    <>
      <rect x="4" y="5" width="6" height="5" rx="1.2" />
      <rect x="14" y="14" width="6" height="5" rx="1.2" />
      <path d="M10 7.5h3.5a2.5 2.5 0 0 1 2.5 2.5v4" />
      <path d="m13.5 12 2.5 2.5 2.5-2.5" />
    </>
  ),
  code: (
    <>
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
      <path d="m13 5-2 14" />
    </>
  ),
  model: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M4 12a8 3.2 0 0 0 16 0 8 3.2 0 0 0-16 0Z" />
      <path d="M6.5 6.5a8 3.2 0 0 0 11 11" />
      <path d="M17.5 6.5a8 3.2 0 0 1-11 11" />
    </>
  ),
};
