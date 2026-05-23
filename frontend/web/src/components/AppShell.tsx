import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ChatPanel } from "./ChatPanel";
import { ArtifactPanel, artifactPanelListMaxWidth, clampArtifactPanelWidth } from "./ArtifactPanel";
import { ModalHost } from "./ModalHost";
import { Sidebar } from "./Sidebar";
import { TooltipLayer } from "./TooltipLayer";
import { useAppState } from "../state/app-state";
import {
  shouldAutoCollapseSidebarForChatWidth,
  sidebarAutoCollapseChatWidthPx,
  sidebarCollapsedTrackWidthPx,
} from "../layout/sidebarLayout";

const sidebarTransitionMs = 220;

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
  const previousSidebarCollapsedRef = useRef(state.sidebarCollapsed);
  const [sidebarTransitionHeld, setSidebarTransitionHeld] = useState(false);
  const sidebarTransitionStarted = previousSidebarCollapsedRef.current !== state.sidebarCollapsed;
  const sidebarTransitioning = sidebarTransitionStarted || sidebarTransitionHeld;
  useAutoSidebarCollapse(
    state.sidebarCollapsed,
    state.sidebarCollapseReason,
    state.sidebarWidth,
    state.artifactPanelOpen,
    state.artifactResizing,
    dispatch,
  );
  const className = [
    "app-shell",
    state.sidebarCollapsed ? "sidebar-collapsed" : "",
    sidebarTransitioning ? "sidebar-transitioning" : "",
    state.artifactPanelOpen ? "artifact-open" : "",
    state.sidebarResizing ? "resizing-sidebar" : "",
    state.artifactResizing ? "resizing-artifact" : "",
  ].filter(Boolean).join(" ");
  const style: AppShellStyle = {
    "--chat-panel-min-width": `${sidebarAutoCollapseChatWidthPx}px`,
    "--sidebar-collapsed-track-width": `${sidebarCollapsedTrackWidthPx}px`,
    "--sidebar-track-width": !state.sidebarCollapsed && state.sidebarWidth ? `${state.sidebarWidth}px` : undefined,
    "--artifact-panel-width": state.artifactPanelWidth
      ? `${state.activeArtifact ? state.artifactPanelWidth : Math.min(state.artifactPanelWidth, artifactPanelListMaxWidth)}px`
      : undefined,
  };

  useEffect(() => {
    if (previousSidebarCollapsedRef.current === state.sidebarCollapsed) {
      return undefined;
    }
    const wasCollapsed = previousSidebarCollapsedRef.current;
    let releaseTimeoutId: number | null = null;
    previousSidebarCollapsedRef.current = state.sidebarCollapsed;
    const manuallyReopened = wasCollapsed && !state.sidebarCollapsed && state.sidebarCollapseReason === "manual";
    if (
      manuallyReopened
      && state.artifactPanelOpen
    ) {
      const currentArtifactWidth = state.artifactPanelWidth || measuredPanelWidth(".artifact-panel");
      const reclaimedSidebarWidth = Math.max(0, state.sidebarWidth - sidebarCollapsedTrackWidthPx);
      if (currentArtifactWidth > 0 && reclaimedSidebarWidth > 0) {
        dispatch({
          type: "set_artifact_panel_width",
          value: Math.round(clampArtifactPanelWidth(currentArtifactWidth - reclaimedSidebarWidth, {
            windowWidth: window.innerWidth,
            sidebarCollapsed: false,
            sidebarWidth: state.sidebarWidth,
          })),
        });
      }
    }
    if (manuallyReopened) {
      releaseTimeoutId = window.setTimeout(() => {
        dispatch({ type: "release_sidebar_manual_open" });
      }, sidebarTransitionMs);
    }
    setSidebarTransitionHeld(true);
    const timeoutId = window.setTimeout(() => {
      setSidebarTransitionHeld(false);
    }, sidebarTransitionMs);
    return () => {
      window.clearTimeout(timeoutId);
      if (releaseTimeoutId !== null) {
        window.clearTimeout(releaseTimeoutId);
      }
    };
  }, [dispatch, state.sidebarCollapsed]);

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
  artifactResizing: boolean,
  dispatch: ReturnType<typeof useAppState>["dispatch"],
) {
  const sidebarStateRef = useRef({
    sidebarCollapsed,
    sidebarCollapseReason,
    sidebarWidth,
    artifactPanelOpen,
    artifactResizing,
  });

  useEffect(() => {
    sidebarStateRef.current = {
      sidebarCollapsed,
      sidebarCollapseReason,
      sidebarWidth,
      artifactPanelOpen,
      artifactResizing,
    };
  }, [sidebarCollapsed, sidebarCollapseReason, sidebarWidth, artifactPanelOpen, artifactResizing]);

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
