import { useMemo, useState } from "react";
import { sendBackendRequest, sendMessage } from "../api/messages";
import { useAppState } from "../state/app-state";
import type { McpServerItem, PluginItem, SkillItem } from "../types/backend";
import { Icon, type IconName } from "./ArtifactIcons";
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
  skillCount?: number;
  skills?: ToggleEntry[];
};

type SkillPluginGroup = {
  plugin: ToggleEntry;
  items: ToggleEntry[];
  toneIndex: number | string;
};

type HelpIntroSection = {
  title: string;
  body: string;
  itemCount: number;
};

const SKILL_GROUP_TONE_COUNT = 6;
const VIRTUAL_SKILL_TONE = "virtual";
const preferredPluginOrder = [
  "claude-for-legal-lite",
  "경영기획본부",
];
const virtualSkillPluginNames = new Set(["경영기획본부"]);
const introSectionTitles = new Set(["입력 단축키", "알아두면 좋은 기능"]);

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
  "insane-search": "일반 웹 도구나 OpenWeb로 해결되지 않는 차단·희소 웹 소스를 우회하기 위해 가능한 방법을 순차적으로 시도합니다.",
  "openweb": "OpenWeb 지원 플랫폼의 URL, 핸들, 프로필, 저장소·패키지, 논문, 플랫폼 한정 검색을 구조화된 read/search operation으로 처리합니다.",
  "plan": "코딩 전에 구현 계획을 설계해야 할 때 사용합니다.",
  "playwright-capture": "Playwright/Chromium으로 HTML 페이지를 렌더링하고 스크린샷이나 PDF로 내보낼 때 사용합니다.",
  "polish": "출시 전 MyHarness UI의 최종 다듬기와 QA가 필요할 때 사용합니다.",
  "pptx-writer": "PowerPoint, PPT/PPTX, 슬라이드 덱, 임원 보고용 발표자료를 만들거나 읽고, 편집하고, 분석하고, 변환하거나 품질을 점검할 때 사용합니다.",
  "receiving-code-review": "코드 리뷰 피드백을 받은 뒤 제안을 구현하기 전에 사용합니다.",
  "requesting-code-review": "작업 완료, 주요 기능 구현, 병합 전 단계에서 코드 리뷰가 필요할 때 사용합니다.",
  "review": "버그, 보안 문제, 품질 이슈를 찾기 위해 코드를 검토할 때 사용합니다.",
  "simplify": "코드를 더 단순하고 유지보수하기 쉽게 리팩터링할 때 사용합니다.",
  "skill-creator": "효과적인 스킬을 만들거나 기존 스킬을 업데이트하는 절차를 안내합니다.",
  "skill-evaluator": "Agent Skill, Codex Skill, MyHarness 스킬이나 .skills/**/SKILL.md 폴더의 발동 조건, 안전성, 리소스 구조, UI 메타데이터, 이름 충돌, 유지보수성, 활성화 준비 상태를 검토할 때 사용합니다.",
  "spreadsheet-analyst": "엑셀·스프레드시트 파일이 핵심 입력 또는 산출물일 때 사용합니다. XLSX, XLSM, CSV, TSV 생성·읽기·편집·검수·정리·변환, 수식·서식·차트·표·피벗·데이터 검증·업무 보고서 작성에 사용합니다.",
  "subagent-driven-development": "현재 세션에서 독립 작업이 포함된 구현 계획을 실행할 때 사용합니다.",
  "systematic-debugging": "버그, 테스트 실패, 예기치 않은 동작을 만났을 때 수정안을 제안하기 전에 사용합니다.",
  "tailwind-design-system": "Tailwind CSS v4 기반 디자인 시스템, CSS-first 테마, variant 컴포넌트, v3→v4 마이그레이션 작업에 사용합니다.",
  "test": "코드 테스트를 작성하고 실행할 때 사용합니다.",
  "test-driven-development": "기능이나 버그 수정을 구현하기 전, 구현 코드 작성 전에 사용합니다.",
  "ui-design-essence": "페이지, 컴포넌트, 대시보드, 보고서, 프로토타입, 랜딩 페이지, HTML 프리뷰를 만들거나 개선할 때의 시각 UI 디자인 기준입니다.",
  "ui-ux-pro-max": "웹과 모바일 UI/UX 설계, 계획, 구현, 검토, 개선이 필요할 때 사용합니다.",
  "using-git-worktrees": "현재 작업공간과 분리된 기능 작업이 필요하거나 구현 계획을 실행하기 전에 안전한 git worktree를 만들 때 사용합니다.",
  "verification-before-completion": "작업 완료, 수정 완료, 테스트 통과를 주장하기 직전에 검증 명령을 실행하고 결과를 확인해야 할 때 사용합니다.",
  "visual-artifact": "보고서, 대시보드, 인포그래픽, 원페이지, 슬라이드형 웹페이지 등 단일 HTML 시각 산출물이 필요할 때 사용합니다.",
  "visual-review": "브라우저에서 렌더링된 시각 산출물의 레이아웃, 내보내기, 접근성, 발표 품질을 검토할 때 사용합니다.",
  "writing-plans": "다단계 작업의 명세나 요구사항이 있고 코드를 만지기 전에 구현 계획을 작성해야 할 때 사용합니다.",
};

