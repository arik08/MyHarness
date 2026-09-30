import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantArtifactCards } from "../AssistantArtifactCards";
import { WorkflowPanel } from "../WorkflowPanel";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { readArtifact } from "../../api/artifacts";
import type { WorkflowEvent } from "../../types/ui";

vi.mock("../../api/artifacts", () => ({
  readArtifact: vi.fn(), resolveArtifact: vi.fn(async () => ({ path: "outputs/report.html", name: "report.html", kind: "html" })),
}));
let state: typeof initialAppState;
let dispatch: ReturnType<typeof useAppState>["dispatch"];
function Probe() { const app = useAppState(); state = app.state; dispatch = app.dispatch; return null; }
const artifact = { path: "outputs/report.html", name: "report.html", kind: "html" };
const event: WorkflowEvent = { id: "write", toolCallId: "write", toolName: "write_file", title: "Write", detail: "", status: "done",
  toolInput: { path: artifact.path, content: "<html>Report</html>" }, output: "written" };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
afterEach(cleanup);

for (const entry of ["card", "workflow"] as const) {
  it.each(["newchat", "workspace", "other-file", "closed", "reopen-same"].flatMap(destination => [false, true].map(failure => ({ destination, failure }))))(
    `${entry} ignores a late read after $destination (failure=$failure)`, async ({ destination, failure }) => {
      let finish!: (value: Awaited<ReturnType<typeof readArtifact>>) => void;
      let fail!: (error: Error) => void;
      vi.mocked(readArtifact).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
      render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: "runtime-a", activeHistoryId: "saved-a", workspacePath: "C:/fixture", workspaceName: "Fixture" }}>
        {entry === "card" ? <AssistantArtifactCards message={{ id: "answer", role: "assistant", text: "Report", isComplete: true, artifacts: [artifact] }} />
          : <WorkflowPanel events={[event]} expanded persistenceKey="entry-point-test" />}
        <Probe />
      </AppStateProvider>);
      if (entry === "card") fireEvent.click(await screen.findByRole("button", { name: /report.html/ }));
      else fireEvent.click(await screen.findByRole("button", { name: "report.html 미리보기 열기" }));
      await waitFor(() => expect(readArtifact).toHaveBeenCalledTimes(1));
      expect(state.activeArtifact?.path).toBe(artifact.path);
      act(() => {
        if (destination === "newchat") dispatch({ type: "begin_new_chat", sessionId: "saved-b" });
        if (destination === "workspace") dispatch({ type: "session_replaced", sessionId: "runtime-b", savedSessionId: "saved-b", workspace: { name: "B", path: "C:/b" } });
        if (destination === "other-file") dispatch({ type: "open_artifact", artifact: { path: "outputs/other.html", kind: "html" }, payload: { kind: "html", content: "New selection" } });
        if (destination === "closed" || destination === "reopen-same") dispatch({ type: "close_artifact" });
        if (destination === "reopen-same") dispatch({ type: "open_artifact", artifact: { ...artifact }, payload: { kind: "html", content: "Newer same-path payload" } });
      });
      const selected = state.activeArtifact;
      const payload = state.activeArtifactPayload;
      const open = state.artifactPanelOpen;
      await act(async () => failure ? fail(new Error("Old read failed")) : finish({ kind: "html", content: "Old delayed payload" }));
      expect(state.activeArtifact).toBe(selected);
      expect(state.activeArtifactPayload).toBe(payload);
      expect(state.artifactPanelOpen).toBe(open);
      expect(state.modal).toBeNull();
    },
  );
}
