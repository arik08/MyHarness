import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../ChatPanel";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";

function ArtifactPanelState() {
  const { state } = useAppState();
  return <output aria-label="artifact panel state">{state.artifactPanelOpen ? "open" : "closed"}</output>;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
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
});
