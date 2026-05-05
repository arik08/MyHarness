import { useMemo, useState } from "react";
import { sendBackendRequest, sendMessage } from "../api/messages";
import { useAppState } from "../state/app-state";
import type { SkillItem } from "../types/backend";
import { MarkdownMessage } from "./MarkdownMessage";

type CommandEntry = {
  name: string;
  description: string;
};

type ToggleEntry = {
  name: string;
  enabled: boolean;
  description: string;
  source: string;
};

const koSkillDescriptionsByName: Record<string, string> = {
  "brainstorming": "창의적 작업, 기능 생성, 컴포넌트 구축, 기능 추가, 동작 수정처럼 구현 전에 의도와 요구사항, 설계를 먼저 탐색해야 할 때 사용합니다.",
  "commit": "작업 내용을 깔끔하고 구조화된 git 커밋으로 정리해야 할 때 사용합니다.",
  "debug": "버그를 체계적으로 진단하고 수정할 때 사용합니다.",
  "design-md": "특정 회사나 제품의 스타일, 콘셉트, 시각 언어, 브랜드 느낌을 반영한 보고서, HTML 산출물, 대시보드, 페이지, UI, 시각 문서를 요청받았을 때 사용합니다.",
  "diagnose": "에이전트 실행이 실패했거나, 회귀가 생겼거나, 예상과 다른 결과가 나온 이유를 직감이 아니라 증거 기반으로 진단해야 할 때 사용합니다.",
  "dispatching-parallel-agents": "공유 상태나 순차 의존성이 없는 2개 이상의 독립 작업을 병렬로 처리할 수 있을 때 사용합니다.",
  "dot-skill": "인물이나 자료에 대한 원문을 재사용 가능한 AI 스킬로 바꾸기 위한 영어 우선 메타 스킬입니다.",
  "executing-plans": "검토 체크포인트가 포함된 작성된 구현 계획을 별도 세션에서 실행할 때 사용합니다.",
  "finishing-a-development-branch": "구현이 완료되고 모든 테스트가 통과한 뒤, 병합·PR·정리 등 개발 브랜치 통합 방식을 결정해야 할 때 사용합니다.",
  "frontend-design": "고품질 프론트엔드 인터페이스를 만들어야 할 때 사용합니다. 웹 컴포넌트, 페이지, 산출물, 포스터, 애플리케이션, 랜딩 페이지, 대시보드, React 컴포넌트, HTML/CSS 레이아웃, 웹 UI 스타일링과 시각 개선 작업에 사용합니다.",
  "insane-search": "차단된 웹사이트를 자동으로 우회하기 위해 가능한 방법을 순차적으로 시도합니다. WebFetch가 차단 오류를 반환하거나 봇 보호가 있는 플랫폼에 접근할 때 사용합니다.",
  "plan": "코딩 전에 구현 계획을 설계해야 할 때 사용합니다.",
  "playwright-capture": "Playwright/Chromium으로 HTML 페이지를 렌더링하고 스크린샷이나 PDF로 내보낼 때 사용합니다.",
  "polish": "출시 전 MyHarness UI의 최종 다듬기와 QA가 필요할 때 사용합니다.",
  "receiving-code-review": "코드 리뷰 피드백을 받은 뒤 제안을 구현하기 전에 사용합니다.",
  "requesting-code-review": "작업 완료, 주요 기능 구현, 병합 전 단계에서 코드 리뷰가 필요할 때 사용합니다.",
  "review": "버그, 보안 문제, 품질 이슈를 찾기 위해 코드를 검토할 때 사용합니다.",
  "simplify": "코드를 더 단순하고 유지보수하기 쉽게 리팩터링할 때 사용합니다.",
  "skill-creator": "효과적인 스킬을 만들거나 기존 스킬을 업데이트하는 절차를 안내합니다.",
  "subagent-driven-development": "현재 세션에서 독립 작업이 포함된 구현 계획을 실행할 때 사용합니다.",
  "systematic-debugging": "버그, 테스트 실패, 예기치 않은 동작을 만났을 때 수정안을 제안하기 전에 사용합니다.",
  "tailwind-design-system": "Tailwind CSS v4 기반 디자인 시스템, CSS-first 테마, variant 컴포넌트, v3→v4 마이그레이션 작업에 사용합니다.",
  "test": "코드 테스트를 작성하고 실행할 때 사용합니다.",
  "test-driven-development": "기능이나 버그 수정을 구현하기 전, 구현 코드 작성 전에 사용합니다.",
  "ui-design-essence": "페이지, 컴포넌트, 대시보드, 보고서, 프로토타입, 랜딩 페이지, HTML 프리뷰를 만들거나 개선할 때의 시각 UI 디자인 기준입니다.",
  "ui-ux-pro-max": "웹과 모바일 UI/UX 설계, 계획, 구현, 검토, 개선이 필요할 때 사용합니다.",
  "using-git-worktrees": "현재 작업공간과 분리된 기능 작업이 필요하거나 구현 계획을 실행하기 전에 안전한 git worktree를 만들 때 사용합니다.",
  "using-superpowers": "대화를 시작할 때 스킬을 찾고 사용하는 방식을 정하며, 답변이나 질문 전 관련 스킬을 먼저 불러와야 할 때 사용합니다.",
  "verification-before-completion": "작업 완료, 수정 완료, 테스트 통과를 주장하기 직전에 검증 명령을 실행하고 결과를 확인해야 할 때 사용합니다.",
  "visual-artifact": "보고서, 대시보드, 인포그래픽, 원페이지, 슬라이드형 웹페이지 등 단일 HTML 시각 산출물이 필요할 때 사용합니다.",
  "visual-review": "브라우저에서 렌더링된 시각 산출물의 레이아웃, 내보내기, 접근성, 발표 품질을 검토할 때 사용합니다.",
  "writing-plans": "다단계 작업의 명세나 요구사항이 있고 코드를 만지기 전에 구현 계획을 작성해야 할 때 사용합니다.",
  "writing-skills": "새 스킬을 만들거나 기존 스킬을 편집하거나 배포 전 스킬 동작을 검증할 때 사용합니다.",
};

