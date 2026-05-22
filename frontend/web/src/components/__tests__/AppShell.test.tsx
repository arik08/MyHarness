import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../AppShell";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sidebarAutoCollapseChatWidthPx, sidebarCollapsedTrackWidthPx } from "../../layout/sidebarLayout";

vi.mock("../Sidebar", () => ({
  Sidebar: () => <aside className="sidebar" data-testid="sidebar" />,
}));

vi.mock("../ChatPanel", () => ({
  ChatPanel: () => <main className="chat-panel" data-testid="chat-panel" />,
}));

vi.mock("../ArtifactPanel", () => ({
  ArtifactPanel: () => <section className="artifact-panel" data-testid="artifact-panel" />,
  clampArtifactPanelWidth: (
    value: number,
    options: { windowWidth: number; sidebarCollapsed: boolean; sidebarWidth?: number },
  ) => {
    const sidebarWidth = options.sidebarCollapsed ? sidebarCollapsedTrackWidthPx : Math.max(268, options.sidebarWidth || 268);
    const maxWidth = Math.max(320, options.windowWidth - sidebarWidth - sidebarAutoCollapseChatWidthPx);
    return Math.min(Math.max(value, 320), maxWidth);
  },
}));

vi.mock("../ModalHost", () => ({
  ModalHost: () => null,
}));

vi.mock("../TooltipLayer", () => ({
  TooltipLayer: () => null,
}));

const chatAutoCollapseWidth = sidebarAutoCollapseChatWidthPx;
const collapsedSidebarWidth = sidebarCollapsedTrackWidthPx;

function SidebarStateProbe() {
  const { state } = useAppState();
  const collapseReason = (state as unknown as { sidebarCollapseReason?: string | null }).sidebarCollapseReason ?? null;
  return (
    <output aria-label="sidebar state">
      {state.sidebarCollapsed ? `collapsed:${collapseReason}` : `open:${collapseReason || "none"}`}
    </output>
  );
}

function ManualSidebarToggle() {
  const { state, dispatch } = useAppState();
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "set_sidebar_collapsed", value: !state.sidebarCollapsed, source: "manual" })}
    >
      manual sidebar toggle
    </button>
  );
}

function ArtifactWidthProbe() {
  const { state } = useAppState();
  return <output aria-label="artifact width">{state.artifactPanelWidth ?? ""}</output>;
}

function ArtifactWidthButton() {
  const { dispatch } = useAppState();
  return (
    <button type="button" onClick={() => dispatch({ type: "set_artifact_panel_width", value: 777 })}>
      resize artifact
    </button>
  );
}

function ArtifactResizeStateButton() {
  const { dispatch } = useAppState();
  return (
    <button type="button" onClick={() => dispatch({ type: "set_artifact_resizing", value: true })}>
      start artifact resize
    </button>
  );
}

function appShell() {
  const shell = document.querySelector(".app-shell");
  if (!shell) {
    throw new Error("Expected app shell to render");
  }
  return shell;
}