const koPluginDescriptionsByName: Record<string, string> = {
  "claude-for-legal-lite": "사용자가 제공한 문서와 로컬 playbook을 바탕으로 계약, 개인정보, 법무 검토를 지원합니다.",
};

function withVirtualSkillBadge(description: string, source = "") {
  const pluginName = pluginNameFromSkillSource(source);
  const text = String(description || "").trim();
  if (!virtualSkillPluginNames.has(pluginName) || text.startsWith("[가상스킬]")) {
    return text;
  }
  return `[가상스킬] ${text}`;
}

function isVirtualSkillPluginName(name: string) {
  return virtualSkillPluginNames.has(String(name || "").trim());
}

function displaySkillDescription(name: string, description: string, source = "") {
  const normalizedName = String(name || "").trim().replace(/^\$/, "").toLowerCase();
  if (normalizedName.startsWith("learned-")) {
    return "MyHarness가 반복적으로 확인한 실패 또는 해결 패턴을 다시 만났을 때 참고하는 자동 학습 스킬입니다.";
  }
  return withVirtualSkillBadge(koSkillDescriptionsByName[normalizedName] || description, source);
}

function displayPluginDescription(name: string, description: string) {
  const normalizedName = String(name || "").trim().toLowerCase();
  const text = koPluginDescriptionsByName[normalizedName] || description;
  if (!isVirtualSkillPluginName(name) || text.startsWith("[가상스킬]")) {
    return text;
  }
  return `[가상스킬] ${text}`;
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
      const source = (match[2] || "skill").trim();
      return {
        name,
        source,
        enabled: ["enabled", "활성"].includes(match[3].toLowerCase()),
        description: displaySkillDescription(name, (match[4] || "").trim(), source),
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
      const match = line.match(/^-\s+(.+?)\s+\[(enabled|disabled|활성|비활성)\]\s+\(([^)]*)\)(?::\s*(.*))?$/i);
      if (!match) return null;
      const transport = (match[3] || "").trim();
      return {
        name: match[1].trim(),
        enabled: ["enabled", "활성"].includes(match[2].toLowerCase()),
        description: (match[4] || transport).trim() || "MCP server",
        source: isSkillMcpSource(transport) ? "skill-mcp" : "mcp",
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
        description: displayPluginDescription(match[1].trim(), (match[3] || "Plugin").trim()),
        source: "plugin",
      };
    })
    .filter((item): item is ToggleEntry => Boolean(item));
}

