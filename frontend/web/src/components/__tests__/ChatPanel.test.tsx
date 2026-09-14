import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";
import { readConcurrencyStatus } from "../../api/settings";

vi.mock("../../api/messages", () => ({
  sendBackendRequest: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../api/settings", () => ({
  concurrencySettingsChangedEvent: "myharness:concurrency-settings-changed",
  readConcurrencyStatus: vi.fn(),
}));

function ArtifactPanelState() {
  const { state } = useAppState();
  return <output aria-label="artifact panel state">{state.artifactPanelOpen ? "open" : "closed"}</output>;
}

function SidebarState() {
  const { state } = useAppState();
  return <output aria-label="sidebar state">{state.sidebarCollapsed ? "collapsed" : "open"}</output>;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    vi.mocked(sendBackendRequest).mockClear();
    vi.mocked(readConcurrencyStatus).mockReset().mockResolvedValue({
      maxCpuPercent: 95,
      maxMemoryPercent: 98,
      maxBusySessionsPerClient: 3,
      idleSessionTimeoutMinutes: 30,
      activeSessions: 12,
      connectedScreens: 1,
      activeUsers: 3,
      busySessions: 5,
      busySessionsForClient: 2,
      queuedSessions: 2,
      queuedResponses: 4,
    });
  });

  it("shows concurrency values in one compact status tooltip", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, clientId: "browser-1" }}>
        <ChatPanel />
      </AppStateProvider>,
    );

    const statusButton = await screen.findByRole("button", {
      name: "동시 사용 현황: 사용자 수 3명, 연결된 화면 1개, 열린 작업 세션 12개, 동시에 AI 응답을 생성하는 세션 5개, 같은 브라우저의 동시 AI 응답 2 / 3, 대기열 세션 2, 응답 4",
    });
    const tooltip = screen.getByRole("tooltip");

    expect(readConcurrencyStatus).toHaveBeenCalledWith("browser-1");
    expect(statusButton.closest(".header-actions")).toBeTruthy();
    expect(document.querySelectorAll(".concurrency-status-button")).toHaveLength(1);
    expect(statusButton.querySelector('[data-icon="capacity"]')).toBeTruthy();
    expect(tooltip.querySelector('[data-status="responses"] [data-icon="responses"]')).toBeTruthy();
    expect(statusButton.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(within(tooltip).getByText("1개")).toBeTruthy();
    expect(within(tooltip).getByText("열린 작업 세션")).toBeTruthy();
    expect(within(tooltip).getByText("12개")).toBeTruthy();
    expect(within(tooltip).getByText("사용자 수")).toBeTruthy();
    expect(within(tooltip).getByText("3명")).toBeTruthy();
    expect(within(tooltip).getByText("5개")).toBeTruthy();
    expect(within(tooltip).getByText("2 / 3")).toBeTruthy();
    expect(within(tooltip).getByText("세션 2 · 응답 4")).toBeTruthy();
  });

  it("shows the current capacity queue position above the composer", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          status: "processing",
          statusText: "응답 대기열 2번째 · AI 응답 자리를 기다리는 중",
        }}
      >
        <ChatPanel />
      </AppStateProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("응답 대기열 2번째");
    await screen.findByRole("button", { name: /동시 사용 현황/ });
  });

  it("keeps the artifact panel open when the chat area is clicked once", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, artifactPanelOpen: true }}>
        <ChatPanel />
        <ArtifactPanelState />
      </AppStateProvider>,
    );

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("open");

    await userEvent.click(screen.getByRole("main"));

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("open");
  });

  it("closes the artifact panel when the chat area is double-clicked", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, artifactPanelOpen: true }}>
        <ChatPanel />
        <ArtifactPanelState />
      </AppStateProvider>,
    );

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("open");

    await userEvent.dblClick(screen.getByRole("main"));

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("closed");
  });

  it("keeps the artifact panel open when chat controls are clicked", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html" }],
        }}
      >
        <ChatPanel />
        <ArtifactPanelState />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "프로젝트 파일 보기" }));

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("open");
  });

  it("renders title editing with only the input as the interactive frame", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, chatTitle: "TEST2" }}>
        <ChatPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "TEST2" }));

    const titleInput = screen.getByLabelText("대화 제목");
    expect(titleInput.closest("button")).toBeNull();
    expect(titleInput.closest(".chat-title.editing")?.tagName).toBe("DIV");
  });

  it("toggles the sidebar from the mobile header control", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, sidebarCollapsed: true }}>
        <ChatPanel />
        <SidebarState />
      </AppStateProvider>,
    );

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed");

    await userEvent.click(screen.getByRole("button", { name: "사이드바 열기" }));

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open");
  });

  it("does not expose the removed AI team feature", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, swarmTeammates: [{ id: "old-worker", name: "worker", status: "running" }] }}>
        <ChatPanel />
      </AppStateProvider>,
    );
    await screen.findByRole("button", { name: /동시 사용 현황: 사용자 수 3명/ });
    expect(screen.queryByRole("button", { name: "AI 팀 열기" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "AI 팀" })).toBeNull();
  });
});