function rectWithWidth(width: number) {
  return {
    x: 0,
    y: 0,
    width,
    height: 760,
    top: 0,
    right: width,
    bottom: 760,
    left: 0,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

describe("AppShell sidebar auto collapse", () => {
  let chatPanelWidth = 960;
  let artifactPanelWidth = 360;

  beforeEach(() => {
    localStorage.clear();
    chatPanelWidth = 960;
    artifactPanelWidth = 360;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getTestRect(this: HTMLElement) {
      if (this.classList.contains("chat-panel")) {
        return rectWithWidth(chatPanelWidth);
      }
      if (this.classList.contains("artifact-panel")) {
        return rectWithWidth(artifactPanelWidth);
      }
      if (this.classList.contains("sidebar")) {
        return rectWithWidth(collapsedSidebarWidth);
      }
      return rectWithWidth(1200);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("auto-collapses when the pure chat panel width reaches 400px", () => {
    localStorage.setItem("myharness:sidebarCollapsed", "0");

    render(
      <AppStateProvider initialState={{ ...initialAppState, sidebarCollapsed: false }}>
        <AppShell />
        <SidebarStateProbe />
      </AppStateProvider>,
    );

    act(() => {
      chatPanelWidth = chatAutoCollapseWidth;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed:auto");
    expect(appShell().classList.contains("sidebar-transitioning")).toBe(true);
    expect(localStorage.getItem("myharness:sidebarCollapsed")).toBe("0");
  });

  it("keeps the sidebar open just above the 400px chat width boundary", () => {
    render(
      <AppStateProvider initialState={{ ...initialAppState, sidebarCollapsed: false }}>
        <AppShell />
        <SidebarStateProbe />
      </AppStateProvider>,
    );

    act(() => {
      chatPanelWidth = chatAutoCollapseWidth + 1;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:none");
  });

  it("gives reclaimed sidebar width to the artifact panel when auto-collapsing", () => {
    const expandedSidebarWidth = initialAppState.sidebarWidth;
    const reclaimedSidebarWidth = expandedSidebarWidth - collapsedSidebarWidth;
    artifactPanelWidth = 332;

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifactPanelWidth,
          artifactPanelListWidth: artifactPanelWidth,
          sidebarCollapsed: false,
          sidebarWidth: expandedSidebarWidth,
        }}
      >
        <AppShell />
        <SidebarStateProbe />
        <ArtifactWidthProbe />
      </AppStateProvider>,
    );

    act(() => {
      chatPanelWidth = chatAutoCollapseWidth;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed:auto");
    expect(screen.getByLabelText("artifact width").textContent).toBe(String(artifactPanelWidth + reclaimedSidebarWidth));
    expect(appShell().className).toContain("artifact-open");
    expect(appShell().classList.contains("sidebar-transitioning")).toBe(true);
  });

  it("keeps the sidebar transition active through fast artifact resize updates", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifactResizing: true,
          sidebarCollapsed: false,
        }}
      >
        <AppShell />
        <SidebarStateProbe />
        <ArtifactWidthButton />
      </AppStateProvider>,
    );

    act(() => {
      chatPanelWidth = chatAutoCollapseWidth;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed:auto");
    expect(appShell().classList.contains("resizing-artifact")).toBe(true);
    expect(appShell().classList.contains("sidebar-transitioning")).toBe(true);

    act(() => {
      screen.getByRole("button", { name: "resize artifact" }).click();
    });

    expect(appShell().classList.contains("resizing-artifact")).toBe(true);
    expect(appShell().classList.contains("sidebar-transitioning")).toBe(true);
  });

  it("releases a manually reopened auto-collapsed sidebar after narrowing the artifact panel", () => {
    vi.useFakeTimers();
    const expandedSidebarWidth = initialAppState.sidebarWidth;
    const expandedArtifactWidth = 568;
    const reclaimedSidebarWidth = expandedSidebarWidth - collapsedSidebarWidth;
    chatPanelWidth = chatAutoCollapseWidth;
    artifactPanelWidth = expandedArtifactWidth;

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifactPanelWidth: expandedArtifactWidth,
          artifactPanelListWidth: expandedArtifactWidth,
          sidebarCollapsed: true,
          sidebarCollapseReason: "auto",
          sidebarWidth: expandedSidebarWidth,
        } as typeof initialAppState}
      >
        <AppShell />
        <SidebarStateProbe />
        <ArtifactWidthProbe />
        <ManualSidebarToggle />
      </AppStateProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "manual sidebar toggle" }).click();
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:manual");
    expect(screen.getByLabelText("artifact width").textContent).toBe(String(expandedArtifactWidth - reclaimedSidebarWidth));

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:manual");

    act(() => {
      chatPanelWidth = chatAutoCollapseWidth + reclaimedSidebarWidth;
      vi.advanceTimersByTime(220);
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:none");
  });

  it("auto-collapses again when the user grows the artifact panel after manual reopen", () => {
    const expandedSidebarWidth = initialAppState.sidebarWidth;
    const reopenedArtifactWidth = 332;
    const reclaimedSidebarWidth = expandedSidebarWidth - collapsedSidebarWidth;
    chatPanelWidth = chatAutoCollapseWidth + 80;
    artifactPanelWidth = reopenedArtifactWidth;

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifactPanelOpen: true,
          artifactPanelWidth: reopenedArtifactWidth,
          artifactPanelListWidth: reopenedArtifactWidth,
          sidebarCollapsed: false,
          sidebarCollapseReason: null,
          sidebarWidth: expandedSidebarWidth,
        }}
      >
        <AppShell />
        <SidebarStateProbe />
        <ArtifactWidthProbe />
        <ArtifactResizeStateButton />
      </AppStateProvider>,
    );

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:none");

    act(() => {
      screen.getByRole("button", { name: "start artifact resize" }).click();
      chatPanelWidth = chatAutoCollapseWidth;
      artifactPanelWidth = reopenedArtifactWidth + 120;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed:auto");
    expect(screen.getByLabelText("artifact width").textContent).toBe(String(reopenedArtifactWidth + 120 + reclaimedSidebarWidth));
  });

  it("restores an auto-collapsed sidebar only when the expanded chat width can stay above 400px", () => {
    const expandedSidebarWidth = initialAppState.sidebarWidth;
    const restoreBoundary = chatAutoCollapseWidth + expandedSidebarWidth - collapsedSidebarWidth;
    chatPanelWidth = restoreBoundary;

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sidebarCollapsed: true,
          sidebarWidth: expandedSidebarWidth,
          sidebarCollapseReason: "auto",
        } as typeof initialAppState}
      >
        <AppShell />
        <SidebarStateProbe />
      </AppStateProvider>,
    );

    act(() => {
      chatPanelWidth = restoreBoundary;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("collapsed:auto");

    act(() => {
      chatPanelWidth = restoreBoundary + 1;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByLabelText("sidebar state").textContent).toBe("open:none");
    expect(appShell().classList.contains("sidebar-transitioning")).toBe(true);
  });
});
