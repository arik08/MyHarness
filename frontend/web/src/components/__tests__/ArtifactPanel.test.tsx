import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRequire } from "node:module";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPanel, clampArtifactPanelWidth } from "../ArtifactPanel";
import { ArtifactPreview, artifactAiCommentsMessage, artifactAiSelectionMessage, artifactHtmlEditMessage, artifactHtmlEditModeMessage } from "../ArtifactPreview";
import { ModalHost } from "../ModalHost";
import { TooltipLayer } from "../TooltipLayer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { aiEditArtifact, deleteArtifact, listProjectFiles, organizeProjectFiles, overwriteArtifact, readArtifact, renameArtifact } from "../../api/artifacts";
import type { BackendEvent } from "../../types/backend";
import type { ArtifactAiEditComment } from "../../types/ui";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options?: Record<string, unknown>) => { window: Window & typeof globalThis };
};

vi.mock("../../api/artifacts", () => ({
  aiEditArtifact: vi.fn(async () => ({ ok: true, sourcePath: "outputs/report.html", targetPath: "outputs/report_v1.html" })),
  deleteArtifact: vi.fn(async () => ({ deleted: true })),
  listProjectFiles: vi.fn(async () => ({ scope: "default", files: [] })),
  organizeProjectFiles: vi.fn(async () => ({ files: [] })),
  overwriteArtifact: vi.fn(async () => ({
    artifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 44 },
    payload: { kind: "html", content: "<html><body>Changed</body></html>" },
  })),
  renameArtifact: vi.fn(async () => ({
    artifact: { path: "outputs/renamed-report.html", name: "renamed-report.html", kind: "html", size: 44 },
    payload: { kind: "html", content: "<html><body>Preview</body></html>" },
  })),
  readArtifact: vi.fn(async () => ({ kind: "html", content: "<html><body>Preview</body></html>" })),
}));

function renderHtmlPreviewSrcdoc(content: string, comments: ArtifactAiEditComment[] = []) {
  const { container, unmount } = render(
    <ArtifactPreview
      artifact={{ path: "outputs/report.html", name: "report.html", kind: "html" }}
      payload={{ kind: "html", content }}
      draftContent={content}
      sourceMode={false}
      downloadUrl="#"
      htmlEditMode
      aiSelectionEnabled
      aiEditComments={comments}
      onDraftContentChange={vi.fn()}
    />,
  );
  const frame = container.querySelector("iframe") as HTMLIFrameElement;
  const srcdoc = frame.srcdoc;
  unmount();
  return srcdoc;
}

function collectHighlightText(dom: { window: Window & typeof globalThis }) {
  return Array.from(dom.window.document.querySelectorAll(".myharness-ai-comment-highlight"))
    .map((node) => node.textContent || "")
    .join("");
}

async function loadPreviewDom(srcdoc: string) {
  const dom = new JSDOM(srcdoc, { pretendToBeVisual: true, runScripts: "dangerously", url: "http://localhost/" });
  const rangePrototype = dom.window.Range.prototype as unknown as {
    getClientRects?: unknown;
    getBoundingClientRect?: unknown;
  };
  const rect = {
    left: 10,
    top: 10,
    right: 80,
    bottom: 24,
    width: 70,
    height: 14,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect;
  rangePrototype.getClientRects = () => [rect];
  rangePrototype.getBoundingClientRect = () => rect;
  dom.window.postMessage({ type: artifactHtmlEditModeMessage, path: "outputs/report.html", edit: true, ai: true }, "*");
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return dom;
}

async function submitInlineAiSelection(
  dom: { window: Window & typeof globalThis },
  configureRange: (document: Document) => Range,
  instruction = "범위 유지",
) {
  const submitted: ArtifactAiEditComment[] = [];
  dom.window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === artifactAiSelectionMessage) {
      submitted.push({
        ...event.data.selection,
        id: "comment-1",
        instruction: event.data.selection.instruction,
      });
    }
  });

  const range = configureRange(dom.window.document);
  const selection = dom.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  dom.window.document.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 24,
  }));
  const textarea = dom.window.document.querySelector(".myharness-ai-comment-popover textarea") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  textarea.value = instruction;
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  expect(submitted).toHaveLength(1);
  return submitted[0] as ArtifactAiEditComment & { htmlSnapshot?: string };
}

