import { Fragment, useEffect, useMemo, useState } from "react";
import { readArtifact, resolveArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import type { AppSettings, ChatMessage } from "../types/ui";
import {
  artifactDisplayName,
  artifactIcon,
  artifactKind,
  artifactLabelForPath,
  artifactName,
  collectArtifactCandidates,
  collectArtifactReferences,
  dedupeArtifactsByResolvedPath,
  formatBytes,
  labelForArtifact,
  normalizeArtifactPath,
  shouldResolveArtifactCandidate,
} from "../utils/artifacts";
import { countInlineSourceLinksInMarkdown, MarkdownMessage } from "./MarkdownMessage";
import type { SourceEvidenceByUrl } from "./MarkdownMessage";
import { StreamingAssistantMessage } from "./StreamingAssistantMessage";

type ResolvedArtifact = ArtifactSummary & {
  sourcePath: string;
};

function artifactKey(path: string) {
  return normalizeArtifactPath(path).toLowerCase();
}

function hasMermaidFence(text: string) {
  return /^ {0,3}(`{3,}|~{3,})\s*(?:mermaid|mmd)\b/im.test(String(text || ""));
}

function messageArtifactCandidates(message: ChatMessage) {
  if (message.artifacts?.length) {
    return message.artifacts.map((artifact) => {
      const path = normalizeArtifactPath(artifact.path || artifact.name || "");
      const kind = artifact.kind || artifactKind(path);
      return {
        ...artifact,
        path,
        name: artifact.name || artifactName(path),
        kind,
        label: artifact.label || artifactLabelForPath(path, kind),
      };
    }).filter((artifact) => artifact.path);
  }
  return collectArtifactCandidates(message.isComplete ? message.text : "");
}

function lineContainsArtifactPath(line: string, artifacts: ArtifactSummary[]) {
  const normalizedLine = line.replace(/\\/g, "/");
  return artifacts.some((artifact) => {
    const path = normalizeArtifactPath(artifact.path || "");
    return path && normalizedLine.includes(path);
  });
}

function removeStructuredArtifactReferenceLines(text: string, artifacts: ArtifactSummary[]) {
  if (!artifacts.length) {
    return text;
  }
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const remove = new Set<number>();
  lines.forEach((line, index) => {
    if (!lineContainsArtifactPath(line, artifacts)) {
      return;
    }
    remove.add(index);
    if (/^\s*["'`]{1,2}\s*$/.test(lines[index + 1] || "")) {
      remove.add(index + 1);
    }
    if (/^\s*(?:[-*+]\s*)?[^:\n]{0,120}:\s*["'`]*\s*$/.test(lines[index - 1] || "")) {
      remove.add(index - 1);
    }
    if (/^\s*["'`]{1,2}\s*$/.test(lines[index - 1] || "")) {
      remove.add(index - 1);
      if (/^\s*(?:[-*+]\s*)?[^:\n]{0,120}:\s*["'`]*\s*$/.test(lines[index - 2] || "")) {
        remove.add(index - 2);
      }
    }
  });
  return lines
    .filter((_line, index) => !remove.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeArtifactReferenceRanges(text: string, references: Array<{ start: number; end: number }>) {
  if (!references.length) {
    return text;
  }
  let cursor = 0;
  const output: string[] = [];
  for (const reference of [...references].sort((left, right) => left.start - right.start)) {
    if (reference.start < cursor) {
      continue;
    }
    output.push(text.slice(cursor, reference.start));
    cursor = reference.end;
  }
  output.push(text.slice(cursor));
  return output.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function useMessageArtifacts(message: ChatMessage) {
  const { state, dispatch } = useAppState();
  const [artifacts, setArtifacts] = useState<ResolvedArtifact[]>([]);
  const [loadingPath, setLoadingPath] = useState("");
  const candidateSignature = useMemo(
    () => messageArtifactCandidates(message)
      .filter((artifact) => shouldResolveArtifactCandidate(artifact.path, state.workspacePath))
      .map((artifact) => artifact.path)
      .join("\n"),
    [message, state.workspacePath],
  );

  useEffect(() => {
    let canceled = false;
    const candidates = messageArtifactCandidates(message)
      .filter((artifact) => shouldResolveArtifactCandidate(artifact.path, state.workspacePath));
    if (!candidates.length || (!state.sessionId && !state.workspacePath && !state.workspaceName)) {
      setArtifacts((current) => (current.length ? [] : current));
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
              sourcePath: artifact.path,
              path: payload.path || artifact.path,
              name: payload.name || artifact.name || artifactName(payload.path || artifact.path),
              kind: payload.kind || artifact.kind,
              workspace: payload.workspace || artifact.workspace,
              label: payload.label || artifactLabelForPath(payload.path || artifact.path, payload.kind || artifact.kind),
            };
          } catch (error) {
            const errorWithStatus = error as Error & { status?: number };
            if (errorWithStatus.status === 404) {
              return null;
            }
            return { ...artifact, sourcePath: artifact.path };
          }
        }),
      );
      if (canceled) {
        return;
      }
      const nextArtifacts = resolved.filter(Boolean) as ResolvedArtifact[];
      setArtifacts(nextArtifacts);
      if (nextArtifacts.length) {
        dispatch({ type: "set_artifacts", artifacts: dedupeArtifactsByResolvedPath(nextArtifacts) });
      }
    }

    void resolveCandidates();
    return () => {
      canceled = true;
    };
  }, [candidateSignature, dispatch, message.isComplete, message.text, state.clientId, state.sessionId, state.workspaceName, state.workspacePath]);

  async function openArtifact(artifact: ArtifactSummary) {
    const displayArtifact = { ...artifact, name: artifactDisplayName(artifact) };
    dispatch({ type: "open_artifact", artifact: displayArtifact });
    setLoadingPath(displayArtifact.path);
    try {
      const payload = await readArtifact({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: displayArtifact.workspace?.path || state.workspacePath,
        workspaceName: displayArtifact.workspace?.name || state.workspaceName,
        path: displayArtifact.path,
      });
      dispatch({ type: "open_artifact", artifact: { ...displayArtifact, workspace: payload.workspace || displayArtifact.workspace }, payload });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setLoadingPath("");
    }
  }

  const artifactBySourcePath = useMemo(() => {
    const map = new Map<string, ResolvedArtifact>();
    for (const artifact of artifacts) {
      map.set(artifactKey(artifact.sourcePath), artifact);
    }
    return map;
  }, [artifacts]);

  return {
    artifactBySourcePath,
    artifacts: dedupeArtifactsByResolvedPath(artifacts),
    loadingPath,
    openArtifact,
  };
}

