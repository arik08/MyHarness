import { useEffect, useRef } from "react";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import type { AppState } from "../types/ui";

function conversationScope(state: AppState) {
  return JSON.stringify([state.sessionId, state.clientId, state.workspacePath, state.workspaceName, state.conversationViewRevision]);
}

// The selected artifact object identifies the opening action, including reopening
// the same path through another card or after closing the pane.
export function useArtifactReadGuard() {
  const { state } = useAppState();
  const latestState = useRef(state);
  latestState.current = state;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return (artifact: ArtifactSummary) => {
    const scope = conversationScope(state);
    return () => mounted.current
      && conversationScope(latestState.current) === scope
      && latestState.current.artifactPanelOpen
      && latestState.current.activeArtifact === artifact;
  };
}
