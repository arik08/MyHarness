import type { ArtifactSummary } from "../types/backend";

export const artifactPathExtensionPattern = "html?|md|markdown|txt|json|csv|xml|ya?ml|toml|ini|log|py|m?js|cjs|tsx?|jsx|css|sql|sh|ps1|bat|cmd|png|gif|jpe?g|webp|svg|pdf|docx?|xlsx?|pptx?|zip";

const artifactExtensions = new Set([
  "html",
  "htm",
  "md",
  "markdown",
  "txt",
  "json",
  "csv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "sql",
  "sh",
  "ps1",
  "bat",
  "cmd",
  "png",
  "gif",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
]);

const imageExtensions = new Set(["png", "gif", "jpg", "jpeg", "webp", "svg"]);
const textExtensions = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "csv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "sql",
  "sh",
  "ps1",
  "bat",
  "cmd",
]);

const documentExtensions = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip"]);
const sourceCodeExtensions = new Set(["py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "sql", "sh", "ps1", "bat", "cmd"]);

export function normalizeArtifactPath(value: string) {
  return String(value || "")
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/^["'`]+|["'`.,;:)]+$/g, "")
    .replace(/\\/g, "/");
}

export function normalizeProjectFilePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

export function artifactName(path: string) {
  const normalized = normalizeArtifactPath(path);
  return normalized.split("/").filter(Boolean).pop() || normalized || "artifact";
}

export function artifactExtension(path: string) {
  const name = artifactName(path);
  const match = name.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

export function isKnownArtifactPath(path: string) {
  return artifactExtensions.has(artifactExtension(path));
}

export function artifactKind(path: string) {
  const ext = artifactExtension(path);
  if (ext === "html" || ext === "htm") return "html";
  if (imageExtensions.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (textExtensions.has(ext)) return "text";
  return "file";
}

export function artifactKindLabel(kind: string) {
  if (kind === "html") return "HTML";
  if (kind === "image") return "이미지";
  if (kind === "pdf") return "PDF";
  if (kind === "text") return "텍스트";
  return "파일";
}

export function artifactLabelForPath(path: string, kind = artifactKind(path)) {
  if (kind === "file") {
    const ext = artifactExtension(path);
    if (documentExtensions.has(ext)) {
      return ext.toUpperCase();
    }
  }
  return artifactKindLabel(kind);
}

export function labelForArtifact(artifact: ArtifactSummary) {
  return artifact.label || artifactLabelForPath(artifact.path, artifact.kind);
}

export function artifactIcon(kind: string) {
  if (kind === "html") return "</>";
  if (kind === "image") return "IMG";
  if (kind === "pdf") return "PDF";
  if (kind === "text" || kind === "markdown" || kind === "json") return "TXT";
  return "FILE";
}

export function formatBytes(value?: number) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactCategoryForPath(path: string) {
  const ext = artifactExtension(path);
  if (["html", "htm"].includes(ext)) return "web";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "docs";
  if (["json", "csv", "xml", "yaml", "yml", "toml", "ini", "log"].includes(ext)) return "data";
  if (sourceCodeExtensions.has(ext)) return "code";
  return "other";
}

export function artifactCategory(artifact: ArtifactSummary) {
  return artifactCategoryForPath(artifact.path || artifact.name);
}

export function isRootProjectFileCandidatePath(path: string) {
  const normalized = normalizeProjectFilePath(path);
  if (!normalized || normalized.includes("/") || normalized.startsWith("outputs/")) return false;
  return isKnownArtifactPath(normalized);
}

export function isSourceCodeArtifact(artifact: ArtifactSummary) {
  return sourceCodeExtensions.has(artifactExtension(artifact.path || artifact.name));
}

export function sourceLanguageForArtifact(path: string) {
  const aliases: Record<string, string> = {
    htm: "html",
    html: "html",
    md: "markdown",
    markdown: "markdown",
    txt: "plaintext",
    json: "json",
    csv: "csv",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    log: "plaintext",
    svg: "xml",
    xml: "xml",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    css: "css",
    py: "python",
    sql: "sql",
    ps1: "powershell",
    sh: "bash",
    bat: "dos",
    cmd: "dos",
  };
  const ext = artifactExtension(path);
  return aliases[ext] || ext || "plaintext";
}

export function collectArtifactCandidates(text: string) {
  const value = String(text || "");
  const candidates: string[] = [];
  const push = (candidate: string) => {
    const normalized = normalizeArtifactPath(candidate);
    if (!normalized || !isKnownArtifactPath(normalized) || /^https?:\/\//i.test(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  for (const match of value.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    push(match[1]);
  }
  const backtickPattern = new RegExp(`\`([^\`\\n]+\\.(?:${artifactPathExtensionPattern}))\``, "gi");
  const pathPattern = new RegExp(`(?:^|[\\s(["'])((?:[A-Za-z]:)?[^\\s<>"'()]*\\.(?:${artifactPathExtensionPattern}))`, "gim");

  for (const match of value.matchAll(backtickPattern)) {
    push(match[1]);
  }
  for (const match of value.matchAll(pathPattern)) {
    push(match[1]);
  }

  const seen = new Set<string>();
  return candidates
    .filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map((path) => {
      const kind = artifactKind(path);
      return {
        path,
        name: artifactName(path),
        kind,
        label: artifactLabelForPath(path, kind),
      } satisfies ArtifactSummary;
    });
}

export function dedupeArtifactsByResolvedPath(artifacts: ArtifactSummary[]) {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = normalizeArtifactPath(artifact.path).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