function ArtifactCard({
  artifact,
  loadingPath,
  onOpen,
}: {
  artifact: ArtifactSummary;
  loadingPath: string;
  onOpen: (artifact: ArtifactSummary) => void;
}) {
  const displayName = artifactDisplayName(artifact);
  return (
    <button
      className="artifact-card"
      type="button"
      aria-label={`${displayName} 미리보기 열기`}
      data-artifact-path={artifact.path}
      onClick={() => onOpen(artifact)}
    >
      <span className="artifact-card-icon" aria-hidden="true">{artifactIcon(artifact.kind)}</span>
      <span className="artifact-card-copy">
        <strong>{displayName}</strong>
        <small>{loadingPath === artifact.path ? "불러오는 중" : [labelForArtifact(artifact), formatBytes(artifact.size)].filter(Boolean).join(" · ")}</small>
      </span>
    </button>
  );
}

export function AssistantArtifactCards({ message }: { message: ChatMessage }) {
  const { artifacts, loadingPath, openArtifact } = useMessageArtifacts(message);

  if (!message.isComplete || !artifacts.length) {
    return null;
  }

  return (
    <div className="artifact-cards" aria-label="답변 산출물">
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.path} artifact={artifact} loadingPath={loadingPath} onOpen={(nextArtifact) => void openArtifact(nextArtifact)} />
      ))}
    </div>
  );
}

