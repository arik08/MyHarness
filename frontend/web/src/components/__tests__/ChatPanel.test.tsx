import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({
  sendBackendRequest: vi.fn().mockResolvedValue({ ok: true }),
}));

function ArtifactPanelState() {
  const { state } = useAppState();
  return <output aria-label="artifact panel state">{state.artifactPanelOpen ? "open" : "closed"}</output>;
}

function ModalState() {
  const { state } = useAppState();
  return <output aria-label="modal state">{state.modal?.kind === "backend" ? String(state.modal.payload?.output || "") : ""}</output>;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    vi.mocked(sendBackendRequest).mockClear();
  });

  it("closes the artifact panel when the chat area is clicked", async () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, artifactPanelOpen: true }}>
        <ChatPanel />
        <ArtifactPanelState />
      </AppStateProvider>,
    );

    expect(screen.getByLabelText("artifact panel state").textContent).toBe("open");

    await userEvent.click(screen.getByRole("main"));

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

  it("shows the AI team button in the top-right header and opens the popup from there", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          swarmTeammates: [
            {
              id: "worker@office",
              name: "worker",
              role: "조사",
              status: "running",
              task: "데이터센터 산업 현황 조사",
              startedAt: Date.now() - 5000,
              lastOutput: "자료 수집 중",
              taskId: "local_agent_1",
            },
          ],
        }}
      >
        <ChatPanel />
      </AppStateProvider>,
    );

    const headerButton = screen.getByRole("button", { name: "AI 팀 열기" });
    expect(headerButton.closest(".header-actions")).toBeTruthy();
    expect(document.querySelector(".composer-box .swarm-command")).toBeNull();

    await userEvent.click(headerButton);

    expect(screen.getByRole("dialog", { name: "AI 팀" })).toBeTruthy();
    expect(screen.getByText("작업 진행 현황")).toBeTruthy();
    expect(screen.queryByText("사무 작업 진행 현황")).toBeNull();
    expect(screen.getByText("조사")).toBeTruthy();
    expect(screen.getByText("데이터센터 산업 현황 조사")).toBeTruthy();
  });

  it("sends swarm task output and stop requests from the header popup", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          swarmTeammates: [
            {
              id: "research@office",
              name: "research",
              role: "조사",
              status: "running",
              task: "자료 수집",
              taskId: "a123",
            },
          ],
        }}
      >
        <ChatPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "AI 팀 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "a123 결과 보기" }));
    await userEvent.click(screen.getByRole("button", { name: "a123 중단" }));

    expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
      type: "task_output",
      task_id: "a123",
      max_bytes: 12000,
    });
    expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
      type: "task_stop",
      task_id: "a123",
    });
  });

  it("opens cached swarm output when task output cannot be requested live", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: null,
          historyReadOnly: true,
          swarmTeammates: [
            {
              id: "research@office",
              name: "research",
              role: "조사",
              status: "completed",
              task: "자료 수집",
              taskId: "a123",
              lastOutput: "조사 결과 ok",
            },
          ],
        }}
      >
        <ChatPanel />
        <ModalState />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "AI 팀 열기" }));
    await userEvent.click(screen.getByRole("button", { name: "a123 결과 보기" }));

    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByLabelText("modal state").textContent).toBe("조사 결과 ok");
  });

  it("uses the task end time for completed AI team elapsed time", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          swarmTeammates: [
            {
              id: "research@office",
              name: "research",
              role: "조사",
              status: "completed",
              task: "자료 수집",
              startedAt: 1710000000000,
              endedAt: 1710000031000,
              taskId: "a123",
            },
          ],
        }}
      >
        <ChatPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "AI 팀 열기" }));

    expect(screen.getByText("완료")).toBeTruthy();
    expect(screen.getByText("31초")).toBeTruthy();
  });
});
