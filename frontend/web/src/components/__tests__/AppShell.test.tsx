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
      {state.sidebarCollapsed ? `collapsed:${collapseReason}` : "open:none"}
    </output>
  );
}

function ArtifactWidthProbe() {
  const { state } = useAppState();
  return <output aria-label="artifact width">{state.artifactPanelWidth ?? ""}</output>;
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
  });
});
