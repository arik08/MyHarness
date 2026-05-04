const webExtensions = new Set(["html", "htm"]);
const markdownExtensions = new Set(["md", "markdown"]);
const docsExtensions = new Set(["txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
const dataExtensions = new Set(["json", "csv", "xml", "yaml", "yml", "toml", "ini", "log"]);
const codeExtensions = new Set(["py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "sql", "sh", "ps1", "bat", "cmd"]);
const artifactCandidateExtensions = new Set([
  ...webExtensions,
  ...markdownExtensions,
  ...docsExtensions,
  ...dataExtensions,
  ...codeExtensions,
  "png",
  "gif",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "zip",
]);
const hiddenProjectFilePrefixes = [
  "autopilot-dashboard/",
  "docs/autopilot/",
  ".myharness/",
];

export const projectFileCategories = [
  { value: "all", label: "전체" },
  { value: "web", label: "웹페이지" },
  { value: "markdown", label: "마크다운" },
  { value: "docs", label: "문서" },
  { value: "data", label: "데이터" },
  { value: "code", label: "코드" },
  { value: "other", label: "기타" },
];

export function normalizeProjectFilePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

export function projectFileExtension(path) {
  const match = normalizeProjectFilePath(path).match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

export function artifactCategoryForPath(path) {
  const ext = projectFileExtension(path);
  if (webExtensions.has(ext)) return "web";
  if (markdownExtensions.has(ext)) return "markdown";
  if (docsExtensions.has(ext)) return "docs";
  if (dataExtensions.has(ext)) return "data";
  if (codeExtensions.has(ext)) return "code";
  return "other";
}

export function isVisibleProjectFilePath(path) {
  const normalized = normalizeProjectFilePath(path);
  return !hiddenProjectFilePrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

export function isArtifactCandidatePath(path) {
  return artifactCandidateExtensions.has(projectFileExtension(path));
}

export function isDefaultProjectFileCandidate(path) {
  const normalized = normalizeProjectFilePath(path);
  if (!normalized || !isVisibleProjectFilePath(normalized)) {
    return false;
  }
  if (normalized.startsWith("outputs/")) {
    return true;
  }
  if (normalized.includes("/")) {
    return false;
  }
  return isArtifactCandidatePath(normalized);
}

export function projectFileDirectory(path) {
  const normalized = normalizeProjectFilePath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "루트";
}

export function nextAvailableRelativePath(candidate, existingPaths) {
  const normalized = normalizeProjectFilePath(candidate);
  const existing = existingPaths instanceof Set
    ? existingPaths
    : new Set((existingPaths || []).map(normalizeProjectFilePath));
  const existingLower = new Set([...existing].map((path) => String(path).toLowerCase()));
  if (!existingLower.has(normalized.toLowerCase())) {
    return normalized;
  }
  const dot = normalized.lastIndexOf(".");
  const slash = normalized.lastIndexOf("/");
  const base = dot > slash ? normalized.slice(0, dot) : normalized;
  const suffix = dot > slash ? normalized.slice(dot) : "";
  let index = 2;
  while (existingLower.has(`${base}-${index}${suffix}`.toLowerCase())) {
    index += 1;
  }
  return `${base}-${index}${suffix}`;
}
