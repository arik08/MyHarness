import hljs from "highlight.js/lib/common";
import type { ArtifactSummary } from "../types/backend";
import type { ArtifactPayload } from "../types/ui";
import { isSourceCodeArtifact, sourceLanguageForArtifact } from "../utils/artifacts";
import { Icon } from "./ArtifactIcons";
import { MarkdownMessage } from "./MarkdownMessage";

export const artifactFrameBackMessage = "myharness:artifact-panel-back";

function iframeBackBridge(content: string) {
  const bridge = `
<script>
(() => {
  let pending = false;
  const sendBack = (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; }, 900);
    parent.postMessage({ type: "${artifactFrameBackMessage}" }, "*");
  };
  window.addEventListener("mousedown", sendBack, true);
  window.addEventListener("mouseup", sendBack, true);
  window.addEventListener("auxclick", sendBack, true);
})();
</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

export function isEditablePayload(artifact: ArtifactSummary, payload: ArtifactPayload) {
  const kind = String(payload.kind || artifact.kind || "");
  return kind === "html" || kind === "text" || kind === "markdown" || kind === "json";
}

function isMarkdownArtifact(artifact: ArtifactSummary, payload: ArtifactPayload) {
  const kind = String(payload.kind || artifact.kind || "").toLowerCase();
  const path = String(artifact.path || "").toLowerCase();
  return kind === "markdown" || path.endsWith(".md") || path.endsWith(".markdown");
}

export function ArtifactPreview({
  artifact,
  payload,
  draftContent,
  sourceMode,
  downloadUrl,
  onDraftContentChange,
}: {
  artifact: ArtifactSummary;
  payload: ArtifactPayload;
  draftContent: string;
  sourceMode: boolean;
  downloadUrl: string;
  onDraftContentChange: (value: string) => void;
}) {
  const kind = String(payload.kind || artifact.kind || "");
  const content = String(payload.content || "");
  const dataUrl = String(payload.dataUrl || "");
  if (sourceMode && content && (kind === "html" || isSourceCodeArtifact(artifact))) {
    return <HighlightedArtifactSource artifact={artifact} content={draftContent || content} />;
  }
  if (sourceMode && content) {
    return (
      <textarea
        className="artifact-text artifact-source-editor"
        value={draftContent || content}
        aria-label={`${artifact.name} 원문`}
        onChange={(event) => onDraftContentChange(event.currentTarget.value)}
      />
    );
  }
  if (kind === "html") {
    return <iframe className="artifact-frame artifact-html-frame" title={artifact.name} sandbox="allow-scripts" srcDoc={iframeBackBridge(draftContent || content)} />;
  }
  if (kind === "image") {
    return <img className="artifact-image" src={dataUrl} alt={artifact.name} />;
  }
  if (kind === "pdf") {
    return <iframe className="artifact-frame" title={artifact.name} src={dataUrl} />;
  }
  if (isMarkdownArtifact(artifact, payload)) {
    return (
      <div className="artifact-markdown">
        <MarkdownMessage text={content || "(내용 없음)"} />
      </div>
    );
  }
  if (content && isSourceCodeArtifact(artifact)) {
    return <HighlightedArtifactSource artifact={artifact} content={draftContent || content} />;
  }
  if (kind === "file") {
    return (
      <div className="artifact-file">
        <p className="artifact-empty">이 파일 형식은 미리보기 대신 다운로드로 열 수 있습니다.</p>
        <a className="artifact-file-download" href={downloadUrl} download={artifact.name} aria-label={`${artifact.name} 다운로드`}>
          <Icon name="download" />
          <span>다운로드</span>
        </a>
      </div>
    );
  }
  return (
    <textarea
      className="artifact-text artifact-source-editor"
      value={draftContent || content}
      aria-label={`${artifact.name} 내용`}
      onChange={(event) => onDraftContentChange(event.currentTarget.value)}
    />
  );
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function HighlightedArtifactSource({ artifact, content }: { artifact: ArtifactSummary; content: string }) {
  const language = sourceLanguageForArtifact(artifact.path);
  const highlighted = hljs.getLanguage(language)
    ? hljs.highlight(content, { language, ignoreIllegals: true }).value
    : escapeHtml(content);
  return (
    <pre className="artifact-text artifact-source">
      <code
        className={`hljs language-${language}`}
        data-highlighted="yes"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}
