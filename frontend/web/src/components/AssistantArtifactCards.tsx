import { useEffect, useState } from "react";
import { readArtifact, resolveArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import type { ChatMessage } from "../types/ui";
import {
  artifactIcon,
  artifactLabelForPath,
  collectArtifactCandidates,
  dedupeArtifactsByResolvedPath,
  formatBytes,
  labelForArtifact,
} from "../utils/artifacts";

export function AssistantArtifactCards({ message }: { message: ChatMessage }) {
  const { state, dispatch } = useAppState();
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [loadingPath, setLoadingPath] = useState("");

  useEffect(() => {
    let canceled = false;
    const candidates = collectArtifactCandidates(message.isComplete ? message.text : "");
    if (!candidates.length || (!state.sessionId && !state.workspacePath && !state.workspaceName)) {
      setArtifacts([]);
      return () => {
        canceled = true;
      };
    }

    async function resolveCandidates() {
      const resolved = await Promise.all(
        candidates.map(async (artifact) => {
          try {
            const payload = await resolveArtifact({
              sessionId: state.sessionId || undefined,
              clientId: state.clientId,
              workspacePath: state.workspacePath,
              workspaceName: state.workspaceName,
              path: artifact.path,
            });
            return {
              ...artifact,
              ...payload,
              path: payload.path || artifact.path,
              name: payload.name || artifact.name,
              kind: payload.kind || artifact.kind,
              label: payload.label || artifactLabelForPath(payload.path || artifact.path, payload.kind || artifact.kind),
            };
          } catch {
            return null;
          }
        }),
      );
      if (canceled) {
        return;
      }
      const nextArtifacts = dedupeArtifactsByResolvedPath(resolved.filter(Boolean) as ArtifactSummary[]);
      setArtifacts(nextArtifacts);
      if (nextArtifacts.length) {
        dispatch({ type: "set_artifacts", artifacts: nextArtifacts });
      }
    }

    void resolveCandidates();
    return () => {
      canceled = true;
    };
  }, [dispatch, message.isComplete, message.text, state.clientId, state.sessionId, state.workspaceName, state.workspacePath]);

  async function openArtifact(artifact: ArtifactSummary) {
    dispatch({ type: "open_artifact", artifact });
    setLoadingPath(artifact.path);
    try {
      const payload = await readArtifact({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        path: artifact.path,
      });
      dispatch({ type: "set_artifact_payload", payload });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setLoadingPath("");
    }
  }

  if (!message.isComplete || !artifacts.length) {
    return null;
  }

  return (
    <div className="artifact-cards" aria-label="답변 산출물">
      {artifacts.map((artifact) => (
        <button
          className="artifact-card"
          type="button"
          key={artifact.path}
          aria-label={`${artifact.name || artifact.path} 미리보기 열기`}
          data-artifact-path={artifact.path}
          onClick={() => void openArtifact(artifact)}
        >
          <span className="artifact-card-icon" aria-hidden="true">{artifactIcon(artifact.kind)}</span>
          <span className="artifact-card-copy">
            <strong>{artifact.name || artifact.path}</strong>
            <small>{loadingPath === artifact.path ? "불러오는 중" : [labelForArtifact(artifact), formatBytes(artifact.size)].filter(Boolean).join(" · ")}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
