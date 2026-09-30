import type { ArtifactSummary } from "../types/backend";
import type { ArtifactPayload } from "../types/ui";

export const artifactFrameBackMessage = "myharness:artifact-panel-back";
export const artifactHtmlEditMessage = "myharness:artifact-html-edit";
export const artifactAiSelectionMessage = "myharness:artifact-ai-selection";
export const artifactAiCommentsMessage = "myharness:artifact-ai-comments";
export const artifactFrameScrollMessage = "myharness:artifact-frame-scroll";
export const artifactFrameResizeMessage = "myharness:artifact-frame-resize";
export const artifactHtmlEditModeMessage = "myharness:artifact-html-edit-mode";
export const artifactCaptureRequestMessage = "myharness:artifact-capture-request";
export const artifactCaptureSnapshotMessage = "myharness:artifact-capture-snapshot";

export type ArtifactCaptureResult = { requestId: string; path: string; blob?: Blob; error?: string };

export function isEditablePayload(artifact: ArtifactSummary, payload: ArtifactPayload) {
  return String(payload.kind || artifact.kind || "") === "html";
}