function displaySkillDescription(name: string, description: string) {
  const normalizedName = String(name || "").trim().replace(/^\$/, "").toLowerCase();
  if (normalizedName.startsWith("learned-")) {
    return "MyHarness가 반복적으로 확인한 실패 또는 해결 패턴을 다시 만났을 때 참고하는 자동 학습 스킬입니다.";
  }
  return koSkillDescriptionsByName[normalizedName] || description;
}

export function isCommandCatalog(text: string) {
  const source = String(text || "");
  return source.includes("Available commands:") || source.includes("사용 가능한 명령어:");
}

function splitCommandCatalog(text: string) {
  const source = String(text || "");
  const marker = source.includes("사용 가능한 명령어:")
    ? "사용 가능한 명령어:"
    : "Available commands:";
  const skillMarker = source.includes("사용 가능한 스킬:")
    ? "사용 가능한 스킬:"
    : "Available skills:";
  const index = source.indexOf(marker);
  if (index < 0) {
    return { intro: "", catalog: source, skills: "" };
  }
  const skillIndex = source.indexOf(skillMarker, index + marker.length);
  return {
    intro: source.slice(0, index).trim(),
    catalog: source.slice(index, skillIndex < 0 ? undefined : skillIndex).trim(),
    skills: skillIndex < 0 ? "" : source.slice(skillIndex).trim(),
  };
}

function parseCommandCatalog(text: string): CommandEntry[] {
  const { catalog } = splitCommandCatalog(text);
  const source = String(catalog || "").replace(/^(Available commands:|사용 가능한 명령어:)\s*/i, "").trim();
  const matches = [...source.matchAll(/\/[a-z][a-z0-9-]*/g)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const start = (match.index || 0) + match[0].length;
    const end = next?.index ?? source.length;
    return {
      name: match[0],
      description: source.slice(start, end).trim(),
    };
  });
}

function splitNamedCatalog(text: string, marker: string) {
  const source = String(text || "");
  const index = source.indexOf(marker);
  if (index < 0) {
    return "";
  }
  const headings = [
    "Available skills:",
    "사용 가능한 스킬:",
    "MCP servers:",
    "MCP 서버:",
    "Plugins:",
    "플러그인:",
    "Toggle usage:",
    "전환 사용법:",
    "Available commands:",
    "사용 가능한 명령어:",
  ];
  const end = headings
    .filter((heading) => heading !== marker)
    .map((heading) => source.indexOf(heading, index + marker.length))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];
  return source.slice(index, end === undefined ? undefined : end).trim();
}

function hasNamedCatalog(text: string, ...markers: string[]) {
  return markers.some((marker) => Boolean(splitNamedCatalog(text, marker)));
}

function parseSkillCatalog(text: string): ToggleEntry[] {
  const marker = String(text || "").includes("사용 가능한 스킬:")
    ? "사용 가능한 스킬:"
    : "Available skills:";
  const source = splitNamedCatalog(text, marker)
    .replace(/^(Available skills:|사용 가능한 스킬:)\s*/i, "")
    .trim();
  if (!source || source === "(no custom skills available)" || source === "(사용자 스킬이 없습니다)") {
    return [];
  }
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = line.match(/^-\s+(.+?)(?:\s+\[([^\]]+)\])?\s+\[(enabled|disabled|활성|비활성)\]\s*:\s*(.*)$/i);
      if (!match) return null;
      const name = match[1].trim();
      return {
        name,
        source: (match[2] || "skill").trim(),
        enabled: ["enabled", "활성"].includes(match[3].toLowerCase()),
        description: displaySkillDescription(name, (match[4] || "").trim()),
      };
    })
    .filter((item): item is ToggleEntry => Boolean(item));
}

