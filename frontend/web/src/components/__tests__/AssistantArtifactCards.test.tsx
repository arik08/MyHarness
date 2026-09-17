import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../../state/reducer";
import { readArtifact } from "../../api/artifacts";
import { AssistantArtifactContent } from "../AssistantArtifactCards";

const dispatch = vi.fn();
const state = { ...initialAppState, workspacePath: "/workspace" };
vi.mock("../../state/app-state", () => ({ useAppState: () => ({ state, dispatch }) }));
vi.mock("../../api/artifacts", () => ({
  resolveArtifact: vi.fn(async () => ({ path: "outputs/report.html", name: "report.html", kind: "html" })),
  readArtifact: vi.fn(async () => ({ kind: "html", content: "<html>Report</html>" })),
}));
vi.mock("../MarkdownMessage", () => ({
  MarkdownMessage: ({ text }: { text: string }) => <span>{text}</span>,
  countInlineSourceLinksInMarkdown: () => 0,
  inlineSourceNumberingForMarkdown: () => ({}),
}));
vi.mock("../StreamingAssistantMessage", () => ({
  StreamingAssistantMessage: ({ message }: { message: { text: string } }) => <span>{message.text}</span>,
}));

describe("assistant artifact buttons", () => {
  it.each([false, true])("renders one working button for repeated paths and aliases (structured=%s)", async (structured) => {
    const { container, unmount } = render(<AssistantArtifactContent
      message={{ id: "report", role: "assistant", isComplete: true,
        text: "보고서입니다.\n[보고서](outputs/report.html)\n[다시 열기](outputs/report.html)\n[절대 경로](/workspace/outputs/report.html)\n끝.",
        artifacts: structured ? [
          { path: "outputs/report.html", name: "report.html", kind: "html" },
          { path: "/workspace/outputs/report.html", name: "report.html", kind: "html" },
        ] : undefined,
      }} settings={state.appSettings} active={false} />);
    await waitFor(() => expect(container.querySelectorAll(".artifact-card").length).toBe(1));
    expect(container.textContent).not.toContain("[다시 열기]");
    expect(container.textContent).not.toContain("[절대 경로]");
    expect(container.textContent).toContain("끝.");
    fireEvent.click(container.querySelector(".artifact-card")!);
    await waitFor(() => expect(readArtifact).toHaveBeenCalled());
    unmount();
  });
});
