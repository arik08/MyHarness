import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPanel, clampArtifactPanelWidth } from "../ArtifactPanel";
import { artifactAiSelectionMessage, artifactHtmlEditMessage } from "../ArtifactPreview";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { aiEditArtifact, deleteArtifact, listProjectFiles, organizeProjectFiles, overwriteArtifact, readArtifact, renameArtifact } from "../../api/artifacts";
import type { BackendEvent } from "../../types/backend";

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
  });

  it("highlights HTML source mode and omits the redundant back action", async () => {
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
    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.querySelector(".hljs-tag")?.textContent).toContain("<html>");
    expect(code?.textContent).toContain("<!doctype html>");
    expect(code?.textContent).toContain("<h1>Hello</h1>");
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
    expect(actions).toHaveLength(6);
    expect(actions[0].getAttribute("data-tooltip")).toBe("본문 수정");
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
    expect(actions).toHaveLength(5);
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
    expect(frame.srcdoc).toContain("const html = htmlFromRange(range)");
    expect(frame.srcdoc).toContain("showPendingHighlight(range.cloneRange())");
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
    expect(frame.srcdoc).not.toContain("myharness-ai-comment-mic");
    expect(frame.srcdoc).toContain("댓글 추가");
    expect(frame.srcdoc).toContain("취소");
    expect(frame.srcdoc).toContain("myharness-ai-comment-submit");
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

    await waitFor(() => expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: "수정사항 반영" }));

    await waitFor(() => expect(overwriteArtifact).toHaveBeenCalledWith({
      path: "outputs/report.html",
      content: "<html><body>Changed</body></html>",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
    }));
    actions = [...document.querySelectorAll<HTMLButtonElement>(".artifact-panel-actions .artifact-action")];
    expect((screen.getByRole("button", { name: "수정사항 반영" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "편집 취소" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(document.querySelector(".artifact-source code")?.textContent).toBe("");
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
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(expect.objectContaining({
      path: "outputs/report_v1.html",
      sessionId: "session-a",
      clientId: "client-a",
      workspacePath: "C:/repo",
      workspaceName: "repo",
    })));
    expect(await screen.findByRole("button", { name: "report_v1.html 파일명 수정" })).toBeTruthy();

    act(() => {
      sendBackendEvent?.({ type: "line_complete" } as BackendEvent);
    });
    expect(await screen.findByRole("button", { name: "report_v1.html 파일명 수정" })).toBeTruthy();
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

    expect(document.querySelector(".artifact-ai-progress-empty")?.textContent).toContain("AI 자동편집");
    expect(document.querySelector(".artifact-ai-progress-empty")?.textContent).toContain("초 경과");
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
    expect(document.querySelector(".artifact-source code")?.textContent).toContain("Preview");
    expect(document.querySelector(".artifact-source code")?.textContent).not.toContain("Changed");
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

  it("selects the highlighted artifact source instead of the whole page on Ctrl+A", async () => {
    const source = "<!doctype html>\n<html><body><h1>Hello</h1></body></html>";
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
      content: source,
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
        <p>Different focus text</p>
        <ArtifactPanel />
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "report.html 열기" }));
    await screen.findByTitle("report.html");
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
    const main = document.querySelector(".project-file-main");
    expect(main?.children[1]?.getAttribute("aria-label")).toBe("report.html 열기");
    expect(actions?.children[0]?.getAttribute("aria-label")).toBe("report.html 즐겨찾기 추가");
    expect(actions?.children[1]?.getAttribute("aria-label")).toBe("report.html 파일명 수정");
    expect(actions?.children[2]?.getAttribute("aria-label")).toBe("report.html 삭제");
    expect(actions?.children[3]?.textContent).toBe("42 B");
    expect(actions?.children[4]?.getAttribute("aria-label")).toBe("report.html 다운로드");

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
    expect(pinnedSection?.querySelector(".project-file-main")?.classList.contains("project-file-main-pinned")).toBe(true);
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
    expect(clampArtifactPanelWidth(1420, { windowWidth: 1200, sidebarCollapsed: false })).toBe(632);
  });
});
