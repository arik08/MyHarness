import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPreview } from "../ArtifactPreview";
import { MarkdownMessage } from "../MarkdownMessage";
import { StreamingAssistantMessage } from "../StreamingAssistantMessage";
import { initialAppState } from "../../state/reducer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, source: string) => ({
      svg: `<svg data-render-id="${id}" role="img"><text>${source.includes("Ready") ? "Ready" : "chart"}</text></svg>`,
    })),
  },
}));

function dispatchPointer(target: Element | Window, type: string, init: { clientX?: number; clientY?: number; button?: number; pointerId?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    pointerId: { value: init.pointerId ?? 1 },
  });
  fireEvent(target, event);
}

describe("MarkdownMessage Mermaid rendering", () => {
  it("renders mermaid code fences as charts in chat markdown", async () => {
    render(
      <MarkdownMessage
        text={[
          "흐름은 다음과 같습니다.",
          "",
          "```mermaid",
          "flowchart LR",
          "  Start --> Ready",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    expect(document.querySelector(".markdown-body pre")).toBeNull();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("renders long mermaid fences with blank lines and edge labels after markdown parsing", async () => {
    render(
      <MarkdownMessage
        text={[
          "완료된 프로세스입니다.",
          "",
          "```mermaid",
          "flowchart TD",
          "    A[사업부 투자 수요 발생] --> B[투자 제안서 작성]",
          "    B --> C[사업부 자체 검토]",
          "    C --> D[투자관리그룹 접수]",
          "",
          "    D --> E[투자 유형 분류]",
          "    E --> E1[유지보수 / 안전 / 환경]",
          "    E --> E2[생산능력 증대]",
          "    E1 --> F[기초 타당성 검토]",
          "    E2 --> F",
          "",
          "    F --> G[재무성 검토]",
          "    G --> G1[CAPEX 산정]",
          "    G --> G2[NPV / IRR / 회수기간 분석]",
          "    G1 --> H[전략 적합성 검토]",
          "    G2 --> H",
          "",
          "    H --> I{승인 권한 구분}",
          "    I -->|소액 / 정형 투자| J[부문장 승인]",
          "    I -->|중대형 투자| K[투자심의위원회 상정]",
          "    I -->|전략 / 대규모 투자| L[경영층 / 이사회 보고]",
          "    J --> M[투자 승인]",
          "    K --> M",
          "    L --> M",
          "```",
          "",
          "후속 표가 이어집니다.",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart > svg")).toBeTruthy());
    expect(document.querySelector(".mermaid-render-placeholder")).toBeNull();
    expect(document.body.textContent || "").toContain("후속 표가 이어집니다.");
  });

  it("renders mermaid code fences inside markdown artifact previews", async () => {
    render(
      <ArtifactPreview
        artifact={{ path: "outputs/flow.md", name: "flow.md", kind: "markdown", size: 64 }}
        payload={{
          kind: "markdown",
          content: [
            "# 처리 흐름",
            "",
            "```mermaid",
            "sequenceDiagram",
            "  Agent->>User: Ready",
            "```",
          ].join("\n"),
        }}
        draftContent=""
        sourceMode={false}
        downloadUrl="/api/artifact/download?path=outputs%2Fflow.md"
        onDraftContentChange={() => {}}
      />,
    );

    await waitFor(() => expect(document.querySelector(".artifact-markdown .mermaid-chart svg")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "처리 흐름" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("keeps rendered mermaid svg intact when reveal effects rerun", async () => {
    const text = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
      "```",
      "",
      "Done",
    ].join("\n");
    const { rerender } = render(<MarkdownMessage text={text} revealFrom={null} />);

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    rerender(<MarkdownMessage text={text} revealFrom={0} />);

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    expect(document.querySelector(".mermaid-chart .stream-reveal-sentence")).toBeNull();
    expect(document.querySelector(".mermaid-render-placeholder")).toBeNull();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("opens rendered mermaid charts in a zoomable and pannable viewer", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "flowchart LR",
          "  Start --> Ready",
          "```",
        ].join("\n")}
      />,
    );

    const openButton = await screen.findByRole("button", { name: "Mermaid 다이어그램 크게 보기" });
    expect(openButton.getAttribute("data-tooltip")).toBe("크게 보기");

    fireEvent.click(openButton);

    const dialog = screen.getByRole("dialog", { name: "Mermaid 다이어그램 확대 보기" });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(dialog.querySelector(".mermaid-zoom-canvas svg")).toBeTruthy());
    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(screen.getByText("120%")).toBeTruthy();

    const viewport = dialog.querySelector(".mermaid-zoom-viewport") as HTMLElement;
    const canvas = dialog.querySelector(".mermaid-zoom-canvas") as HTMLElement;
    dispatchPointer(viewport, "pointerdown", { clientX: 100, clientY: 100 });
    dispatchPointer(window, "pointermove", { clientX: 138, clientY: 126 });
    dispatchPointer(window, "pointerup");
    expect(canvas.style.transform).toContain("translate(38px, 26px)");

    fireEvent.click(screen.getByRole("button", { name: "이동 초기화" }));
    expect(canvas.style.transform).toContain("translate(0px, 0px) scale(1)");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Mermaid 다이어그램 확대 보기" })).toBeNull();
  });

  it("keeps an already rendered streaming mermaid chart mounted while later content streams", async () => {
    const mermaidBlock = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
      "```",
    ].join("\n");
    const { rerender } = render(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: mermaidBlock }}
      />,
    );

    const chart = await waitFor(() => {
      const node = document.querySelector(".mermaid-chart");
      expect(node?.querySelector(":scope > svg")).toBeTruthy();
      return node;
    });
    const svg = chart?.querySelector(":scope > svg");

    rerender(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{
          id: "assistant-1",
          role: "assistant",
          text: `${mermaidBlock}\n\n| 항목 | 값 |\n| --- | --- |\n| A | 1 |`,
        }}
      />,
    );

    expect(document.querySelector(".mermaid-chart")).toBe(chart);
    expect(document.querySelector(".mermaid-chart > svg")).toBe(svg);
  });

  it("does not render an incomplete streaming mermaid fence before it closes", async () => {
    const incompleteMermaid = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
    ].join("\n");
    const { rerender } = render(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: incompleteMermaid }}
      />,
    );

    expect(document.querySelector(".mermaid-chart")).toBeNull();
    expect(document.body.textContent || "").toContain("```mermaid");

    rerender(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: `${incompleteMermaid}\n\`\`\`` }}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart > svg")).toBeTruthy());
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("keeps the first rendered mermaid chart mounted while a later mermaid fence is incomplete and when it completes", async () => {
    const firstMermaid = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
      "```",
    ].join("\n");
    const secondIncomplete = [
      "```mermaid",
      "sequenceDiagram",
      "  User->>Agent: Later",
    ].join("\n");
    const secondComplete = `${secondIncomplete}\n\`\`\``;
    const { rerender } = render(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: firstMermaid }}
      />,
    );

    const firstChart = await waitFor(() => {
      const node = document.querySelector(".mermaid-chart");
      expect(node?.querySelector(":scope > svg")).toBeTruthy();
      return node;
    });
    const firstSvg = firstChart?.querySelector(":scope > svg");

    rerender(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: `${firstMermaid}\n\n${secondIncomplete}` }}
      />,
    );

    expect(document.querySelector(".mermaid-chart")).toBe(firstChart);
    expect(document.querySelector(".mermaid-chart > svg")).toBe(firstSvg);
    expect(document.querySelectorAll(".mermaid-chart")).toHaveLength(1);

    rerender(
      <StreamingAssistantMessage
        active={false}
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: `${firstMermaid}\n\n${secondComplete}`, isComplete: true }}
      />,
    );

    await waitFor(() => expect(document.querySelectorAll(".mermaid-chart > svg")).toHaveLength(2));
    expect(document.querySelector(".mermaid-chart")).toBe(firstChart);
    expect(document.querySelector(".mermaid-chart > svg")).toBe(firstSvg);
  });

  it("keeps a rendered mermaid chart mounted when the streaming answer completes", async () => {
    const mermaidBlock = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
      "```",
      "",
      "완료 문장",
    ].join("\n");
    const { rerender } = render(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: mermaidBlock }}
      />,
    );

    const chart = await waitFor(() => {
      const node = document.querySelector(".mermaid-chart");
      expect(node?.querySelector(":scope > svg")).toBeTruthy();
      return node;
    });
    const svg = chart?.querySelector(":scope > svg");

    rerender(
      <StreamingAssistantMessage
        active={false}
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: mermaidBlock, isComplete: true }}
      />,
    );

    expect(document.querySelector(".mermaid-chart")).toBe(chart);
    expect(document.querySelector(".mermaid-chart > svg")).toBe(svg);
  });

  it("keeps a rendered mermaid chart mounted when completion prepends final prose", async () => {
    const mermaidBlock = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Ready",
      "```",
    ].join("\n");
    const completedText = [
      "완료 결과입니다.",
      "",
      mermaidBlock,
      "",
      "완료 문장",
    ].join("\n");
    const { rerender } = render(
      <StreamingAssistantMessage
        active
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: mermaidBlock }}
      />,
    );

    const chart = await waitFor(() => {
      const node = document.querySelector(".mermaid-chart");
      expect(node?.querySelector(":scope > svg")).toBeTruthy();
      return node;
    });
    const svg = chart?.querySelector(":scope > svg");

    rerender(
      <StreamingAssistantMessage
        active={false}
        settings={{ ...initialAppState.appSettings, streamStartBufferMs: 0, streamRevealDurationMs: 0 }}
        message={{ id: "assistant-1", role: "assistant", text: completedText, isComplete: true }}
      />,
    );

    expect(document.querySelector(".mermaid-chart")).toBe(chart);
    expect(document.querySelector(".mermaid-chart > svg")).toBe(svg);
    expect(document.body.textContent || "").toContain("완료 결과입니다.");
  });
});
