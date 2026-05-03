import { useEffect } from "react";
import type { CSSProperties } from "react";
import { ChatPanel } from "./ChatPanel";
import { ArtifactPanel } from "./ArtifactPanel";
import { ModalHost } from "./ModalHost";
import { Sidebar } from "./Sidebar";
import { TooltipLayer } from "./TooltipLayer";
import { useAppState } from "../state/app-state";

export function AppShell() {
  const { state } = useAppState();
  const className = [
    "app-shell",
    state.sidebarCollapsed ? "sidebar-collapsed" : "",
    state.artifactPanelOpen ? "artifact-open" : "",
    state.artifactResizing ? "resizing-artifact" : "",
  ].filter(Boolean).join(" ");
  const style = {
    "--artifact-panel-width": state.artifactPanelWidth ? `${state.artifactPanelWidth}px` : undefined,
  } as CSSProperties;

  useEffect(() => {
    if (state.themeId === "light") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = state.themeId;
    }
    localStorage.setItem("myharness:theme", state.themeId);
  }, [state.themeId]);

  useEffect(() => {
    localStorage.setItem("myharness:sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
  }, [state.sidebarCollapsed]);

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
