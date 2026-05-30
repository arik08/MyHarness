import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canUseServerHostSettings, isLocalBrowserHostname } from "../ModalHost";
import { ModalHost } from "../ModalHost";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { restartSession } from "../../api/session";
import { deleteWorkspace } from "../../api/workspaces";
import { readUserStats } from "../../api/settings";

vi.mock("../../api/session", () => ({
  restartSession: vi.fn(),
}));

vi.mock("../../api/workspaces", () => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock("../../api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/settings")>()),
  readUserStats: vi.fn(),
}));

describe("ModalHost remote access helpers", () => {
  it("treats loopback browser hosts as server-local", () => {
    expect(isLocalBrowserHostname("localhost")).toBe(true);
    expect(isLocalBrowserHostname("127.0.0.1")).toBe(true);
    expect(isLocalBrowserHostname("::1")).toBe(true);
  });

  it("treats LAN browser hosts as remote clients", () => {
    expect(isLocalBrowserHostname("192.168.0.12")).toBe(false);
    expect(isLocalBrowserHostname("10.20.30.40")).toBe(false);
    expect(isLocalBrowserHostname("myharness-demo.local")).toBe(false);
  });

  it("allows server-host settings from remote browsers after admin mode unlock", () => {
    expect(canUseServerHostSettings(false, false)).toBe(false);
    expect(canUseServerHostSettings(false, true)).toBe(true);
    expect(canUseServerHostSettings(true, false)).toBe(true);
  });
});

describe("ModalHost download settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDownloadSettingsModal() {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          modal: { kind: "settings" },
        }}
      >
        <ModalHost />
      </AppStateProvider>,
    );
  }

  it("shows browser download first and selected by default", async () => {
    renderDownloadSettingsModal();

    await userEvent.click(screen.getByRole("button", { name: /파일 저장경로/ }));
    const mode = screen.getByRole("combobox") as HTMLSelectElement;
    const options = Array.from(mode.options).map((option) => option.textContent);

    expect(options).toEqual(["브라우저 다운로드", "매번 저장 위치 선택", "지정 폴더에 자동 저장"]);
    expect(mode.value).toBe("browser");
  });

  it("shows only active streaming output controls", async () => {
    renderDownloadSettingsModal();

    await userEvent.click(screen.getByRole("button", { name: /스트리밍 출력/ }));

    expect(screen.getByRole("heading", { name: "스트리밍 출력" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /시작 버퍼/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /표시 시간/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /따라가기 시간/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /따라가기 앞섬/ })).toBeTruthy();
    expect(screen.queryByText("닦아내기 폭")).toBeNull();
  });

  it("keeps admin mode locked when the password is wrong", async () => {
    renderDownloadSettingsModal();

    await userEvent.click(screen.getByRole("button", { name: /Admin mode/ }));
    await userEvent.type(screen.getByLabelText("Admin mode 비밀번호"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Admin mode 진입" }));

    expect(screen.getByText("비밀번호가 맞지 않습니다.")).toBeTruthy();
  });

  it("enables and disables admin mode with the configured password", async () => {
    renderDownloadSettingsModal();

    const adminShortcut = screen.getByRole("button", { name: "Admin mode" });
    expect(adminShortcut.getAttribute("data-tooltip")).toBe("Admin Mode");
    expect(screen.getByText("기본 모드").getAttribute("data-tooltip")).toBe("자주 바꾸는 동작과 연결 정보를 한 곳에서 관리합니다.");
    expect(screen.queryByText("숨긴 히스토리와 완전 삭제 권한")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Admin mode/ }));
    await userEvent.type(screen.getByLabelText("Admin mode 비밀번호"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Admin mode 진입" }));

    expect(screen.getByText("관리자 모드 적용 중")).toBeTruthy();
    expect(localStorage.getItem("myharness:adminMode")).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: /Admin mode/ }));
    expect(screen.getByText("현재 관리자 모드가 켜져 있으며 이 브라우저에 유지됩니다.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Admin mode 해제" }));
    await userEvent.click(screen.getByRole("button", { name: "뒤로" }));

    expect(screen.getByText("기본 모드")).toBeTruthy();
    expect(localStorage.getItem("myharness:adminMode")).toBe("0");
    expect(screen.queryByText("숨긴 히스토리와 완전 삭제 권한")).toBeNull();
  });

  it("keeps detailed user stats collapsed until requested", async () => {
    vi.mocked(readUserStats).mockResolvedValue({
      dailyActiveIpCount: 2,
      todayVisitCount: 5,
      totalVisitCount: 25,
      viewerIp: "10.0.0.7",
      currentIpTodayVisitCount: 3,
      conversationCount: 4,
      activeSessionCount: 1,
      activeIpSessionCount: 1,
      currentWorkspaceConversationCount: 2,
      currentWorkspaceName: "Default",
      ipBreakdown: [
        {
          ip: "10.0.0.7",
          visitCount: 15,
          todayVisitCount: 3,
          firstSeenAt: 1777796334760,
          lastSeenAt: 1778503290462,
          activeSessionCount: 1,
        },
        {
          ip: "10.0.0.8",
          visitCount: 10,
          todayVisitCount: 2,
          firstSeenAt: 1777796334760,
          lastSeenAt: 1778503290462,
          activeSessionCount: 0,
        },
      ],
      dailyBreakdown: [
        { date: "2026-05-20", activeIpCount: 2, visitCount: 5 },
        { date: "2026-05-19", activeIpCount: 1, visitCount: 20 },
      ],
      dailyIpBreakdown: [],
    });
    renderDownloadSettingsModal();

    await userEvent.click(screen.getByRole("button", { name: /IP별 사용 통계/ }));
    await screen.findByText("오늘 DAU");

    expect(screen.queryByText("최근 14일 합계")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "상세 보기" }));

    expect(screen.getByText("최근 14일 합계")).toBeTruthy();
    expect(screen.getByText("IP별 상세")).toBeTruthy();
    expect(screen.getByText("최다 접속 IP")).toBeTruthy();
    expect(screen.getAllByText("10.0.0.7").length).toBeGreaterThan(0);
  });
});

