import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHelpMessage } from "../CommandHelpMessage";
import { Composer } from "../Composer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({
  cancelMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendBackendRequest: vi.fn().mockResolvedValue({ ok: true }),
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../api/session", () => ({
  startSession: vi.fn().mockResolvedValue({ sessionId: "session-new" }),
}));

function SkillsSnapshotButton() {
  const { dispatch } = useAppState();
  return (
    <button
      type="button"
      onClick={() => dispatch({
        type: "backend_event",
        event: {
          type: "skills_snapshot",
          skills: [
            { name: "ship", description: "Shipping checklist", source: "project", enabled: false },
            { name: "review", description: "Review checklist", source: "project", enabled: true },
          ],
        },
      })}
    >
      snapshot
    </button>
  );
}

async function openHelpSection(user: ReturnType<typeof userEvent.setup>, label: string) {
  const summary = screen.getAllByText(label)
    .map((node) => node.closest("summary"))
    .find((node): node is HTMLElement => Boolean(node));
  if (!summary) throw new Error(`Help section not found: ${label}`);
  await user.click(summary);
}

function expectHelpSectionIcon(label: string) {
  const summary = screen.getByText(label).closest("summary");
  expect(summary?.querySelector(".command-summary-label svg")).toBeTruthy();
}

describe("CommandHelpMessage", () => {
  beforeEach(() => {
    vi.mocked(sendBackendRequest).mockClear();
  });

  it("starts help catalog sections collapsed", () => {
    const helpText = [
      "사용 가능한 스킬:",
      "- ship [project] [활성]: Shipping checklist",
      "",
      "MCP 서버:",
      "(설정된 MCP 서버가 없습니다)",
      "",
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "pptx-writer",
              description: "Use when creating, editing, reading, analyzing, converting, or quality-checking PowerPoint decks.",
              source: "project",
              enabled: true,
            },
            {
              name: "skill-evaluator",
              description: "Use when assessing, installing, updating, or reviewing Agent Skills.",
              source: "project",
              enabled: true,
            },
            {
              name: "spreadsheet-analyst",
              description: "Use when a spreadsheet is the primary input or output.",
              source: "project",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    for (const label of ["스킬", "MCP", "플러그인", "사용 가능한 명령어"]) {
      const details = screen.getByText(label).closest("details") as HTMLDetailsElement | null;
      expect(details?.open).toBe(false);
      expectHelpSectionIcon(label);
    }
  });

  it("upgrades the legacy frequent-features help block in existing sessions", async () => {
    const user = userEvent.setup();
    const helpText = [
      "입력 단축키:",
      "- !: 로컬 CLI 명령어를 바로 실행합니다.",
      "",
      "자주 쓰는 기능:",
      "- 채팅 입력란에 이미지를 복사한 뒤 붙여넣으면 이미지가 첨부됩니다.",
      "- 5줄 이상 긴 글을 붙여넣거나 입력하면 하나의 그룹으로 묶어 표시하고, 원문은 그대로 전송됩니다.",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    expect(screen.getByText("알아두면 좋은 기능")).toBeTruthy();
    expect(screen.getByText(/첨부 칩에서 바로 미리볼 수 있습니다/)).toBeTruthy();
    expect(screen.getByText(/20줄을 초과한 긴 글/)).toBeTruthy();
    expect(screen.getByText(/HTML, Markdown, CSV/)).toBeTruthy();
    expect(screen.getByText(/체크리스트가 생기면/)).toBeTruthy();
    expect(screen.queryByText("자주 쓰는 기능")).toBeNull();
    expect(screen.queryByText(/5줄 이상 긴 글/)).toBeNull();
    expect(screen.queryByText(/현재 프로젝트 파일과 산출물을 찾아/)).toBeNull();
    expect(screen.queryByText(/스킬, MCP, 플러그인을 검색해/)).toBeNull();
    expectHelpSectionIcon("입력 단축키");
    expectHelpSectionIcon("알아두면 좋은 기능");

    const shortcutDetails = screen.getByText("입력 단축키").closest("details") as HTMLDetailsElement | null;
    const featureDetails = screen.getByText("알아두면 좋은 기능").closest("details") as HTMLDetailsElement | null;
    expect(shortcutDetails?.open).toBe(false);
    expect(featureDetails?.open).toBe(false);

    await user.click(screen.getByText("입력 단축키").closest("summary") as HTMLElement);
    await user.click(screen.getByText("알아두면 좋은 기능").closest("summary") as HTMLElement);
    expect(shortcutDetails?.open).toBe(true);
    expect(featureDetails?.open).toBe(true);

    await user.click(screen.getByText("입력 단축키").closest("summary") as HTMLElement);
    await user.click(screen.getByText("알아두면 좋은 기능").closest("summary") as HTMLElement);
    expect(shortcutDetails?.open).toBe(false);
    expect(featureDetails?.open).toBe(false);
  });

  it("removes duplicated shortcut tips from the features block in live sessions", () => {
    const helpText = [
      "입력 단축키:",
      "- @: 현재 프로젝트의 파일을 선택해 프롬프트에 첨부하거나 참조합니다.",
      "- $: 사용할 스킬, MCP, 플러그인을 선택해 프롬프트에 넣습니다.",
      "",
      "알아두면 좋은 기능:",
      "- 채팅 입력란에 이미지를 붙여넣으면 첨부 이미지로 전송되고, 첨부 칩에서 바로 미리볼 수 있습니다.",
      "- 20줄을 초과한 긴 글은 입력창 위에 접힌 항목으로 표시되고, 전송 시 원문 전체가 그대로 포함됩니다.",
      "- @를 입력하면 현재 프로젝트 파일과 산출물을 찾아 프롬프트에 첨부하거나 참조할 수 있습니다.",
      "- $를 입력하면 스킬, MCP, 플러그인을 검색해 필요한 작업 능력을 바로 선택할 수 있습니다.",
      "- 에이전트가 만든 HTML, Markdown, CSV, 이미지, PDF 산출물은 답변 카드나 오른쪽 패널에서 바로 미리볼 수 있습니다.",
      "- Shift+Tab으로 계획모드를 켜고 꺼도 작성 중인 초안, 이미지 첨부, 긴 붙여넣기 내용은 유지됩니다.",
      "- 체크리스트가 생기면 입력창 옆 아이콘으로 접고 펼치며 진행 상황을 확인할 수 있습니다.",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    expect(screen.getByText("입력 단축키").closest("details")?.textContent).toContain("@:");
    expect(screen.getByText("알아두면 좋은 기능").closest("details")?.textContent).toContain("5개");
    expect(screen.queryByText(/현재 프로젝트 파일과 산출물을 찾아/)).toBeNull();
    expect(screen.queryByText(/스킬, MCP, 플러그인을 검색해/)).toBeNull();
  });

  it("updates the visible skill state when the backend snapshot changes", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- ship [project] [활성]: Shipping checklist",
      "- review [project] [활성]: Review checklist",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            { name: "ship", description: "Shipping checklist", source: "project", enabled: true },
            { name: "review", description: "Review checklist", source: "project", enabled: true },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
        <SkillsSnapshotButton />
        <Composer />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    const shipCard = screen.getByRole("button", { name: /ship/ });
    await user.click(shipCard);
    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "ship", enabled: false },
    );

    await user.click(screen.getByRole("button", { name: "snapshot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /ship/ }).textContent).toContain("비활성"));

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$");
    expect(screen.queryByRole("option", { name: /\$ship/ })).toBeNull();
    expect(screen.getByRole("option", { name: /\$review/ })).toBeTruthy();
  });

  it("adds translated skill descriptions to the shared tooltip layer", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- frontend-design [project] [활성]: Create distinctive, production-grade frontend interfaces with high design quality.",
      "- pptx-writer [project] [활성]: Use when creating, editing, reading, analyzing, converting, or quality-checking PowerPoint decks.",
      "- skill-evaluator [project] [활성]: Use when assessing, installing, updating, or reviewing Agent Skills.",
      "- spreadsheet-analyst [project] [활성]: Use when a spreadsheet is the primary input or output.",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    const tooltip = screen.getByRole("button", { name: /frontend-design/ }).getAttribute("data-tooltip") || "";
    expect(tooltip).toContain("고품질 프론트엔드 인터페이스");
    expect(tooltip).not.toContain("Create distinctive");

    const pptxTooltip = screen.getByRole("button", { name: /pptx-writer/ }).getAttribute("data-tooltip") || "";
    expect(pptxTooltip).toContain("발표자료");
    expect(pptxTooltip).not.toContain("Use when creating");

    const evaluatorTooltip = screen.getByRole("button", { name: /skill-evaluator/ }).getAttribute("data-tooltip") || "";
    expect(evaluatorTooltip).toContain("발동 조건");
    expect(evaluatorTooltip).not.toContain("Use when assessing");

    const spreadsheetTooltip = screen.getByRole("button", { name: /spreadsheet-analyst/ }).getAttribute("data-tooltip") || "";
    expect(spreadsheetTooltip).toContain("엑셀");
    expect(spreadsheetTooltip).not.toContain("spreadsheet is the primary");
  });

  it("translates plugin descriptions in plugin catalog tooltips", async () => {
    const user = userEvent.setup();
    const helpText = [
      "플러그인:",
      "- claude-for-legal-lite [활성]: Legal review skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "플러그인");
    const legalPlugin = screen.getByRole("button", { name: /claude-for-legal-lite/ });
    expect(legalPlugin.textContent).toContain("법무 검토");
    expect(legalPlugin.textContent).not.toContain("Legal review");
    expect(legalPlugin.getAttribute("data-tooltip")).toContain("계약");
    expect(legalPlugin.getAttribute("data-tooltip")).not.toContain("Legal review");
  });

  it("orders POSCO skill after the existing preferred plugins", async () => {
    const user = userEvent.setup();
    const helpText = [
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "- POSCO 스킬 [활성]: 업무 자료 정리",
      "- claude-for-legal-lite [활성]: Legal review skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    const { container } = render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "플러그인");
    const pluginCard = Array.from(container.querySelectorAll("details.command-card"))
      .find((card) => card.querySelector("summary")?.textContent?.includes("플러그인"));
    const pluginNames = Array.from(pluginCard?.querySelectorAll("button.skill-toggle-pill strong") ?? [])
      .map((node) => node.textContent);
    expect(pluginNames).toEqual([
      "claude-for-legal-lite",
      "POSCO 스킬",
      "workflow-kit",
    ]);
  });

  it("renders POSCO skill as a collapsible headquarters tree with business skills", async () => {
    const user = userEvent.setup();
    const poscoSkills = [
      "경영 Skill",
      "안전보건환경본부",
      "사장직속",
      "경영기획본부",
      "전략투자본부",
      "경영지원본부",
      "마케팅본부",
      "구매본부",
      "포항제철소",
      "광양제철소",
      "기술연구원",
    ];
    const helpText = [
      "사용 가능한 스킬:",
      ...poscoSkills.map((name) => `- ${name} [plugin:POSCO 스킬] [활성]: ${name} 업무 자료 정리와 보고 준비를 지원합니다.`),
      "",
      "플러그인:",
      "- POSCO 스킬 [활성]: 업무 자료 정리",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: poscoSkills.map((name) => ({
            name,
            description: `${name} 업무 자료 정리와 보고 준비를 지원합니다.`,
            source: "plugin:POSCO 스킬",
            enabled: true,
          })),
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await openHelpSection(user, "플러그인");

    const poscoGroup = screen.getByRole("group", { name: "POSCO 스킬" });
    expect(within(poscoGroup).getByText("POSCO 스킬")).toBeTruthy();
    expect(within(poscoGroup).queryByText("본부별 업무 스킬")).toBeNull();
    expect(within(poscoGroup).getByText("11개 본부")).toBeTruthy();

    const tree = within(poscoGroup).getByRole("tree", { name: "POSCO 스킬 본부 목록" });
    const treeNames = Array.from(tree.querySelectorAll(".posco-skill-tree-node strong"))
      .map((node) => node.textContent);
    expect(treeNames).toEqual(poscoSkills);
    const planningNode = within(poscoGroup).getByText("경영기획본부").closest("button") as HTMLElement;
    expect(planningNode.querySelector("small")?.textContent).toContain("업무 자료");
    expect(planningNode.hasAttribute("data-tooltip")).toBe(false);
    expect(within(poscoGroup).queryByText("부서")).toBeNull();
    expect(within(poscoGroup).queryByText("전략 시나리오")).toBeNull();

    await user.click(planningNode);
    expect(within(poscoGroup).getByText("전략 시나리오")).toBeTruthy();
    expect(within(poscoGroup).getByText("사업계획 점검")).toBeTruthy();
    expect(within(poscoGroup).getByRole("button", { name: "경영기획본부 업무 스킬 접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(poscoGroup.querySelector(".posco-skill-tree-dot")).toBeTruthy();
    const scenarioLeaf = within(poscoGroup).getByText("전략 시나리오").closest(".posco-skill-tree-leaf") as HTMLElement;
    expect(scenarioLeaf.querySelector("small")?.textContent).toContain("시장");
    expect(scenarioLeaf.hasAttribute("data-tooltip")).toBe(false);
    expect(poscoGroup.querySelector("[data-tooltip]")).toBeNull();

    await user.click(within(poscoGroup).getByRole("button", { name: "전략 시나리오 비활성화" }));
    expect(within(poscoGroup).getByRole("button", { name: "전략 시나리오 활성화" }).querySelector(".posco-skill-tree-state")?.textContent).toBe("비활성");

    await user.click(planningNode);
    expect(within(poscoGroup).queryByText("전략 시나리오")).toBeNull();
    expect(sendBackendRequest).not.toHaveBeenCalled();

    await user.click(within(poscoGroup).getByRole("button", { name: "경영기획본부 비활성화" }));
    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "경영기획본부", enabled: false },
    );

    await user.click(within(poscoGroup).getByRole("button", { name: "POSCO 스킬 트리 접기" }));
    expect(within(poscoGroup).queryByRole("tree", { name: "POSCO 스킬 본부 목록" })).toBeNull();
    expect(within(poscoGroup).getByRole("button", { name: "POSCO 스킬 트리 펼치기" }).getAttribute("aria-expanded")).toBe("false");

    const pluginButtons = screen.getAllByRole("button", { name: /POSCO 스킬/ });
    expect(pluginButtons.some((button) => button.getAttribute("data-skill-group-tone") === "virtual")).toBe(true);
  });

  it("shows configured POSCO MCP connectors with minimal labels", async () => {
    const user = userEvent.setup();
    const helpText = [
      "MCP 서버:",
      "- posco-email [활성] (stdio): POSCO 메일 데이터 연동",
      "- posco-calender [활성] (stdio): POSCO 일정 데이터 연동",
      "- posco-ecm [활성] (stdio): ECM 문서 데이터 연동",
      "- posco-datalake [활성] (stdio): 데이터레이크 정형 데이터 연동",
      "- posco-ontology [활성] (stdio): 업무 온톨로지/기준정보 연동",
      "- posco-plm [활성] (stdio): 투자관리시스템 데이터 연동",
      "- posco-erp [활성] (stdio): ERP/POSPIA 기준 데이터 연동",
      "- posco-mih [활성] (stdio): MIH 시장 정보 연동",
      "- posco-gih [활성] (stdio): GIH 글로벌 정보 연동",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "MCP");
    for (const name of [
      "posco-email",
      "posco-calender",
      "posco-ecm",
      "posco-datalake",
      "posco-ontology",
      "posco-plm",
      "posco-erp",
      "posco-mih",
      "posco-gih",
    ]) {
      const connector = screen.getByRole("button", { name: new RegExp(name) });
      expect(connector.textContent).toContain("활성");
    }

    const emailConnector = screen.getByRole("button", { name: /posco-email/ });
    expect(emailConnector.textContent).toContain("POSCO 메일 데이터 연동");
    expect(screen.getByRole("button", { name: /posco-datalake/ }).textContent).toContain("데이터레이크 정형 데이터 연동");

    await user.click(emailConnector);
    expect(emailConnector.textContent).toContain("비활성");
    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_mcp_enabled", value: "posco-email", enabled: false },
    );

    await user.click(emailConnector);
    expect(emailConnector.textContent).toContain("활성");
    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_mcp_enabled", value: "posco-email", enabled: true },
    );
  });

  it("restores persisted disabled state for configured POSCO MCP connectors", async () => {
    const user = userEvent.setup();
    const helpText = [
      "MCP 서버:",
      "- posco-email [활성] (stdio)",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          mcpServers: [
            {
              name: "posco-email",
              state: "disabled",
              detail: "Disabled in settings.",
              transport: "stdio",
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "MCP");
    expect(screen.getByRole("button", { name: /posco-email/ }).textContent).toContain("비활성");
  });

  it("treats skill-mcp catalog entries as MCP items that toggle skill state", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- report-writer [project] [활성]: 보고서를 작성합니다.",
      "",
      "MCP 서버:",
      "- browser-qa [활성] (skill-mcp): 브라우저 MCP를 스킬 지침으로 라우팅합니다.",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "browser-qa",
              description: "브라우저 MCP를 스킬 지침으로 라우팅합니다.",
              source: "skill-mcp:browser",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    const regularSkills = screen.getByRole("group", { name: "일반 스킬" });
    expect(within(regularSkills).queryByRole("button", { name: /browser-qa/ })).toBeNull();

    await openHelpSection(user, "MCP");
    const mcpSkill = screen.getByRole("button", { name: /browser-qa/ });
    expect(mcpSkill.textContent).toContain("활성");
    expect(mcpSkill.textContent).toContain("브라우저 MCP를 스킬 지침으로 라우팅합니다.");

    await user.click(mcpSkill);
    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "browser-qa", enabled: false },
    );
  });

  it("does not invent POSCO MCP connectors when they are absent from the catalog", async () => {
    const user = userEvent.setup();
    const helpText = [
      "MCP 서버:",
      "- sqlite_analysis [활성] (stdio, tools=4, resources=1)",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1" }}>
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "MCP");
    expect(screen.queryByRole("button", { name: /posco-email/ })).toBeNull();
    expect(screen.getByRole("button", { name: /sqlite_analysis/ }).textContent).toContain("stdio");
  });

  it("collapses plugin-owned skills in the help view when their plugin is toggled off", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-workflow-kit [plugin] [활성]: 워크플로 사용 방식을 정합니다.",
      "",
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "using-workflow-kit",
              description: "워크플로 사용 방식을 정합니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await user.click(screen.getByRole("button", { name: "workflow-kit 플러그인 비활성화" }));

    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "workflow-kit", enabled: false },
    );
    const workflowKitGroup = screen.getByRole("group", { name: /workflow-kit 플러그인 스킬/ });
    expect(workflowKitGroup.textContent).toContain("workflow-kit");
    expect(workflowKitGroup.textContent).toContain("비활성");
    expect(workflowKitGroup.textContent).not.toContain("using-workflow-kit");
    expect(screen.queryByRole("button", { name: /using-workflow-kit/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "workflow-kit 플러그인 활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "workflow-kit", enabled: true },
    );
    expect(screen.getByRole("button", { name: /using-workflow-kit/ }).textContent).toContain("활성");
  });

  it("keeps disabled backend plugin snapshots visible as collapsed skill groups", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-workflow-kit [plugin:workflow-kit] [활성]: 워크플로 사용 방식을 정합니다.",
      "",
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "- claude-for-legal-lite [활성]: Legal workflows",
      "- office-subagent-presets [비활성]: Focused office-work subagent presets",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "using-workflow-kit",
              description: "워크플로 사용 방식을 정합니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
          ],
          plugins: [
            {
              name: "workflow-kit",
              description: "Workflow kit skills",
              enabled: true,
              skill_count: 14,
            },
            {
              name: "claude-for-legal-lite",
              description: "Legal workflows",
              enabled: false,
              skill_count: 10,
              skills: [
                {
                  name: "legal-contract-review",
                  description: "계약서를 검토합니다.",
                  source: "plugin:claude-for-legal-lite",
                  enabled: true,
                },
              ],
            },
            {
              name: "office-subagent-presets",
              description: "Focused office-work subagent presets",
              enabled: false,
              skill_count: 0,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    const disabledGroup = screen.getByRole("group", { name: /claude-for-legal-lite 플러그인 스킬/ });
    expect(disabledGroup.textContent).toContain("비활성");
    expect(disabledGroup.textContent).toContain("10개");
    expect(screen.queryByRole("button", { name: /legal-contract-review/ })).toBeNull();
    expect(screen.queryByRole("group", { name: /office-subagent-presets 플러그인 스킬/ })).toBeNull();

    await openHelpSection(user, "플러그인");
    const pluginButtons = screen.getAllByRole("button", { name: /claude-for-legal-lite/ });
    expect(pluginButtons.some((button) => button.textContent?.includes("비활성"))).toBe(true);
    expect(screen.getByRole("button", { name: /office-subagent-presets/ }).textContent).toContain("비활성");
  });

  it("keeps a disabled plugin skill group visible while it is optimistically re-enabled", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-workflow-kit [plugin:workflow-kit] [활성]: 워크플로 사용 방식을 정합니다.",
      "",
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "- claude-for-legal-lite [활성]: Legal workflows",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "using-workflow-kit",
              description: "워크플로 사용 방식을 정합니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
          ],
          plugins: [
            {
              name: "workflow-kit",
              description: "Workflow kit skills",
              enabled: true,
              skill_count: 14,
            },
            {
              name: "claude-for-legal-lite",
              description: "Legal workflows",
              enabled: false,
              skill_count: 10,
              skills: [
                {
                  name: "legal-contract-review",
                  description: "계약서를 검토합니다.",
                  source: "plugin:claude-for-legal-lite",
                  enabled: true,
                },
              ],
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await user.click(screen.getByRole("button", { name: "claude-for-legal-lite 플러그인 활성화" }));

    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "claude-for-legal-lite", enabled: true },
    );
    const enabledGroup = screen.getByRole("group", { name: /claude-for-legal-lite 플러그인 스킬/ });
    expect(enabledGroup.textContent).toContain("claude-for-legal-lite");
    expect(enabledGroup.textContent).toContain("활성");
    expect(enabledGroup.textContent).toContain("10개");
    expect(screen.getByRole("button", { name: /legal-contract-review/ }).textContent).toContain("활성");
  });

  it("allows individual plugin-owned skill toggles and syncs them from the plugin toggle", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-workflow-kit [plugin] [활성]: 워크플로 사용 방식을 정합니다.",
      "- skill-writer [plugin] [활성]: 스킬 작성을 돕습니다.",
      "",
      "플러그인:",
      "- workflow-kit [활성]: Workflow kit skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "using-workflow-kit",
              description: "워크플로 사용 방식을 정합니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
            {
              name: "skill-writer",
              description: "스킬 작성을 돕습니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await user.click(screen.getByRole("button", { name: /using-workflow-kit/ }));

    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "using-workflow-kit", enabled: false },
    );
    expect(screen.getByRole("button", { name: /using-workflow-kit/ }).textContent).toContain("비활성");
    expect(screen.getByRole("button", { name: /skill-writer/ }).textContent).toContain("활성");

    await user.click(screen.getByRole("button", { name: "workflow-kit 플러그인 비활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "workflow-kit", enabled: false },
    );
    expect(screen.queryByRole("button", { name: /using-workflow-kit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /skill-writer/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "workflow-kit 플러그인 활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "workflow-kit", enabled: true },
    );
    expect(screen.getByRole("button", { name: /using-workflow-kit/ }).textContent).toContain("활성");
    expect(screen.getByRole("button", { name: /skill-writer/ }).textContent).toContain("활성");
  });

  it("groups plugin-owned skills together under their plugin", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- legal-contract-review [plugin] [활성]: 계약서를 검토합니다.",
      "- deploy-helper [plugin] [활성]: 배포를 돕습니다.",
      "- using-workflow-kit [plugin] [활성]: 워크플로 사용 방식을 정합니다.",
      "- skill-writer [plugin] [활성]: 스킬 작성을 돕습니다.",
      "- review [project] [활성]: Review checklist",
      "",
      "플러그인:",
      "- claude-for-legal-lite [활성]: Legal review skills",
      "- deploy [활성]: Deploy skills",
      "- workflow-kit [활성]: Workflow kit skills",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    const { container } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            {
              name: "using-workflow-kit",
              description: "워크플로 사용 방식을 정합니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
            {
              name: "skill-writer",
              description: "스킬 작성을 돕습니다.",
              source: "plugin:workflow-kit",
              enabled: true,
            },
            {
              name: "deploy-helper",
              description: "배포를 돕습니다.",
              source: "plugin:deploy",
              enabled: true,
            },
            {
              name: "legal-contract-review",
              description: "계약서를 검토합니다.",
              source: "plugin:claude-for-legal-lite",
              enabled: true,
            },
            { name: "review", description: "Review checklist", source: "project", enabled: true },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await openHelpSection(user, "플러그인");

    const legalGroup = screen.getByRole("group", { name: /claude-for-legal-lite 플러그인 스킬/ });
    expect(legalGroup.textContent).toContain("legal-contract-review");
    expect(legalGroup.getAttribute("data-skill-group-tone")).toBe("1");
    expect(screen.getByText(/법무 검토를 지원합니다/).closest("button")?.getAttribute("data-skill-group-tone")).toBe("1");

    const deployGroup = screen.getByRole("group", { name: /deploy 플러그인 스킬/ });
    expect(deployGroup.textContent).toContain("deploy-helper");
    expect(deployGroup.getAttribute("data-skill-group-tone")).toBe("2");
    expect(screen.getByText("Deploy skills").closest("button")?.getAttribute("data-skill-group-tone")).toBe("2");

    const workflowKitGroup = screen.getByRole("group", { name: /workflow-kit 플러그인 스킬/ });
    expect(workflowKitGroup.textContent).toContain("using-workflow-kit");
    expect(workflowKitGroup.textContent).toContain("skill-writer");
    expect(workflowKitGroup.textContent).not.toContain("review");
    expect(workflowKitGroup.getAttribute("data-skill-group-tone")).toBe("3");
    expect(screen.getByText(/Workflow kit skills/).closest("button")?.getAttribute("data-skill-group-tone")).toBe("3");

    const pluginGroupNames = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(pluginGroupNames.filter((name): name is string => Boolean(name))).toEqual([
      "일반 스킬",
      "claude-for-legal-lite 플러그인 스킬",
      "deploy 플러그인 스킬",
      "workflow-kit 플러그인 스킬",
    ]);

    const pluginCard = Array.from(container.querySelectorAll("details.command-card"))
      .find((card) => card.querySelector("summary")?.textContent?.includes("플러그인"));
    const pluginNames = Array.from(pluginCard?.querySelectorAll("button.skill-toggle-pill strong") ?? [])
      .map((node) => node.textContent);
    expect(pluginNames).toEqual(["claude-for-legal-lite", "deploy", "workflow-kit"]);

    const standaloneGroup = screen.getByRole("group", { name: "일반 스킬" });
    expect(standaloneGroup.className).toContain("skill-plugin-group");
    expect(standaloneGroup.getAttribute("data-skill-group-tone")).toBe("0");
    expect(standaloneGroup.textContent).toContain("review");
    expect(standaloneGroup.textContent).not.toContain("using-workflow-kit");

    const collapseStandalone = screen.getByRole("button", { name: "일반 스킬 접기" });
    expect(collapseStandalone.getAttribute("aria-expanded")).toBe("true");
    await user.click(collapseStandalone);
    expect(standaloneGroup.className).toContain("collapsed");
    expect(standaloneGroup.textContent).not.toContain("review");

    const expandStandalone = screen.getByRole("button", { name: "일반 스킬 펼치기" });
    expect(expandStandalone.getAttribute("aria-expanded")).toBe("false");
    await user.click(expandStandalone);
    expect(standaloneGroup.className).not.toContain("collapsed");
    expect(standaloneGroup.textContent).toContain("review");
  });
});
