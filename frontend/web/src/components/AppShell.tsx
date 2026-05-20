import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { ChatPanel } from "./ChatPanel";
import { ArtifactPanel } from "./ArtifactPanel";
import { ModalHost } from "./ModalHost";
import { Sidebar } from "./Sidebar";
import { TooltipLayer } from "./TooltipLayer";
import { useAppState } from "../state/app-state";
import {
  shouldAutoCollapseSidebarForChatWidth,
  sidebarAutoCollapseChatWidthPx,
  sidebarCollapsedTrackWidthPx,
} from "../layout/sidebarLayout";

type AppShellStyle = CSSProperties & {
  "--artifact-panel-width"?: string;
  "--chat-panel-min-width": string;
  "--sidebar-collapsed-track-width": string;
  "--sidebar-track-width"?: string;
};

function measuredPanelWidth(selector: string) {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width || 0;
}

export function AppShell() {
  const { state, dispatch } = useAppState();
  useAutoSidebarCollapse(
    state.sidebarCollapsed,
    state.sidebarCollapseReason,
    state.sidebarWidth,
    state.artifactPanelOpen,
    dispatch,
  );
  const className = [
    "app-shell",
    state.sidebarCollapsed ? "sidebar-collapsed" : "",
    state.artifactPanelOpen ? "artifact-open" : "",
    state.sidebarResizing ? "resizing-sidebar" : "",
    state.artifactResizing ? "resizing-artifact" : "",
  ].filter(Boolean).join(" ");
  const style: AppShellStyle = {
    "--chat-panel-min-width": `${sidebarAutoCollapseChatWidthPx}px`,
    "--sidebar-collapsed-track-width": `${sidebarCollapsedTrackWidthPx}px`,
    "--sidebar-track-width": !state.sidebarCollapsed && state.sidebarWidth ? `${state.sidebarWidth}px` : undefined,
    "--artifact-panel-width": state.artifactPanelWidth ? `${state.artifactPanelWidth}px` : undefined,
  };

  useEffect(() => {
    if (state.themeId === "light") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = state.themeId;
    }
    localStorage.setItem("myharness:theme", state.themeId);
  }, [state.themeId]);

  useEffect(() => {
    if (state.sidebarCollapseReason === "auto") {
      return;
    }
    localStorage.setItem("myharness:sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
  }, [state.sidebarCollapsed, state.sidebarCollapseReason]);

  useEffect(() => {
    if (!state.sidebarCollapsed && state.sidebarWidth) {
      localStorage.setItem("myharness:sidebarWidth", String(state.sidebarWidth));
    }
  }, [state.sidebarCollapsed, state.sidebarWidth]);

  useEffect(() => {
    if (!state.artifactPanelWidth) {
      return;
    }
    if (state.activeArtifact) {
      localStorage.setItem("myharness:artifactPanelPreviewWidth", String(state.artifactPanelWidth));
    } else {
      localStorage.setItem("myharness:artifactPanelListWidth", String(state.artifactPanelWidth));
    }
  }, [state.activeArtifact, state.artifactPanelWidth]);

  return (
    <div className={className} data-react-webui="true" style={style}>
      <Sidebar />
      <ChatPanel />
      <ArtifactPanel />
      <ModalHost />
      <TooltipLayer />
    </div>
  );
}

function useAutoSidebarCollapse(
  sidebarCollapsed: boolean,
  sidebarCollapseReason: ReturnType<typeof useAppState>["state"]["sidebarCollapseReason"],
  sidebarWidth: number,
  artifactPanelOpen: boolean,
  dispatch: ReturnType<typeof useAppState>["dispatch"],
) {
  const sidebarStateRef = useRef({ sidebarCollapsed, sidebarCollapseReason, sidebarWidth, artifactPanelOpen });

  useEffect(() => {
    sidebarStateRef.current = { sidebarCollapsed, sidebarCollapseReason, sidebarWidth, artifactPanelOpen };
  }, [sidebarCollapsed, sidebarCollapseReason, sidebarWidth, artifactPanelOpen]);

  useEffect(() => {
    function collapsedSidebarWidth() {
      return measuredPanelWidth(".sidebar");
    }

    function projectedChatWidthWithExpandedSidebar(chatWidth: number, expandedSidebarWidth: number) {
      return chatWidth - Math.max(0, expandedSidebarWidth - collapsedSidebarWidth());
    }

    function updateSidebarForChatWidth() {
      const current = sidebarStateRef.current;
      const chatWidth = measuredPanelWidth(".chat-panel") || window.innerWidth;

      if (
        !current.sidebarCollapsed
        && current.sidebarCollapseReason !== "manual"
        && shouldAutoCollapseSidebarForChatWidth(chatWidth)
      ) {
        if (current.artifactPanelOpen) {
          const artifactWidth = measuredPanelWidth(".artifact-panel");
          const reclaimedSidebarWidth = Math.max(0, current.sidebarWidth - sidebarCollapsedTrackWidthPx);
          if (artifactWidth > 0 && reclaimedSidebarWidth > 0) {
            dispatch({ type: "set_artifact_panel_width", value: Math.round(artifactWidth + reclaimedSidebarWidth) });
          }
        }
        dispatch({ type: "set_sidebar_collapsed", value: true, source: "auto" });
      } else if (
        current.sidebarCollapsed
        && current.sidebarCollapseReason === "auto"
        && projectedChatWidthWithExpandedSidebar(chatWidth, current.sidebarWidth) > sidebarAutoCollapseChatWidthPx
      ) {
        dispatch({ type: "set_sidebar_collapsed", value: false, source: "auto" });
      }
    }

    const chatPanel = document.querySelector<HTMLElement>(".chat-panel");
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    updateSidebarForChatWidth();
    const animationFrameId = window.requestAnimationFrame(updateSidebarForChatWidth);
    const resizeObserver = typeof ResizeObserver === "undefined" || (!chatPanel && !appShell)
      ? null
      : new ResizeObserver(updateSidebarForChatWidth);
    if (chatPanel) {
      resizeObserver?.observe(chatPanel);
    }
    if (appShell) {
      resizeObserver?.observe(appShell);
    }
    window.addEventListener("resize", updateSidebarForChatWidth);
    window.visualViewport?.addEventListener("resize", updateSidebarForChatWidth);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateSidebarForChatWidth);
      window.visualViewport?.removeEventListener("resize", updateSidebarForChatWidth);
    };
  }, [dispatch]);
}
