import { render, screen, waitFor } from "@testing-library/react";
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
  const summary = screen.getByText(label).closest("summary");
  expect(summary).toBeTruthy();
  await user.click(summary as HTMLElement);
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
      "- superpowers [활성]: Superpowers skills",
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
      "- superpowers [활성]: An agentic skills framework & software development methodology that works: planning, TDD, debugging, and collaboration workflows.",
      "- claude-for-legal-lite [활성]: 사용자가 제공한 문서와 로컬 playbook을 바탕으로 계약, 개인...",
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
    const superpowers = screen.getByRole("button", { name: /superpowers/ });
    expect(superpowers.textContent).toContain("계획 수립");
    expect(superpowers.textContent).not.toContain("agentic skills");
    expect(superpowers.getAttribute("data-tooltip")).toContain("에이전트 스킬 프레임워크");
    expect(superpowers.getAttribute("data-tooltip")).not.toContain("software development methodology");
  });

  it("shows POSCO demo MCP connectors when no MCP servers are configured", async () => {
    const user = userEvent.setup();
    const helpText = [
      "MCP 서버:",
      "(설정된 MCP 서버가 없습니다)",
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
    ]) {
      const connector = screen.getByRole("button", { name: new RegExp(name) });
      expect(connector.textContent).toContain("활성");
      expect(connector.textContent).toContain("[연결필요]");
    }

    const emailConnector = screen.getByRole("button", { name: /posco-email/ });
    expect(screen.getByRole("button", { name: /posco-ecm/ }).textContent).toContain("비정형 문서");
    expect(screen.getByRole("button", { name: /posco-datalake/ }).textContent).toContain("정형 데이터");

    await user.click(emailConnector);
    expect(emailConnector.textContent).toContain("비활성");
    expect(sendBackendRequest).not.toHaveBeenCalled();

    await user.click(emailConnector);
    expect(emailConnector.textContent).toContain("활성");
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("collapses plugin-owned skills in the help view when their plugin is toggled off", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-superpowers [plugin] [활성]: 스킬을 찾고 사용하는 방식을 정합니다.",
      "",
      "플러그인:",
      "- superpowers [활성]: Superpowers skills",
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
              name: "using-superpowers",
              description: "스킬을 찾고 사용하는 방식을 정합니다.",
              source: "plugin:superpowers",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await user.click(screen.getByRole("button", { name: "superpowers 플러그인 비활성화" }));

    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "superpowers", enabled: false },
    );
    const superpowersGroup = screen.getByRole("group", { name: /superpowers 플러그인 스킬/ });
    expect(superpowersGroup.textContent).toContain("superpowers");
    expect(superpowersGroup.textContent).toContain("비활성");
    expect(superpowersGroup.textContent).not.toContain("using-superpowers");
    expect(screen.queryByRole("button", { name: /using-superpowers/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "superpowers 플러그인 활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "superpowers", enabled: true },
    );
    expect(screen.getByRole("button", { name: /using-superpowers/ }).textContent).toContain("활성");
  });

  it("allows individual plugin-owned skill toggles and syncs them from the plugin toggle", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- using-superpowers [plugin] [활성]: 스킬을 찾고 사용하는 방식을 정합니다.",
      "- writing-skills [plugin] [활성]: 새 스킬을 만듭니다.",
      "",
      "플러그인:",
      "- superpowers [활성]: Superpowers skills",
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
              name: "using-superpowers",
              description: "스킬을 찾고 사용하는 방식을 정합니다.",
              source: "plugin:superpowers",
              enabled: true,
            },
            {
              name: "writing-skills",
              description: "새 스킬을 만듭니다.",
              source: "plugin:superpowers",
              enabled: true,
            },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
      </AppStateProvider>,
    );

    await openHelpSection(user, "스킬");
    await user.click(screen.getByRole("button", { name: /using-superpowers/ }));

    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "using-superpowers", enabled: false },
    );
    expect(screen.getByRole("button", { name: /using-superpowers/ }).textContent).toContain("비활성");
    expect(screen.getByRole("button", { name: /writing-skills/ }).textContent).toContain("활성");

    await user.click(screen.getByRole("button", { name: "superpowers 플러그인 비활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "superpowers", enabled: false },
    );
    expect(screen.queryByRole("button", { name: /using-superpowers/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /writing-skills/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "superpowers 플러그인 활성화" }));

    expect(sendBackendRequest).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_plugin_enabled", value: "superpowers", enabled: true },
    );
    expect(screen.getByRole("button", { name: /using-superpowers/ }).textContent).toContain("활성");
    expect(screen.getByRole("button", { name: /writing-skills/ }).textContent).toContain("활성");
  });

  it("groups plugin-owned skills together under their plugin", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- legal-contract-review [plugin] [활성]: 계약서를 검토합니다.",
      "- deploy-helper [plugin] [활성]: 배포를 돕습니다.",
      "- using-superpowers [plugin] [활성]: 스킬을 찾고 사용하는 방식을 정합니다.",
      "- writing-skills [plugin] [활성]: 새 스킬을 만듭니다.",
      "- review [project] [활성]: Review checklist",
      "",
      "플러그인:",
      "- claude-for-legal-lite [활성]: Legal review skills",
      "- deploy [활성]: Deploy skills",
      "- superpowers [활성]: Superpowers skills",
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
              name: "using-superpowers",
              description: "스킬을 찾고 사용하는 방식을 정합니다.",
              source: "plugin:superpowers",
              enabled: true,
            },
            {
              name: "writing-skills",
              description: "새 스킬을 만듭니다.",
              source: "plugin:superpowers",
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

    const superpowersGroup = screen.getByRole("group", { name: /superpowers 플러그인 스킬/ });
    expect(superpowersGroup.textContent).toContain("using-superpowers");
    expect(superpowersGroup.textContent).toContain("writing-skills");
    expect(superpowersGroup.textContent).not.toContain("review");
    expect(superpowersGroup.getAttribute("data-skill-group-tone")).toBe("1");
    expect(screen.getByText(/계획 수립, TDD/).closest("button")?.getAttribute("data-skill-group-tone")).toBe("1");

    const legalGroup = screen.getByRole("group", { name: /claude-for-legal-lite 플러그인 스킬/ });
    expect(legalGroup.textContent).toContain("legal-contract-review");
    expect(legalGroup.getAttribute("data-skill-group-tone")).toBe("2");
    expect(screen.getByText(/법무 검토를 지원합니다/).closest("button")?.getAttribute("data-skill-group-tone")).toBe("2");

    const deployGroup = screen.getByRole("group", { name: /deploy 플러그인 스킬/ });
    expect(deployGroup.textContent).toContain("deploy-helper");
    expect(deployGroup.getAttribute("data-skill-group-tone")).toBe("3");
    expect(screen.getByText("Deploy skills").closest("button")?.getAttribute("data-skill-group-tone")).toBe("3");

    const pluginGroupNames = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(pluginGroupNames.filter((name): name is string => Boolean(name))).toEqual([
      "일반 스킬",
      "superpowers 플러그인 스킬",
      "claude-for-legal-lite 플러그인 스킬",
      "deploy 플러그인 스킬",
    ]);

    const pluginCard = Array.from(container.querySelectorAll("details.command-card"))
      .find((card) => card.querySelector("summary")?.textContent?.includes("플러그인"));
    const pluginNames = Array.from(pluginCard?.querySelectorAll("button.skill-toggle-pill strong") ?? [])
      .map((node) => node.textContent);
    expect(pluginNames).toEqual(["superpowers", "claude-for-legal-lite", "deploy"]);

    const standaloneGroup = screen.getByRole("group", { name: "일반 스킬" });
    expect(standaloneGroup.className).toContain("skill-plugin-group");
    expect(standaloneGroup.getAttribute("data-skill-group-tone")).toBe("0");
    expect(standaloneGroup.textContent).toContain("review");
    expect(standaloneGroup.textContent).not.toContain("using-superpowers");
  });
});
