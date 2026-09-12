import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantActions } from "../AssistantActions";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { branchHistory } from "../../api/branch";
import { startSession } from "../../api/session";
import { sendBackendRequest } from "../../api/messages";
import type { ChatMessage } from "../../types/ui";

vi.mock("../../api/branch", () => ({ branchHistory: vi.fn() }));
vi.mock("../../api/session", () => ({ startSession: vi.fn() }));
vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));

const first: ChatMessage = { id: "a1", role: "assistant", text: "first answer", isComplete: true };
const second: ChatMessage = { id: "a2", role: "assistant", text: "second answer", isComplete: true };
const workspace = { name: "Default", path: "/workspace" };
function Probe() {
  const { state } = useAppState();
  return <output data-testid="state">{JSON.stringify({ sessionId: state.sessionId, pendingHistoryId: state.pendingHistoryId, history: state.history, modal: state.modal })}</output>;
}
function mount(message = first) {
  return render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "live-source", activeHistoryId: "saved-source", clientId: "client", workspacePath: workspace.path, workspaceName: workspace.name, messages: [first, second] }}>
    <AssistantActions message={message} /><Probe />
  </AppStateProvider>);
}

describe("answer branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(branchHistory).mockResolvedValue({ sessionId: "child", title: "Source · 분기", workspace });
    vi.mocked(startSession).mockResolvedValue({ sessionId: "live-child", workspace });
    vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  });

  it("copies the selected prefix and resumes it in a separate live session", async () => {
    mount(second);
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
    await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("live-child", "client", { type: "apply_select_command", command: "resume", value: "child" }));
    expect(branchHistory).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "saved-source", answerIndex: 1, answerText: "second answer", workspacePath: "/workspace" }));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client", cwd: "/workspace" }));
    expect(screen.getByTestId("state").textContent).toContain('"sessionId":"live-child"');
    expect(screen.getByTestId("state").textContent).toContain('"pendingHistoryId":"child"');
    expect(sendBackendRequest).not.toHaveBeenCalledWith("live-source", expect.anything(), expect.anything());
  });

  it("keeps the original selected when saving the branch fails", async () => {
    vi.mocked(branchHistory).mockRejectedValue(new Error("stale anchor"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "이 답변까지 새 채팅으로 분기" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("stale anchor"));
    expect(startSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain('"sessionId":"live-source"');
  });

  it("does not offer a branching button for an unfinished answer", () => {
    mount({ ...first, isComplete: false });
    expect(screen.queryByRole("button", { name: "이 답변까지 새 채팅으로 분기" })).toBeNull();
  });
});