export function AssistantArtifactContent({
  message,
  settings,
  active,
  onVisibleTextChange,
  sourceEvidenceByUrl,
}: {
  message: ChatMessage;
  settings: AppSettings;
  active: boolean;
  onVisibleTextChange?: () => void;
  sourceEvidenceByUrl?: SourceEvidenceByUrl;
}) {
  const { artifactBySourcePath, artifacts, loadingPath, openArtifact } = useMessageArtifacts(message);
  const hasStructuredArtifacts = Boolean(message.artifacts?.length);
  const structuredArtifactText = useMemo(
    () => (hasStructuredArtifacts ? removeStructuredArtifactReferenceLines(message.text, message.artifacts || []) : message.text),
    [hasStructuredArtifacts, message.artifacts, message.text],
  );
  const resolvedReferences = useMemo(() => {
    if (hasStructuredArtifacts || !message.isComplete || !artifactBySourcePath.size) {
      return [];
    }
    return collectArtifactReferences(message.text)
      .map((reference) => ({
        reference,
        artifact: artifactBySourcePath.get(artifactKey(reference.path)),
      }))
      .filter((item): item is { reference: ReturnType<typeof collectArtifactReferences>[number]; artifact: ResolvedArtifact } => Boolean(item.artifact))
      .sort((left, right) => left.reference.start - right.reference.start);
  }, [artifactBySourcePath, hasStructuredArtifacts, message.isComplete, message.text]);
  const parts = useMemo(() => {
    if (!resolvedReferences.length || hasMermaidFence(message.text)) {
      return [];
    }
    const nextParts: Array<{ type: "markdown"; text: string } | { type: "artifact"; artifact: ArtifactSummary }> = [];
    let cursor = 0;
    for (const { reference, artifact } of resolvedReferences) {
      if (reference.start < cursor) {
        continue;
      }
      const before = message.text.slice(cursor, reference.start);
      if (before.trim()) {
        nextParts.push({ type: "markdown", text: before });
      }
      nextParts.push({ type: "artifact", artifact });
      cursor = reference.end;
    }
    const after = message.text.slice(cursor);
    if (after.trim()) {
      nextParts.push({ type: "markdown", text: after });
    }
    return nextParts;
  }, [message.text, resolvedReferences]);
  const mermaidArtifactText = useMemo(() => (
    message.isComplete && resolvedReferences.length && hasMermaidFence(message.text)
      ? removeArtifactReferenceRanges(message.text, resolvedReferences.map((item) => item.reference))
      : structuredArtifactText
  ), [message.isComplete, message.text, resolvedReferences, structuredArtifactText]);
  const partSourceNumberOffsets = useMemo(() => {
    let total = 0;
    return parts.map((part) => {
      const offset = total;
      if (part.type === "markdown") {
        total += countInlineSourceLinksInMarkdown(part.text);
      }
      return offset;
    });
  }, [parts]);

  if (!parts.length) {
    return (
      <div className={(resolvedReferences.length && hasMermaidFence(message.text)) || hasStructuredArtifacts ? "assistant-artifact-content" : undefined}>
        <StreamingAssistantMessage
          message={mermaidArtifactText === message.text ? message : { ...message, text: mermaidArtifactText }}
          settings={settings}
          active={active}
          onVisibleTextChange={onVisibleTextChange}
          sourceEvidenceByUrl={sourceEvidenceByUrl}
        />
        {resolvedReferences.length && hasMermaidFence(message.text) ? (
          <div className="artifact-cards" aria-label="답변 산출물">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.path} artifact={artifact} loadingPath={loadingPath} onOpen={(nextArtifact) => void openArtifact(nextArtifact)} />
            ))}
          </div>
        ) : null}
        {hasStructuredArtifacts && artifacts.length ? (
          <div className="artifact-cards" aria-label="답변 산출물">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.path} artifact={artifact} loadingPath={loadingPath} onOpen={(nextArtifact) => void openArtifact(nextArtifact)} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="assistant-artifact-content">
      {parts.map((part, index) => (
        <Fragment key={part.type === "artifact" ? `${part.artifact.path}-${index}` : `markdown-${index}`}>
          {part.type === "markdown" ? (
            <MarkdownMessage text={part.text} sourceEvidenceByUrl={sourceEvidenceByUrl} sourceNumberOffset={partSourceNumberOffsets[index] || 0} />
          ) : (
            <div className="assistant-artifact-inline" aria-label="답변 산출물">
              <ArtifactCard artifact={part.artifact} loadingPath={loadingPath} onOpen={(artifact) => void openArtifact(artifact)} />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
