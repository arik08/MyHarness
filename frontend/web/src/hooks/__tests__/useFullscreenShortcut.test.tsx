import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactFullscreenScrollMessage, fullscreenMessage, useFullscreenShortcut } from "../useFullscreenShortcut";

function Harness({ disabled = false, path = "outputs/report.html" }) {
  useFullscreenShortcut();
  return <>
    <div data-testid="chat">Chat</div>
    <aside className="artifact-panel">
      <header data-testid="artifact-header">Report</header>
      <div className="artifact-viewer" data-testid="viewer" data-fullscreen-disabled={String(disabled)} data-artifact-path={path}>
        <p data-testid="document">Document</p>
        <iframe className="artifact-html-frame" title="report" />
        <input data-testid="input" />
        <textarea data-testid="textarea" />
        <select data-testid="select"><option>Choice</option></select>
        <div contentEditable suppressContentEditableWarning><span data-testid="contenteditable">Editable text</span></div>
      </div>
    </aside>
    <iframe title="unrelated" />
  </>;
}

describe("useFullscreenShortcut", () => {
  const fullscreenDescriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  const exitDescriptor = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
  const requestDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "requestFullscreen");
  let activeElement: Element | null = null;
  let requestFullscreen: ReturnType<typeof vi.fn>;
  let exitFullscreen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activeElement = null;
    requestFullscreen = vi.fn(function (this: Element) {
      activeElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    exitFullscreen = vi.fn(async () => {
      activeElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => activeElement });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
  });

  afterEach(() => {
    if (fullscreenDescriptor) Object.defineProperty(document, "fullscreenElement", fullscreenDescriptor);
    else Reflect.deleteProperty(document, "fullscreenElement");
    if (exitDescriptor) Object.defineProperty(document, "exitFullscreen", exitDescriptor);
    else Reflect.deleteProperty(document, "exitFullscreen");
    if (requestDescriptor) Object.defineProperty(Element.prototype, "requestFullscreen", requestDescriptor);
    else Reflect.deleteProperty(Element.prototype, "requestFullscreen");
    vi.restoreAllMocks();
  });

  it.each(["document", "artifact-header"])("fills fullscreen with only the document when right-clicking %s and restores on the next click", async (target) => {
    render(<Harness />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { screen.getByTestId(target).dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(activeElement).toBe(screen.getByTestId("viewer"));
    expect(activeElement?.contains(screen.getByTestId("artifact-header"))).toBe(false);
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("document")); });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(activeElement).toBeNull();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("keeps app fullscreen available outside the artifact panel", async () => {
    render(<Harness />);
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("chat")); });
    expect(activeElement).toBe(document.documentElement);
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("chat")); });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it.each(["right-click", "Escape"])("restores the prior document scroll when fullscreen exits through %s", async (exit) => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    render(<Harness />);
    const viewer = screen.getByTestId("viewer");
    const frame = screen.getByTitle("report") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    viewer.scrollLeft = 18;
    viewer.scrollTop = 640;
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: {
        type: fullscreenMessage, path: "outputs/report.html", scroll: { x: 23, y: 766 },
      } }));
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: artifactFullscreenScrollMessage, path: "outputs/report.html", action: "save", scroll: { x: 23, y: 766 },
    }, "*");
    viewer.scrollLeft = 0;
    viewer.scrollTop = 1200;
    await act(async () => {
      if (exit === "right-click") fireEvent.contextMenu(screen.getByTestId("document"));
      else {
        activeElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      }
    });
    act(() => { frames.splice(0).forEach((callback) => callback(0)); });
    expect(viewer.scrollLeft).toBe(18);
    expect(viewer.scrollTop).toBe(640);
    expect(postMessage).toHaveBeenCalledWith({
      type: artifactFullscreenScrollMessage, path: "outputs/report.html", action: "restore",
    }, "*");
  });

  it("does not restore an earlier fullscreen snapshot over a new entry before its request completes", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    render(<Harness />);
    const viewer = screen.getByTestId("viewer");
    viewer.scrollTop = 125;
    await act(async () => { fireEvent.contextMenu(viewer); });
    viewer.scrollTop = 600;
    await act(async () => { fireEvent.contextMenu(viewer); });
    viewer.scrollTop = 700;
    let finish!: () => void;
    requestFullscreen.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.contextMenu(viewer);
    act(() => { frames.splice(0).forEach((callback) => callback(0)); });
    expect(viewer.scrollTop).toBe(700);
    await act(async () => { finish(); });
  });

  it.each(["document", "artifact-header"])("leaves editing and file-list right-click handling intact on %s", async (target) => {
    render(<Harness disabled />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { screen.getByTestId(target).dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "select", "contenteditable"])("preserves right-click editing on a %s inside the artifact panel", async (target) => {
    render(<Harness />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { screen.getByTestId(target).dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("accepts fullscreen requests only from the active preview iframe with a matching artifact path", async () => {
    render(<Harness />);
    const frame = screen.getByTitle("report") as HTMLIFrameElement;
    const unrelated = screen.getByTitle("unrelated") as HTMLIFrameElement;
    for (const [source, path] of [
      [window, "outputs/report.html"],
      [unrelated.contentWindow, "outputs/report.html"],
      [frame.contentWindow, "outputs/stale-report.html"],
      [frame.contentWindow, undefined],
    ] as const) {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { source, data: { type: fullscreenMessage, path } }));
      });
    }
    expect(requestFullscreen).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: fullscreenMessage, path: "outputs/report.html" } }));
    });
    expect(activeElement).toBe(screen.getByTestId("viewer"));
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: fullscreenMessage, path: "outputs/report.html" } }));
    });
    expect(activeElement).toBeNull();
  });

  it("ignores iframe requests while the artifact is being edited", async () => {
    render(<Harness disabled />);
    const frame = screen.getByTitle("report") as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: fullscreenMessage, path: "outputs/report.html" } }));
    });
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("prevents duplicate fullscreen requests while an earlier transition is pending", async () => {
    let finish!: () => void;
    requestFullscreen.mockImplementationOnce(function (this: Element) {
      activeElement = this;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    render(<Harness />);
    fireEvent.contextMenu(screen.getByTestId("document"));
    fireEvent.contextMenu(screen.getByTestId("document"));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("document")); });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("allows another request after the browser rejects fullscreen", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    requestFullscreen.mockRejectedValueOnce(new Error("fullscreen denied"));
    render(<Harness />);
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("document")); });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(activeElement).toBeNull();
    await act(async () => { fireEvent.contextMenu(screen.getByTestId("document")); });
    expect(requestFullscreen).toHaveBeenCalledTimes(2);
    expect(activeElement).toBe(screen.getByTestId("viewer"));
  });

  it("restores document scroll when the browser rejects entering fullscreen", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<Harness />);
    const viewer = screen.getByTestId("viewer");
    const frame = screen.getByTitle("report") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    viewer.scrollTop = 640;
    requestFullscreen.mockImplementationOnce(() => {
      viewer.scrollTop = 0;
      return Promise.reject(new Error("fullscreen denied"));
    });
    await act(async () => { fireEvent.contextMenu(viewer); });
    act(() => { frames.splice(0).forEach((callback) => callback(0)); });
    expect(viewer.scrollTop).toBe(640);
    expect(postMessage).toHaveBeenCalledWith({
      type: artifactFullscreenScrollMessage, path: "outputs/report.html", action: "restore",
    }, "*");
    expect(activeElement).toBeNull();
  });

  it("removes right-click and frame-message listeners when unmounted", async () => {
    const view = render(<Harness />);
    view.unmount();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(event);
      window.dispatchEvent(new MessageEvent("message", { data: { type: fullscreenMessage, path: "outputs/report.html" } }));
    });
    expect(event.defaultPrevented).toBe(false);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});