describe("ModalHost task output", () => {
  it("renders task output backend modals as read-only logs", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          modal: {
            kind: "backend",
            payload: {
              kind: "task_output",
              title: "작업 결과 a123",
              task_id: "a123",
              output: "line one\nline two",
            },
          },
        }}
      >
        <ModalHost />
      </AppStateProvider>,
    );

    expect(screen.getByRole("dialog", { name: "작업 결과 a123" })).toBeTruthy();
    expect(document.querySelector(".task-output-log")?.textContent).toBe("line one\nline two");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("removes surrounding blank lines from task output logs", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          modal: {
            kind: "backend",
            payload: {
              kind: "task_output",
              title: "작업 결과 a123",
              task_id: "a123",
              output: "\n\n   \nline one\nline two\n\n",
            },
          },
        }}
      >
        <ModalHost />
      </AppStateProvider>,
    );

    expect(document.querySelector(".task-output-log")?.textContent).toBe("line one\nline two");
  });
});

describe("ModalHost workspace deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(restartSession).mockResolvedValue({
      sessionId: "session-default",
      workspace: { name: "Default", path: "C:/Users/user/Desktop/Documents/Python/MyHarness" },
    });
    vi.mocked(deleteWorkspace).mockResolvedValue({
      deleted: { name: "TEST1", path: "C:/Users/user/Desktop/Documents/Python/MyHarness/TEST1" },
      workspaces: [{ name: "Default", path: "C:/Users/user/Desktop/Documents/Python/MyHarness" }],
    });
  });

  function renderWorkspaceModal() {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-test1",
          clientId: "client-1",
          workspaceName: "TEST1",
          workspacePath: "C:/Users/user/Desktop/Documents/Python/MyHarness/TEST1",
          modal: { kind: "workspace" },
          workspaces: [
            { name: "Default", path: "C:/Users/user/Desktop/Documents/Python/MyHarness" },
            { name: "TEST1", path: "C:/Users/user/Desktop/Documents/Python/MyHarness/TEST1" },
          ],
        }}
      >
        <ModalHost />
      </AppStateProvider>,
    );
  }

  it("arms project deletion on the first click without deleting", async () => {
    renderWorkspaceModal();

    const deleteButton = screen.getByRole("button", { name: "TEST1 삭제" });
    await userEvent.click(deleteButton);

    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "TEST1 삭제 확인" })).toBeTruthy();
    expect(deleteButton.closest(".workspace-row")?.classList.contains("delete-ready")).toBe(true);
  });

  it("deletes the active project on the second click after switching to another project", async () => {
    renderWorkspaceModal();

    await userEvent.click(screen.getByRole("button", { name: "TEST1 삭제" }));
    await userEvent.click(screen.getByRole("button", { name: "TEST1 삭제 확인" }));

    await waitFor(() => expect(restartSession).toHaveBeenCalledWith({
      sessionId: "session-test1",
      clientId: "client-1",
      cwd: "C:/Users/user/Desktop/Documents/Python/MyHarness",
    }));
    expect(deleteWorkspace).toHaveBeenCalledWith("TEST1");
    expect(screen.queryByText("TEST1")).toBeNull();
  });
});