function parseMcpCatalog(text: string): ToggleEntry[] {
  const marker = String(text || "").includes("MCP 서버:") ? "MCP 서버:" : "MCP servers:";
  const source = splitNamedCatalog(text, marker)
    .replace(/^(MCP servers:|MCP 서버:)\s*/i, "")
    .trim();
  if (!source || source === "(no MCP servers configured)" || source === "(설정된 MCP 서버가 없습니다)") {
    return [];
  }
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = line.match(/^-\s+(.+?)\s+\[(enabled|disabled|활성|비활성)\]\s+\(([^)]*)\)/i);
      if (!match) return null;
      return {
        name: match[1].trim(),
        enabled: ["enabled", "활성"].includes(match[2].toLowerCase()),
        description: match[3].trim() || "MCP server",
        source: "mcp",
      };
    })
    .filter((item): item is ToggleEntry => Boolean(item));
}

function parsePluginCatalog(text: string): ToggleEntry[] {
  const marker = String(text || "").includes("플러그인:") ? "플러그인:" : "Plugins:";
  const source = splitNamedCatalog(text, marker)
    .replace(/^(Plugins:|플러그인:)\s*/i, "")
    .trim();
  if (!source || source === "(no plugins discovered)" || source === "(발견된 플러그인이 없습니다)") {
    return [];
  }
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = line.match(/^-\s+(.+?)\s+\[(enabled|disabled|활성|비활성)\](?::\s*(.*))?$/i);
      if (!match) return null;
      return {
        name: match[1].trim(),
        enabled: ["enabled", "활성"].includes(match[2].toLowerCase()),
        description: (match[3] || "Plugin").trim(),
        source: "plugin",
      };
    })
    .filter((item): item is ToggleEntry => Boolean(item));
}

function formatHelpIntro(text: string) {
  return String(text || "")
    .replace(/^입력 단축키:\s*$/gm, "**입력 단축키**")
    .replace(/^자주 쓰는 기능:\s*$/gm, "**자주 쓰는 기능**");
}

function optimisticSkillSnapshot(skills: SkillItem[], items: ToggleEntry[], name: string, enabled: boolean): SkillItem[] {
  const source = skills.length
    ? skills
    : items.map((item) => ({
      name: item.name,
      description: item.description,
      source: item.source,
      enabled: item.enabled,
    }));
  return source.map((skill) => (
    skill.name.toLowerCase() === name.toLowerCase()
      ? { ...skill, enabled }
      : skill
  ));
}

function pluginNameFromSkillSource(source: string) {
  const match = String(source || "").trim().match(/^plugin:(.+)$/i);
  return match?.[1]?.trim().toLowerCase() || "";
}

function mergeSkillState(
  items: ToggleEntry[],
  skills: SkillItem[],
  pluginEnabledByName: Map<string, boolean>,
) {
  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
  return items.map((item) => {
    const snapshot = byName.get(item.name.toLowerCase());
    const source = snapshot?.source || item.source;
    const pluginName = pluginNameFromSkillSource(source);
    const pluginEnabled = pluginName ? pluginEnabledByName.get(pluginName) : undefined;
    if (!snapshot) {
      return pluginEnabled === false ? { ...item, enabled: false } : item;
    }
    return {
      ...item,
      enabled: pluginEnabled === false ? false : snapshot.enabled !== false,
      description: snapshot.description || item.description,
      source,
    };
  });
}

function catalogTooltip(item: ToggleEntry, fallback: string) {
  return [
    item.name,
    item.description || item.source || fallback,
  ].filter(Boolean).join("\n");
}