describe("ArtifactPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(aiEditArtifact).mockResolvedValue({ ok: true, sourcePath: "outputs/report.html", targetPath: "outputs/report_v1.html" });
    vi.mocked(deleteArtifact).mockResolvedValue({ deleted: true });
    vi.mocked(listProjectFiles).mockResolvedValue({ scope: "default", files: [] });
    vi.mocked(organizeProjectFiles).mockResolvedValue({ files: [] });
    vi.mocked(overwriteArtifact).mockResolvedValue({
      artifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 44 },
      payload: { kind: "html", content: "<html><body>Changed</body></html>" },
    });
    vi.mocked(renameArtifact).mockResolvedValue({
      artifact: { path: "outputs/renamed-report.html", name: "renamed-report.html", kind: "html", size: 44 },
      payload: { kind: "html", content: "<html><body>Preview</body></html>" },
    });
    localStorage.removeItem("myharness:projectFileFilter");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("myharness:projectFilePins:")) {
        localStorage.removeItem(key);
      }
    }
    history.replaceState(null, "", window.location.href);
  });

  it("can open from the closed initial state without changing hook order", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function OpenPanel() {
      const { dispatch } = useAppState();
      useEffect(() => {
        dispatch({ type: "open_artifact_list" });
      }, [dispatch]);
      return <ArtifactPanel />;
    }

    render(
      <AppStateProvider initialState={{ ...initialAppState, artifactPanelOpen: false }}>
        <OpenPanel />
      </AppStateProvider>,
    );

    await screen.findByText("표시할 프로젝트 파일이 아직 없습니다.");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("loads the default project file scope when the panel opens", async () => {
    function OpenPanel() {
      const { dispatch } = useAppState();
      useEffect(() => {
        dispatch({ type: "open_artifact_list" });
      }, [dispatch]);
      return <ArtifactPanel />;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: false,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
        }}
      >
        <OpenPanel />
      </AppStateProvider>,
    );

    await waitFor(() => expect(listProjectFiles).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-a",
      scope: "default",
      sessionId: "session-a",
      workspacePath: "C:/repo",
    })));
  });

  it("uses browser history for list, detail, and closing the panel", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("report.html");
    expect(history.state).toMatchObject({ myharnessArtifactPanel: true, view: "list" });

    await userEvent.click(screen.getByRole("button", { name: "report.html 열기" }));
    await screen.findByTitle("report.html");
    expect(history.state).toMatchObject({ myharnessArtifactPanel: true, view: "detail", path: "outputs/report.html" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: { myharnessArtifactPanel: true, view: "list" },
      }));
    });
    await screen.findByText("report.html");
    expect(screen.queryByTitle("report.html")).toBeNull();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(screen.queryByText("report.html")).toBeNull());
  });

  it("treats fullscreen preview as its own back-navigation step", async () => {
    vi.mocked(listProjectFiles).mockResolvedValue({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "report.html 열기" }));
    await screen.findByTitle("report.html");

    await userEvent.click(screen.getByRole("button", { name: "미리보기 확대" }));
    await waitFor(() => expect(history.state).toMatchObject({
      myharnessArtifactPanel: true,
      view: "fullscreen",
      path: "outputs/report.html",
    }));
    expect(document.querySelector(".artifact-panel")?.classList.contains("fullscreen")).toBe(true);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: {
          myharnessArtifactPanel: true,
          view: "detail",
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
        },
      }));
    });

    await screen.findByTitle("report.html");
    await waitFor(() => expect(document.querySelector(".artifact-panel")?.classList.contains("fullscreen")).toBe(false));
    expect(screen.queryByRole("button", { name: "report.html 열기" })).toBeNull();
  });

  it("uses the close button as detail-to-list, then list-to-closed", async () => {
    const backSpy = vi.spyOn(history, "back");
    vi.mocked(listProjectFiles).mockResolvedValue({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "report.html 열기" }));
    await screen.findByTitle("report.html");

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await screen.findByRole("button", { name: "report.html 열기" });
    expect(screen.queryByTitle("report.html")).toBeNull();
    expect(backSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "report.html 열기" })).toBeNull());
    expect(history.state).toBeNull();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("does not reopen a previous artifact when closing from the list", async () => {
    vi.mocked(listProjectFiles).mockResolvedValue({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });
    history.replaceState({
      myharnessArtifactPanel: true,
      view: "detail",
      path: "outputs/previous.html",
      name: "previous.html",
      kind: "html",
    }, "", window.location.href);

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: null,
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByRole("button", { name: "report.html 열기" });
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "report.html 열기" })).toBeNull());
    expect(readArtifact).not.toHaveBeenCalledWith(expect.objectContaining({ path: "outputs/previous.html" }));
    expect(history.state).toBeNull();
  });

  it("renders markdown artifacts by default and shows raw markdown only in source mode", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/report.md",
          name: "report.md",
          kind: "markdown",
          size: 42,
        },
      ],
    });
    vi.mocked(readArtifact).mockResolvedValueOnce({
      kind: "markdown",
      content: "# 분석 결과\n\n- 첫 항목\n- 둘째 항목",
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/report.md",
              name: "report.md",
              kind: "markdown",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "report.md 열기" }));

    expect(await screen.findByRole("heading", { name: "분석 결과" })).toBeTruthy();
    expect(screen.queryByLabelText("report.md 원문")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "소스코드 확인" }));

    const source = await screen.findByLabelText("report.md 원문");
    expect(source).toBeInstanceOf(HTMLTextAreaElement);
    expect((source as HTMLTextAreaElement).value).toContain("# 분석 결과");

    await userEvent.clear(source);
    await userEvent.type(source, "# 수정된 문서\n\n본문입니다.");
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }));

    expect(await screen.findByRole("heading", { name: "수정된 문서" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "분석 결과" })).toBeNull();
  });

  it("shows completed HTML source mode in the right preview and omits the redundant back action", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });
    vi.mocked(readArtifact).mockResolvedValueOnce({
      kind: "html",
      assetBaseUrl: "/api/artifact/asset/outputs/",
      content: [
        "<!doctype html>",
        "<html><head>",
        "<style>.hero{background-image:url('../shared/bg.jpg')}</style>",
        "</head><body>",
        "<h1>Hello</h1>",
        "<img src=\"./images/chart.jpg\" alt=\"chart\">",
        "</body></html>",
      ].join("\n"),
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "report.html 열기" }));
    const frame = await screen.findByTitle("report.html");
    expect(frame.classList.contains("artifact-html-frame")).toBe(true);
    expect(frame.getAttribute("srcdoc")).toContain('<base data-myharness-editor-base="true" href="/api/artifact/asset/outputs/">');
    expect(frame.getAttribute("srcdoc")).toContain('src="/api/artifact/asset/outputs/images/chart.jpg"');
    expect(frame.getAttribute("srcdoc")).toContain("url('/api/artifact/asset/shared/bg.jpg')");
    expect(screen.queryByRole("button", { name: "목록으로" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "소스코드 확인" }));

    expect(screen.queryByLabelText("report.html 원문")).toBeNull();
    const code = document.querySelector(".artifact-source code.language-html");
    expect(code?.textContent || "").toContain("<h1>Hello</h1>");
    expect(screen.queryByText("완료된 HTML 원문은 우측 미리보기에서 생략했습니다. 렌더링 결과는 미리보기 탭에서 확인하세요.")).toBeNull();
  });

  it("shows direct edit actions only for HTML artifacts", () => {
    const { unmount } = render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body>Preview</body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    let actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    expect(actions).toHaveLength(7);
    expect(actions[0].getAttribute("data-tooltip")).toBe("본문 수정");
    expect(actions.some((button) => button.getAttribute("data-tooltip") === "공유 링크 복사")).toBe(true);
    expect(actions.some((button) => button.getAttribute("data-tooltip") === "수정사항 반영")).toBe(false);
    expect(actions.some((button) => button.getAttribute("data-tooltip") === "편집 취소")).toBe(false);
    expect(screen.queryByRole("button", { name: "AI 자동편집" })).toBeNull();

    unmount();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.md", name: "report.md", kind: "markdown" },
          activeArtifactPayload: { kind: "markdown", content: "# Preview" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    expect(actions).toHaveLength(6);
    expect(actions.some((button) => button.getAttribute("data-tooltip") === "공유 링크 복사")).toBe(true);
    expect(actions.some((button) => button.getAttribute("data-tooltip")?.includes("편집"))).toBe(false);
  });

  it("injects direct text editing and AI comments while body edit mode is active", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body><h1>Headline</h1><p>Body</p></body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    const initialSrcdoc = frame.srcdoc;
    expect(initialSrcdoc).toContain("const setEditorEnabled");
    expect(initialSrcdoc).toContain("const modeMessageType");

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));

    expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "편집 취소" }) as HTMLButtonElement).disabled).toBe(true);
    expect(frame.srcdoc).toBe(initialSrcdoc);
    expect(frame.srcdoc).toContain("myharness-editable-text");
    expect(frame.srcdoc).toContain("const activateEditable");
    expect(frame.srcdoc).toContain("contentEditable = \"plaintext-only\"");
    expect(frame.srcdoc).toContain("parent.postMessage({ type: messageType");
    expect(frame.srcdoc).toContain("const commitActiveEditable");
    expect(frame.srcdoc).toContain('event.key !== "Enter" || event.shiftKey || event.isComposing');
    expect(frame.srcdoc).toContain("commitActiveEditable();");
    expect(frame.srcdoc).toContain("if (editable !== activeEditable)");
    expect(frame.srcdoc).toContain("const normalizeEditableLineBreaks");
    expect(frame.srcdoc).toContain('root.createElement("br")');
    expect(frame.srcdoc).toContain("myharness-ai-comment-popover");
    expect(frame.srcdoc).toContain('document.addEventListener("contextmenu"');
    expect(frame.srcdoc).toContain("const documentPayload");
    expect(frame.srcdoc).toContain("전체 수정 요청...");
    expect(frame.srcdoc).toContain("myharness:artifact-frame-scroll");
    expect(frame.srcdoc).toContain("window.scrollTo(restoreScroll.x, restoreScroll.y)");
    expect(frame.srcdoc).toContain("::selection");
    expect(frame.srcdoc).toContain("::highlight(myharness-ai-pending-selection)");
    expect(frame.srcdoc).toContain("rgba(245, 158, 11, 0.34)");
    expect(frame.srcdoc).toContain("myharness-ai-pending-highlight");
    expect(frame.srcdoc).toContain("const showPendingHighlight");
    expect(frame.srcdoc).not.toContain("hasDirectSelectableText");
    expect(frame.srcdoc).not.toContain("myharness-ai-drag-box");
  });

  it("injects a Mermaid expand control into HTML artifact previews", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: [
              "<html><body>",
              "<div class=\"mermaid-panel\"><div class=\"mermaid\">flowchart LR",
              "A --> B",
              "</div></div>",
              "<script src=\"https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js\"></script>",
              "</body></html>",
            ].join("\n"),
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("data-myharness-mermaid-zoom-style");
    expect(frame.srcdoc).toContain("data-myharness-mermaid-zoom-script");
    expect(frame.srcdoc).toContain("myharness-mermaid-expand-button");
    expect(frame.srcdoc).toContain("Mermaid 다이어그램 크게 보기");
    expect(frame.srcdoc).toContain("Mermaid 다이어그램 확대 보기");
    expect(frame.srcdoc).not.toContain("화면에 맞춤");
    expect(frame.srcdoc).not.toContain('control("화면에 맞춤", "Fit", "fit", fitView)');
    expect(frame.srcdoc).toContain('control("이동 초기화", "Reset", "reset", resetView)');
    expect(frame.srcdoc).toContain("controlIcons");
  });

  it("injects the inline comment picker through the unified body edit mode", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body><h1>Headline</h1><p>Body</p></body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    const initialSrcdoc = frame.srcdoc;

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));

    expect(frame.srcdoc).toBe(initialSrcdoc);
    expect(frame.srcdoc).toContain("myharness-ai-comment-popover");
    expect(frame.srcdoc).toContain("submit.type = \"button\"");
    expect(frame.srcdoc).toContain("submit.addEventListener(\"click\", submitComment)");
    expect(frame.srcdoc).toContain('event.key === "Enter" && !event.shiftKey');
    expect(frame.srcdoc).toContain("if ((node.nodeValue || \"\").trim())");
    expect(frame.srcdoc).toContain("const html = htmlFromRange(payloadRange)");
    expect(frame.srcdoc).toContain("htmlSnapshot: cleanDocumentHtml()");
    expect(frame.srcdoc).toContain("showPendingHighlight(selectionResult.pendingRange.cloneRange())");
    expect(frame.srcdoc).toContain("openSelectionPopover({ x: event.clientX, y: event.clientY })");
    expect(frame.srcdoc).toContain("showPopover(documentPayload()");
    expect(frame.srcdoc).toContain("const safeLeft = clamp(point.x + 8");
    expect(frame.srcdoc).toContain("clearPendingHighlight()");
    expect(frame.srcdoc).toContain("window.CSS.highlights.set(pendingHighlightName");
    expect(frame.srcdoc).toContain('document.addEventListener("contextmenu"');
    expect(frame.srcdoc).not.toContain('document.addEventListener("mouseup"');
    expect(frame.srcdoc).toContain("myharness-ai-comment-anchor");
    expect(frame.srcdoc).toContain("syncFormShape");
    expect(frame.srcdoc).toContain("myharness-ai-comment-multiline");
    expect(frame.srcdoc).toContain("event.stopImmediatePropagation?.();");
    expect(frame.srcdoc).toContain("event.stopPropagation();");
    expect(frame.srcdoc).toContain("const textOffsetsFromRange = (range) =>");
    expect(frame.srcdoc).toContain("const documentTextFromNodes = (nodes) =>");
    expect(frame.srcdoc).not.toContain("bodyRange.toString().length");
    expect(frame.srcdoc).not.toContain("myharness-ai-comment-mic");
    expect(frame.srcdoc).toContain("댓글 추가");
    expect(frame.srcdoc).toContain("취소");
    expect(frame.srcdoc).toContain("myharness-ai-comment-submit");
  });

  it("keeps an inline AI comment anchored to the selected text when submitting with Enter", async () => {
    const content = `<html><body>
      <main>
        <p>Alpha target range omega.</p>
      </main>
    </body></html>`;
    const dom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content));
    const submitted = await submitInlineAiSelection(dom, (document) => {
      const textNode = document.querySelector("p")?.firstChild as Text;
      const start = textNode.nodeValue?.indexOf("target range") ?? -1;
      expect(start).toBeGreaterThanOrEqual(0);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "target range".length);
      return range;
    });

    const highlightedDom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content, [submitted]));
    expect(collectHighlightText(highlightedDom)).toBe("target range");
  });

  it("trims boundary whitespace from inline AI selection ranges before anchoring comments", async () => {
    const content = `<html><body><p>Alpha target range omega.</p></body></html>`;
    const dom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content));
    const submitted = await submitInlineAiSelection(dom, (document) => {
      const textNode = document.querySelector("p")?.firstChild as Text;
      const start = textNode.nodeValue?.indexOf(" target") ?? -1;
      expect(start).toBeGreaterThanOrEqual(0);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + " target range ".length);
      return range;
    });

    expect(submitted.text).toBe("target range");
    const highlightedDom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content, [submitted]));
    expect(collectHighlightText(highlightedDom)).toBe("target range");
  });

  it("keeps inline AI comments anchored across formatted inline nodes", async () => {
    const content = `<html><body><p>Alpha <strong>target</strong> range omega.</p></body></html>`;
    const dom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content));
    const submitted = await submitInlineAiSelection(dom, (document) => {
      const first = document.querySelector("p")?.firstChild?.firstChild as Text;
      const tail = document.querySelector("strong")?.nextSibling?.firstChild as Text;
      const range = document.createRange();
      range.setStart(first, first.nodeValue?.indexOf(" ") ?? 0);
      range.setEnd(tail, " range".length);
      return range;
    });

    expect(submitted.text).toBe("target range");
    const highlightedDom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content, [submitted]));
    expect(collectHighlightText(highlightedDom)).toBe("target range");
  });

  it("uses the live edited HTML snapshot when submitting an inline AI comment", async () => {
    const originalContent = `<html><body><p>Alpha target range omega.</p></body></html>`;
    const dom = await loadPreviewDom(renderHtmlPreviewSrcdoc(originalContent));
    const paragraphText = dom.window.document.querySelector("p")?.firstChild as Text;
    paragraphText.nodeValue = "Alpha edited target range omega.";
    const submitted = await submitInlineAiSelection(dom, (document) => {
      const textNode = document.querySelector("p")?.firstChild as Text;
      const start = textNode.nodeValue?.indexOf("target range") ?? -1;
      expect(start).toBeGreaterThanOrEqual(0);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "target range".length);
      return range;
    });

    const htmlSnapshot = submitted.htmlSnapshot || "";
    expect(htmlSnapshot).toContain("Alpha edited target range omega.");
    const highlightedDom = await loadPreviewDom(renderHtmlPreviewSrcdoc(htmlSnapshot, [submitted]));
    expect(collectHighlightText(highlightedDom)).toBe("target range");
  });

  it("re-anchors stale inline AI comment offsets with selected text and context", async () => {
    const content = `<html><body><p>Alpha target range omega.</p></body></html>`;
    const staleComment: ArtifactAiEditComment = {
      id: "comment-1",
      instruction: "범위 유지",
      text: "target range",
      start: "Alpha edited ".length,
      end: "Alpha edited target range".length,
      before: "Alpha ",
      after: " omega.",
      html: "target range",
      scope: "selection",
    };

    const highlightedDom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content, [staleComment]));
    expect(collectHighlightText(highlightedDom)).toBe("target range");
  });

  it("updates inline AI comment highlights inside the live iframe without rebuilding srcdoc", async () => {
    const content = `<html><body><p>Alpha target range omega.</p></body></html>`;
    const dom = await loadPreviewDom(renderHtmlPreviewSrcdoc(content));
    const comment: ArtifactAiEditComment = {
      id: "comment-1",
      instruction: "범위 유지",
      text: "target range",
      start: "Alpha ".length,
      end: "Alpha target range".length,
      before: "Alpha ",
      after: " omega.",
      html: "target range",
      scope: "selection",
    };

    dom.window.postMessage({
      type: artifactAiCommentsMessage,
      path: "outputs/report.html",
      comments: [comment],
    }, "*");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    expect(collectHighlightText(dom)).toBe("target range");
  });

  it("keeps the HTML preview iframe srcdoc stable when Enter submits an AI comment", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><p>Alpha target range omega.</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));
    const editModeSrcdoc = frame.srcdoc;

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "target range",
            html: "target range",
            htmlSnapshot: "<html><body><p>Alpha target range omega.</p></body></html>",
            start: "Alpha ".length,
            end: "Alpha target range".length,
            before: "Alpha ",
            after: " omega.",
            instruction: "범위 유지",
          },
        },
      }));
    });

    await waitFor(() => expect(document.querySelector(".artifact-ai-comment")).toBeTruthy());
    expect(frame.srcdoc).toBe(editModeSrcdoc);
  });

  it("saves edited HTML preview drafts back to the current artifact path", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 42 }],
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 42 },
          activeArtifactPayload: { kind: "html", content: "<html><body>Preview</body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    let actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    await userEvent.click(actions[0]);
    const editSessionSrcDoc = frame.srcdoc;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactHtmlEditMessage,
          path: "outputs/report.html",
          html: "<html><body>Changed</body></html>",
        },
      }));
    });

    await waitFor(() => expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: "수정사항 반영" }));

    await waitFor(() => expect(overwriteArtifact).toHaveBeenCalledWith({
      path: "outputs/report.html",
      content: "<html><body>Changed</body></html>",
      clientId: "client-a",
      expectedMtimeMs: undefined,
      workspacePath: "C:/repo",
      workspaceName: "repo",
    }));
    actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "편집 취소" }) as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTitle("report.html") as HTMLIFrameElement).srcdoc).toBe(editSessionSrcDoc);
  });

  it("keeps an intentionally blank HTML draft instead of showing the original preview", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(overwriteArtifact).mockResolvedValueOnce({
      artifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 0 },
      payload: { kind: "html", content: "" },
    });
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 42 }],
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 42 },
          activeArtifactPayload: { kind: "html", content: "<html><body>Preview</body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    let actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    await userEvent.click(actions[0]);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactHtmlEditMessage,
          path: "outputs/report.html",
          html: "",
        },
      }));
    });

    await waitFor(() => expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(false));
    expect(frame.srcdoc).not.toContain("<html><body>Preview</body></html>");
    await userEvent.click(screen.getByRole("button", { name: "소스코드 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(""));

    await userEvent.click(screen.getByRole("button", { name: "수정사항 반영" }));

    await waitFor(() => expect(overwriteArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report.html",
      content: "",
    })));
    expect(await screen.findByRole("button", { name: "본문 수정" })).toBeTruthy();
    const sourceButton = screen.getByRole("button", { name: "소스코드 확인" }) as HTMLButtonElement;
    expect(sourceButton.disabled).toBe(false);
    expect((await screen.findByTitle("report.html") as HTMLIFrameElement).srcdoc).not.toContain("Preview");

    await userEvent.click(sourceButton);
    const code = document.querySelector(".artifact-source code.language-html");
    expect(code).toBeTruthy();
    expect(code?.textContent || "").toBe("");
    expect(screen.queryByText("완료된 HTML 원문은 우측 미리보기에서 생략했습니다. 렌더링 결과는 미리보기 탭에서 확인하세요.")).toBeNull();
  });

  it("falls back to selection copy for HTML artifacts when Clipboard API is unavailable", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const copiedText: string[] = [];
    const execCommand = vi.fn((command: string) => {
      copiedText.push((document.querySelector("textarea") as HTMLTextAreaElement | null)?.value || "");
      return command === "copy";
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            sessionId: "session-a",
            workspacePath: "C:/repo",
            workspaceName: "repo",
            artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
        </AppStateProvider>,
      );

      expect(await screen.findByTitle("report.html")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "소스코드 복사" }));

      await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
      expect(copiedText).toEqual(["<!doctype html><html><body><h1>Preview</h1></body></html>"]);
      expect(screen.getByRole("button", { name: "복사됨" })).toBeTruthy();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("copies a LAN-friendly share link for the active artifact", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalFetch = globalThis.fetch;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/share/base-url");
      return new Response(JSON.stringify({ baseUrl: "http://10.0.0.5:4273" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            sessionId: "session-a",
            workspacePath: "C:/repo",
            workspaceName: "repo",
            artifacts: [{ path: "outputs/포스코홀딩스_해외경쟁사_이슈분석_v1.html", name: "포스코홀딩스_해외경쟁사_이슈분석_v1.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/포스코홀딩스_해외경쟁사_이슈분석_v1.html", name: "포스코홀딩스_해외경쟁사_이슈분석_v1.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
        </AppStateProvider>,
      );

      expect(await screen.findByTitle("포스코홀딩스_해외경쟁사_이슈분석_v1.html")).toBeTruthy();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/share/base-url", { cache: "no-store" }));
      await userEvent.click(screen.getByRole("button", { name: "공유 링크 복사" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(
        "http://10.0.0.5:4273/share/artifact?path=outputs/포스코홀딩스_해외경쟁사_이슈분석_v1.html&workspace=repo",
      ));
      expect(screen.getByRole("button", { name: "공유 링크 복사됨" })).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("shows the share copied label immediately while the share URL request is still pending", async () => {
    let resolveFetch: (response: Response) => void = () => {
      throw new Error("share base URL request was not started");
    };
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalFetch = globalThis.fetch;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/share/base-url");
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            workspaceName: "Default",
            artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
          <TooltipLayer />
        </AppStateProvider>,
      );

      expect(screen.getByTitle("report.html")).toBeTruthy();
      const shareButton = screen.getByRole("button", { name: "공유 링크 복사" });
      await act(async () => {
        fireEvent.pointerOver(shareButton);
        fireEvent.click(shareButton);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "공유 링크 복사됨" })).toBeTruthy();
      expect(screen.getByRole("tooltip").textContent).toBe("공유 링크 복사됨");
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/share/artifact?path=outputs/report.html&workspace=Default`,
      );
      resolveFetch(new Response(JSON.stringify({ baseUrl: "http://10.0.0.5:4273" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("uses the prefetched share base URL so fallback copy stays inside the click activation", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    const originalFetch = globalThis.fetch;
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    let clickActivationActive = false;
    const execCommand = vi.fn(() => clickActivationActive);
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ baseUrl: "http://10.0.0.5:4273" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            workspaceName: "Default",
            artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
          <ModalHost />
        </AppStateProvider>,
      );

      await screen.findByTitle("report.html");
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/share/base-url", { cache: "no-store" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      clickActivationActive = true;
      fireEvent.click(screen.getByRole("button", { name: "공유 링크 복사" }));
      clickActivationActive = false;

      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "공유 링크 복사됨" })).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalIsSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalIsSecureContext);
      } else {
        Reflect.deleteProperty(window, "isSecureContext");
      }
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("resets the share copied label after a successful copy", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalFetch = globalThis.fetch;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalSetTimeout = window.setTimeout;
    let shareResetScheduled = false;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ baseUrl: "http://10.0.0.5:4273" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            workspaceName: "Default",
            artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
        </AppStateProvider>,
      );

      expect(screen.getByTitle("report.html")).toBeTruthy();
      vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 1400 && typeof handler === "function") {
          shareResetScheduled = true;
          handler(...args);
        }
        return originalSetTimeout(() => undefined, 0);
      }) as typeof window.setTimeout);
      fireEvent.click(screen.getByRole("button", { name: "공유 링크 복사" }));
      expect(screen.getByRole("button", { name: "공유 링크 복사됨" })).toBeTruthy();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalled();

      expect(screen.getByRole("button", { name: "공유 링크 복사" })).toBeTruthy();
      expect(shareResetScheduled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("restores the share label and opens an error modal when copying the share link fails", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalFetch = globalThis.fetch;
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ baseUrl: "http://10.0.0.5:4273" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            workspaceName: "Default",
            artifacts: [{ path: "outputs/report.html", name: "report.html", kind: "html", size: 64 }],
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html", size: 64 },
            activeArtifactPayload: { kind: "html", content: "<!doctype html><html><body><h1>Preview</h1></body></html>" },
          }}
        >
          <ArtifactPanel />
          <ModalHost />
        </AppStateProvider>,
      );

      await screen.findByTitle("report.html");
      fireEvent.click(screen.getByRole("button", { name: "공유 링크 복사" }));
      expect(screen.getByRole("button", { name: "공유 링크 복사됨" })).toBeTruthy();

      await waitFor(() => expect(screen.getByRole("button", { name: "공유 링크 복사" })).toBeTruthy());
      expect(screen.getByRole("dialog").textContent).toContain("복사에 실패했습니다.");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("saves restored history artifacts through their resolved workspace", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/current",
          workspaceName: "current",
          activeArtifact: {
            path: "outputs/history-report.html",
            name: "history-report.html",
            kind: "html",
            workspace: { path: "C:/history", name: "history" },
          },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body>History</body></html>",
            workspace: { path: "C:/history", name: "history" },
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    await userEvent.click(actions[0]);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactHtmlEditMessage,
          path: "outputs/history-report.html",
          html: "<html><body>History Changed</body></html>",
        },
      }));
    });

    await waitFor(() => expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "수정사항 반영" }));

    await waitFor(() => expect(overwriteArtifact).toHaveBeenCalledWith({
      path: "outputs/history-report.html",
      content: "<html><body>History Changed</body></html>",
      clientId: "client-a",
      workspacePath: "C:/history",
      workspaceName: "history",
    }));
  });

  it("adds preview selection comments and submits them for AI editing", async () => {
    let sendBackendEvent: ((event: BackendEvent) => void) | null = null;
    function BackendEventProbe() {
      const { dispatch } = useAppState();
      sendBackendEvent = (event: BackendEvent) => dispatch({ type: "backend_event", event, sessionId: "session-a" });
      return null;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: {
            path: "outputs/report.html",
            name: "report.html",
            kind: "html",
            workspace: { path: "C:/repo", name: "repo" },
          },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
            workspace: { path: "C:/repo", name: "repo" },
          },
        }}
      >
        <BackendEventProbe />
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = await screen.findByTitle("report.html") as HTMLIFrameElement;
    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make headline clearer",
          },
        },
      }));
    });

    const commentChip = document.querySelector(".artifact-ai-comment") as HTMLElement | null;
    expect(commentChip).toBeTruthy();
    expect(commentChip?.getAttribute("data-tooltip")).toBe("1. Make headline clearer");
    expect(commentChip?.querySelector(".artifact-ai-comment-index")?.textContent).toBe("1");
    expect(commentChip?.querySelector(".artifact-ai-comment-text")).toBeNull();
    expect(commentChip?.querySelector(".artifact-ai-comment-instruction")?.textContent).toBe("Make hea...");
    expect(screen.queryByRole("dialog", { name: "AI 수정 의견 작성" })).toBeNull();
    await waitFor(() => expect(frame.srcdoc).toContain("myharness-ai-comment-anchor"));
    expect(frame.srcdoc).toContain('anchor.dataset.tooltip = comment.instruction || ""');
    expect(frame.srcdoc).toContain('data-tooltip-align="left"');
    expect(frame.srcdoc).toContain('data-tooltip-align="right"');
    expect(frame.srcdoc).toContain("anchor.dataset.tooltipAlign = \"left\"");
    expect(frame.srcdoc).toContain("delete anchor.dataset.tooltipAlign");
    expect(frame.srcdoc).toContain("document.body.appendChild(anchor)");
    expect(frame.srcdoc).toContain("positionCommentAnchors();");
    expect(frame.srcdoc).toContain('anchor.setAttribute("aria-label", "AI 수정 의견 " + comment.index + " 위치")');

    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));

    await waitFor(() => expect(aiEditArtifact).toHaveBeenCalledWith({
      path: "outputs/report.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
      comments: [
        expect.objectContaining({
          text: "Old headline",
          start: 0,
          end: 12,
          before: "",
          after: "Old body",
          html: "<h1>Old headline</h1>",
          instruction: "Make headline clearer",
        }),
      ],
    }));
    expect(screen.getByText("AI 자동편집 진행 중: outputs/report_v1.html")).toBeTruthy();
    expect(screen.getByRole("button", { name: "report.html 파일명 수정" })).toBeTruthy();
    expect(screen.getByTitle("report.html")).toBeTruthy();
    vi.mocked(readArtifact).mockClear();
    act(() => {
      sendBackendEvent?.({
        type: "tool_input_delta",
        tool_name: "write_file",
        arguments_delta: JSON.stringify({
          path: "outputs/report_v1.html",
          content: "<html><body><h1>Half written</h1></body></html>",
        }),
      } as BackendEvent);
    });
    expect(screen.getByTitle("report.html")).toBeTruthy();
    expect(screen.queryByTitle("report_v1.html")).toBeNull();
    expect(document.querySelector(".artifact-ai-progress")).toBeTruthy();

    act(() => {
      sendBackendEvent?.({
        type: "tool_completed",
        tool_name: "write_file",
        output: "Wrote outputs/report_v1.html",
      } as BackendEvent);
    });
    expect(readArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "report.html 파일명 수정" })).toBeTruthy();
    expect(screen.getByTitle("report.html")).toBeTruthy();
    expect(screen.queryByTitle("report_v1.html")).toBeNull();
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("Half written");

    act(() => {
      sendBackendEvent?.({ type: "line_complete" } as BackendEvent);
    });
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report_v1.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
    })));
    expect(await screen.findByRole("button", { name: "report_v1.html 파일명 수정" })).toBeTruthy();
  });

  it("keeps the inline AI edit popover open when a long instruction scrolls the textarea", async () => {
    const srcdoc = renderHtmlPreviewSrcdoc("<html><body><h1>Old headline</h1><p>Old body</p></body></html>");
    const dom = await loadPreviewDom(srcdoc);

    dom.window.document.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 24,
    }));
    const textarea = dom.window.document.querySelector(".myharness-ai-comment-popover textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    textarea.value = Array.from({ length: 300 }, (_, index) => `수정사항 ${index + 1}`).join("\n");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));

    expect(dom.window.document.querySelector(".myharness-ai-comment-popover")).toBeTruthy();
  });

  it("adds a document-wide AI edit comment from the preview", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "전체 문서",
            html: "",
            start: 0,
            end: 0,
            before: "",
            after: "",
            scope: "document",
            instruction: "전반적으로 임원 보고서 톤으로 정리해줘",
          },
        },
      }));
    });

    const commentChip = document.querySelector(".artifact-ai-comment") as HTMLElement | null;
    expect(commentChip?.getAttribute("data-tooltip")).toBe("1. 전반적으로 임원 보고서 톤으로 정리해줘");
    expect(commentChip?.querySelector(".artifact-ai-comment-instruction")?.textContent).toBe("전반적으로 임원...");
    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));

    await waitFor(() => expect(aiEditArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report.html",
      comments: [
        expect.objectContaining({
          text: "전체 문서",
          start: 0,
          end: 0,
          scope: "document",
          instruction: "전반적으로 임원 보고서 톤으로 정리해줘",
        }),
      ],
    })));
  });

  it("numbers multiple AI edit comments and sends them together", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Shorten the headline",
          },
        },
      }));
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old body",
            html: "<p>Old body</p>",
            start: 12,
            end: 20,
            before: "Old headline",
            after: "",
          },
        },
      }));
    });

    expect(await screen.findByRole("dialog", { name: "AI 수정 의견 작성" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("수정 의견"), "Make the body more specific");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect([...document.querySelectorAll(".artifact-ai-comment-index")].map((item) => item.textContent)).toEqual(["1", "2"]);
    const commentChips = [...document.querySelectorAll(".artifact-ai-comment")] as HTMLElement[];
    expect(commentChips.map((item) => item.getAttribute("data-tooltip"))).toEqual([
      "1. Shorten the headline",
      "2. Make the body more specific",
    ]);
    expect(document.querySelector(".artifact-ai-comment-text")).toBeNull();
    expect([...document.querySelectorAll(".artifact-ai-comment-instruction")].map((item) => item.textContent)).toEqual([
      "Shorten...",
      "Make the...",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));

    await waitFor(() => expect(aiEditArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report.html",
      comments: [
        expect.objectContaining({
          text: "Old headline",
          instruction: "Shorten the headline",
        }),
        expect.objectContaining({
          text: "Old body",
          instruction: "Make the body more specific",
        }),
      ],
    })));
  });

  it("shows AI edit workflow progress inside the comment overlay", async () => {
    let sendBackendEvent: ((event: BackendEvent) => void) | null = null;
    function BackendEventProbe() {
      const { dispatch } = useAppState();
      sendBackendEvent = (event: BackendEvent) => dispatch({ type: "backend_event", event, sessionId: "session-a" });
      return null;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          workflowEvents: [
            {
              id: "workflow-edit",
              toolName: "edit_file",
              title: "파일 수정",
              detail: "outputs/report.html",
              status: "running",
              level: "child",
              toolInput: {
                path: "outputs/report.html",
                old_str: "Old headline",
                new_str: "New headline",
              },
            },
          ],
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
        <BackendEventProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make it clearer",
          },
        },
      }));
    });

    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));

    expect(document.querySelector(".artifact-ai-progress .workflow-message")).toBeTruthy();
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("AI 편집 요청");
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("첫 streaming 이벤트 대기");
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("report_v1.html");
    expect(document.querySelector(".artifact-ai-progress .workflow-output-preview")?.textContent || "").not.toContain("Old headline");

    await userEvent.click(screen.getByRole("button", { name: "AI 수정 패널 접기" }));
    expect(document.querySelector(".artifact-ai-comments.collapsed")).toBeTruthy();
    expect(document.querySelector(".artifact-ai-progress")).toBeNull();
    expect(screen.getByRole("button", { name: "report.html 파일명 수정" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "AI 수정 패널 다시 펼치기" }));
    expect(document.querySelector(".artifact-ai-comments.collapsed")).toBeNull();
    expect(document.querySelector(".artifact-ai-progress")).toBeTruthy();

    act(() => {
      sendBackendEvent?.({
        type: "status",
        message: "수정 위치를 확인하고 있습니다.",
      });
    });
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("현재 상태");
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("수정 위치를 확인하고 있습니다.");

    act(() => {
      sendBackendEvent?.({
        type: "tool_started",
        tool_name: "edit_file",
        tool_call_index: 0,
        tool_input: {
          path: "outputs/report.html",
          old_str: "Old headline",
          new_str: "New headline",
        },
      });
    });

    await waitFor(() => expect(document.querySelector(".artifact-ai-progress .workflow-message")).toBeTruthy());
    expect(document.querySelector(".artifact-ai-progress .workflow-output-preview")?.textContent || "").toContain("report.html");
    expect(document.querySelector(".artifact-ai-progress .workflow-output-body")?.textContent || "").toContain("Old headline");
    expect(document.querySelector(".artifact-ai-progress .workflow-output-body")?.textContent || "").toContain("New headline");
  });

  it("keeps the AI edit progress panel scrolled to new workflow events without moving after user scrolls up", async () => {
    const user = userEvent.setup();
    let sendBackendEvent: ((event: BackendEvent) => void) | null = null;
    function BackendEventProbe() {
      const { dispatch } = useAppState();
      sendBackendEvent = (event: BackendEvent) => dispatch({ type: "backend_event", event, sessionId: "session-a" });
      return null;
    }

    const scrollHeights = new WeakMap<Element, number>();
    const clientHeights = new WeakMap<Element, number>();
    const scrollTopValues = new WeakMap<Element, number>();
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeights.get(this) ?? originalScrollHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return clientHeights.get(this) ?? originalClientHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValues.get(this) ?? originalScrollTop?.get?.call(this) ?? 0;
      },
      set(value: number) {
        scrollTopValues.set(this, value);
      },
    });

    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            artifactPanelOpen: true,
            clientId: "client-a",
            sessionId: "session-a",
            workspacePath: "C:/repo",
            workspaceName: "repo",
            activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
            activeArtifactPayload: {
              kind: "html",
              content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
            },
          }}
        >
          <ArtifactPanel />
          <BackendEventProbe />
        </AppStateProvider>,
      );

      await user.click(screen.getByRole("button", { name: "본문 수정" }));
      act(() => {
        window.dispatchEvent(new MessageEvent("message", {
          data: {
            type: artifactAiSelectionMessage,
            path: "outputs/report.html",
            selection: {
              text: "Old headline",
              html: "<h1>Old headline</h1>",
              start: 0,
              end: 12,
              before: "",
              after: "Old body",
              instruction: "Make it clearer",
            },
          },
        }));
      });

      await user.click(screen.getByRole("button", { name: "AI 자동편집" }));

      await waitFor(() => expect(document.querySelector(".artifact-ai-comments.with-progress")).toBeTruthy());
      await waitFor(() => expect(document.querySelector(".artifact-ai-progress")).toBeTruthy());
      const overlay = document.querySelector(".artifact-ai-comments.with-progress") as HTMLElement;
      const progress = document.querySelector(".artifact-ai-progress") as HTMLElement;
      clientHeights.set(overlay, 120);
      clientHeights.set(progress, 80);
      scrollHeights.set(overlay, 300);
      scrollHeights.set(progress, 360);
      overlay.scrollTop = 0;
      progress.scrollTop = 0;

      scrollHeights.set(overlay, 540);
      scrollHeights.set(progress, 760);
      act(() => {
        sendBackendEvent?.({
          type: "tool_started",
          tool_name: "edit_file",
          tool_call_index: 0,
          tool_input: {
            path: "outputs/report.html",
            old_str: "Old headline",
            new_str: "New headline",
          },
        });
      });

      await waitFor(() => expect(progress.scrollTop).toBe(760));
      expect(overlay.scrollTop).toBe(540);

      fireEvent.wheel(progress, { deltaY: -40 });
      progress.scrollTop = 100;
      fireEvent.scroll(progress);
      scrollHeights.set(overlay, 720);
      scrollHeights.set(progress, 960);
      act(() => {
        sendBackendEvent?.({
          type: "tool_started",
          tool_name: "edit_file",
          tool_call_index: 1,
          tool_input: {
            path: "outputs/second-report.html",
            old_str: "Second headline",
            new_str: "Better headline",
          },
        });
      });

      await waitFor(() => expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("second-report.html"));
      expect(progress.scrollTop).toBe(100);
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
    }
  });

  it("keeps the AI edit overlay in an explicit streaming wait state until live progress arrives", async () => {
    let sendBackendEvent: ((event: BackendEvent) => void) | null = null;
    function BackendEventProbe() {
      const { dispatch } = useAppState();
      sendBackendEvent = (event: BackendEvent) => dispatch({ type: "backend_event", event, sessionId: "session-a" });
      return null;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
        <BackendEventProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make it clearer",
          },
        },
      }));
    });

    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));

    act(() => {
      sendBackendEvent?.({
        type: "transcript_item",
        item: { role: "user", text: "AI edit request" },
      } as BackendEvent);
    });

    const progressText = document.querySelector(".artifact-ai-progress")?.textContent || "";
    expect(progressText).toContain("첫 streaming 이벤트 대기");
    expect(progressText).toContain("report_v1.html");
    expect(progressText).not.toContain("작업 계획 수립");

    act(() => {
      sendBackendEvent?.({
        type: "tool_started",
        tool_name: "edit_file",
        tool_call_index: 0,
        tool_input: {
          path: "outputs/report_v1.html",
          old_str: "Old headline",
          new_str: "New headline",
        },
      });
    });

    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("파일 수정");
    expect(document.querySelector(".artifact-ai-progress .workflow-output-body")?.textContent || "").toContain("New headline");
  });

  it("keeps AI edit progress visibly alive during a long pre-streaming wait", async () => {
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make it clearer",
          },
        },
      }));
    });

    await user.click(screen.getByRole("button", { name: "AI 자동편집" }));

    nowSpy.mockReturnValue(181_000);
    await user.click(screen.getByRole("button", { name: "AI 수정 패널 접기" }));
    await user.click(screen.getByRole("button", { name: "AI 수정 패널 다시 펼치기" }));

    const progressText = document.querySelector(".artifact-ai-progress")?.textContent || "";
    expect(progressText).toContain("AI 응답 대기 중");
    expect(progressText).toContain("3분 경과");
    expect(progressText).toContain("report_v1.html");
    expect(progressText).not.toContain("첫 streaming 이벤트 대기");
  });

  it("keeps the AI edit progress panel open on a transient event connection error", async () => {
    let sendBackendEvent: ((event: BackendEvent) => void) | null = null;
    function BackendEventProbe() {
      const { dispatch } = useAppState();
      sendBackendEvent = (event: BackendEvent) => dispatch({ type: "backend_event", event, sessionId: "session-a" });
      return null;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
        <BackendEventProbe />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make it clearer",
          },
        },
      }));
    });

    await userEvent.click(screen.getByRole("button", { name: "AI 자동편집" }));
    await waitFor(() => expect(screen.getByText("AI 자동편집 진행 중: outputs/report_v1.html")).toBeTruthy());

    act(() => {
      sendBackendEvent?.({ type: "error", message: "이벤트 연결 오류" } as BackendEvent);
    });

    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(readArtifact).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report_v1.html",
    }));
    expect(screen.getByRole("button", { name: "report.html 파일명 수정" })).toBeTruthy();
    expect(document.querySelector(".artifact-ai-progress")).toBeTruthy();
    expect(document.querySelector(".artifact-ai-progress")?.textContent || "").toContain("report_v1.html");
  });

  it("does not show two elapsed timers for AI edit waiting progress", async () => {
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body><h1>Old headline</h1><p>Old body</p></body></html>",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "본문 수정" }));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactAiSelectionMessage,
          path: "outputs/report.html",
          selection: {
            text: "Old headline",
            html: "<h1>Old headline</h1>",
            start: 0,
            end: 12,
            before: "",
            after: "Old body",
            instruction: "Make it clearer",
          },
        },
      }));
    });

    await user.click(screen.getByRole("button", { name: "AI 자동편집" }));

    nowSpy.mockReturnValue(59_000);
    await user.click(screen.getByRole("button", { name: "AI 수정 패널 접기" }));
    await user.click(screen.getByRole("button", { name: "AI 수정 패널 다시 펼치기" }));

    const waitingStep = [...document.querySelectorAll(".workflow-step")]
      .find((item) => (item.textContent || "").includes("streaming 이벤트 지연"));
    const elapsedMatches = waitingStep?.textContent?.match(/(?:\d+분(?: \d+초)?|\d+초) 경과/g) || [];
    expect(elapsedMatches).toEqual(["58초 경과"]);
  });

  it("renames the active preview title on double click and Enter", async () => {
    vi.mocked(renameArtifact).mockResolvedValueOnce({
      artifact: {
        path: "outputs/renamed-history-report.html",
        name: "renamed-history-report.html",
        kind: "html",
        size: 45,
        workspace: { path: "C:/history", name: "history" },
      },
      payload: { kind: "html", content: "<html><body>Renamed</body></html>", workspace: { path: "C:/history", name: "history" } },
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/current",
          workspaceName: "current",
          artifacts: [
            {
              path: "outputs/history-report.html",
              name: "history-report.html",
              kind: "html",
              size: 42,
              workspace: { path: "C:/history", name: "history" },
            },
          ],
          activeArtifact: {
            path: "outputs/history-report.html",
            name: "history-report.html",
            kind: "html",
            workspace: { path: "C:/history", name: "history" },
          },
          activeArtifactPayload: {
            kind: "html",
            content: "<html><body>History</body></html>",
            workspace: { path: "C:/history", name: "history" },
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.dblClick(screen.getByRole("button", { name: "history-report.html 파일명 수정" }));
    const input = document.querySelector(".artifact-title-rename-input") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "renamed-history-report.html{Enter}");

    await waitFor(() => expect(renameArtifact).toHaveBeenCalledWith({
      path: "outputs/history-report.html",
      name: "renamed-history-report.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/history",
      workspaceName: "history",
    }));
    expect(await screen.findByRole("button", { name: "renamed-history-report.html 파일명 수정" })).toBeTruthy();
  });

  it("switches artifact versions from the title menu", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [
            { path: "outputs/report.html", name: "report.html", kind: "html", size: 40 },
            { path: "outputs/report_v1.html", name: "report_v1.html", kind: "html", size: 41 },
            { path: "outputs/report_v2.html", name: "report_v2.html", kind: "html", size: 42 },
          ],
          activeArtifact: { path: "outputs/report_v1.html", name: "report_v1.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body>Version 1</body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const trigger = document.querySelector(".artifact-version-trigger") as HTMLButtonElement;
    expect(trigger.textContent).toBe("v1");
    await userEvent.click(trigger);

    const options = [...document.querySelectorAll(".artifact-version-option")];
    expect(options.map((item) => item.querySelector("span")?.textContent)).toEqual(["\uC6D0\uBCF8", "v1", "v2"]);
    await userEvent.click(screen.getByRole("menuitem", { name: /v2/ }));

    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report_v2.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
    })));
    expect(await screen.findByTitle("report_v2.html")).toBeTruthy();
  });

  it("keeps the file list open when a stale version preview load finishes after close", async () => {
    const versionArtifacts = [
      { path: "outputs/report.html", name: "report.html", kind: "html", size: 40 },
      { path: "outputs/report_v1.html", name: "report_v1.html", kind: "html", size: 41 },
    ];
    vi.mocked(listProjectFiles).mockResolvedValue({ scope: "default", files: versionArtifacts });
    const pendingReads = new Map<string, (payload: { kind: "html"; content: string }) => void>();
    vi.mocked(readArtifact).mockImplementation(({ path }) => new Promise((resolve) => {
      pendingReads.set(String(path), resolve);
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: versionArtifacts,
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "report.html 열기" }));
    await userEvent.click(document.querySelector(".artifact-version-trigger") as HTMLButtonElement);
    await userEvent.click(screen.getByRole("menuitem", { name: /v1/ }));

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.getByText("프로젝트 파일")).toBeTruthy();
    expect(screen.getByRole("button", { name: "report.html 열기" })).toBeTruthy();

    await act(async () => {
      pendingReads.get("outputs/report.html")?.({ kind: "html", content: "<html><body>Original</body></html>" });
      pendingReads.get("outputs/report_v1.html")?.({ kind: "html", content: "<html><body>Version 1</body></html>" });
      await Promise.resolve();
    });

    expect(screen.getByText("프로젝트 파일")).toBeTruthy();
    expect(screen.queryByTitle("report.html")).toBeNull();
    expect(screen.queryByTitle("report_v1.html")).toBeNull();
  });

  it("restores the loaded HTML when direct edit is canceled", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body>Preview</body></html>" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    let actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    await userEvent.click(actions[0]);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: artifactHtmlEditMessage,
          path: "outputs/report.html",
          html: "<html><body>Changed</body></html>",
        },
      }));
    });

    await waitFor(() => expect((screen.getByRole("button", { name: "편집 취소" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "편집 취소" }));

    actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    await waitFor(() => expect(screen.queryByRole("button", { name: "편집 취소" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "소스코드 확인" }));
    expect(screen.queryByText("완료된 HTML 원문은 우측 미리보기에서 생략했습니다. 렌더링 결과는 미리보기 탭에서 확인하세요.")).toBeNull();
    const code = document.querySelector(".artifact-source code.language-html");
    expect(code?.textContent || "").toContain("Preview");
    expect(code?.textContent || "").not.toContain("Changed");
  });

  it("shows streaming HTML source instead of a blank frame while the style block is incomplete", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/live-report.html", name: "live-report.html", kind: "html" },
          activeArtifactPayload: {
            kind: "html",
            content: "<!doctype html><html><head><style>.report{display:grid}",
          },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    expect(screen.queryByTitle("live-report.html")).toBeNull();
    const code = document.querySelector(".artifact-source code.language-html");
    expect(code?.textContent).toContain("<style>");
    expect(code?.textContent).toContain(".report{display:grid}");
  });

  it("selects the highlighted non-HTML artifact source instead of the whole page on Ctrl+A", async () => {
    const source = "def greet(name: str) -> str:\n    return f\"Hello, {name}\"\n";
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/example.py",
          name: "example.py",
          kind: "text",
          size: 42,
        },
      ],
    });
    vi.mocked(readArtifact).mockResolvedValueOnce({
      kind: "text",
      content: source,
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/example.py",
              name: "example.py",
              kind: "text",
              size: 42,
            },
          ],
        }}
      >
        <p>Different focus text</p>
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "example.py 열기" }));
    await screen.findByText("def");
    await userEvent.click(screen.getByRole("button", { name: "소스코드 확인" }));

    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe(source);
  });

  it("highlights Python project files in the preview", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/example.py",
          name: "example.py",
          kind: "text",
          size: 42,
        },
      ],
    });
    vi.mocked(readArtifact).mockResolvedValueOnce({
      kind: "text",
      content: "def greet(name: str) -> str:\n    return f\"Hello, {name}\"\n",
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/example.py",
              name: "example.py",
              kind: "text",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "example.py 열기" }));

    expect(screen.queryByLabelText("example.py 내용")).toBeNull();
    const code = document.querySelector(".artifact-source code.language-python");
    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("def");
    expect(code?.textContent).toContain("return");
  });

  it("shows a visible download button for unsupported document previews", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: {
            path: "outputs/namuwiki-history-report.pptx",
            name: "namuwiki-history-report.pptx",
            kind: "file",
            label: "PPTX",
            size: 42,
          },
          activeArtifactPayload: { kind: "file" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    expect(screen.getByText("이 파일 형식은 미리보기 대신 다운로드로 열 수 있습니다.")).toBeTruthy();
    const download = document.querySelector(".artifact-file-download") as HTMLAnchorElement;
    expect(download).toBeTruthy();
    expect(download.getAttribute("download")).toBe("namuwiki-history-report.pptx");
    expect(decodeURIComponent(download.getAttribute("href") || "")).toContain("path=outputs/namuwiki-history-report.pptx");
  });

  it("embeds PDF previews through the inline artifact URL", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          activeArtifact: {
            path: "outputs/quarterly-review.pdf",
            name: "quarterly-review.pdf",
            kind: "pdf",
            label: "PDF",
            size: 42,
          },
          activeArtifactPayload: { kind: "pdf", mime: "application/pdf" },
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    const frame = document.querySelector(".artifact-pdf-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(decodeURIComponent(frame.getAttribute("src") || "")).toContain("/api/artifact/raw?");
    expect(decodeURIComponent(frame.getAttribute("src") || "")).toContain("path=outputs/quarterly-review.pdf");
  });

  it("requires a second click before deleting a project file from the list", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/report.html",
          name: "report.html",
          kind: "html",
          size: 42,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [
            {
              path: "outputs/report.html",
              name: "report.html",
              kind: "html",
              size: 42,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("report.html");
    const actions = document.querySelector(".project-file-actions");
    const floatingActions = document.querySelector(".project-file-floating-actions");
    const main = document.querySelector(".project-file-main");
    expect(main?.children[1]?.getAttribute("aria-label")).toBe("report.html 열기");
    expect(floatingActions?.children[0]?.getAttribute("aria-label")).toBe("report.html 즐겨찾기 추가");
    expect(floatingActions?.children[1]?.getAttribute("aria-label")).toBe("report.html 파일명 수정");
    expect(floatingActions?.children[2]?.getAttribute("aria-label")).toBe("report.html 삭제");
    expect(actions?.children[0]?.textContent).toBe("42 B");
    expect(actions?.children[1]?.getAttribute("aria-label")).toBe("report.html 다운로드");

    await userEvent.click(screen.getByRole("button", { name: "report.html 삭제" }));
    expect(deleteArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "report.html 삭제 확인" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "report.html 삭제 확인" }));

    await waitFor(() => expect(deleteArtifact).toHaveBeenCalledWith({
      path: "outputs/report.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
    }));
    await waitFor(() => expect(screen.queryByText("report.html")).toBeNull());
  });

  it("pins project files into a virtual favorites section without removing the original row", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        { path: "outputs/report.html", name: "report.html", kind: "html", size: 42 },
        { path: "outputs/notes.md", name: "notes.md", kind: "markdown", size: 30 },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [
            { path: "outputs/report.html", name: "report.html", kind: "html", size: 42 },
            { path: "outputs/notes.md", name: "notes.md", kind: "markdown", size: 30 },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("report.html");
    await userEvent.click(screen.getByRole("button", { name: "report.html 즐겨찾기 추가" }));

    const pinnedSection = document.querySelector(".project-file-section-pinned");
    expect(pinnedSection?.querySelector(".project-file-section-title")?.textContent).toBe("즐겨찾기");
    expect(pinnedSection?.querySelector(".project-file-item strong")?.textContent).toBe("report.html");
    expect(pinnedSection?.querySelector(".project-file-floating-actions .project-file-pin")?.classList.contains("active")).toBe(true);
    expect([...document.querySelectorAll(".project-file-item strong")].filter((node) => node.textContent === "report.html")).toHaveLength(2);
    expect(localStorage.getItem("myharness:projectFilePins:C%3A%2Frepo")).toContain("outputs/report.html");

    await userEvent.click(screen.getAllByRole("button", { name: "report.html 즐겨찾기 해제" })[0]);
    expect(document.querySelector(".project-file-section-pinned")).toBeNull();
  });

  it("renames a project file from the list without losing its workspace", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/history-report.html",
          name: "history-report.html",
          kind: "html",
          size: 42,
          workspace: { path: "C:/history", name: "history" },
        },
      ],
    });
    vi.mocked(renameArtifact).mockResolvedValueOnce({
      artifact: {
        path: "outputs/renamed-history-report.html",
        name: "renamed-history-report.html",
        kind: "html",
        size: 45,
        workspace: { path: "C:/history", name: "history" },
      },
      payload: { kind: "html", content: "<html></html>", workspace: { path: "C:/history", name: "history" } },
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/current",
          workspaceName: "current",
          artifacts: [
            {
              path: "outputs/history-report.html",
              name: "history-report.html",
              kind: "html",
              size: 42,
              workspace: { path: "C:/history", name: "history" },
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "history-report.html 파일명 수정" }));
    expect(screen.queryByRole("dialog", { name: "파일명 수정" })).toBeNull();
    const input = document.querySelector(".project-file-inline-rename input") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "renamed-history-report.html{Enter}");

    await waitFor(() => expect(renameArtifact).toHaveBeenCalledWith({
      path: "outputs/history-report.html",
      name: "renamed-history-report.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/history",
      workspaceName: "history",
    }));
    expect(await screen.findByText("renamed-history-report.html")).toBeTruthy();
  });

  it("shows extension-specific colored badges for project files", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        { path: "outputs/report.html", name: "report.html", kind: "file", label: "HTML", size: 42 },
        { path: "outputs/notes.md", name: "notes.md", kind: "markdown", size: 30 },
        { path: "outputs/deck.pptx", name: "deck.pptx", kind: "file", label: "PPTX", size: 26 },
        { path: "outputs/data.csv", name: "data.csv", kind: "file", label: "CSV", size: 24 },
        { path: "outputs/script.py", name: "script.py", kind: "text", size: 18 },
        { path: "outputs/chart.png", name: "chart.png", kind: "image", size: 12 },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            { path: "outputs/report.html", name: "report.html", kind: "file", label: "HTML", size: 42 },
            { path: "outputs/notes.md", name: "notes.md", kind: "markdown", size: 30 },
            { path: "outputs/deck.pptx", name: "deck.pptx", kind: "file", label: "PPTX", size: 26 },
            { path: "outputs/data.csv", name: "data.csv", kind: "file", label: "CSV", size: 24 },
            { path: "outputs/script.py", name: "script.py", kind: "text", size: 18 },
            { path: "outputs/chart.png", name: "chart.png", kind: "image", size: 12 },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("report.html");
    const badgeByFileName = new Map(
      [...document.querySelectorAll(".project-file-item")].map((item) => [
        item.querySelector("strong")?.textContent,
        item.querySelector(".artifact-card-icon"),
      ]),
    );
    expect(badgeByFileName.get("report.html")?.textContent).toBe("HTML");
    expect(badgeByFileName.get("report.html")?.classList.contains("artifact-card-icon-web")).toBe(true);
    expect(badgeByFileName.get("notes.md")?.textContent).toBe("MD");
    expect(badgeByFileName.get("notes.md")?.classList.contains("artifact-card-icon-markdown")).toBe(true);
    expect(badgeByFileName.get("deck.pptx")?.textContent).toBe("PPTX");
    expect(badgeByFileName.get("deck.pptx")?.classList.contains("artifact-card-icon-docs")).toBe(true);
    expect(badgeByFileName.get("data.csv")?.textContent).toBe("CSV");
    expect(badgeByFileName.get("data.csv")?.classList.contains("artifact-card-icon-data")).toBe(true);
    expect(badgeByFileName.get("script.py")?.textContent).toBe("PY");
    expect(badgeByFileName.get("script.py")?.classList.contains("artifact-card-icon-code")).toBe(true);
    expect(badgeByFileName.get("chart.png")?.textContent).toBe("PNG");
    expect(badgeByFileName.get("chart.png")?.classList.contains("artifact-card-icon-image")).toBe(true);
  });

  it("uses the file path name when a project file summary has no name", async () => {
    const namelessArtifact = { path: "outputs/fallback-report.html", kind: "html", size: 42 } as any;
    vi.mocked(readArtifact).mockResolvedValueOnce({ kind: "html", content: "<html><body>Fallback</body></html>" });
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [namelessArtifact],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [namelessArtifact],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    expect(await screen.findByRole("button", { name: "fallback-report.html 열기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "fallback-report.html 파일명 수정" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "fallback-report.html 삭제" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "fallback-report.html 다운로드" })).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("undefined");

    await userEvent.click(screen.getByRole("button", { name: "fallback-report.html 열기" }));
    expect(await screen.findByRole("button", { name: "fallback-report.html 파일명 수정" })).toBeTruthy();
    expect(await screen.findByTitle("fallback-report.html")).toBeTruthy();
    expect(screen.getByRole("link", { name: "fallback-report.html 다운로드" })).toBeTruthy();
  });

  it("separates markdown files from document files in the project file filter", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        { path: "outputs/summary.md", name: "summary.md", kind: "markdown", size: 42 },
        { path: "outputs/deck.pptx", name: "deck.pptx", kind: "file", label: "PPTX", size: 24 },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            { path: "outputs/summary.md", name: "summary.md", kind: "markdown", size: 42 },
            { path: "outputs/deck.pptx", name: "deck.pptx", kind: "file", label: "PPTX", size: 24 },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("summary.md");
    const filter = screen.getByLabelText("프로젝트 파일 유형 필터");
    const filterLabels = [...filter.querySelectorAll("option")].map((option) => option.textContent);
    expect(filterLabels).toContain("웹페이지");
    expect(filterLabels).toContain("마크다운");

    await userEvent.selectOptions(filter, "markdown");
    expect(screen.getByText("summary.md")).toBeTruthy();
    expect(screen.queryByText("deck.pptx")).toBeNull();

    await userEvent.selectOptions(filter, "docs");
    expect(screen.getByText("deck.pptx")).toBeTruthy();
    expect(screen.queryByText("summary.md")).toBeNull();
  });

  it("shows project file size without repeating the file type label", async () => {
    vi.mocked(listProjectFiles).mockResolvedValueOnce({
      scope: "default",
      files: [
        {
          path: "outputs/evangelion-story-analysis-report.html",
          name: "evangelion-story-analysis-report.html",
          kind: "html",
          size: 21504,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifacts: [
            {
              path: "outputs/evangelion-story-analysis-report.html",
              name: "evangelion-story-analysis-report.html",
              kind: "html",
              size: 21504,
            },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("evangelion-story-analysis-report.html");
    const item = document.querySelector(".project-file-item");
    expect(item?.querySelector(".artifact-card-icon")?.textContent).toBe("HTML");
    expect(item?.querySelector(".artifact-card-size")?.textContent).toBe("21.0 KB");
    expect(item?.querySelector(".artifact-card-copy")?.textContent).not.toContain("HTML");
    expect(item?.querySelector(".project-file-open")?.getAttribute("data-tooltip")).toBe("evangelion-story-analysis-report.html");
  });

  it("organizes root project files into outputs", async () => {
    vi.mocked(listProjectFiles)
      .mockResolvedValueOnce({
        scope: "default",
        files: [
          { path: "root-report.html", name: "root-report.html", kind: "html", size: 42 },
          { path: "outputs/kept.html", name: "kept.html", kind: "html", size: 24 },
        ],
      })
      .mockResolvedValueOnce({
        scope: "default",
        files: [
          { path: "outputs/root-report.html", name: "root-report.html", kind: "html", size: 42 },
          { path: "outputs/kept.html", name: "kept.html", kind: "html", size: 24 },
        ],
      });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          clientId: "client-a",
          sessionId: "session-a",
          workspacePath: "C:/repo",
          workspaceName: "repo",
          artifacts: [
            { path: "root-report.html", name: "root-report.html", kind: "html", size: 42 },
            { path: "outputs/kept.html", name: "kept.html", kind: "html", size: 24 },
          ],
        }}
      >
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await screen.findByText("root-report.html");
    await userEvent.click(screen.getByRole("button", { name: "정리" }));
    expect(await screen.findByRole("dialog", { name: "루트 산출물 정리" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "선택 파일 이동" }));

    await waitFor(() => expect(organizeProjectFiles).toHaveBeenCalledWith({
      paths: ["root-report.html"],
      sessionId: "session-a",
      clientId: "client-a",
      expectedMtimes: {},
      workspacePath: "C:/repo",
      workspaceName: "repo",
    }));
    await waitFor(() => expect(listProjectFiles).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "default" })));
  });

  it("stops resizing when a move event shows the mouse button is no longer pressed", async () => {
    function ResizeState() {
      const { state } = useAppState();
      return <output aria-label="resize state">{`${state.artifactResizing}:${state.artifactPanelWidth}`}</output>;
    }

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
          activeArtifactPayload: { kind: "html", content: "<html><body>Preview</body></html>" },
          artifactPanelWidth: 520,
        }}
      >
        <ArtifactPanel />
        <ResizeState />
      </AppStateProvider>,
    );

    const handle = screen.getByRole("button", { name: "패널 너비 조절" });
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 900, buttons: 1 });
    });
    expect(screen.getByLabelText("resize state").textContent).toBe("true:520");

    act(() => {
      const move = new MouseEvent("pointermove", { bubbles: true, clientX: 850 });
      Object.defineProperty(move, "buttons", { value: 0 });
      window.dispatchEvent(move);
    });

    expect(screen.getByLabelText("resize state").textContent).toBe("false:520");
  });

  it("keeps enough chat width visible when the artifact panel is resized wide", () => {
    expect(clampArtifactPanelWidth(1420, { windowWidth: 1200, sidebarCollapsed: false })).toBe(532);
  });

  it("caps the artifact panel at the comfortable project-file width", () => {
    expect(clampArtifactPanelWidth(900, { windowWidth: 1600, sidebarCollapsed: true, maxWidth: 500 })).toBe(500);
  });
});
