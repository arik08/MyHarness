import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { ArtifactPreview } from "../ArtifactPreview";
import { MarkdownMessage } from "../MarkdownMessage";
import { StreamingAssistantMessage } from "../StreamingAssistantMessage";
import { initialAppState } from "../../state/reducer";

function escapeMockSvgText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, source: string) => ({
      svg: `<svg data-render-id="${id}" role="img"><text>${escapeMockSvgText(source.includes("Ready") ? "Ready" : source)}</text></svg>`,
      diagramType: "flowchart",
    })),
  },
}));

beforeEach(() => {
  vi.mocked(mermaid.render).mockReset();
  vi.mocked(mermaid.render).mockImplementation(async (id: string, source: string) => ({
    svg: `<svg data-render-id="${id}" role="img"><text>${escapeMockSvgText(source.includes("Ready") ? "Ready" : source)}</text></svg>`,
    diagramType: "flowchart",
  }));
});

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

  it("renders Korean sankey labels through ASCII-safe Mermaid node ids", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "sankey-beta",
          "  사용자,프론트엔드,100",
          "  프론트엔드,API,80",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    const renderedSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    expect(renderedSource).toContain("sankey\n");
    expect(renderedSource).not.toContain("sankey-beta");
    expect(renderedSource).toContain("mh_sankey_node_1,mh_sankey_node_2,100");
    expect(renderedSource).not.toContain("사용자");
    expect(screen.getByText(/사용자/)).toBeTruthy();
    expect(screen.getByText(/프론트엔드/)).toBeTruthy();
  });

  it("quotes Korean quadrant fields before passing them to Mermaid", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "quadrantChart",
          "  title 기능 우선순위",
          "  x-axis 낮은 난이도 --> 높은 난이도",
          "  y-axis 낮은 가치 --> 높은 가치",
          "  quadrant-1 전략 과제",
          "  quadrant-2 빠른 성과",
          "  로그인 개선: [0.25, 0.75]",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    const renderedSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    expect(renderedSource).toContain('x-axis "낮은 난이도" --> "높은 난이도"');
    expect(renderedSource).toContain('y-axis "낮은 가치" --> "높은 가치"');
    expect(renderedSource).toContain('quadrant-1 "전략 과제"');
    expect(renderedSource).toContain('"로그인 개선": [0.25, 0.75]');
  });

  it("quotes requirement diagram free-text fields before rendering", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "requirementDiagram",
          "requirement auth {",
          "  id: 1",
          "  text: 사용자는 안전하게 로그인할 수 있어야 한다",
          "  risk: high",
          "  verifymethod: test",
          "}",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    const renderedSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    expect(renderedSource).toContain('id: "1"');
    expect(renderedSource).toContain('text: "사용자는 안전하게 로그인할 수 있어야 한다"');
    expect(renderedSource).toContain("risk: High");
    expect(renderedSource).toContain("verifymethod: Test");
  });

  it("normalizes Mermaid diagrams that start with init directives", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "%%{init: {",
          '  "theme": "base",',
          '  "themeVariables": { "fontFamily": "Inter, Pretendard, sans-serif" }',
          "}}%%",
          "quadrantChart",
          "  x-axis 낮은 영향도 --> 높은 영향도",
          "  y-axis 낮은 노력 --> 높은 노력",
          "  quadrant-1 전략 과제",
          "  로그인 개선: [0.75, 0.25]",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    const renderedSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    expect(renderedSource).toContain("%%{init:");
    expect(renderedSource).toContain('x-axis "낮은 영향도" --> "높은 영향도"');
    expect(renderedSource).toContain('quadrant-1 "전략 과제"');
    expect(renderedSource).toContain('"로그인 개선": [0.75, 0.25]');
  });

  it("normalizes init-prefixed requirement and sankey diagrams", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          '%%{init: {"theme": "base"}}%%',
          "requirementDiagram",
          "requirement auth {",
          "  id: 1",
          "  text: 사용자는 로그인할 수 있어야 한다",
          "  risk: medium",
          "  verifymethod: test",
          "}",
          "```",
          "",
          "```mermaid",
          '%%{init: {"theme": "base"}}%%',
          "sankey-beta",
          "  방문,가입,120",
          "  가입,활성 사용자,70",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelectorAll(".mermaid-chart > svg")).toHaveLength(2));
    const requirementSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    const sankeySource = vi.mocked(mermaid.render).mock.calls[1]?.[1] || "";
    expect(requirementSource).toContain('text: "사용자는 로그인할 수 있어야 한다"');
    expect(requirementSource).toContain("risk: Medium");
    expect(requirementSource).toContain("verifymethod: Test");
    expect(sankeySource).toContain("sankey\n");
    expect(sankeySource).toContain("mh_sankey_node_1,mh_sankey_node_2,120");
    expect(sankeySource).not.toContain("sankey-beta");
  });

  it("renames flowchart class names that conflict with Mermaid keywords", async () => {
    render(
      <MarkdownMessage
        text={[
          "```mermaid",
          "flowchart TD",
          "  A[시작] --> E[종료]",
          "  classDef end fill:#d53e4f,color:#fff",
          "  class E end",
          "```",
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(document.querySelector(".mermaid-chart svg")).toBeTruthy());
    const renderedSource = vi.mocked(mermaid.render).mock.calls[0]?.[1] || "";
    expect(renderedSource).toContain("classDef mh_end fill:#d53e4f,color:#fff");
    expect(renderedSource).toContain("class E mh_end");
    expect(renderedSource).not.toContain("classDef end");
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

  it("does not nest streaming reveal spans when markdown enhancement reruns", async () => {
    const { container, rerender } = render(<MarkdownMessage text="첫 문장입니다." revealFrom={0} />);

    expect(container.querySelector(".stream-reveal-sentence")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    rerender(<MarkdownMessage text="첫 문장입니다. 다음 문장입니다." revealFrom={7} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const revealCount = container.querySelectorAll(".stream-reveal-sentence").length;
    expect(container.querySelector(".stream-reveal-sentence .stream-reveal-sentence")).toBeNull();
    expect(revealCount).toBeGreaterThan(0);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelector(".stream-reveal-sentence .stream-reveal-sentence")).toBeNull();
    expect(container.querySelectorAll(".stream-reveal-sentence")).toHaveLength(revealCount);
  });

  it("does not leave uncancelled enhancement frames during rapid reveal rerenders", () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      frames.delete(id);
    }) as typeof window.cancelAnimationFrame;

    try {
      const { rerender, unmount } = render(<MarkdownMessage text="첫 문장입니다. 다음 문장입니다." revealFrom={0} />);
      rerender(<MarkdownMessage text="첫 문장입니다. 다음 문장입니다." revealFrom={4} />);
      rerender(<MarkdownMessage text="첫 문장입니다. 다음 문장입니다." revealFrom={8} />);

      expect(frames.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    }
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
    expect(screen.queryByRole("button", { name: "화면에 맞춤" })).toBeNull();
    const resetButton = screen.getByRole("button", { name: "이동 초기화" });
    expect(resetButton.getAttribute("data-tooltip")).toBe("Reset");
    expect(resetButton.querySelector("svg")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(screen.getByText("120%")).toBeTruthy();

    const viewport = dialog.querySelector(".mermaid-zoom-viewport") as HTMLElement;
    const canvas = dialog.querySelector(".mermaid-zoom-canvas") as HTMLElement;
    const beforeDragTransform = canvas.style.transform;
    dispatchPointer(viewport, "pointerdown", { clientX: 100, clientY: 100 });
    dispatchPointer(window, "pointermove", { clientX: 138, clientY: 126 });
    dispatchPointer(window, "pointerup");
    expect(canvas.style.transform).not.toBe(beforeDragTransform);
    expect(canvas.style.transform).toContain("translate(");

    fireEvent.click(screen.getByRole("button", { name: "이동 초기화" }));
    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(screen.getByText("120%")).toBeTruthy();
    fireEvent.click(resetButton);
    expect(screen.getByText("100%")).toBeTruthy();

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
    expect(document.querySelector(".mermaid-stream-pending")).toBeTruthy();
    expect(document.body.textContent || "").toContain("다이어그램 작성 중...");
    expect(document.body.textContent || "").not.toContain("```mermaid");
    expect(document.body.textContent || "").not.toContain("flowchart LR");

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