function normalizeHelpIntro(text: string) {
  const featureTips = [
    "알아두면 좋은 기능:",
    "- 채팅 입력란에 이미지를 붙여넣으면 첨부 이미지로 전송되고, 첨부 칩에서 바로 미리볼 수 있습니다.",
    "- 20줄을 초과한 긴 글은 입력창 위에 접힌 항목으로 표시되고, 전송 시 원문 전체가 그대로 포함됩니다.",
    "- 에이전트가 만든 HTML, Markdown, CSV, 이미지, PDF 산출물은 답변 카드나 오른쪽 패널에서 바로 미리볼 수 있습니다.",
    "- Shift+Tab으로 계획모드를 켜고 꺼도 작성 중인 초안, 이미지 첨부, 긴 붙여넣기 내용은 유지됩니다.",
    "- 체크리스트가 생기면 입력창 옆 아이콘으로 접고 펼치며 진행 상황을 확인할 수 있습니다.",
  ].join("\n");
  return String(text || "")
    .replace(
      /^자주 쓰는 기능:\s*\r?\n-\s*채팅 입력란에 이미지를 복사한 뒤 붙여넣으면 이미지가 첨부됩니다\.\s*\r?\n-\s*5줄 이상 긴 글을 붙여넣거나 입력하면 하나의 그룹으로 묶어 표시하고, 원문은 그대로 전송됩니다\./gm,
      featureTips,
    )
    .replace(/^\s*-\s*@를 입력하면 현재 프로젝트 파일과 산출물을 찾아 프롬프트에 첨부하거나 참조할 수 있습니다\.\s*$/gm, "")
    .replace(/^\s*-\s*\$를 입력하면 스킬, MCP, 플러그인을 검색해 필요한 작업 능력을 바로 선택할 수 있습니다\.\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function countMarkdownListItems(body: string) {
  return String(body || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("- "))
    .length;
}

function parseHelpIntroSections(text: string): HelpIntroSection[] {
  const normalized = normalizeHelpIntro(text).trim();
  if (!normalized) return [];

  const sections: HelpIntroSection[] = [];
  let current: { title: string; lines: string[] } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    sections.push({
      title: current.title,
      body,
      itemCount: countMarkdownListItems(body),
    });
  };

  for (const line of normalized.split(/\r?\n/)) {
    const title = line.trim().replace(/:$/, "");
    if (introSectionTitles.has(title)) {
      pushCurrent();
      current = { title, lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  pushCurrent();
  return sections;
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

function isSkillMcpSource(source: string) {
  return /^(skill-mcp(?::|$)|mcp:)/i.test(String(source || "").trim());
}

function isSkillMcpItem(item: ToggleEntry) {
  return isSkillMcpSource(item.source);
}

function pluginToneIndexByName(plugins: ToggleEntry[]) {
  return new Map(plugins.map((plugin, index) => [
    plugin.name.toLowerCase(),
    isVirtualSkillPluginName(plugin.name) ? VIRTUAL_SKILL_TONE : (index + 1) % SKILL_GROUP_TONE_COUNT,
  ]));
}

function orderPluginsForHelp(plugins: ToggleEntry[]) {
  return plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((left, right) => {
      const leftRank = preferredPluginOrder.indexOf(left.plugin.name.toLowerCase());
      const rightRank = preferredPluginOrder.indexOf(right.plugin.name.toLowerCase());
      const normalizedLeftRank = leftRank >= 0 ? leftRank : preferredPluginOrder.length;
      const normalizedRightRank = rightRank >= 0 ? rightRank : preferredPluginOrder.length;
      return normalizedLeftRank - normalizedRightRank || left.index - right.index;
    })
    .map(({ plugin }) => plugin);
}

function groupSkillsByPlugin(
  items: ToggleEntry[],
  plugins: ToggleEntry[],
  pluginToneByName: Map<string, number | string>,
) {
  const pluginByName = new Map(plugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const standalone: ToggleEntry[] = [];
  const groups = new Map<string, SkillPluginGroup>();

  for (const item of items) {
    const pluginName = pluginNameFromSkillSource(item.source);
    if (!pluginName) {
      standalone.push(item);
      continue;
    }

    const plugin = pluginByName.get(pluginName) || {
      name: pluginName,
      enabled: item.enabled,
      description: "Plugin",
      source: "plugin",
    };
    const group = groups.get(pluginName) || {
      plugin,
      items: [],
      toneIndex: pluginToneByName.get(pluginName) ?? (groups.size + 1) % SKILL_GROUP_TONE_COUNT,
    };
    group.items.push(item);
    groups.set(pluginName, group);
  }

  for (const plugin of plugins) {
    if (!plugin.skills?.length) continue;
    const pluginName = plugin.name.toLowerCase();
    const group = groups.get(pluginName) || {
      plugin,
      items: [],
      toneIndex: pluginToneByName.get(pluginName) ?? (groups.size + 1) % SKILL_GROUP_TONE_COUNT,
    };
    const existingNames = new Set(group.items.map((item) => item.name.toLowerCase()));
    for (const skill of plugin.skills) {
      if (existingNames.has(skill.name.toLowerCase())) continue;
      group.items.push({
        ...skill,
        enabled: plugin.enabled === false ? false : skill.enabled,
      });
    }
    groups.set(pluginName, group);
  }

  const orderedGroups = plugins
    .map((plugin) => {
      const pluginName = plugin.name.toLowerCase();
      const group = groups.get(pluginName);
      if (group) return group;
      if (!plugin.skillCount && !plugin.skills?.length) return null;
      return {
        plugin,
        items: [],
        toneIndex: pluginToneByName.get(pluginName) ?? (groups.size + 1) % SKILL_GROUP_TONE_COUNT,
      };
    })
    .filter((group): group is SkillPluginGroup => Boolean(group));
  const listedPluginNames = new Set(plugins.map((plugin) => plugin.name.toLowerCase()));
  const unlistedGroups = [...groups.entries()]
    .filter(([pluginName]) => !listedPluginNames.has(pluginName))
    .map(([, group]) => group);

  return { standalone, groups: [...orderedGroups, ...unlistedGroups] };
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
      description: displaySkillDescription(snapshot.name || item.name, snapshot.description || item.description, source),
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

function pluginGroupStatusLabel(group: SkillPluginGroup) {
  if (!group.plugin.enabled) return "비활성";
  return "활성";
}

function helpSummaryIconName(label: string): IconName {
  if (label === "입력 단축키") return "keyboard";
  if (label === "알아두면 좋은 기능") return "sparkles";
  if (label === "스킬") return "ai";
  if (label === "MCP") return "network";
  if (label === "플러그인") return "plug";
  if (label === "사용 가능한 명령어") return "terminal";
  return "comment";
}

function mergePluginState(items: ToggleEntry[], plugins: PluginItem[]) {
  const byName = new Map(plugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  return items.map((item) => {
    const snapshot = byName.get(item.name.toLowerCase());
    if (!snapshot) return item;
    return {
      ...item,
      description: snapshot.description || item.description,
      enabled: snapshot.enabled !== false,
      skillCount: snapshot.skill_count,
      skills: Array.isArray(snapshot.skills)
        ? snapshot.skills.map((skill) => ({
          name: skill.name,
          description: displaySkillDescription(skill.name, skill.description || "", skill.source || `plugin:${item.name}`),
          enabled: skill.enabled !== false,
          source: skill.source || `plugin:${item.name}`,
        }))
        : undefined,
    };
  });
}

function mergeMcpState(items: ToggleEntry[], servers: McpServerItem[]) {
  const byName = new Map(servers.map((server) => [server.name.toLowerCase(), server]));
  return items.map((item) => {
    const status = byName.get(item.name.toLowerCase());
    if (!status) return item;
    return {
      ...item,
      enabled: status.state !== "disabled",
    };
  });
}

function mergeSkillMcpState(items: ToggleEntry[], skills: SkillItem[]) {
  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
  return items.map((item) => {
    if (!isSkillMcpItem(item)) return item;
    const snapshot = byName.get(item.name.toLowerCase());
    if (!snapshot) return item;
    return {
      ...item,
      description: displaySkillDescription(snapshot.name || item.name, snapshot.description || item.description, snapshot.source || item.source),
      enabled: snapshot.enabled !== false,
      source: snapshot.source || item.source,
    };
  });
}

function HelpSummaryTitle({ label }: { label: string }) {
  return (
    <span className="command-summary-label">
      <Icon name={helpSummaryIconName(label)} />
      <span className="command-summary-text">{label}</span>
    </span>
  );
}

export function CommandHelpMessage({ text }: { text: string }) {
  const { state, dispatch } = useAppState();
  const [toggleOverrides, setToggleOverrides] = useState<Record<string, boolean>>({});
  const parsed = useMemo(() => {
    const intro = splitCommandCatalog(text).intro;
    const commands = parseCommandCatalog(text);
    return {
      introSections: parseHelpIntroSections(intro),
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
    () => orderPluginsForHelp(mergePluginState(parsed.plugins, state.plugins).map((item) => ({
      ...item,
      enabled: toggleOverrides[`plugin:${item.name.toLowerCase()}`] ?? item.enabled,
    }))),
    [parsed.plugins, state.plugins, toggleOverrides],
  );
  const pluginEnabledByName = useMemo(
    () => new Map(pluginItems.map((item) => [item.name.toLowerCase(), item.enabled])),
    [pluginItems],
  );
  const pluginToneByName = useMemo(
    () => pluginToneIndexByName(pluginItems),
    [pluginItems],
  );
  const skillItems = useMemo(
    () => mergeSkillState(parsed.skills, state.skills, pluginEnabledByName).map((item) => ({
      ...item,
      enabled: toggleOverrides[`skill:${item.name.toLowerCase()}`] ?? item.enabled,
    })),
    [parsed.skills, pluginEnabledByName, state.skills, toggleOverrides],
  );
  const mcpItems = useMemo(
    () => mergeSkillMcpState(mergeMcpState(parsed.mcps, state.mcpServers), state.skills).map((item) => {
      const overridePrefix = isSkillMcpItem(item) ? "skill" : "mcp";
      return {
        ...item,
        enabled: toggleOverrides[`${overridePrefix}:${item.name.toLowerCase()}`] ?? item.enabled,
      };
    }),
    [parsed.mcps, state.mcpServers, state.skills, toggleOverrides],
  );
  const groupedSkillItems = useMemo(
    () => groupSkillsByPlugin(skillItems, pluginItems, pluginToneByName),
    [pluginItems, pluginToneByName, skillItems],
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

  const toggleItem = async (
    requestType: string,
    name: string,
    enabled: boolean,
    options: { localOnly?: boolean } = {},
  ) => {
    const overrideKey = requestType === "set_plugin_enabled"
      ? `plugin:${name.toLowerCase()}`
      : requestType === "set_skill_enabled"
        ? `skill:${name.toLowerCase()}`
        : requestType === "set_mcp_enabled"
          ? `mcp:${name.toLowerCase()}`
          : "";
    if (overrideKey) {
      setToggleOverrides((current) => {
        const next = { ...current, [overrideKey]: !enabled };
        if (requestType === "set_plugin_enabled") {
          const pluginName = name.toLowerCase();
          for (const skill of skillItems) {
            if (pluginNameFromSkillSource(skill.source) === pluginName) {
              next[`skill:${skill.name.toLowerCase()}`] = !enabled;
            }
          }
        }
        return next;
      });
    }
    if (options.localOnly || !state.sessionId) return;
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
      {parsed.introSections.length ? (
        <div className="command-help-intro">
          {parsed.introSections.map((section) => (
            <details className="command-card command-intro-card" key={section.title}>
              <summary>
                <HelpSummaryTitle label={section.title} />
                <span className="command-count">{section.itemCount ? `${section.itemCount}개` : "열기"}</span>
              </summary>
              <div className="command-intro-body">
                <MarkdownMessage text={section.body} />
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {parsed.hasSkills ? (
        <SkillCatalog
          label="스킬"
          standaloneItems={groupedSkillItems.standalone}
          pluginGroups={groupedSkillItems.groups}
          itemCount={skillItems.length}
          emptyText="사용 가능한 커스텀 스킬이 없습니다"
          onToggle={(item) => void toggleItem("set_skill_enabled", item.name, item.enabled)}
          onPluginToggle={(item) => void toggleItem("set_plugin_enabled", item.name, item.enabled)}
        />
      ) : null}
      {parsed.hasMcps ? (
        <ToggleCatalog
          label="MCP"
          items={mcpItems}
          emptyText="설정된 MCP 서버가 없습니다"
          onToggle={(item) => void toggleItem(isSkillMcpItem(item) ? "set_skill_enabled" : "set_mcp_enabled", item.name, item.enabled)}
        />
      ) : null}
      {parsed.hasPlugins ? (
        <ToggleCatalog
          label="플러그인"
          items={pluginItems}
          emptyText="발견된 플러그인이 없습니다"
          toneForItem={(item) => pluginToneByName.get(item.name.toLowerCase())}
          onToggle={(item) => void toggleItem("set_plugin_enabled", item.name, item.enabled)}
        />
      ) : null}
      <details className="command-card">
        <summary>
          <HelpSummaryTitle label="사용 가능한 명령어" />
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

function SkillCatalog({
  label,
  standaloneItems,
  pluginGroups,
  itemCount,
  emptyText,
  onToggle,
  onPluginToggle,
}: {
  label: string;
  standaloneItems: ToggleEntry[];
  pluginGroups: SkillPluginGroup[];
  itemCount: number;
  emptyText: string;
  onToggle: (item: ToggleEntry) => void;
  onPluginToggle: (item: ToggleEntry) => void;
}) {
  const hasItems = standaloneItems.length > 0 || pluginGroups.length > 0;
  const [standaloneCollapsed, setStandaloneCollapsed] = useState(false);
  return (
    <details className="command-card skill-card">
      <summary>
        <HelpSummaryTitle label={label} />
        <span className="command-count">{itemCount ? `${itemCount}개` : "0개"}</span>
      </summary>
      {hasItems ? (
        <div className="skill-catalog-groups">
          {standaloneItems.length ? (
            <section
              className={`skill-plugin-group${standaloneCollapsed ? " collapsed" : ""}`}
              data-skill-group-tone="0"
              role="group"
              aria-label="일반 스킬"
            >
              <button
                className="skill-section-header plugin-skill-header skill-plugin-group-trigger"
                type="button"
                aria-expanded={!standaloneCollapsed}
                aria-label={standaloneCollapsed ? "일반 스킬 펼치기" : "일반 스킬 접기"}
                data-tooltip={`일반 스킬\n클릭하면 일반 스킬 목록을 ${standaloneCollapsed ? "펼칩니다." : "접습니다."}`}
                onClick={() => setStandaloneCollapsed((current) => !current)}
              >
                <span>
                  <strong>일반 스킬</strong>
                  <small>{standaloneCollapsed ? "접힘" : "열림"}</small>
                </span>
                <span>{standaloneItems.length}개</span>
              </button>
              {standaloneCollapsed ? null : (
                <ToggleGrid label={label} items={standaloneItems} onToggle={onToggle} />
              )}
            </section>
          ) : null}
          {pluginGroups.map((group) => (
            <section
              className={`skill-plugin-group${group.plugin.enabled ? "" : " disabled collapsed"}`}
              data-skill-group-tone={group.toneIndex}
              role="group"
              aria-label={`${group.plugin.name} 플러그인 스킬`}
              key={`plugin-group:${group.plugin.name}`}
            >
              <button
                className="skill-section-header plugin-skill-header skill-plugin-group-trigger"
                type="button"
                aria-label={`${group.plugin.name} 플러그인 ${group.plugin.enabled ? "비활성화" : "활성화"}`}
                data-tooltip={`${group.plugin.name}\n클릭하면 플러그인을 ${group.plugin.enabled ? "비활성화하고 스킬 목록을 접습니다." : "활성화합니다."}`}
                onClick={() => onPluginToggle(group.plugin)}
              >
                <span>
                  <strong>{group.plugin.name}</strong>
                  <small>{pluginGroupStatusLabel(group)}</small>
                </span>
                <span>{group.plugin.skillCount ?? group.items.length}개</span>
              </button>
              {group.plugin.enabled ? (
                <ToggleGrid label={group.plugin.name} items={group.items} onToggle={onToggle} />
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <div className="command-grid skill-grid">
          <span className="skill-pill-description">{emptyText}</span>
        </div>
      )}
    </details>
  );
}

function ToggleCatalog({
  label,
  items,
  emptyText,
  toneForItem,
  onToggle,
}: {
  label: string;
  items: ToggleEntry[];
  emptyText: string;
  toneForItem?: (item: ToggleEntry) => number | string | undefined;
  onToggle: (item: ToggleEntry) => void;
}) {
  return (
    <details className="command-card skill-card">
      <summary>
        <HelpSummaryTitle label={label} />
        <span className="command-count">{items.length ? `${items.length}개` : "0개"}</span>
      </summary>
      {items.length ? (
        <ToggleGrid label={label} items={items} toneForItem={toneForItem} onToggle={onToggle} />
      ) : (
        <div className="command-grid skill-grid">
          <span className="skill-pill-description">{emptyText}</span>
        </div>
      )}
    </details>
  );
}

function ToggleGrid({
  label,
  items,
  toneForItem,
  onToggle,
}: {
  label: string;
  items: ToggleEntry[];
  toneForItem?: (item: ToggleEntry) => number | string | undefined;
  onToggle: (item: ToggleEntry) => void;
}) {
  return (
    <div className="command-grid skill-grid">
      {items.map((item) => {
        const toneIndex = toneForItem?.(item);
        return (
          <button
            className={`command-pill skill-toggle-pill${toneIndex === undefined ? "" : " skill-tone-scope"}${item.enabled ? "" : " disabled"}`}
            type="button"
            aria-pressed={item.enabled}
            data-skill-group-tone={toneIndex}
            data-tooltip={catalogTooltip(item, label)}
            key={`${label}:${item.name}`}
            onClick={() => onToggle(item)}
          >
            <span className="skill-pill-header">
              <strong>{item.name}</strong>
              <small>{item.enabled ? "활성" : "비활성"}</small>
            </span>
            <span className="skill-pill-description">{item.description || item.source || label}</span>
          </button>
        );
      })}
    </div>
  );
}
