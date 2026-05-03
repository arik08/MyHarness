import { useEffect } from "react";
import { restartSession } from "./api/session";
import { AppShell } from "./components/AppShell";
import { useBackendSession } from "./hooks/useBackendSession";
import { useWorkspaceData } from "./hooks/useWorkspaceData";
import { AppStateProvider } from "./state/app-state";
import { useAppState } from "./state/app-state";

function AppContent() {
  const { state, dispatch } = useAppState();
  useBackendSession();
  useWorkspaceData();
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "o") {
        return;
      }
      event.preventDefault();
      void restartSession({
        sessionId: state.sessionId,
        clientId: state.clientId,
        cwd: state.workspacePath || undefined,
      }).then((session) => {
        dispatch({ type: "session_replaced", sessionId: session.sessionId, workspace: session.workspace });
      }).catch((error: unknown) => {
        dispatch({
          type: "open_modal",
          modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
        });
      });
    }
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [dispatch, state.clientId, state.sessionId, state.workspacePath]);
  return <AppShell />;
}

export default function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}
