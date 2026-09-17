import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantActions } from "../AssistantActions";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { branchHistory } from "../../api/branch";
import { startSession } from "../../api/session";
import { sendBackendRequest } from "../../api/messages";
import { loadHistorySnapshot } from "../../api/history";
import type { ChatMessage } from "../../types/ui";

vi.mock("../../api/branch", () => ({ branchHistory: vi.fn() }));
vi.mock("../../api/session", () => ({ startSession: vi.fn() }));
vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));
vi.mock("../../api/history", () => ({ loadHistorySnapshot: vi.fn() }));

const first: ChatMessage = { id: "a1", role: "assistant", text: "first answer", isComplete: true };
const second: ChatMessage = { id: "a2", role: "assistant", text: "second answer", isComplete: true };
const workspace = { name: "Default", path: "/workspace" };
function Probe() {
  const { state } = useAppState();
  return <output data-testid="state">{JSON.stringify({ sessionId: state.sessionId, activeHistoryId: state.activeHistoryId, pendingHistoryId: state.pendingHistoryId, restoringHistory: state.restoringHistory, historyReadOnly: state.historyReadOnly, messages: state.messages, chatTitle: state.chatTitle, artifactPanelOpen: state.artifactPanelOpen, history: state.history, modal: state.modal })}</output>;
}
function mount(message = first) {
  return render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "live-source", activeHistoryId: "saved-source", clientId: "client", workspacePath: workspace.path, workspaceName: workspace.name, messages: [first, second], history: Array.from({ length: 40 }, (_, index) => ({ value: `saved-${index}`, label: `Existing ${index}` })), historyHasMore: true, historyNextOffset: 40 }}>
    <AssistantActions message={message} /><Probe />
  </AppStateProvider>);
}

describe("answer branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(branchHistory).mockResolvedValue({ sessionId: "child", title: "Source · 분기", workspace });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "live-child", workspace });
    vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
    vi.mocked(loadHistorySnapshot).mockResolvedValue({
      type: "history_snapshot", value: "child", message: "Source · 분기", preview_only: true,
      history_events: [{ type: "user", text: "first question" }, { type: "assistant", text: "first answer" }],
    });
  });

  it("shows the saved prefix in a separate session without waiting for backend events", async () => {
    mount(first);
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain('"activeHistoryId":"child"'));
    expect(branchHistory).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "saved-source", answerIndex: 0, answerText: "first answer", workspacePath: "/workspace" }));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client", cwd: "/workspace" }));
    expect(screen.getByTestId("state").textContent).toContain('"sessionId":"live-child"');
    const state = JSON.parse(screen.getByTestId("state").textContent!);
    expect(state).toMatchObject({ pendingHistoryId: null, restoringHistory: false, historyReadOnly: true, chatTitle: "Source · 분기", artifactPanelOpen: false });
    expect(state.messages.map((message: ChatMessage) => message.text)).toEqual(["first question", "first answer"]);
    expect(loadHistorySnapshot).toHaveBeenCalledWith({ sessionId: "child", workspacePath: "/workspace", workspaceName: "Default" });
    expect(state.history[0]).toMatchObject({ value: "child", description: "Source · 분기" });
    expect(state.history).toHaveLength(41);
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("keeps the original selected when saving the branch fails", async () => {
    vi.mocked(branchHistory).mockRejectedValue(new Error("stale anchor"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("stale anchor"));
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain('"sessionId":"live-source"');
  });

  it("keeps the original view when the copied transcript cannot be loaded", async () => {
    vi.mocked(loadHistorySnapshot).mockRejectedValue(new Error("snapshot unavailable"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("snapshot unavailable"));
    const state = JSON.parse(screen.getByTestId("state").textContent!);
    expect(state.sessionId).toBe("live-source");
    expect(state.activeHistoryId).toBe("saved-source");
    expect(state.messages).toEqual([first, second]);
    expect(state.history[0].value).toBe("child");
  });

  it("does not offer a branching button for an unfinished answer", () => {
    mount({ ...first, isComplete: false });
    expect(screen.queryByRole("button", { name: "이 답변까지 새 채팅으로 분기" })).toBeNull();
  });
});