export function CommandHelpMessage({ text }: { text: string }) {
  const { state, dispatch } = useAppState();
  const [toggleOverrides, setToggleOverrides] = useState<Record<string, boolean>>({});
  const parsed = useMemo(() => {
    const commands = parseCommandCatalog(text);
    return {
      intro: splitCommandCatalog(text).intro,
      commands,
      skills: parseSkillCatalog(text),
      mcps: parseMcpCatalog(text),
      plugins: parsePluginCatalog(text),
      hasSkills: hasNamedCatalog(text, "Available skills:", "사용 가능한 스킬:"),
      hasMcps: hasNamedCatalog(text, "MCP servers:", "MCP 서버:"),
      hasPlugins: hasNamedCatalog(text, "Plugins:", "플러그인:"),
    };
  }, [text]);
  const pluginItems = useMemo(
    () => parsed.plugins.map((item) => ({
      ...item,
      enabled: toggleOverrides[`plugin:${item.name.toLowerCase()}`] ?? item.enabled,
    })),
    [parsed.plugins, toggleOverrides],
  );
  const pluginEnabledByName = useMemo(
    () => new Map(pluginItems.map((item) => [item.name.toLowerCase(), item.enabled])),
    [pluginItems],
  );
  const skillItems = useMemo(
    () => mergeSkillState(parsed.skills, state.skills, pluginEnabledByName).map((item) => ({
      ...item,
      enabled: toggleOverrides[`skill:${item.name.toLowerCase()}`] ?? item.enabled,
    })),
    [parsed.skills, pluginEnabledByName, state.skills, toggleOverrides],
  );

  const describeCommand = (name: string, fallback: string) =>
    state.commands.find((command) => command.name === name)?.description || fallback || "명령어를 실행합니다";

  const runCommand = async (command: string) => {
    if (!state.sessionId) return;
    dispatch({ type: "set_busy", value: true });
    try {
      await sendMessage({ sessionId: state.sessionId, clientId: state.clientId, line: command, attachments: [] });
    } catch (error) {
      dispatch({ type: "set_busy", value: false });
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const toggleItem = async (requestType: string, name: string, enabled: boolean) => {
    if (!state.sessionId) return;
    const overrideKey = requestType === "set_plugin_enabled"
      ? `plugin:${name.toLowerCase()}`
      : requestType === "set_skill_enabled"
        ? `skill:${name.toLowerCase()}`
        : "";
    if (overrideKey) {
      setToggleOverrides((current) => ({ ...current, [overrideKey]: !enabled }));
    }
    try {
      await sendBackendRequest(state.sessionId, state.clientId, { type: requestType, value: name, enabled: !enabled });
      if (requestType === "set_skill_enabled") {
        dispatch({
          type: "backend_event",
          event: {
            type: "skills_snapshot",
            skills: optimisticSkillSnapshot(state.skills, skillItems, name, !enabled),
          },
        });
      }
    } catch (error) {
      if (overrideKey) {
        setToggleOverrides((current) => ({ ...current, [overrideKey]: enabled }));
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  return (
    <div className="command-help-stack">
      {parsed.intro ? (
        <div className="command-help-intro">
          <MarkdownMessage text={formatHelpIntro(parsed.intro)} />
        </div>
      ) : null}
      {parsed.hasSkills ? (
        <ToggleCatalog
          label="Skills"
          items={skillItems}
          emptyText="No custom skills available"
          onToggle={(item) => void toggleItem("set_skill_enabled", item.name, item.enabled)}
        />
      ) : null}
      {parsed.hasMcps ? (
        <ToggleCatalog
          label="MCP"
          items={parsed.mcps}
          emptyText="No MCP servers configured"
          onToggle={(item) => void toggleItem("set_mcp_enabled", item.name, item.enabled)}
        />
      ) : null}
      {parsed.hasPlugins ? (
        <ToggleCatalog
          label="Plugins"
          items={pluginItems}
          emptyText="No plugins discovered"
          onToggle={(item) => void toggleItem("set_plugin_enabled", item.name, item.enabled)}
        />
      ) : null}
      <details className="command-card" open>
        <summary>
          <span>사용 가능한 명령어</span>
          <span className="command-count">{parsed.commands.length ? `${parsed.commands.length}개` : "열기"}</span>
        </summary>
        <div className="command-grid">
          {parsed.commands.length ? parsed.commands.map((command) => (
            <button className="command-pill" type="button" key={command.name} onClick={() => void runCommand(command.name)}>
              <strong>{command.name}</strong>
              <span>{describeCommand(command.name, command.description)}</span>
            </button>
          )) : (
            <MarkdownMessage text={text} />
          )}
        </div>
      </details>
    </div>
  );
}

function ToggleCatalog({
  label,
  items,
  emptyText,
  onToggle,
}: {
  label: string;
  items: ToggleEntry[];
  emptyText: string;
  onToggle: (item: ToggleEntry) => void;
}) {
  return (
    <details className="command-card skill-card" open>
      <summary>
        <span>{label}</span>
        <span className="command-count">{items.length ? `${items.length}개` : "0개"}</span>
      </summary>
      <div className="command-grid skill-grid">
        {items.length ? items.map((item) => (
          <button
            className={`command-pill skill-toggle-pill${item.enabled ? "" : " disabled"}`}
            type="button"
            aria-pressed={item.enabled}
            data-tooltip={catalogTooltip(item, label)}
            key={`${label}:${item.name}`}
            onClick={() => onToggle(item)}
          >
            <span className="skill-pill-header">
              <strong>{item.name}</strong>
              <small>{item.enabled ? "Active" : "Inactive"}</small>
            </span>
            <span className="skill-pill-description">{item.description || item.source || label}</span>
          </button>
        )) : (
          <span className="skill-pill-description">{emptyText}</span>
        )}
      </div>
    </details>
  );
}
