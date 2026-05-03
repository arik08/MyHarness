import { useEffect } from "react";
import { listProjectFiles } from "../api/artifacts";
import { listHistory } from "../api/history";
import { listWorkspaces } from "../api/workspaces";
import { useAppState } from "../state/app-state";

export function useWorkspaceData() {
  const { state, dispatch } = useAppState();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const data = await listWorkspaces();
      if (cancelled) return;
      dispatch({ type: "set_workspaces", workspaces: data.workspaces, scope: data.scope });
      if (!state.workspaceName) {
        const selected = data.workspaces.find((workspace) => workspace.name === "Default") || data.workspaces[0];
        if (selected) {
          dispatch({ type: "set_workspace", workspace: selected });
        }
      }
    }

    void load().catch((error) => {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.workspaceName]);

  useEffect(() => {
    let cancelled = false;
    if (!state.workspaceName && !state.workspacePath) {
      return () => {
        cancelled = true;
      };
    }

    dispatch({ type: "set_history_loading", value: true });
    void listHistory({ workspacePath: state.workspacePath, workspaceName: state.workspaceName })
      .then((data) => {
        if (!cancelled) {
          dispatch({ type: "set_history", history: Array.isArray(data.options) ? data.options : [] });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          dispatch({ type: "set_history", history: [] });
          dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.historyRefreshKey, state.workspaceName, state.workspacePath]);

  useEffect(() => {
    let cancelled = false;
    if (!state.clientId || (!state.sessionId && !state.workspacePath && !state.workspaceName)) {
      return () => {
        cancelled = true;
      };
    }

    const request = listProjectFiles({
      sessionId: state.sessionId || undefined,
      clientId: state.clientId,
      workspacePath: state.workspacePath,
      workspaceName: state.workspaceName,
    });

    void request
      .then((data) => {
        if (!cancelled) {
          dispatch({ type: "set_artifacts", artifacts: Array.isArray(data.files) ? data.files : [] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: "set_artifacts", artifacts: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.artifactRefreshKey, state.clientId, state.sessionId, state.workspaceName, state.workspacePath]);
}
