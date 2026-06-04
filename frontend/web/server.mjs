import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { countTokens } from "gpt-tokenizer";
import { compareHistoryItems, historyOrderTimestamp, lastAssistantActivityTimestamp } from "./modules/historyOrder.js";
import {
  artifactCategoryForPath,
  isDefaultProjectFileCandidate,
  nextAvailableRelativePath,
  normalizeProjectFilePath,
} from "./modules/projectFiles.js";
import {
  appendRawSessionEvent,
  canReplayFromLastEventId,
  createSessionReplayState,
  rawEventsAfterLastEventId,
  rememberSuppressedUserTranscript,
  replayEventsForState,
  shouldReplayRawEvent,
  updateSessionReplayState,
} from "./modules/sessionReplay.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = normalize(join(root, "../.."));
const webRoot = normalize(root);
const webDistRoot = normalize(join(root, "dist"));
const vendorRoot = normalize(join(root, "node_modules"));
const playgroundRoot = normalize(join(repoRoot, "Playground"));
const appConfigRoot = normalize(join(repoRoot, ".myharness"));
if (!String(process.env.MYHARNESS_CONFIG_DIR || "").trim()) {
  process.env.MYHARNESS_CONFIG_DIR = appConfigRoot;
}
if (!String(process.env.MYHARNESS_DATA_DIR || "").trim()) {
  process.env.MYHARNESS_DATA_DIR = join(appConfigRoot, "data");
}
if (!String(process.env.MYHARNESS_LOGS_DIR || "").trim()) {
  process.env.MYHARNESS_LOGS_DIR = join(appConfigRoot, "logs");
}
if (!String(process.env.MYHARNESS_HOME || "").trim()) {
  process.env.MYHARNESS_HOME = appConfigRoot;
}
const runtimeLogPath = join(process.env.MYHARNESS_LOGS_DIR, "myharness-web-runtime.log");
const webUsageStatsPath = join(process.env.MYHARNESS_DATA_DIR || join(appConfigRoot, "data"), "web-usage-stats.json");
configurePoscoCertificate();
const sharedWorkspaceScopeName = "shared";
const defaultWorkspaceName = "Default";
const projectPreferencesRel = join(".myharness", "preferences.json");
const appPreferencesRel = "preferences.json";
const artifactAliasesRel = join(".myharness", "artifact-aliases.json");
const port = Number(process.env.PORT || 4273);
const host = process.env.HOST || "0.0.0.0";
let effectiveHost = host;
const devUiRedirectEnabled = normalizeBooleanEnv(process.env.MYHARNESS_DEV_UI_REDIRECT);
const devUiRedirectPort = normalizeOptionalPort(
  process.env.MYHARNESS_DEV_UI_PORT || process.env.MYHARNESS_DEV_PORT || process.env.MYHARNESS_WEB_PORT || process.env.VITE_PORT,
);
let workspaceScopeMode = normalizeWorkspaceScopeMode(process.env.MYHARNESS_WORKSPACE_SCOPE);
let shellPreference = normalizeShellPreference(process.env.MYHARNESS_SHELL);
const protocolPrefix = "OHJSON:";
const sessions = new Map();
let webUsageStatsWriteQueue = Promise.resolve();
const recentDevRedirectVisitTtlMs = 15_000;
const recentDevRedirectVisits = new Map();
let server = null;
const workspaceMutationQueues = new Map();
const aiEditHeartbeatIntervalMs = 15_000;
const reservedWorkspaceNames = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const artifactPreviewMaxBytes = 8 * 1024 * 1024;
const artifactAiEditMaxBytes = 2 * 1024 * 1024;
const chatHtmlPreviewMaxBytes = 2 * 1024 * 1024;
const chatHtmlPreviewTtlMs = 10 * 60 * 1000;
const chatHtmlPreviews = new Map();
const clientAttachmentRootRel = ".myharness/client-uploads";
const clientAttachmentMaxFiles = 10;
const clientAttachmentMaxBytes = 32 * 1024 * 1024;
const clientAttachmentTotalMaxBytes = 80 * 1024 * 1024;
const artifactAssetWorkspaceTtlMs = 30 * 60 * 1000;
const artifactAssetWorkspaces = new Map();
const artifactTypes = {
  ".html": { kind: "html", mime: "text/html; charset=utf-8", encoding: "text" },
  ".htm": { kind: "html", mime: "text/html; charset=utf-8", encoding: "text" },
  ".md": { kind: "markdown", mime: "text/markdown; charset=utf-8", encoding: "text" },
  ".markdown": { kind: "markdown", mime: "text/markdown; charset=utf-8", encoding: "text" },
  ".txt": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".json": { kind: "text", mime: "application/json; charset=utf-8", encoding: "text" },
  ".csv": { kind: "text", mime: "text/csv; charset=utf-8", encoding: "text" },
  ".xml": { kind: "text", mime: "application/xml; charset=utf-8", encoding: "text" },
  ".yaml": { kind: "text", mime: "text/yaml; charset=utf-8", encoding: "text" },
  ".yml": { kind: "text", mime: "text/yaml; charset=utf-8", encoding: "text" },
  ".toml": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".ini": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".log": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".py": { kind: "text", mime: "text/x-python; charset=utf-8", encoding: "text" },
  ".js": { kind: "text", mime: "text/javascript; charset=utf-8", encoding: "text" },
  ".mjs": { kind: "text", mime: "text/javascript; charset=utf-8", encoding: "text" },
  ".cjs": { kind: "text", mime: "text/javascript; charset=utf-8", encoding: "text" },
  ".ts": { kind: "text", mime: "text/typescript; charset=utf-8", encoding: "text" },
  ".tsx": { kind: "text", mime: "text/typescript; charset=utf-8", encoding: "text" },
  ".jsx": { kind: "text", mime: "text/javascript; charset=utf-8", encoding: "text" },
  ".css": { kind: "text", mime: "text/css; charset=utf-8", encoding: "text" },
  ".sql": { kind: "text", mime: "application/sql; charset=utf-8", encoding: "text" },
  ".sh": { kind: "text", mime: "text/x-shellscript; charset=utf-8", encoding: "text" },
  ".ps1": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".bat": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".cmd": { kind: "text", mime: "text/plain; charset=utf-8", encoding: "text" },
  ".png": { kind: "image", mime: "image/png", encoding: "base64" },
  ".gif": { kind: "image", mime: "image/gif", encoding: "base64" },
  ".jpg": { kind: "image", mime: "image/jpeg", encoding: "base64" },
  ".jpeg": { kind: "image", mime: "image/jpeg", encoding: "base64" },
  ".webp": { kind: "image", mime: "image/webp", encoding: "base64" },
  ".svg": { kind: "image", mime: "image/svg+xml", encoding: "base64" },
  ".pdf": { kind: "pdf", mime: "application/pdf", encoding: "binary" },
  ".doc": { kind: "file", mime: "application/msword", encoding: "binary" },
  ".docx": { kind: "file", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", encoding: "binary" },
  ".xls": { kind: "file", mime: "application/vnd.ms-excel", encoding: "binary" },
  ".xlsx": { kind: "file", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", encoding: "binary" },
  ".ppt": { kind: "file", mime: "application/vnd.ms-powerpoint", encoding: "binary" },
  ".pptx": { kind: "file", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", encoding: "binary" },
  ".zip": { kind: "file", mime: "application/zip", encoding: "binary" },
};
const artifactListSkipDirs = new Set([
  ".git",
  ".github",
  ".mcp",
  ".myharness",
  ".next",
  ".openharness",
  ".playwright-mcp",
  ".plugins",
  ".pytest_cache",
  ".ruff_cache",
  ".skills",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "Playground",
  "venv",
]);
const artifactListMaxItems = 300;
const projectFileListMaxItems = 600;
const projectFileCacheTtlMs = 10_000;
const projectFileListCache = new Map();
const projectFileListSkipPrefixes = [
  "autopilot-dashboard/",
  "docs/autopilot/",
];
const shellCommandTimeoutMs = 60_000;
const shellOutputMaxChars = 24_000;
const tokenCountMaxChars = 200_000;
const modelOutputTokenDefault = 42_000;
const composeTargetOutputTokenMax = 40_000;
const maxActiveSessions = Math.max(1, Number(process.env.MYHARNESS_MAX_ACTIVE_SESSIONS || 20));
const maxBusySessions = Math.max(1, Number(process.env.MYHARNESS_MAX_BUSY_SESSIONS || 8));
const currentSessionBusyMessage = "현재 대화가 응답 중입니다. 답변이 끝난 뒤 다시 시도하거나 텍스트로 이어서 지시하세요.";
const clientResponseLimitMessage = "현재 브라우저에서 여러 작업이 동시에 진행 중입니다. 진행 중인 응답이 끝난 뒤 다시 시도하세요.";
const serverResponseLimitMessage = "여러 명이 동시에 작업 중이라 서버가 바쁩니다. 다른 응답이 끝난 뒤 다시 시도하세요.";
const activeSessionLimitMessage = "여러 명이 동시에 사용 중이라 열려 있는 작업 세션이 많습니다. 사용하지 않는 채팅을 닫고 다시 시도하세요.";
const modelOutputTokenCaps = Object.freeze({
  "gpt-5.5": 128_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
});
const configurableOutputTokenModels = Object.freeze(Object.keys(modelOutputTokenCaps));
const backendIdleClientCloseMs = Math.max(
  10,
  Number(process.env.MYHARNESS_BACKEND_IDLE_CLIENT_CLOSE_MS || 30 * 60 * 1000),
);
const sseHeartbeatMs = Math.max(10, Number(process.env.MYHARNESS_SSE_HEARTBEAT_MS || 15_000));

function errorPayload(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error || ""),
    stack: error?.stack || "",
  };
}

function writeRuntimeLog(event, details = {}) {
  try {
    mkdirSync(process.env.MYHARNESS_LOGS_DIR, { recursive: true });
    appendFileSync(runtimeLogPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      ...details,
    })}\n`, "utf8");
  } catch {
    // Logging must never be the reason the web server exits.
  }
}

writeRuntimeLog("server_process_start", {
  node: process.version,
  port,
  host,
  cwd: repoRoot,
});

function normalizeWorkspaceScopeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "ip" || mode === "client_ip" || mode === "client-ip" ? "ip" : "shared";
}

function isWildcardListenHost(value) {
  return value === "0.0.0.0" || value === "::";
}

function normalizeShellPreference(value) {
  const normalized = String(value || "auto").trim().toLowerCase().replace(/_/g, "-");
  if (["pwsh", "powershell", "powershell.exe", "power-shell"].includes(normalized)) {
    return "powershell";
  }
  if (["gitbash", "git-bash", "bash"].includes(normalized)) {
    return "git-bash";
  }
  if (["cmd", "cmd.exe", "command-prompt"].includes(normalized)) {
    return "cmd";
  }
  return "auto";
}

function configurePoscoCertificate() {
  if (process.platform !== "win32") {
    return;
  }
  const certPath = "C:\\POSCO_CA.crt";
  const bundlePath = join(repoRoot, "certs", "posco-ca-bundle.pem");
  if (!existsSync(certPath)) {
    return;
  }
  if (existsSync(bundlePath)) {
    process.env.SSL_CERT_FILE = bundlePath;
    process.env.REQUESTS_CA_BUNDLE = bundlePath;
    process.env.CURL_CA_BUNDLE = bundlePath;
    process.env.PIP_CERT = bundlePath;
  }
  process.env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS || certPath;
  process.env.npm_config_cafile = process.env.npm_config_cafile || certPath;
}

function forwardedAddressFromRequest(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(request.socket?.remoteAddress || "");
}

function normalizeClientAddress(value) {
  let address = String(value || "").trim();
  if (!address) {
    return "127.0.0.1";
  }
  if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  if (address === "::1") {
    return "127.0.0.1";
  }
  return address.replace(/^\[|\]$/g, "");
}

function isLoopbackAddress(value) {
  const address = normalizeClientAddress(value).toLowerCase();
  return address === "localhost" || address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("127.");
}

function hasAdminModeAccess(request) {
  return String(request.headers["x-myharness-admin-mode"] || "").trim() === "1";
}

function requireLocalAdminRequest(request, message = "This action can only be performed from the local MyHarness host") {
  const peerAddress = normalizeClientAddress(request.socket?.remoteAddress || "");
  const forwardedAddress = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (hasAdminModeAccess(request)) {
    return;
  }
  if (!isLoopbackAddress(peerAddress) || (forwardedAddress && !isLoopbackAddress(forwardedAddress))) {
    const error = new Error(message);
    error.status = 403;
    throw error;
  }
}

function safeWorkspaceScopeName(value) {
  const name = normalizeClientAddress(value).replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return name || "127.0.0.1";
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isPageVisitPath(pathname) {
  return pathname === "/" || pathname === "/index.html";
}

function normalizeBooleanEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeOptionalPort(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function devUiRedirectLocation(request) {
  if (!devUiRedirectEnabled || !devUiRedirectPort) {
    return null;
  }
  try {
    const incoming = new URL(request.url || "/", `http://${request.headers.host || `localhost:${port}`}`);
    const incomingPort = Number(incoming.port || "80");
    if (incomingPort === devUiRedirectPort) {
      return null;
    }
    incoming.protocol = "http:";
    incoming.port = String(devUiRedirectPort);
    return incoming.toString();
  } catch {
    return `http://localhost:${devUiRedirectPort}/`;
  }
}

function shouldRedirectDevUiRequest(request, pathname) {
  return (request.method === "GET" || request.method === "HEAD") && isPageVisitPath(pathname);
}

function hasBuiltReactUi() {
  return existsSync(join(webDistRoot, "index.html"));
}

function workspaceScopeFromRequest(request) {
  const name = workspaceScopeMode === "ip"
    ? safeWorkspaceScopeName(forwardedAddressFromRequest(request))
    : sharedWorkspaceScopeName;
  const scopeRoot = normalize(join(playgroundRoot, name));
  const rel = relative(playgroundRoot, scopeRoot);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\") || rel.includes("/")) {
    throw new Error("Workspace scope must stay directly inside Playground");
  }
  return { mode: workspaceScopeMode, name, root: scopeRoot };
}

function defaultWorkspaceScope() {
  const scopeRoot = normalize(join(playgroundRoot, sharedWorkspaceScopeName));
  return { mode: "shared", name: sharedWorkspaceScopeName, root: scopeRoot };
}

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${port}`).pathname);
  const relativePath = pathname.replace(/^\/+/, "");
  const filePath =
    pathname === "/" || pathname === "/index.html"
      ? (hasBuiltReactUi() ? join(webDistRoot, "index.html") : join(root, "index.html"))
      : pathname.startsWith("/web-assets/")
        ? join(webDistRoot, relativePath)
      : pathname === "/vendor/marked/marked.esm.js"
        ? join(vendorRoot, "marked/lib/marked.esm.js")
        : pathname === "/vendor/highlight/highlight.min.js"
          ? join(vendorRoot, "@highlightjs/cdn-assets/highlight.min.js")
          : pathname === "/vendor/highlight/github-dark.min.css"
            ? join(vendorRoot, "@highlightjs/cdn-assets/styles/github-dark.min.css")
        : pathname === "/vendor/katex/katex.mjs"
          ? join(vendorRoot, "katex/dist/katex.mjs")
          : pathname === "/vendor/katex/katex.min.css"
            ? join(vendorRoot, "katex/dist/katex.min.css")
            : pathname.startsWith("/vendor/katex/fonts/")
              ? join(vendorRoot, "katex/dist/fonts", pathname.replace("/vendor/katex/fonts/", ""))
        : join(root, relativePath);
  const normalized = normalize(filePath);

  if (
    normalized !== webRoot &&
    !normalized.startsWith(webRoot) &&
    normalized !== webDistRoot &&
    !normalized.startsWith(webDistRoot) &&
    !normalized.startsWith(vendorRoot)
  ) {
    return null;
  }

  return normalized;
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requestOrigin(request) {
  const hostHeader = String(request.headers.host || "").trim() || `localhost:${port}`;
  return `http://${hostHeader}`;
}

function publicBaseUrlForRequest(request) {
  const configured = String(
    process.env.MYHARNESS_SHARE_BASE_URL
    || process.env.MYHARNESS_PUBLIC_URL
    || process.env.MYHARNESS_LAN_URL
    || "",
  ).trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  try {
    const origin = new URL(requestOrigin(request));
    if (isLoopbackAddress(origin.hostname)) {
      return getLanUrl() || origin.origin;
    }
    return origin.origin;
  } catch {
    return getLanUrl() || `http://localhost:${port}`;
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRequestBuffer(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error("Uploaded files are too large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  return String(match?.[1] || match?.[2] || "").trim();
}

function parseHeaderParameters(value) {
  const result = {};
  for (const part of String(value || "").split(";").slice(1)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    let item = part.slice(separator + 1).trim();
    if (item.startsWith('"') && item.endsWith('"')) {
      item = item.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (key) {
      result[key] = item;
    }
  }
  return result;
}

function parseMultipartFormData(buffer, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    const error = new Error("Missing multipart boundary");
    error.status = 400;
    throw error;
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const fields = new Map();
  const files = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) {
      break;
    }
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) {
      partStart += 2;
    }
    const next = buffer.indexOf(delimiter, partStart);
    if (next < 0) {
      break;
    }
    let part = buffer.subarray(partStart, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf(headerSeparator);
    if (headerEnd >= 0) {
      const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
      const headers = {};
      for (const line of rawHeaders.split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
      const disposition = String(headers["content-disposition"] || "");
      const params = parseHeaderParameters(disposition);
      const fieldName = String(params.name || "").trim();
      if (fieldName) {
        const data = part.subarray(headerEnd + headerSeparator.length);
        if (Object.prototype.hasOwnProperty.call(params, "filename")) {
          files.push({
            fieldName,
            filename: String(params.filename || ""),
            media_type: String(headers["content-type"] || "application/octet-stream").trim(),
            data,
          });
        } else {
          fields.set(fieldName, data.toString("utf8"));
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}

function pruneChatHtmlPreviews() {
  const now = Date.now();
  for (const [id, preview] of chatHtmlPreviews) {
    if (preview.expiresAt <= now) {
      chatHtmlPreviews.delete(id);
    }
  }
}

function pruneArtifactAssetWorkspaces() {
  const now = Date.now();
  for (const [token, entry] of artifactAssetWorkspaces) {
    if (!entry || entry.expiresAt <= now) {
      artifactAssetWorkspaces.delete(token);
    }
  }
}

const chatHtmlPreviewAutosizeScript = `<script>
(function () {
  function visibleElementHeight() {
    var minTop = Infinity;
    var maxBottom = 0;
    var elements = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < elements.length; i += 1) {
      var element = elements[i];
      if (/^(script|style|link|meta)$/i.test(element.tagName)) {
        continue;
      }
      var style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }
      var rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }
      var fillsViewport = element.children.length > 0
        && rect.top <= 1
        && rect.height >= window.innerHeight - 2;
      if (fillsViewport) {
        continue;
      }
      minTop = Math.min(minTop, rect.top);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }
    if (!Number.isFinite(minTop) || maxBottom <= 0) {
      return 0;
    }
    var bodyStyle = document.body ? getComputedStyle(document.body) : null;
    var bottomSpace = bodyStyle
      ? (parseFloat(bodyStyle.marginBottom) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0)
      : 0;
    return Math.ceil(maxBottom + window.scrollY + bottomSpace);
  }
  function height() {
    var body = document.body;
    var doc = document.documentElement;
    var visibleHeight = visibleElementHeight();
    if (visibleHeight > 0) {
      return visibleHeight;
    }
    return Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0
    ));
  }
  function send() {
    var token = "";
    try {
      token = new URLSearchParams(location.search).get("ohPreviewToken") || window.name;
    } catch (error) {
      token = window.name;
    }
    parent.postMessage({
      type: "myharness-html-preview-size",
      token: token,
      height: height()
    }, "*");
  }
  function handleParentResize(event) {
    var token = "";
    try {
      token = new URLSearchParams(location.search).get("ohPreviewToken") || window.name;
    } catch (error) {
      token = window.name;
    }
    if (!event.data || event.data.type !== "myharness-html-preview-resize" || event.data.token !== token) {
      return;
    }
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (error) {
      var resizeEvent = document.createEvent("Event");
      resizeEvent.initEvent("resize", true, true);
      window.dispatchEvent(resizeEvent);
    }
    send();
    requestAnimationFrame(send);
    setTimeout(send, 120);
  }
  window.addEventListener("load", send);
  window.addEventListener("resize", send);
  window.addEventListener("message", handleParentResize);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", send);
  } else {
    send();
  }
  if (window.ResizeObserver) {
    new ResizeObserver(send).observe(document.documentElement);
  }
  if (window.MutationObserver) {
    new MutationObserver(send).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }
})();
<\/script>`;

const chatHtmlPreviewBaseStyle = `<style>
html,
body {
  background: transparent;
}
body {
  margin: 0;
}
</style>`;

function injectChatHtmlPreviewBaseStyle(content) {
  const value = String(content || "");
  if (/<head(?:\s[^>]*)?>/i.test(value)) {
    return value.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${chatHtmlPreviewBaseStyle}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(value)) {
    return value.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${chatHtmlPreviewBaseStyle}</head>`);
  }
  return `${chatHtmlPreviewBaseStyle}${value}`;
}

function injectChatHtmlPreviewAutosize(content) {
  const value = injectChatHtmlPreviewBaseStyle(content);
  if (/<\/body\s*>/i.test(value)) {
    return value.replace(/<\/body\s*>/i, `${chatHtmlPreviewAutosizeScript}</body>`);
  }
  if (/<\/html\s*>/i.test(value)) {
    return value.replace(/<\/html\s*>/i, `${chatHtmlPreviewAutosizeScript}</html>`);
  }
  return `${value}${chatHtmlPreviewAutosizeScript}`;
}

function wrapChatHtmlPreview(content) {
  const value = String(content || "");
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(value)) {
    return injectChatHtmlPreviewAutosize(value);
  }
  return injectChatHtmlPreviewAutosize(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>${value}</body>
</html>`);
}

function storeChatHtmlPreview(content) {
  const value = String(content || "");
  if (Buffer.byteLength(value, "utf8") > chatHtmlPreviewMaxBytes) {
    throw new Error("HTML preview is too large");
  }
  pruneChatHtmlPreviews();
  const id = crypto.randomUUID();
  chatHtmlPreviews.set(id, {
    content: wrapChatHtmlPreview(value),
    expiresAt: Date.now() + chatHtmlPreviewTtlMs,
  });
  return id;
}

function workspaceRelativeTarget(workspacePath, candidate) {
  const raw = String(candidate || "").trim();
  if (!raw) {
    throw new Error("Artifact path is required");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.toLowerCase().startsWith("file://")) {
    throw new Error("External URLs cannot be previewed");
  }
  const withoutFileScheme = raw
    .replace(/^file:\/\/\/?/i, "")
    .replace(/^\/([A-Za-z]:\/)/, "$1")
    .replace(/\\/g, "/");
  const target = isAbsolute(withoutFileScheme)
    ? normalize(withoutFileScheme)
    : normalize(join(workspacePath, withoutFileScheme));
  const rel = relative(workspacePath, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Artifact must stay inside the current project");
  }
  return { target, rel: rel.replace(/\\/g, "/") };
}

function artifactAliasPath(workspacePath) {
  return join(workspacePath, artifactAliasesRel);
}

function normalizeArtifactAliasPath(value) {
  return normalizeProjectFilePath(value);
}

function normalizeArtifactAliasMap(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const aliases = source.aliases && typeof source.aliases === "object" ? source.aliases : source;
  const normalized = {};
  for (const [from, to] of Object.entries(aliases)) {
    const sourcePath = normalizeArtifactAliasPath(from);
    const targetPath = normalizeArtifactAliasPath(to);
    if (sourcePath && targetPath && sourcePath !== targetPath) {
      normalized[sourcePath] = targetPath;
    }
  }
  return normalized;
}

async function readArtifactAliases(workspacePath) {
  return normalizeArtifactAliasMap(await readJsonFileIfExists(artifactAliasPath(workspacePath)));
}

async function writeArtifactAliases(workspacePath, aliases) {
  await writeJsonFileAtomic(artifactAliasPath(workspacePath), {
    version: 1,
    aliases: normalizeArtifactAliasMap(aliases),
  });
}

async function updateArtifactRenameAlias(session, oldRel, newRel) {
  const workspacePath = session.workspace.path;
  const aliases = await readArtifactAliases(workspacePath);
  const oldPath = normalizeArtifactAliasPath(oldRel);
  const newPath = normalizeArtifactAliasPath(newRel);
  for (const [from, to] of Object.entries(aliases)) {
    if (normalizeArtifactAliasPath(to) === oldPath) {
      aliases[from] = newPath;
    }
  }
  if (oldPath !== newPath) {
    aliases[oldPath] = newPath;
  }
  delete aliases[newPath];
  await writeArtifactAliases(workspacePath, aliases);
}

async function resolveArtifactTarget(session, artifactPath) {
  const initial = workspaceRelativeTarget(session.workspace.path, artifactPath);
  try {
    const info = await stat(initial.target);
    return { ...initial, info, aliasFrom: null };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const aliases = await readArtifactAliases(session.workspace.path);
  let rel = normalizeArtifactAliasPath(initial.rel);
  const visited = new Set([rel]);
  for (let depth = 0; depth < 8; depth += 1) {
    const nextRel = aliases[rel];
    if (!nextRel || visited.has(nextRel)) {
      break;
    }
    visited.add(nextRel);
    const next = workspaceRelativeTarget(session.workspace.path, nextRel);
    try {
      const info = await stat(next.target);
      return { ...next, info, aliasFrom: initial.rel };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    rel = next.rel;
  }
  throw Object.assign(new Error("Artifact not found"), { code: "ENOENT" });
}

async function readArtifactPreview(session, artifactPath) {
  const { target, rel, info } = await resolveArtifactTarget(session, artifactPath);
  const ext = extname(target).toLowerCase();
  const type = artifactTypes[ext];
  if (!type) {
    throw new Error("Unsupported artifact type");
  }
  if (!info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  if (type.encoding !== "binary" && info.size > artifactPreviewMaxBytes) {
    throw new Error("Artifact is too large to preview");
  }
  const payload = {
    path: rel,
    name: rel.split(/[\\/]/).pop() || rel,
    kind: type.kind,
    workspace: session.workspace,
    mime: type.mime,
    size: info.size,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs,
  };
  if (type.kind === "html") {
    payload.assetBaseUrl = artifactAssetBaseUrl(session, rel);
  }
  if (type.encoding === "binary") {
    return payload;
  }
  const body = await readFile(target);
  if (type.encoding === "base64") {
    payload.dataUrl = `data:${type.mime};base64,${body.toString("base64")}`;
  } else {
    payload.content = body.toString("utf8");
  }
  return payload;
}

function artifactAssetBaseUrl(session, artifactRel) {
  pruneArtifactAssetWorkspaces();
  const token = crypto.randomUUID();
  artifactAssetWorkspaces.set(token, {
    workspacePath: session.workspace.path,
    expiresAt: Date.now() + artifactAssetWorkspaceTtlMs,
  });
  const normalized = String(artifactRel || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  const encodedDir = parts.map((part) => encodeURIComponent(part)).join("/");
  return `/api/artifact/asset/${encodeURIComponent(token)}/${encodedDir ? `${encodedDir}/` : ""}`;
}

function artifactAssetSessionFromToken(token) {
  pruneArtifactAssetWorkspaces();
  const entry = artifactAssetWorkspaces.get(token);
  if (!entry?.workspacePath) {
    return null;
  }
  entry.expiresAt = Date.now() + artifactAssetWorkspaceTtlMs;
  return {
    workspace: {
      path: entry.workspacePath,
      name: basename(entry.workspacePath),
    },
  };
}

async function readArtifactMetadata(session, artifactPath) {
  const { target, rel, info } = await resolveArtifactTarget(session, artifactPath);
  const ext = extname(target).toLowerCase();
  const type = artifactTypes[ext];
  if (!type) {
    throw new Error("Unsupported artifact type");
  }
  if (!info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  return {
    path: rel,
    name: rel.split(/[\\/]/).pop() || rel,
    kind: type.kind,
    workspace: session.workspace,
    mime: type.mime,
    size: info.size,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

async function artifactAssetTarget(session, assetPath) {
  const { target, rel } = workspaceRelativeTarget(session.workspace.path, assetPath);
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error("Artifact asset is not a file");
  }
  const ext = extname(target).toLowerCase();
  const type = artifactTypes[ext] || { mime: "application/octet-stream" };
  return {
    target,
    rel,
    mime: type.mime || "application/octet-stream",
    size: info.size,
  };
}

async function artifactDownloadTarget(session, artifactPath) {
  const { target, rel, info } = await resolveArtifactTarget(session, artifactPath);
  if (!info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  const ext = extname(target).toLowerCase();
  const type = artifactTypes[ext] || { mime: "application/octet-stream" };
  return {
    target,
    rel,
    name: rel.split(/[\\/]/).pop() || "download",
    mime: type.mime || "application/octet-stream",
    size: info.size,
    ext,
  };
}

function shareWorkspaceFromParams(params, scope = defaultWorkspaceScope()) {
  return workspaceFromHistoryRequest({
    workspacePath: params.get("workspacePath"),
    workspaceName: params.get("workspace") || params.get("workspaceName"),
  }, scope);
}

function shareSessionFromParams(params, scope = defaultWorkspaceScope()) {
  return { workspace: shareWorkspaceFromParams(params, scope) };
}

function shareArtifactQuery(params, path) {
  const query = new URLSearchParams();
  const workspace = params.get("workspace") || params.get("workspaceName");
  const workspacePath = params.get("workspacePath");
  if (workspace) query.set("workspace", workspace);
  if (workspacePath) query.set("workspacePath", workspacePath);
  query.set("path", path);
  return query.toString();
}

function shareRawArtifactUrl(params, path) {
  return `/share/artifact/raw?${shareArtifactQuery(params, path)}`;
}

function shareSourceArtifactUrl(params, path) {
  return `/share/artifact/source?${shareArtifactQuery(params, path)}`;
}

function shareDownloadArtifactUrl(params, path) {
  return `/share/artifact/download?${shareArtifactQuery(params, path)}`;
}

function injectHtmlBase(content, baseHref) {
  const safeBase = escapeHtml(baseHref);
  const baseTag = `<base href="${safeBase}">`;
  const value = String(content || "");
  if (/<head(?:\s[^>]*)?>/i.test(value)) {
    return value.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${baseTag}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(value)) {
    return value.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${baseTag}</head>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${value}</body></html>`;
}

function shareArtifactShell(payload, params) {
  const name = payload.name || "artifact";
  const rawUrl = shareRawArtifactUrl(params, payload.path);
  const sourceUrl = shareSourceArtifactUrl(params, payload.path);
  const downloadUrl = shareDownloadArtifactUrl(params, payload.path);
  const safeName = escapeHtml(name);
  const safeRawUrl = escapeHtml(rawUrl);
  const safeSourceUrl = escapeHtml(sourceUrl);
  const safeDownloadUrl = escapeHtml(downloadUrl);
  const canShowSource = payload.content !== undefined;
  let body = "";
  if (payload.kind === "html" || payload.kind === "pdf") {
    body = `<iframe class="share-frame share-preview" src="${safeRawUrl}" title="${safeName}"></iframe>`;
  } else if (payload.kind === "image") {
    body = `<main class="share-image share-preview"><img src="${safeRawUrl}" alt="${safeName}"></main>`;
  } else if (payload.content !== undefined) {
    body = `<main class="share-text share-preview"><pre>${escapeHtml(payload.content)}</pre></main>`;
  } else {
    body = `<main class="share-download share-preview"><a href="${safeRawUrl}" download="${safeName}">파일 열기</a></main>`;
  }
  const sourcePanel = canShowSource
    ? `<main class="share-source" aria-label="${safeName} 소스코드"><pre><code></code></pre></main>`
    : "";
  const sourceActions = canShowSource
    ? `<button class="share-action" type="button" data-action="toggle-source" data-source-url="${safeSourceUrl}" aria-label="소스코드 확인" data-tooltip="소스코드 확인"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m10 8-4 4 4 4"></path><path d="m14 8 4 4-4 4"></path></svg></button>
      <button class="share-action" type="button" data-action="copy-source" data-source-url="${safeSourceUrl}" aria-label="소스코드 복사" data-tooltip="소스코드 복사"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>`
    : "";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>${safeName} - MyHarness</title>
  <style>
    :root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f8;color:#15171a}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;flex-direction:column}
    header{height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px 0 14px;border-bottom:1px solid rgba(0,0,0,.1);background:#fff}
    h1{margin:0;font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    a{color:inherit}
    .share-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
    .share-action{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid rgba(0,0,0,.12);border-radius:7px;background:transparent;color:inherit;cursor:pointer;text-decoration:none}
    .share-action:hover,.share-action:focus-visible,.share-action.active{border-color:rgba(37,99,235,.45);color:#2563eb;outline:none;background:rgba(37,99,235,.06)}
    .share-action svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .share-action[data-tooltip]::after{position:absolute;top:calc(100% + 7px);right:0;z-index:10;max-width:220px;padding:5px 7px;border-radius:6px;background:rgba(17,24,39,.94);color:#fff;content:attr(data-tooltip);font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;pointer-events:none;transform:translateY(2px);transition:opacity 120ms ease,transform 120ms ease;white-space:nowrap}
    .share-action:hover::after,.share-action:focus-visible::after{opacity:1;transform:translateY(0)}
    .share-frame{width:100%;flex:1;border:0;background:#fff}
    .share-image{flex:1;display:grid;place-items:center;padding:16px;overflow:auto}
    .share-image img{max-width:100%;height:auto}
    .share-text{flex:1;margin:0;padding:18px;overflow:auto;background:#fff}
    .share-text pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
    .share-source{display:none;flex:1;margin:0;padding:18px;overflow:auto;background:#fff}
    .share-source pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
    body.source-mode .share-preview{display:none}
    body.source-mode .share-source{display:block}
    .share-download{flex:1;display:grid;place-items:center}
    .share-download a{padding:9px 12px;border:1px solid rgba(0,0,0,.18);border-radius:8px;text-decoration:none;background:#fff}
    @media (prefers-color-scheme:dark){:root{background:#15171a;color:#f4f5f6}header,.share-text,.share-source,.share-frame,.share-download a{background:#1d2024;border-color:rgba(255,255,255,.14)}.share-action{border-color:rgba(255,255,255,.14)}.share-action:hover,.share-action:focus-visible,.share-action.active{background:rgba(96,165,250,.12);border-color:rgba(96,165,250,.5);color:#93c5fd}}
  </style>
</head>
<body>
  <header><h1>${safeName}</h1><div class="share-actions">${sourceActions}<a class="share-action" href="${safeDownloadUrl}" download="${safeName}" aria-label="다운로드" data-tooltip="다운로드"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg></a></div></header>
  ${body}
  ${sourcePanel}
  <script>
    (() => {
      const sourceButton = document.querySelector('[data-action="toggle-source"]');
      const copyButton = document.querySelector('[data-action="copy-source"]');
      const sourceCode = document.querySelector('.share-source code');
      let sourceText = null;
      async function loadSource(url) {
        if (sourceText !== null) return sourceText;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("Source load failed");
        sourceText = await response.text();
        if (sourceCode) sourceCode.textContent = sourceText;
        return sourceText;
      }
      async function copyText(text) {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      sourceButton?.addEventListener("click", async () => {
        try {
          await loadSource(sourceButton.dataset.sourceUrl || "");
          const active = !document.body.classList.contains("source-mode");
          document.body.classList.toggle("source-mode", active);
          sourceButton.classList.toggle("active", active);
          sourceButton.dataset.tooltip = active ? "미리보기" : "소스코드 확인";
          sourceButton.setAttribute("aria-label", active ? "미리보기" : "소스코드 확인");
        } catch {
          sourceButton.dataset.tooltip = "소스코드 확인 실패";
        }
      });
      copyButton?.addEventListener("click", async () => {
        try {
          await copyText(await loadSource(copyButton.dataset.sourceUrl || ""));
          copyButton.classList.add("active");
          copyButton.dataset.tooltip = "복사됨";
          window.setTimeout(() => {
            copyButton.classList.remove("active");
            copyButton.dataset.tooltip = "소스코드 복사";
          }, 1400);
        } catch {
          copyButton.dataset.tooltip = "복사 실패";
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function handleShare(request, response, pathname) {
  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return true;
  }
  if (pathname !== "/share/artifact" && pathname !== "/share/artifact/raw" && pathname !== "/share/artifact/source" && pathname !== "/share/artifact/download") {
    return false;
  }
  const params = new URL(request.url, `http://localhost:${port}`).searchParams;
  try {
    const session = shareSessionFromParams(params, defaultWorkspaceScope());
    const artifactPath = params.get("path");
    if (pathname === "/share/artifact/source") {
      const payload = await readArtifactPreview(session, artifactPath);
      if (payload.content === undefined) {
        throw new Error("Artifact source is not available");
      }
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(payload.content);
      return true;
    }
    if (pathname === "/share/artifact/download") {
      const payload = await artifactDownloadTarget(session, artifactPath);
      const encodedName = encodeURIComponent(payload.name).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      );
      const fallbackName = asciiHeaderFilename(payload.name);
      const body = await readDownloadableArtifactBody(payload.target, payload.ext);
      response.writeHead(200, {
        "Content-Type": payload.mime,
        "Content-Length": String(body?.length || payload.size),
        "Content-Disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (body) {
        response.end(body);
      } else {
        createReadStream(payload.target).pipe(response);
      }
      return true;
    }
    if (pathname === "/share/artifact/raw") {
      const payload = await artifactDownloadTarget(session, artifactPath);
      let body = null;
      if (payload.ext === ".html" || payload.ext === ".htm") {
        const htmlPayload = await readArtifactPreview(session, artifactPath);
        body = withDownloadedMermaidZoomBridge(injectHtmlBase(htmlPayload.content || "", htmlPayload.assetBaseUrl || ""));
      }
      response.writeHead(200, {
        "Content-Type": payload.mime,
        "Cache-Control": "no-store",
        "Content-Length": body === null ? payload.size : Buffer.byteLength(body, "utf8"),
        "X-Content-Type-Options": "nosniff",
      });
      if (body === null) {
        createReadStream(payload.target).pipe(response);
      } else {
        response.end(body);
      }
      return true;
    }
    const payload = await readArtifactPreview(session, artifactPath);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(shareArtifactShell(payload, params));
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(error.message || "Could not open shared artifact");
  }
  return true;
}

function withDownloadedMermaidZoomBridge(content) {
  const value = String(content || "");
  if (!/\bmermaid\b/i.test(value) || /data-myharness-mermaid-zoom-script/i.test(value)) {
    return value;
  }
  const renderer = hasDownloadedRawMermaid(value) && !/data-myharness-mermaid-renderer-script/i.test(value)
    ? downloadedMermaidRendererBridge()
    : "";
  const bridge = `
${renderer}
<style data-myharness-mermaid-zoom-style="true">
.myharness-mermaid-zoom-host{position:relative!important}
.myharness-mermaid-expand-button{position:absolute;top:10px;right:10px;z-index:50;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid rgba(17,24,39,.16);border-radius:6px;background:rgba(255,255,255,.94);color:#17212f;box-shadow:0 8px 22px rgba(15,23,42,.14);cursor:pointer}
.myharness-mermaid-expand-button:hover,.myharness-mermaid-expand-button:focus-visible{border-color:rgba(37,99,235,.48);color:#1d4ed8;outline:none}
.myharness-mermaid-expand-button svg,.myharness-mermaid-zoom-control svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.myharness-mermaid-zoom-backdrop{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:rgba(248,250,252,.98);color:#17212f}
.myharness-mermaid-zoom-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid rgba(17,24,39,.12);background:#fff;font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.myharness-mermaid-zoom-title{font-weight:700}
.myharness-mermaid-zoom-controls{display:flex;align-items:center;gap:6px}
.myharness-mermaid-zoom-value{min-width:48px;text-align:center;color:#5d6877}
.myharness-mermaid-zoom-control{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;border:1px solid rgba(17,24,39,.14);border-radius:6px;background:#fff;color:#17212f;font:700 13px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.myharness-mermaid-zoom-control:hover,.myharness-mermaid-zoom-control:focus-visible{border-color:rgba(37,99,235,.48);color:#1d4ed8;outline:none}
.myharness-mermaid-zoom-control[data-tooltip]::after{position:absolute;top:calc(100% + 7px);left:50%;z-index:10000;max-width:220px;padding:5px 7px;border-radius:6px;background:rgba(17,24,39,.94);color:#fff;content:attr(data-tooltip);font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;pointer-events:none;transform:translate(-50%,2px);transition:opacity 120ms ease,transform 120ms ease;white-space:nowrap}
.myharness-mermaid-zoom-control:hover::after,.myharness-mermaid-zoom-control:focus-visible::after{opacity:1;transform:translate(-50%,0)}
.myharness-mermaid-zoom-viewport{flex:1;overflow:hidden;display:grid;place-items:center;background:radial-gradient(circle,rgba(100,116,139,.24) 0 1px,transparent 1.2px),#eef0f2;background-size:18px 18px,auto;cursor:grab;touch-action:none;user-select:none}
.myharness-mermaid-zoom-viewport.dragging{cursor:grabbing}
.myharness-mermaid-zoom-canvas{transform-origin:0 0;transition:transform 120ms ease}
.myharness-mermaid-zoom-canvas svg{display:block;max-width:none;height:auto}
</style>
<script data-myharness-mermaid-zoom-script="true">
(() => {
  const attachedAttribute = "data-myharness-mermaid-zoom-attached";
  let activeViewer = null;
  const icon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 3H3v5"></path><path d="M3 3l7 7"></path><path d="M16 3h5v5"></path><path d="m21 3-7 7"></path><path d="M8 21H3v-5"></path><path d="m3 21 7-7"></path><path d="M16 21h5v-5"></path><path d="m21 21-7-7"></path></svg>';
  const controlIcons = {
    close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
    reset: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7v5h5"></path><path d="M5.7 12A7 7 0 0 1 17 6.5"></path><path d="M18.3 12A7 7 0 0 1 7 17.5"></path></svg>',
    zoomIn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
    zoomOut: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"></path></svg>'
  };
  const classText = (element) => {
    const raw = element?.className;
    if (typeof raw === "string") return raw;
    return String(raw?.baseVal || "");
  };
  const hasMermaidClass = (element) => /(^|\\s)mermaid(?:-|\\s|$)/i.test(classText(element));
  const hasMermaidHostMarker = (element) => element?.hasAttribute?.("data-mermaid") || hasMermaidClass(element);
  const findHost = (svg) => {
    let fallback = svg.closest?.("[data-mermaid], .mermaid, .mermaid-chart") || svg.parentElement;
    for (let node = svg.parentElement; node && node !== document.body; node = node.parentElement) {
      if (hasMermaidHostMarker(node)) fallback = node;
      const style = getComputedStyle(node);
      const overflow = [style.overflow, style.overflowX, style.overflowY].join(" ");
      if (/(auto|scroll)/i.test(overflow) && (node.scrollWidth > node.clientWidth + 8 || node.scrollHeight > node.clientHeight + 8)) return node;
    }
    return fallback;
  };
  const control = (label, tooltip, iconName, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "myharness-mermaid-zoom-control";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = tooltip;
    button.innerHTML = controlIcons[iconName] || "";
    button.addEventListener("click", onClick);
    return button;
  };
  let viewport = null;
  let canvas = null;
  let zoomValue = null;
  let zoom = 1;
  let fitScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let pointerId = -1;
  let lastX = 0;
  let lastY = 0;
  const updateTransform = () => {
    if (!canvas || !zoomValue) return;
    canvas.style.transform = "translate(" + offsetX + "px, " + offsetY + "px) scale(" + (fitScale * zoom) + ")";
    zoomValue.textContent = Math.round(zoom * 100) + "%";
  };
  const closeViewer = () => {
    if (!activeViewer) return;
    activeViewer.remove();
    activeViewer = null;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeViewer();
  };
  const svgNaturalSize = () => {
    const svg = canvas?.querySelector("svg");
    if (!svg) return { width: 0, height: 0 };
    const viewBox = String(svg.getAttribute("viewBox") || "");
    const parts = viewBox.split(/[\\s,]+/).map((part) => Number(part));
    const attrNumber = (name) => {
      const raw = String(svg.getAttribute(name) || "");
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      width: parts.length >= 4 && Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : attrNumber("width"),
      height: parts.length >= 4 && Number.isFinite(parts[3]) && parts[3] > 0 ? parts[3] : attrNumber("height"),
    };
  };
  const normalizeSvgSize = () => {
    const svg = canvas?.querySelector("svg");
    const size = svgNaturalSize();
    if (!svg || !size.width || !size.height) return size;
    svg.style.width = Math.ceil(size.width) + "px";
    svg.style.height = Math.ceil(size.height) + "px";
    svg.style.maxWidth = "none";
    return size;
  };
  const fitView = () => {
    if (!viewport || !canvas) return;
    const size = normalizeSvgSize();
    const rect = viewport.getBoundingClientRect();
    const width = size.width || canvas.scrollWidth || 1;
    const height = size.height || canvas.scrollHeight || 1;
    const padding = 56;
    fitScale = Math.min(4, Math.max(0.05, Math.min(Math.max(1, rect.width - padding) / width, Math.max(1, rect.height - padding) / height)));
    zoom = 1;
    offsetX = (rect.width - width * fitScale) / 2;
    offsetY = (rect.height - height * fitScale) / 2;
    updateTransform();
  };
  const zoomAt = (nextZoom, clientX, clientY) => {
    if (!viewport) return;
    const clampedZoom = Math.min(4, Math.max(0.25, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const centerX = Number.isFinite(clientX) ? clientX - rect.left : rect.width / 2;
    const centerY = Number.isFinite(clientY) ? clientY - rect.top : rect.height / 2;
    const currentScale = fitScale * zoom;
    const nextScale = fitScale * clampedZoom;
    const diagramX = (centerX - offsetX) / currentScale;
    const diagramY = (centerY - offsetY) / currentScale;
    zoom = clampedZoom;
    offsetX = centerX - diagramX * nextScale;
    offsetY = centerY - diagramY * nextScale;
    updateTransform();
  };
  const onPointerMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    offsetX += event.clientX - lastX;
    offsetY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    updateTransform();
  };
  const onPointerUp = (event) => {
    if (event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    viewport?.classList.remove("dragging");
  };
  const openViewer = (svg) => {
    closeViewer();
    const backdrop = document.createElement("div");
    backdrop.className = "myharness-mermaid-zoom-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "Mermaid 다이어그램 확대 보기");
    const header = document.createElement("div");
    header.className = "myharness-mermaid-zoom-header";
    const title = document.createElement("strong");
    title.className = "myharness-mermaid-zoom-title";
    title.textContent = "Mermaid";
    const controls = document.createElement("div");
    controls.className = "myharness-mermaid-zoom-controls";
    zoomValue = document.createElement("span");
    zoomValue.className = "myharness-mermaid-zoom-value";
    zoomValue.textContent = "100%";
    controls.append(
      control("축소", "축소", "zoomOut", () => zoomAt(zoom / 1.2)),
      zoomValue,
      control("확대", "확대", "zoomIn", () => zoomAt(zoom * 1.2)),
      control("이동 초기화", "Reset", "reset", fitView),
      control("닫기", "닫기", "close", closeViewer)
    );
    header.append(title, controls);
    viewport = document.createElement("div");
    viewport.className = "myharness-mermaid-zoom-viewport";
    canvas = document.createElement("div");
    canvas.className = "myharness-mermaid-zoom-canvas";
    canvas.append(svg.cloneNode(true));
    viewport.append(canvas);
    backdrop.append(header, viewport);
    document.body.append(backdrop);
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(zoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX, event.clientY);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges?.();
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.classList.add("dragging");
      viewport.setPointerCapture?.(event.pointerId);
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeViewer();
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    activeViewer = backdrop;
    requestAnimationFrame(fitView);
  };
  const attachButton = (svg) => {
    if (!svg || svg.closest(".myharness-mermaid-zoom-backdrop")) return;
    const host = findHost(svg);
    if (!host) return;
    host.setAttribute(attachedAttribute, "true");
    host.classList.add("myharness-mermaid-zoom-host");
    if (host.querySelector(".myharness-mermaid-expand-button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "myharness-mermaid-expand-button";
    button.setAttribute("aria-label", "Mermaid 다이어그램 크게 보기");
    button.innerHTML = icon;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openViewer(svg);
    });
    host.prepend(button);
  };
  const enhance = () => {
    document.querySelectorAll("[data-mermaid] svg, .mermaid svg, .mermaid-chart svg, svg[id^='mermaid-']").forEach(attachButton);
  };
  const schedule = () => requestAnimationFrame(() => {
    enhance();
    setTimeout(enhance, 120);
    setTimeout(enhance, 500);
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }
  window.addEventListener("load", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;
  if (/<\/body\s*>/i.test(value)) {
    return value.replace(/<\/body\s*>/i, () => `${bridge}</body>`);
  }
  return `${value}${bridge}`;
}

let downloadedMermaidRuntimeCache = "";

function hasDownloadedRawMermaid(content) {
  const value = String(content || "");
  if (/language-mermaid|lang-mermaid/i.test(value)) {
    return true;
  }
  return /class\s*=\s*["'][^"']*\bmermaid\b[^"']*["'][^>]*>(?!\s*<svg\b)[\s\S]*?<\/[a-z][^>]*>/i.test(value);
}

function downloadedMermaidRuntimeScript() {
  if (!downloadedMermaidRuntimeCache) {
    downloadedMermaidRuntimeCache = readFileSync(join(vendorRoot, "mermaid/dist/mermaid.min.js"), "utf8")
      .replace(/<\/script/gi, "<\\/script");
  }
  return downloadedMermaidRuntimeCache;
}

function downloadedMermaidRendererBridge() {
  return `
<script data-myharness-mermaid-renderer-script="true">
${downloadedMermaidRuntimeScript()}
</script>
<script data-myharness-mermaid-renderer-init="true">
(() => {
  const collectRawMermaidNodes = () => {
    const nodes = [];
    document.querySelectorAll("pre > code.language-mermaid, pre > code.lang-mermaid").forEach((code) => {
      const source = (code.textContent || "").trim();
      const pre = code.closest("pre");
      if (!source || !pre) return;
      const target = document.createElement("div");
      target.className = "mermaid";
      target.textContent = source;
      pre.replaceWith(target);
      nodes.push(target);
    });
    document.querySelectorAll(".mermaid").forEach((element) => {
      if (element.querySelector("svg") || element.getAttribute("data-processed") === "true") return;
      if (!(element.textContent || "").trim()) return;
      nodes.push(element);
    });
    return Array.from(new Set(nodes));
  };
  const renderMermaid = async () => {
    const mermaid = window.mermaid;
    if (!mermaid?.initialize) return;
    const nodes = collectRawMermaidNodes();
    if (!nodes.length) return;
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
      if (typeof mermaid.run === "function") {
        await mermaid.run({ nodes });
      } else if (typeof mermaid.init === "function") {
        mermaid.init(undefined, nodes);
      }
    } catch {
      nodes.forEach((node) => {
        if (node.querySelector("svg")) return;
        node.classList.add("mermaid-error");
        node.textContent = "Mermaid 다이어그램을 렌더링하지 못했습니다.";
      });
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { void renderMermaid(); }, { once: true });
  } else {
    void renderMermaid();
  }
})();
</script>`;
}

async function readDownloadableArtifactBody(target, ext) {
  if (ext !== ".html" && ext !== ".htm") {
    return null;
  }
  const content = await readFile(target, "utf8");
  return Buffer.from(withDownloadedMermaidZoomBridge(content), "utf8");
}

function asciiHeaderFilename(name) {
  const safe = String(name || "download")
    .replace(/[\x00-\x1f\x7f"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return safe || "download";
}

class SessionAccessError extends Error {
  constructor(message = "Session does not belong to this client") {
    super(message);
    this.status = 403;
  }
}

function assertClientOwnsSession(session, clientId) {
  const expected = String(session?.clientId || "").trim();
  const actual = String(clientId || "").trim();
  if (expected && expected !== actual) {
    throw new SessionAccessError();
  }
}

function sessionFromIdForClient(sessionId, clientId) {
  const session = sessions.get(sessionId);
  if (session) {
    assertClientOwnsSession(session, clientId);
  }
  return session;
}

function ownedActiveSessionFromIdForClient(sessionId, clientId, message = "Action requires an active session owned by this client") {
  const id = String(sessionId || "").trim();
  const actualClientId = String(clientId || "").trim();
  if (!id || !actualClientId) {
    throw new SessionAccessError(message);
  }
  const session = sessions.get(id);
  if (!session || session.shuttingDown) {
    throw new SessionAccessError(message);
  }
  assertClientOwnsSession(session, actualClientId);
  if (!String(session.clientId || "").trim()) {
    throw new SessionAccessError(message);
  }
  return session;
}

async function workspaceSessionFromRequest(params, artifactPath = "", scope = defaultWorkspaceScope()) {
  const session = sessions.get(params.get("session"));
  if (session) {
    assertClientOwnsSession(session, params.get("clientId"));
    return session;
  }
  if (!params.get("workspacePath") && !params.get("workspaceName") && artifactPath) {
    const workspaces = await listWorkspaces(scope);
    for (const workspace of workspaces) {
      try {
        const { target } = workspaceRelativeTarget(workspace.path, artifactPath);
        const info = await stat(target);
        if (info.isFile()) {
          return { workspace };
        }
      } catch {
        // Try the next workspace.
      }
    }
  }
  const workspace = workspaceFromHistoryRequest({
    workspacePath: params.get("workspacePath"),
    workspaceName: params.get("workspaceName"),
  }, scope);
  return { workspace };
}

async function workspaceTargetSessionFromRequest(params, artifactPath = "", scope = defaultWorkspaceScope()) {
  if (params.get("workspacePath") || params.get("workspaceName")) {
    const workspace = workspaceFromHistoryRequest({
      workspacePath: params.get("workspacePath"),
      workspaceName: params.get("workspaceName"),
    }, scope);
    return { workspace };
  }
  return workspaceSessionFromRequest(params, artifactPath, scope);
}

async function deleteArtifactFile(session, artifactPath, options = {}) {
  const { target, rel } = workspaceRelativeTarget(session.workspace.path, artifactPath);
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  assertExpectedMtime(info, options.expectedMtimeMs);
  await rm(target);
  invalidateProjectFileCache(session.workspace.path);
  return {
    path: rel,
    name: rel.split(/[\\/]/).pop() || rel,
  };
}

async function copyArtifactToFolder(session, artifactPath, folderPath) {
  const directory = normalize(String(folderPath || defaultDownloadFolder()).trim());
  if (!directory || !isAbsolute(directory)) {
    throw new Error("저장 폴더는 절대 경로여야 합니다");
  }
  const { target, rel } = workspaceRelativeTarget(session.workspace.path, artifactPath);
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  await mkdir(directory, { recursive: true });
  const name = rel.split(/[\\/]/).pop() || basename(target) || "download";
  const destination = join(directory, name);
  const body = await readDownloadableArtifactBody(target, extname(target).toLowerCase());
  if (body) {
    await writeFile(destination, body);
  } else {
    await copyFile(target, destination);
  }
  return {
    path: destination,
    name,
    size: body?.length || info.size,
  };
}

function defaultDownloadFolder() {
  const home = String(process.env.USERPROFILE || process.env.HOME || "").trim();
  if (home) {
    const downloads = normalize(join(home, "Downloads"));
    if (existsSync(downloads)) {
      return downloads;
    }
  }
  return normalize(join(repoRoot, "downloads"));
}

async function openFolderDialog(initialPath = "") {
  if (process.platform !== "win32") {
    throw new Error("Folder picker is only available on Windows in this build");
  }
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "저장할 폴더를 선택하세요"
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$initial = [Environment]::GetFolderPath("MyDocuments")
if ($env:MYHARNESS_DIALOG_INITIAL -and (Test-Path -LiteralPath $env:MYHARNESS_DIALOG_INITIAL -PathType Container)) {
  $initial = $env:MYHARNESS_DIALOG_INITIAL
}
$dialog.SelectedPath = $initial
try {
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
    exit 0
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
exit 2
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MYHARNESS_DIALOG_INITIAL: String(initialPath || ""),
        },
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ canceled: false, folderPath: stdout.trim() });
      } else if (code === 2) {
        resolve({ canceled: true, folderPath: "" });
      } else {
        reject(new Error(stderr.trim() || `Folder picker exited with code ${code ?? 0}`));
      }
    });
  });
}

async function saveArtifactFile(session, artifactPath, content) {
  let requestedPath = String(artifactPath || "").trim();
  if (!requestedPath) {
    requestedPath = "outputs/answer.md";
  }
  if (!/\.[A-Za-z0-9]{1,8}$/.test(requestedPath)) {
    requestedPath = `${requestedPath}.md`;
  }
  const ext = extname(requestedPath).toLowerCase();
  const type = artifactTypes[ext];
  if (!type) {
    throw new Error("Unsupported artifact type");
  }
  if (type.encoding !== "text") {
    throw new Error("Only text artifacts can be saved from assistant text");
  }
  let { target, rel } = workspaceRelativeTarget(session.workspace.path, requestedPath);
  const dotIndex = rel.lastIndexOf(".");
  const baseRel = dotIndex > 0 ? rel.slice(0, dotIndex) : rel;
  const suffix = dotIndex > 0 ? rel.slice(dotIndex) : "";
  let index = 2;
  while (true) {
    try {
      await stat(target);
      const nextRel = `${baseRel}-${index}${suffix}`;
      ({ target, rel } = workspaceRelativeTarget(session.workspace.path, nextRel));
      index += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
  await mkdir(dirname(target), { recursive: true });
  while (true) {
    try {
      await writeFile(target, String(content || ""), { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const nextRel = `${baseRel}-${index}${suffix}`;
      ({ target, rel } = workspaceRelativeTarget(session.workspace.path, nextRel));
      index += 1;
    }
  }
  invalidateProjectFileCache(session.workspace.path);
  return readArtifactMetadata(session, rel);
}

async function overwriteHtmlArtifactFile(session, artifactPath, content, options = {}) {
  const { target, rel } = workspaceRelativeTarget(session.workspace.path, artifactPath);
  const ext = extname(target).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error("Only HTML artifacts can be overwritten from preview edit");
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error("Artifact is not a file");
    }
    assertExpectedMtime(info, options.expectedMtimeMs);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (normalizeExpectedMtime(options.expectedMtimeMs) !== null) {
      throw conflictError("파일이 삭제되었거나 이동되었습니다. 새로고침 후 다시 시도하세요.");
    }
  }
  const value = String(content || "");
  if (Buffer.byteLength(value, "utf8") > artifactPreviewMaxBytes) {
    throw new Error("Artifact is too large to save");
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, "utf8");
  invalidateProjectFileCache(session.workspace.path);
  return {
    artifact: await readArtifactMetadata(session, rel),
    payload: await readArtifactPreview(session, rel),
  };
}

function validateArtifactFileName(value) {
  const name = String(value || "").trim();
  if (!name) {
    throw new Error("File name is required");
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("File name must not include folders");
  }
  if (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("File name contains invalid Windows path characters");
  }
  if (!artifactTypes[extname(name).toLowerCase()]) {
    throw new Error("Unsupported artifact type");
  }
  return name;
}

async function renameArtifactFile(session, artifactPath, nextName, options = {}) {
  const source = await resolveArtifactTarget(session, artifactPath);
  if (!source.info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  assertExpectedMtime(source.info, options.expectedMtimeMs);
  const fileName = validateArtifactFileName(nextName);
  const sourceDir = dirname(source.rel);
  const destinationRel = normalizeProjectFilePath(sourceDir === "." ? fileName : join(sourceDir, fileName));
  if (!destinationRel || destinationRel === "." || normalizeProjectFilePath(source.rel) === destinationRel) {
    throw new Error("New file name must be different");
  }
  const sourceExt = extname(source.rel).toLowerCase();
  const destinationExt = extname(destinationRel).toLowerCase();
  if (sourceExt !== destinationExt) {
    throw new Error("File extension cannot be changed");
  }
  const { target: destinationTarget } = workspaceRelativeTarget(session.workspace.path, destinationRel);
  try {
    await stat(destinationTarget);
    throw new Error("A file with that name already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(dirname(destinationTarget), { recursive: true });
  await rename(source.target, destinationTarget);
  await updateArtifactRenameAlias(session, source.rel, destinationRel);
  invalidateProjectFileCache(session.workspace.path);
  return {
    artifact: await readArtifactMetadata(session, destinationRel),
    payload: await readArtifactPreview(session, destinationRel),
  };
}

function normalizeAiEditComments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const instruction = String(item.instruction || item.comment || "").trim();
      if (!instruction) return null;
      const requestedDocumentScope = item.scope === "document" || item.global === true;
      const text = String(item.text || "").trim();
      const start = Number(item.start);
      const end = Number(item.end);
      const hasRangeFields = Object.prototype.hasOwnProperty.call(item, "start") || Object.prototype.hasOwnProperty.call(item, "end");
      const hasValidRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
      const scope = requestedDocumentScope || (!text && !hasRangeFields) ? "document" : "selection";
      if (scope !== "document" && (!text || !hasValidRange)) {
        return null;
      }
      return {
        index: index + 1,
        scope,
        instruction,
        text: (scope === "document" ? "전체 문서" : text).slice(0, 2000),
        html: scope === "document" ? "" : String(item.html || "").slice(0, 6000),
        start: scope === "document" ? 0 : start,
        end: scope === "document" ? 0 : end,
        before: scope === "document" ? "" : String(item.before || "").slice(-500),
        after: scope === "document" ? "" : String(item.after || "").slice(0, 500),
      };
    })
    .filter(Boolean);
}

async function nextArtifactVersionRel(session, artifactPath) {
  const source = await resolveArtifactTarget(session, artifactPath);
  if (!source.info.isFile()) {
    throw new Error("Artifact is not a file");
  }
  const ext = extname(source.rel).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error("AI edit currently supports HTML reports only");
  }
  const dir = dirname(source.rel);
  const originalName = basename(source.rel, ext);
  const baseName = originalName.replace(/[\s_]+(?:ver\.|v)\d+$/i, "");
  for (let index = 1; index < 1000; index += 1) {
    const fileName = `${baseName}_v${index}${ext}`;
    const candidateRel = normalizeProjectFilePath(dir === "." ? fileName : join(dir, fileName));
    const { target } = workspaceRelativeTarget(session.workspace.path, candidateRel);
    const legacyFileName = `${baseName} v${index}${ext}`;
    const legacyRel = normalizeProjectFilePath(dir === "." ? legacyFileName : join(dir, legacyFileName));
    const { target: legacyTarget } = workspaceRelativeTarget(session.workspace.path, legacyRel);
    try {
      await stat(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          await stat(legacyTarget);
        } catch (legacyError) {
          if (legacyError?.code === "ENOENT") {
            return candidateRel;
          }
          throw legacyError;
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not find an available version file name");
}

function compactAiEditTranscriptText(value, maxLength = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildAiArtifactEditTranscript({ sourceRel, targetRel, comments }) {
  const commentLines = comments.map((comment) => {
    const request = compactAiEditTranscriptText(comment.instruction);
    const selected = compactAiEditTranscriptText(comment.text, 80);
    return `${comment.index}. ${request}${comment.scope === "document" ? " (전체 문서)" : selected ? ` (${selected})` : ""}`;
  });
  return [
    "AI 편집 요청",
    `- 원본 문서: ${sourceRel}`,
    `- 새 버전: ${targetRel}`,
    `- 수정 의견: ${comments.length}개`,
    "",
    ...commentLines,
  ].join("\n").trim();
}

function formatAiEditHeartbeatElapsed(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (safeSeconds < 60) return `${safeSeconds}초 경과`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return remainder ? `${minutes}분 ${remainder}초 경과` : `${minutes}분 경과`;
}

function aiEditHeartbeatMessage(heartbeat) {
  const elapsedSeconds = Math.floor((Date.now() - heartbeat.startedAtMs) / 1000);
  return [
    `AI 자동편집 진행 중: ${heartbeat.targetRel}`,
    formatAiEditHeartbeatElapsed(elapsedSeconds),
    "첫 streaming 이벤트를 기다리는 중입니다.",
  ].join(" · ");
}

function clearAiEditHeartbeat(session) {
  if (!session) return;
  if (session.aiEditHeartbeatTimer) {
    clearInterval(session.aiEditHeartbeatTimer);
    session.aiEditHeartbeatTimer = null;
  }
  session.aiEditHeartbeat = null;
}

function emitAiEditHeartbeat(session) {
  if (!session?.aiEditHeartbeat || session.shuttingDown) return;
  emit(session, {
    type: "status",
    quiet: true,
    message: aiEditHeartbeatMessage(session.aiEditHeartbeat),
  });
}

function startAiEditHeartbeat(session, { sourceRel, targetRel, commentCount }) {
  clearAiEditHeartbeat(session);
  session.aiEditHeartbeat = {
    startedAtMs: Date.now(),
    sourceRel,
    targetRel,
    commentCount,
  };
  emitAiEditHeartbeat(session);
  session.aiEditHeartbeatTimer = setInterval(() => {
    emitAiEditHeartbeat(session);
  }, aiEditHeartbeatIntervalMs);
  session.aiEditHeartbeatTimer.unref?.();
}

function stopAiEditHeartbeatForBackendEvent(session, event) {
  if (!session?.aiEditHeartbeat || !event) return;
  if ([
    "tool_started",
    "tool_input_delta",
    "tool_progress",
    "assistant_delta",
    "assistant_complete",
    "error",
    "line_complete",
    "shutdown",
  ].includes(event.type)) {
    clearAiEditHeartbeat(session);
  }
}

function buildAiArtifactEditPrompt({ sourceRel, targetRel, sourceContent, comments }) {
  const commentLines = comments.map((comment) => {
    const scopedLines = comment.scope === "document"
      ? [
          "- Scope: entire document",
          `- User edit request: ${JSON.stringify(comment.instruction)}`,
        ]
      : [
          `- Scope: selected range`,
          `- Rendered text offsets (not raw HTML offsets): ${comment.start}-${comment.end}`,
          `- Selected text: ${JSON.stringify(comment.text)}`,
          comment.html ? `- Selected HTML: ${JSON.stringify(comment.html)}` : "",
          `- User edit request: ${JSON.stringify(comment.instruction)}`,
          `- Before context: ${JSON.stringify(comment.before)}`,
          `- After context: ${JSON.stringify(comment.after)}`,
        ];
    return [`## Comment ${comment.index}`, ...scopedLines].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    "우측 HTML preview에서 사용자가 남긴 선택 영역 또는 문서 전체 AI 수정 의견입니다.",
    "",
    "작업 지시",
    `- 원본 파일: ${sourceRel}`,
    `- 새 버전 파일: ${targetRel}`,
    "- 새 버전 파일은 이미 원본 HTML을 복사해 만들어 둔 작업 파일입니다.",
    "- 아래 원본 HTML 문서와 수정 의견만 편집 컨텍스트로 사용하세요. 이전 대화 전체 맥락에 의존하지 마세요.",
    "- 원본 파일은 수정하지 마세요.",
    `- 반드시 ${targetRel} 파일을 대상으로 부분 수정하세요.`,
    "- Scope가 entire document인 의견은 문서 전체 방향의 수정 요청으로 처리하세요.",
    "- Scope가 selected range인 의견은 선택 영역과 주변 문맥을 중심으로 수정하되, 문체/단어/구조 통일이 필요하면 관련된 앞뒤 문맥도 함께 조정할 수 있습니다.",
    "- selected range의 좌표는 preview에서 보이는 렌더링 텍스트 기준이며 not raw HTML offsets 입니다. Selected HTML과 Before/After context를 우선 앵커로 사용하세요.",
    "- 실제 변경은 edit_file 또는 apply_patch로 수행해 중앙 작업 진행 영역에 편집 작업과 diff 미리보기가 보이게 하세요.",
    "- write_file로 전체 HTML을 처음부터 다시 작성하지 마세요. edit_file/apply_patch가 기술적으로 실패한 경우에만 예외로 사용하세요.",
    "- 최종 답변에는 저장한 새 버전 파일 경로와 핵심 변경 요약만 간단히 알려주세요.",
    "",
    "## Source HTML document",
    `<document path=${JSON.stringify(sourceRel)}>`,
    sourceContent,
    "</document>",
    "",
    "## Edit requests",
    commentLines,
  ].join("\n");

  return [
    "우측 HTML preview에서 사용자가 선택한 영역별 AI 수정 의견입니다.",
    "",
    "작업 지시:",
    `- 원본 파일: ${sourceRel}`,
    `- 새 버전 파일: ${targetRel}`,
    "- 원본 파일은 덮어쓰지 마세요.",
    "- 반드시 같은 폴더의 새 버전 파일에 저장하세요.",
    "- 선택 영역과 주변 문맥을 중심으로 수정하세요.",
    "- 기본적으로 선택된 영역을 수정하되, 문체/용어/구조 통일성이 필요하면 전후 문맥의 관련 부분도 함께 조정할 수 있습니다.",
    "- 토큰과 속도를 아끼기 위해 전체 HTML을 새로 작성하지 말고, 파일을 읽은 뒤 필요한 부분만 부분 수정(diff/edit 방식)하세요.",
    "- 저장 후 최종 답변에는 새 버전 파일 경로만 명확히 알려주세요.",
    "",
    commentLines,
  ].join("\n");
}

async function submitAiArtifactEdit(session, artifactPath, comments) {
  const source = await resolveArtifactTarget(session, artifactPath);
  const normalizedComments = normalizeAiEditComments(comments);
  if (normalizedComments.length === 0) {
    throw new Error("At least one AI edit comment is required");
  }
  if (source.info.size > artifactAiEditMaxBytes) {
    const error = new Error("Artifact is too large for AI edit");
    error.status = 413;
    throw error;
  }
  const targetRel = await nextArtifactVersionRel(session, source.rel);
  const sourceContent = await readFile(source.target, "utf8");
  const prompt = buildAiArtifactEditPrompt({
    sourceRel: source.rel,
    targetRel,
    sourceContent,
    comments: normalizedComments,
  });
  const transcriptLine = buildAiArtifactEditTranscript({
    sourceRel: source.rel,
    targetRel,
    comments: normalizedComments,
  });
  if (session.busy) {
    throw httpError(409, currentSessionBusyMessage);
  }
  if (session.clientId && countBusySessionsForClient(session.clientId) >= 3) {
    throw httpError(429, clientResponseLimitMessage);
  }
  if (countBusySessions() >= maxBusySessions) {
    throw httpError(429, serverResponseLimitMessage);
  }
  const { target: targetFile } = workspaceRelativeTarget(session.workspace.path, targetRel);
  session.busy = true;
  let targetPrepared = false;
  try {
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, sourceContent, { encoding: "utf8", flag: "wx" });
    targetPrepared = true;
    invalidateProjectFileCache(session.workspace.path);
    emit(session, {
      type: "transcript_item",
      item: { role: "user", text: transcriptLine },
    });
    const ok = sendBackend(session, {
      type: "submit_line",
      line: prompt,
      attachments: [],
      transcript_line: transcriptLine,
      suppress_user_transcript: true,
      isolated_context: true,
    });
    if (!ok) {
      const error = new Error("Could not submit AI edit request");
      error.status = 409;
      throw error;
    }
    startAiEditHeartbeat(session, {
      sourceRel: source.rel,
      targetRel,
      commentCount: normalizedComments.length,
    });
  } catch (error) {
    clearAiEditHeartbeat(session);
    session.busy = false;
    if (targetPrepared) {
      try {
        await rm(targetFile, { force: true });
      } finally {
        invalidateProjectFileCache(session.workspace.path);
      }
    }
    throw error;
  }
  return { ok: true, sourcePath: source.rel, targetPath: targetRel };
}

function projectFileCacheKey(workspacePath, scope = "default") {
  return `${normalize(String(workspacePath || ""))}\u0000${scope}`;
}

function invalidateProjectFileCache(workspacePath = "") {
  const normalized = normalize(String(workspacePath || ""));
  for (const key of projectFileListCache.keys()) {
    if (!normalized || key.startsWith(`${normalized}\u0000`)) {
      projectFileListCache.delete(key);
    }
  }
}

function projectFilePayloadFromInfo(session, target, rel, info) {
  const ext = extname(target).toLowerCase();
  const type = artifactTypes[ext] || { kind: "file", mime: "application/octet-stream" };
  return {
    path: rel,
    name: basename(target),
    kind: type.kind,
    category: artifactCategoryForPath(rel),
    mime: type.mime,
    size: info.size,
    mtimeMs: info.mtimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

async function listProjectArtifacts(session) {
  const files = [];
  async function walk(directory) {
    if (files.length >= artifactListMaxItems) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= artifactListMaxItems) {
        return;
      }
      if (entry.isDirectory()) {
        if (!artifactListSkipDirs.has(entry.name)) {
          await walk(join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      const type = artifactTypes[ext];
      if (!type) {
        continue;
      }
      const target = join(directory, entry.name);
      const rel = relative(session.workspace.path, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        continue;
      }
      const info = await stat(target);
      files.push({
        path: rel,
        name: entry.name,
        kind: type.kind,
        mime: type.mime,
        size: info.size,
        mtimeMs: info.mtimeMs,
        birthtimeMs: info.birthtimeMs,
      });
    }
  }
  await walk(session.workspace.path);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function listProjectFiles(session, options = {}) {
  const scope = String(options.scope || "default").toLowerCase() === "all" ? "all" : "default";
  const force = options.force === true;
  const key = projectFileCacheKey(session.workspace.path, scope);
  const cached = projectFileListCache.get(key);
  if (!force && cached && Date.now() - cached.createdAt < projectFileCacheTtlMs) {
    return cached.files;
  }
  const files = scope === "all"
    ? await scanAllProjectFiles(session)
    : await scanDefaultProjectFiles(session);
  projectFileListCache.set(key, { createdAt: Date.now(), files });
  return files;
}

function shouldSkipProjectFileRel(rel) {
  const normalized = normalizeProjectFilePath(rel);
  return projectFileListSkipPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

async function pushProjectFile(files, session, target) {
  const rel = relative(session.workspace.path, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || shouldSkipProjectFileRel(rel)) {
    return;
  }
  const normalizedRel = normalizeProjectFilePath(rel);
  const info = await stat(target);
  if (!info.isFile()) {
    return;
  }
  files.push(projectFilePayloadFromInfo(session, target, normalizedRel, info));
}

async function scanOutputsProjectFiles(session, files) {
  const outputsRoot = join(session.workspace.path, "outputs");
  async function walk(directory) {
    if (files.length >= projectFileListMaxItems) {
      return;
    }
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (files.length >= projectFileListMaxItems) {
        return;
      }
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!artifactListSkipDirs.has(entry.name)) {
          await walk(target);
        }
        continue;
      }
      if (entry.isFile()) {
        await pushProjectFile(files, session, target);
      }
    }
  }
  await walk(outputsRoot);
}

async function scanDefaultProjectFiles(session) {
  const files = [];
  try {
    const entries = await readdir(session.workspace.path, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= projectFileListMaxItems) {
        break;
      }
      if (!entry.isFile()) {
        continue;
      }
      const rel = normalizeProjectFilePath(entry.name);
      if (isDefaultProjectFileCandidate(rel)) {
        await pushProjectFile(files, session, join(session.workspace.path, entry.name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await scanOutputsProjectFiles(session, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function scanAllProjectFiles(session) {
  const files = [];
  async function walk(directory) {
    if (files.length >= projectFileListMaxItems) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= projectFileListMaxItems) {
        return;
      }
      if (entry.isDirectory()) {
        const target = join(directory, entry.name);
        const rel = relative(session.workspace.path, target);
        if (!artifactListSkipDirs.has(entry.name) && !shouldSkipProjectFileRel(rel)) {
          await walk(target);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const target = join(directory, entry.name);
      const rel = relative(session.workspace.path, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        continue;
      }
      if (shouldSkipProjectFileRel(rel)) {
        continue;
      }
      await pushProjectFile(files, session, target);
    }
  }
  await walk(session.workspace.path);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function collisionSafeOutputsPath(session, fileName, existingPaths) {
  let rel = nextAvailableRelativePath(`outputs/${fileName}`, existingPaths);
  while (true) {
    const { target } = workspaceRelativeTarget(session.workspace.path, rel);
    try {
      await stat(target);
      existingPaths.add(rel);
      rel = nextAvailableRelativePath(`outputs/${fileName}`, existingPaths);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return rel;
      }
      throw error;
    }
  }
}

async function organizeRootProjectFiles(session, paths = [], options = {}) {
  const requested = [...new Set((Array.isArray(paths) ? paths : []).map(normalizeProjectFilePath).filter(Boolean))];
  if (!requested.length) {
    return [];
  }
  const existingPaths = new Set((await scanAllProjectFiles(session)).map((file) => normalizeProjectFilePath(file.path)));
  const moved = [];
  for (const requestedPath of requested) {
    if (requestedPath.includes("/") || requestedPath.startsWith("outputs/") || !isDefaultProjectFileCandidate(requestedPath)) {
      throw new Error(`Only root artifact candidates can be organized: ${requestedPath}`);
    }
    const { target, rel } = workspaceRelativeTarget(session.workspace.path, requestedPath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`Not a file: ${requestedPath}`);
    }
    const expectedMtimeMs = options.expectedMtimes && typeof options.expectedMtimes === "object"
      ? options.expectedMtimes[requestedPath] ?? options.expectedMtimes[rel]
      : null;
    assertExpectedMtime(info, expectedMtimeMs);
    const destinationRel = await collisionSafeOutputsPath(session, basename(target), existingPaths);
    const { target: destinationTarget } = workspaceRelativeTarget(session.workspace.path, destinationRel);
    await mkdir(dirname(destinationTarget), { recursive: true });
    await rename(target, destinationTarget);
    await updateArtifactRenameAlias(session, rel, destinationRel);
    existingPaths.delete(normalizeProjectFilePath(rel));
    existingPaths.add(destinationRel);
    moved.push(await readArtifactMetadata(session, destinationRel));
  }
  invalidateProjectFileCache(session.workspace.path);
  return moved;
}

function validateWorkspaceName(value) {
  const name = normalizeWorkspaceName(value);
  if (!name) {
    return { ok: false, error: "Project name is required" };
  }
  if (name === "." || name === ".." || name.length > 80) {
    return { ok: false, error: "Invalid project name" };
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    return { ok: false, error: "Project name contains invalid Windows path characters" };
  }
  if (reservedWorkspaceNames.has(name.toUpperCase())) {
    return { ok: false, error: "Project name is reserved on Windows" };
  }
  return { ok: true, name };
}

function normalizeWorkspaceName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function workspaceScopeOrDefault(scope) {
  return scope && scope.root ? scope : defaultWorkspaceScope();
}

function workspacePathFromName(name, scope = defaultWorkspaceScope()) {
  const activeScope = workspaceScopeOrDefault(scope);
  const validation = validateWorkspaceName(name);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const workspacePath = normalize(join(activeScope.root, validation.name));
  const rel = relative(activeScope.root, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Workspace path must stay inside Playground");
  }
  return { name: validation.name, path: workspacePath, scope: activeScope };
}

function workspaceFromDirectoryName(name, scope = defaultWorkspaceScope()) {
  const activeScope = workspaceScopeOrDefault(scope);
  const displayName = String(name || "").trim();
  if (!displayName) {
    throw new Error("Project name is required");
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(displayName) || /[. ]$/.test(displayName)) {
    throw new Error("Project name contains invalid Windows path characters");
  }
  if (reservedWorkspaceNames.has(displayName.toUpperCase())) {
    throw new Error("Project name is reserved on Windows");
  }
  const workspacePath = normalize(join(activeScope.root, displayName));
  const rel = relative(activeScope.root, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\") || rel.includes("/")) {
    throw new Error("Workspace path must stay inside Playground");
  }
  return { name: displayName, path: workspacePath, scope: activeScope };
}

function workspaceFromPath(candidate, scope = defaultWorkspaceScope()) {
  const activeScope = workspaceScopeOrDefault(scope);
  const workspacePath = normalize(String(candidate || ""));
  const scopedRel = relative(activeScope.root, workspacePath);
  if (scopedRel && !scopedRel.startsWith("..") && !isAbsolute(scopedRel) && !scopedRel.includes("\\") && !scopedRel.includes("/")) {
    return workspaceFromDirectoryName(scopedRel, activeScope);
  }
  const rootRel = relative(playgroundRoot, workspacePath);
  if (rootRel && !rootRel.startsWith("..") && !isAbsolute(rootRel)) {
    const parts = rootRel.split(/[\\/]/).filter(Boolean);
    if (parts.length === 1 || parts.length === 2) {
      return workspaceFromDirectoryName(parts[parts.length - 1], activeScope);
    }
  }
  throw new Error("Workspace cwd must stay inside the current Playground scope");
}

function projectPreferencesPath(workspace) {
  return join(workspace.path, projectPreferencesRel);
}

function appPreferencesPath() {
  return join(globalConfigDir(), appPreferencesRel);
}

function globalConfigDir() {
  const envDir = String(process.env.MYHARNESS_CONFIG_DIR || "").trim();
  if (envDir) {
    return normalize(envDir);
  }
  return normalize(join(process.env.USERPROFILE || process.env.HOME || ".", ".myharness"));
}

function maskSecret(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }
  if (raw.length <= 8) {
    return "••••";
  }
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`;
}

async function readJsonFileIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeJsonFileAtomic(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}-${crypto.randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

function cleanRuntimePreference(value) {
  return String(value || "").trim();
}

function normalizeRuntimeEffortValue(value) {
  const clean = cleanRuntimePreference(value).toLowerCase();
  return clean === "auto" ? "none" : clean;
}

function normalizeBooleanMarker(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeSharedRuntimePreferences(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const next = { version: 1 };
  const activeProfile = cleanRuntimePreference(source.active_profile || source.activeProfile);
  if (activeProfile) {
    next.active_profile = activeProfile;
  }
  const hasModel = (
    Object.prototype.hasOwnProperty.call(source, "model")
    || Object.prototype.hasOwnProperty.call(source, "runtime_model")
    || Object.prototype.hasOwnProperty.call(source, "runtimeModel")
  );
  const model = cleanRuntimePreference(source.model || source.runtime_model || source.runtimeModel);
  if (hasModel && model && model.toLowerCase() !== "default") {
    next.model = model;
  }
  const effort = normalizeRuntimeEffortValue(source.effort || source.reasoning_effort || source.reasoningEffort);
  if (effort) {
    next.effort = effort;
  }
  const pgptAvailable = normalizeBooleanMarker(source.pgpt_available ?? source.pgptAvailable);
  if (pgptAvailable !== undefined) {
    next.pgpt_available = pgptAvailable;
  }
  return next;
}

function hasSharedRuntimePreferences(preferences) {
  return Boolean(preferences?.active_profile || preferences?.model || preferences?.effort);
}

function isSharedWorkspaceScope(scope) {
  return workspaceScopeOrDefault(scope).mode === "shared";
}

async function readSharedRuntimePreferences() {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  return normalizeSharedRuntimePreferences(settings.web_shared_runtime_preferences);
}

async function isPgptRuntimeAvailable() {
  const envApiKey = cleanRuntimePreference(process.env.PGPT_API_KEY);
  const envEmployeeNo = cleanRuntimePreference(
    process.env.PGPT_EMPLOYEE_NO || process.env.PGPT_SYSTEM_CODE || process.env.POSCO_EMP_NO,
  );
  if (envApiKey && envEmployeeNo) {
    return true;
  }

  const credentials = await readJsonFileIfExists(join(globalConfigDir(), "credentials.json")) || {};
  const entry = credentials.pgpt && typeof credentials.pgpt === "object" ? credentials.pgpt : {};
  return Boolean(cleanRuntimePreference(entry.api_key) && cleanRuntimePreference(entry.employee_no || entry.system_code));
}

function shouldUsePgptDefaultRuntimePreferences(preferences, pgptAvailable) {
  if (!pgptAvailable) {
    return false;
  }
  if (!hasSharedRuntimePreferences(preferences)) {
    return true;
  }
  if (preferences.pgpt_available === true || preferences.active_profile === "p-gpt") {
    return false;
  }
  return true;
}

function applyPgptDefaultRuntimePreferences(options) {
  options.activeProfile = "p-gpt";
  delete options.active_profile;
  options.model = "gpt-5.4";
  options.effort = "low";
  return options;
}

async function applySharedRuntimePreferencesToSessionOptions(options, workspaceScope) {
  if (!isSharedWorkspaceScope(workspaceScope)) {
    return options;
  }
  const preferences = await readSharedRuntimePreferences();
  const pgptAvailable = await isPgptRuntimeAvailable();
  if (shouldUsePgptDefaultRuntimePreferences(preferences, pgptAvailable)) {
    return applyPgptDefaultRuntimePreferences(options);
  }
  if (!hasSharedRuntimePreferences(preferences)) {
    return options;
  }
  if (preferences.active_profile) {
    options.activeProfile = preferences.active_profile;
    delete options.active_profile;
  }
  if (preferences.model) {
    options.model = preferences.model;
  } else {
    delete options.model;
  }
  if (preferences.effort) {
    options.effort = preferences.effort;
  }
  return options;
}

function runtimePreferencesFromSession(session) {
  const preferences = session?.runtimePreferences || {};
  return normalizeSharedRuntimePreferences({
    active_profile: preferences.activeProfile || preferences.active_profile,
    model: preferences.model,
    effort: preferences.effort,
  });
}

function sharedRuntimeChoiceFromPayload(payload) {
  if (!payload || payload.type !== "apply_select_command") {
    return null;
  }
  const command = cleanRuntimePreference(payload.command);
  if (!["provider", "model", "effort"].includes(command)) {
    return null;
  }
  const value = cleanRuntimePreference(payload.value);
  if (!value) {
    return null;
  }
  return { type: "apply_select_command", command, value };
}

async function saveSharedRuntimeChoice(session, choice) {
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  const previous = normalizeSharedRuntimePreferences(settings.web_shared_runtime_preferences);
  const sessionRuntime = runtimePreferencesFromSession(session);
  const next = normalizeSharedRuntimePreferences(previous);

  if (choice.command === "provider") {
    next.active_profile = choice.value;
    delete next.model;
  } else if (choice.command === "model") {
    if (sessionRuntime.active_profile && (!next.active_profile || next.active_profile === sessionRuntime.active_profile)) {
      next.active_profile = sessionRuntime.active_profile;
    }
    if (choice.value.toLowerCase() === "default") {
      delete next.model;
    } else {
      next.model = choice.value;
    }
  } else if (choice.command === "effort") {
    if (!next.active_profile && sessionRuntime.active_profile) {
      next.active_profile = sessionRuntime.active_profile;
    }
    const sessionRuntimeMatchesProfile = !sessionRuntime.active_profile
      || !next.active_profile
      || sessionRuntime.active_profile === next.active_profile;
    if (!next.model && sessionRuntime.model && sessionRuntimeMatchesProfile) {
      next.model = sessionRuntime.model;
    }
    next.effort = normalizeRuntimeEffortValue(choice.value);
  }

  next.pgpt_available = await isPgptRuntimeAvailable();
  settings.web_shared_runtime_preferences = normalizeSharedRuntimePreferences(next);
  await writeJsonFile(settingsPath, settings);
  return settings.web_shared_runtime_preferences;
}

function conflictError(message = "파일이 다른 사용자 또는 세션에서 변경되었습니다. 새로고침 후 다시 시도하세요.") {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeExpectedMtime(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function assertExpectedMtime(info, expectedMtimeMs) {
  const expected = normalizeExpectedMtime(expectedMtimeMs);
  if (expected === null) {
    return;
  }
  if (Math.abs(Number(info.mtimeMs || 0) - expected) > 1) {
    throw conflictError();
  }
}

function mutationQueueKey(workspacePath) {
  return normalize(String(workspacePath || ""));
}

async function withWorkspaceMutation(workspacePath, action) {
  const key = mutationQueueKey(workspacePath);
  const previous = workspaceMutationQueues.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => next);
  workspaceMutationQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (workspaceMutationQueues.get(key) === queued) {
      workspaceMutationQueues.delete(key);
    }
  }
}

function normalizeWebUsageStats(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const byIp = source.byIp && typeof source.byIp === "object" ? source.byIp : {};
  return {
    version: 1,
    totalVisits: Number(source.totalVisits || 0),
    byIp,
  };
}

async function readWebUsageStats() {
  return normalizeWebUsageStats(await readJsonFileIfExists(webUsageStatsPath));
}

function updateWebUsageStats(mutator) {
  const next = webUsageStatsWriteQueue.then(async () => {
    const stats = await readWebUsageStats();
    await mutator(stats);
    await writeJsonFileAtomic(webUsageStatsPath, stats);
  });
  webUsageStatsWriteQueue = next.catch(() => {});
  return next;
}

async function recordWebVisit(request) {
  const ip = normalizeClientAddress(forwardedAddressFromRequest(request));
  const now = Date.now();
  const today = localDateKey(new Date(now));
  await updateWebUsageStats(async (stats) => {
    const ipStats = stats.byIp[ip] && typeof stats.byIp[ip] === "object"
      ? stats.byIp[ip]
      : { ip, firstSeenAt: now, lastSeenAt: null, visitCount: 0, daily: {} };
    const daily = ipStats.daily && typeof ipStats.daily === "object" ? ipStats.daily : {};
    const dayStats = daily[today] && typeof daily[today] === "object"
      ? daily[today]
      : { visits: 0, firstSeenAt: now, lastSeenAt: null };

    stats.totalVisits += 1;
    ipStats.ip = ip;
    ipStats.firstSeenAt = Number(ipStats.firstSeenAt || now);
    ipStats.lastSeenAt = now;
    ipStats.visitCount = Number(ipStats.visitCount || 0) + 1;
    dayStats.visits = Number(dayStats.visits || 0) + 1;
    dayStats.firstSeenAt = Number(dayStats.firstSeenAt || now);
    dayStats.lastSeenAt = now;
    daily[today] = dayStats;
    ipStats.daily = daily;
    stats.byIp[ip] = ipStats;
  });
}

function rememberDevRedirectVisit(request) {
  const ip = normalizeClientAddress(forwardedAddressFromRequest(request));
  recentDevRedirectVisits.set(ip, Date.now());
}

function consumeRecentDevRedirectVisit(request) {
  const ip = normalizeClientAddress(forwardedAddressFromRequest(request));
  const recordedAt = recentDevRedirectVisits.get(ip);
  if (!recordedAt) {
    return false;
  }
  recentDevRedirectVisits.delete(ip);
  return Date.now() - recordedAt <= recentDevRedirectVisitTtlMs;
}

async function readWorkspaceScopeSettings(request = null) {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  const mode = normalizeWorkspaceScopeMode(settings.web_workspace_scope || settings.workspace_scope || workspaceScopeMode);
  return {
    mode,
    scope: request ? workspaceScopeFromRequest(request) : null,
  };
}

async function saveWorkspaceScopeSettings(body = {}, request = null) {
  const mode = normalizeWorkspaceScopeMode(body.mode);
  workspaceScopeMode = mode;
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  settings.web_workspace_scope = mode;
  await writeJsonFile(settingsPath, settings);
  return readWorkspaceScopeSettings(request);
}

function normalizeLearnedSkillsMode(value, fallback = "hide") {
  const raw = String(value || "").trim().toLowerCase();
  if (["use", "hide", "off"].includes(raw)) {
    return raw;
  }
  if (["on", "enabled", "visible"].includes(raw)) {
    return "use";
  }
  if (["hidden"].includes(raw)) {
    return "hide";
  }
  if (["disabled", "disable", "false"].includes(raw)) {
    return "off";
  }
  return fallback;
}

async function readLearnedSkillsSettings() {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  const learning = settings.learning && typeof settings.learning === "object" ? settings.learning : {};
  const mode = learning.enabled === false
    ? "off"
    : normalizeLearnedSkillsMode(learning.mode, "hide");
  return { mode };
}

async function saveLearnedSkillsSettings(body = {}) {
  const mode = normalizeLearnedSkillsMode(body.mode, "hide");
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  const learning = settings.learning && typeof settings.learning === "object" ? settings.learning : {};
  settings.learning = {
    ...learning,
    enabled: mode !== "off",
    mode,
  };
  await writeJsonFile(settingsPath, settings);
  return readLearnedSkillsSettings();
}

async function readShellSettings() {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  const preference = normalizeShellPreference(settings.shell || settings.web_shell || shellPreference);
  shellPreference = preference;
  return {
    shell: preference,
    options: shellOptions(),
  };
}

async function saveShellSettings(body = {}) {
  const preference = normalizeShellPreference(body.shell);
  shellPreference = preference;
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  settings.shell = preference;
  await writeJsonFile(settingsPath, settings);
  return readShellSettings();
}

async function readYoloModeSettings() {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  return {
    enabled: settings.yolo_mode_enabled !== false,
    permissionMode: settings.yolo_mode_enabled === false ? "default" : "full_auto",
  };
}

async function saveYoloModeSettings(body = {}) {
  const enabled = body.enabled !== false;
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  settings.yolo_mode_enabled = enabled;
  await writeJsonFile(settingsPath, settings);
  return readYoloModeSettings();
}

function normalizeModelFamily(value) {
  const raw = String(value || "").trim().toLowerCase();
  const model = raw.includes("/") ? raw.split("/").pop() : raw;
  for (const key of [...configurableOutputTokenModels].sort((left, right) => right.length - left.length)) {
    if (model === key || model.startsWith(`${key}-`)) {
      return key;
    }
  }
  return "";
}

function coerceOutputTokenLimit(model, value, fallback = modelOutputTokenDefault) {
  const officialMax = modelOutputTokenCaps[model] || modelOutputTokenDefault;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.min(fallback, officialMax);
  }
  return Math.max(1, Math.min(Math.trunc(parsed), officialMax));
}

function outputTokenValuesFromSettings(settings = {}) {
  const stored = settings.model_output_token_limits && typeof settings.model_output_token_limits === "object"
    ? settings.model_output_token_limits
    : {};
  const fallback = Number.isFinite(Number(settings.max_tokens))
    ? Number(settings.max_tokens)
    : modelOutputTokenDefault;
  return Object.fromEntries(configurableOutputTokenModels.map((model) => [
    model,
    coerceOutputTokenLimit(model, stored[model], fallback),
  ]));
}

async function readOutputTokenSettings() {
  const settings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  const values = outputTokenValuesFromSettings(settings);
  return {
    values,
    models: configurableOutputTokenModels.map((model) => ({
      id: model,
      label: model,
      value: values[model],
      officialMax: modelOutputTokenCaps[model],
    })),
  };
}

async function saveOutputTokenSettings(body = {}) {
  const incoming = body.values && typeof body.values === "object" ? body.values : {};
  const settingsPath = join(globalConfigDir(), "settings.json");
  const settings = await readJsonFileIfExists(settingsPath) || {};
  const previous = outputTokenValuesFromSettings(settings);
  const values = { ...previous };
  for (const model of configurableOutputTokenModels) {
    if (!Object.prototype.hasOwnProperty.call(incoming, model)) {
      continue;
    }
    const parsed = Number(incoming[model]);
    if (!Number.isFinite(parsed) || parsed < 1 || Math.trunc(parsed) !== parsed) {
      throw new Error(`${model} 출력 토큰은 1 이상의 정수여야 합니다.`);
    }
    if (parsed > modelOutputTokenCaps[model]) {
      throw new Error(`${model} 출력 토큰은 공식 최대값 ${modelOutputTokenCaps[model].toLocaleString("en-US")}을 넘을 수 없습니다.`);
    }
    values[model] = parsed;
  }
  settings.model_output_token_limits = values;
  const activeModel = normalizeModelFamily(settings.model);
  if (activeModel && Object.prototype.hasOwnProperty.call(values, activeModel)) {
    settings.max_tokens = values[activeModel];
  }
  await writeJsonFile(settingsPath, settings);
  return readOutputTokenSettings();
}

async function defaultPermissionMode() {
  const { permissionMode } = await readYoloModeSettings();
  return permissionMode;
}

function shellOptions() {
  return [
    {
      value: "auto",
      label: "자동",
      description: "Windows에서는 PowerShell을 우선 사용하고, 없으면 Git Bash, 마지막으로 cmd를 사용합니다.",
    },
    {
      value: "powershell",
      label: "PowerShell",
      description: "pwsh가 있으면 pwsh, 없으면 Windows PowerShell을 사용합니다.",
    },
    {
      value: "git-bash",
      label: "Git Bash",
      description: "Git for Windows의 bash.exe를 사용합니다.",
    },
    {
      value: "cmd",
      label: "cmd",
      description: "Windows Command Prompt(cmd.exe)를 사용합니다.",
    },
  ];
}

async function readPgptSettings() {
  const credentials = await readJsonFileIfExists(join(globalConfigDir(), "credentials.json")) || {};
  const entry = credentials.pgpt && typeof credentials.pgpt === "object" ? credentials.pgpt : {};
  return {
    apiKeyConfigured: Boolean(entry.api_key),
    apiKeyMasked: maskSecret(entry.api_key),
    employeeNo: String(entry.employee_no || entry.system_code || ""),
    companyCode: String(entry.company_code || "30"),
  };
}

async function savePgptSettings(body = {}) {
  const credentialsPath = join(globalConfigDir(), "credentials.json");
  const credentials = await readJsonFileIfExists(credentialsPath) || {};
  const current = credentials.pgpt && typeof credentials.pgpt === "object" ? credentials.pgpt : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(body, "apiKey")) {
    const value = String(body.apiKey || "").trim();
    if (value) {
      next.api_key = value;
      process.env.PGPT_API_KEY = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "employeeNo")) {
    next.employee_no = String(body.employeeNo || "").trim();
    if (next.employee_no) {
      process.env.PGPT_EMPLOYEE_NO = next.employee_no;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "companyCode")) {
    next.company_code = String(body.companyCode || "").trim() || "30";
    process.env.PGPT_COMPANY_CODE = next.company_code;
  }
  credentials.pgpt = next;
  await writeJsonFile(credentialsPath, credentials);
  return readPgptSettings();
}

function normalizeProjectPreferences(raw = {}) {
  const disabledSkills = Array.isArray(raw.disabled_skills)
    ? raw.disabled_skills
    : Array.isArray(raw.disabledSkills)
      ? raw.disabledSkills
      : [];
  const disabledMcpServers = Array.isArray(raw.disabled_mcp_servers)
    ? raw.disabled_mcp_servers
    : Array.isArray(raw.disabledMcpServers)
      ? raw.disabledMcpServers
      : [];
  const enabledPlugins = raw.enabled_plugins && typeof raw.enabled_plugins === "object" && !Array.isArray(raw.enabled_plugins)
    ? raw.enabled_plugins
    : raw.enabledPlugins && typeof raw.enabledPlugins === "object" && !Array.isArray(raw.enabledPlugins)
      ? raw.enabledPlugins
      : {};
  return {
    version: 1,
    disabled_skills: [...new Set(disabledSkills.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean))].sort(),
    disabled_mcp_servers: [...new Set(disabledMcpServers.map((name) => String(name || "").trim()).filter(Boolean))].sort(),
    enabled_plugins: Object.fromEntries(
      Object.entries(enabledPlugins)
        .map(([name, value]) => [String(name || "").trim(), value !== false])
        .filter(([name]) => name)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function globalPreferencesSnapshot() {
  const configDir = globalConfigDir();
  const settings = await readJsonFileIfExists(join(configDir, "settings.json")) || {};
  const skillState = await readJsonFileIfExists(join(configDir, "skill_state.json")) || {};
  const appPreferences = await readJsonFileIfExists(appPreferencesPath()) || {};
  const normalizedAppPreferences = normalizeProjectPreferences(appPreferences);
  return normalizeProjectPreferences({
    disabled_skills: Array.isArray(skillState.disabled_skills) ? skillState.disabled_skills : [],
    disabled_mcp_servers: Array.isArray(settings.disabled_mcp_servers) ? settings.disabled_mcp_servers : [],
    enabled_plugins: {
      ...(settings.enabled_plugins && typeof settings.enabled_plugins === "object" ? settings.enabled_plugins : {}),
      ...normalizedAppPreferences.enabled_plugins,
    },
  });
}

async function updatePluginPreferenceFiles(name, enabled, session = null) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return;
  const normalizedEnabled = enabled !== false;

  const appPath = appPreferencesPath();
  const appPreferences = normalizeProjectPreferences(await readJsonFileIfExists(appPath) || {});
  appPreferences.enabled_plugins[cleanName] = normalizedEnabled;
  await writeJsonFileAtomic(appPath, normalizeProjectPreferences(appPreferences));

  const workspace = session?.workspace;
  if (workspace?.path) {
    const workspacePath = projectPreferencesPath(workspace);
    const workspacePreferences = normalizeProjectPreferences(await readJsonFileIfExists(workspacePath) || {});
    workspacePreferences.enabled_plugins[cleanName] = normalizedEnabled;
    await writeJsonFileAtomic(workspacePath, workspacePreferences);
  }

  const scopes = [];
  try {
    const entries = await readdir(playgroundRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) scopes.push(entry.name);
    }
  } catch {
    return;
  }
  await Promise.all(scopes.map(async (scopeName) => {
    const path = join(playgroundRoot, scopeName, defaultWorkspaceName, projectPreferencesRel);
    const raw = await readJsonFileIfExists(path);
    if (!raw) return;
    const preferences = normalizeProjectPreferences(raw);
    preferences.enabled_plugins[cleanName] = normalizedEnabled;
    await writeJsonFileAtomic(path, preferences);
  }));
}

async function updateMcpPreferenceFiles(name, enabled, session = null) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return;

  const workspace = session?.workspace;
  if (!workspace?.path) return;
  const workspacePath = projectPreferencesPath(workspace);
  const workspacePreferences = normalizeProjectPreferences(await readJsonFileIfExists(workspacePath) || {});
  const disabled = new Set(workspacePreferences.disabled_mcp_servers);
  if (enabled !== false) {
    disabled.delete(cleanName);
  } else {
    disabled.add(cleanName);
  }
  workspacePreferences.disabled_mcp_servers = [...disabled].sort();
  await writeJsonFileAtomic(workspacePath, normalizeProjectPreferences(workspacePreferences));
}

async function ensureDefaultPreferences(scope = defaultWorkspaceScope()) {
  const workspace = workspacePathFromName(defaultWorkspaceName, scope);
  await mkdir(workspace.path, { recursive: true });
  const preferencesPath = projectPreferencesPath(workspace);
  try {
    await stat(preferencesPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await mkdir(dirname(preferencesPath), { recursive: true });
    await writeFile(preferencesPath, `${JSON.stringify(await globalPreferencesSnapshot(), null, 2)}\n`, "utf8");
  }
  return preferencesPath;
}

async function copyDefaultPreferencesToWorkspace(workspace, scope = defaultWorkspaceScope()) {
  if (workspace.name === defaultWorkspaceName) {
    await ensureDefaultPreferences(scope);
    return;
  }
  const source = await ensureDefaultPreferences(scope);
  const target = projectPreferencesPath(workspace);
  try {
    await stat(target);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const raw = await readJsonFileIfExists(source);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(normalizeProjectPreferences(raw), null, 2)}\n`, "utf8");
}

function legacyWorkspacePath(name) {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const workspacePath = normalize(join(playgroundRoot, validation.name));
  const rel = relative(playgroundRoot, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\") || rel.includes("/")) {
    throw new Error("Legacy workspace path must stay directly inside Playground");
  }
  return workspacePath;
}

async function copyLegacyWorkspaceIfNeeded(workspace, scope = defaultWorkspaceScope()) {
  if (scope.name !== sharedWorkspaceScopeName) {
    return false;
  }
  let targetExists = false;
  try {
    targetExists = (await stat(workspace.path)).isDirectory();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (targetExists) {
    return false;
  }
  const legacyPath = legacyWorkspacePath(workspace.name);
  try {
    const info = await stat(legacyPath);
    if (!info.isDirectory()) {
      return false;
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await mkdir(dirname(workspace.path), { recursive: true });
  await cp(legacyPath, workspace.path, { recursive: true, errorOnExist: false, force: false });
  return true;
}

async function looksLikeLegacyWorkspace(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.name === ".myharness" || entry.isFile());
  } catch {
    return false;
  }
}

async function copyLegacyWorkspacesIfNeeded(scope = defaultWorkspaceScope()) {
  if (scope.name !== sharedWorkspaceScopeName) {
    return;
  }
  await mkdir(playgroundRoot, { recursive: true });
  const entries = await readdir(playgroundRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sharedWorkspaceScopeName || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry.name)) {
      continue;
    }
    try {
      const workspace = workspaceFromDirectoryName(entry.name, scope);
      if (await looksLikeLegacyWorkspace(join(playgroundRoot, entry.name))) {
        await copyLegacyWorkspaceIfNeeded(workspace, scope);
      }
    } catch {
      // Ignore folders that are not valid project names.
    }
  }
}

async function ensureWorkspace(name = defaultWorkspaceName, scope = defaultWorkspaceScope()) {
  const workspace = workspacePathFromName(name, scope);
  await mkdir(scope.root, { recursive: true });
  let existed = false;
  try {
    existed = (await stat(workspace.path)).isDirectory();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const copiedLegacy = await copyLegacyWorkspaceIfNeeded(workspace, scope);
  if (!copiedLegacy) {
    await mkdir(workspace.path, { recursive: true });
  }
  if (!existed) {
    await copyDefaultPreferencesToWorkspace(workspace, scope);
  }
  return workspace;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameWorkspacePath(left, right) {
  const leftPath = normalize(String(left || ""));
  const rightPath = normalize(String(right || ""));
  if (!leftPath || !rightPath) {
    return false;
  }
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function sessionUsesWorkspace(session, workspace) {
  return sameWorkspacePath(session?.workspace?.path, workspace?.path);
}

async function stopSessionsForWorkspace(workspace) {
  const targetSessions = [...sessions.values()].filter((session) => sessionUsesWorkspace(session, workspace));
  if (!targetSessions.length) {
    return;
  }
  for (const session of targetSessions) {
    if (!session.shuttingDown) {
      shutdownSession(session, "workspace delete");
    }
    killProcessTree(session.process);
  }
  const deadline = Date.now() + 2500;
  while (
    Date.now() < deadline
    && [...sessions.values()].some((session) => sessionUsesWorkspace(session, workspace))
  ) {
    await sleep(50);
  }
}

async function deleteWorkspace(name, scope = defaultWorkspaceScope()) {
  const workspace = workspacePathFromName(name, scope);
  await stopSessionsForWorkspace(workspace);
  const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  const delays = [0, 120, 300, 700, 1200];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }
    try {
      await rm(workspace.path, { recursive: true, force: true });
      return workspace;
    } catch (error) {
      if (attempt === delays.length - 1 || !retryableCodes.has(error?.code)) {
        throw error;
      }
    }
  }
  return workspace;
}

async function listWorkspaces(scope = defaultWorkspaceScope()) {
  await copyLegacyWorkspacesIfNeeded(scope);
  await mkdir(scope.root, { recursive: true });
  const entries = await readdir(scope.root, { withFileTypes: true });
  const directories = (
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
      try {
        const workspace = workspaceFromDirectoryName(entry.name, scope);
        const info = await stat(workspace.path);
        return { ...workspace, createdAt: info.birthtimeMs || info.ctimeMs || 0 };
      } catch {
        return null;
      }
    }))
  )
    .filter(Boolean)
    .sort((left, right) => {
      const byCreated = left.createdAt - right.createdAt;
      return byCreated || left.name.localeCompare(right.name);
    })
    .map(({ createdAt, ...workspace }) => workspace);
  if (!directories.length) {
    return [await ensureWorkspace(defaultWorkspaceName, scope)];
  }
  return directories;
}

function sessionDirectoryForWorkspace(workspace) {
  return join(workspace.path, ".myharness", "sessions");
}

function hiddenHistoryPathForWorkspace(workspace) {
  return join(workspace.path, ".myharness", "hidden-history.json");
}

function normalizeHiddenHistoryIds(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))].slice(-500);
}

async function readHiddenHistoryIds(workspace) {
  try {
    const payload = JSON.parse(await readFile(hiddenHistoryPathForWorkspace(workspace), "utf8"));
    return normalizeHiddenHistoryIds(payload?.sessionIds);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

async function writeHiddenHistoryIds(workspace, sessionIds) {
  const target = hiddenHistoryPathForWorkspace(workspace);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ sessionIds: normalizeHiddenHistoryIds(sessionIds) }, null, 2)}\n`);
}

async function hideWorkspaceHistoryItem(workspace, sessionId) {
  const cleanId = String(sessionId || "").trim();
  if (!cleanId) {
    throw new Error("Session id is required");
  }
  const hiddenIds = await readHiddenHistoryIds(workspace);
  if (!hiddenIds.includes(cleanId)) {
    await writeHiddenHistoryIds(workspace, [...hiddenIds, cleanId]);
  }
  return true;
}

async function forgetHiddenWorkspaceHistoryItem(workspace, sessionId) {
  const cleanId = String(sessionId || "").trim();
  if (!cleanId) {
    return;
  }
  const hiddenIds = await readHiddenHistoryIds(workspace);
  if (hiddenIds.includes(cleanId)) {
    await writeHiddenHistoryIds(workspace, hiddenIds.filter((item) => item !== cleanId));
  }
}

function compactText(value, limit = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function messageText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (typeof block.text === "string") {
        return block.text;
      }
      if (typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function firstUserSummary(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "user") {
      return compactText(messageText(message));
    }
  }
  return "";
}

async function readSessionListItem(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const info = await stat(path);
  const fileName = basename(path);
  const sessionId = String(data.session_id || "").trim()
    || fileName.replace(/^session-/, "").replace(/\.json$/i, "");
  const summary = compactText(data.summary) || firstUserSummary(data.messages) || "새 대화";
  const createdAt = historyOrderTimestamp(data, info);
  const lastAssistantAt = lastAssistantActivityTimestamp(data, info);
  const date = new Date(createdAt * (createdAt < 10_000_000_000 ? 1000 : 1));
  const labelDate = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const messageCount = Number(data.message_count || (Array.isArray(data.messages) ? data.messages.length : 0));
  return {
    value: sessionId || fileName.replace(/^session-/, "").replace(/\.json$/i, ""),
    label: `${labelDate}  ${messageCount}msg  ${summary}`,
    description: summary,
    createdAt,
    lastAssistantAt,
    pinned: data.pinned === true,
  };
}

async function listWorkspaceHistory(workspace, options = {}) {
  const sessionDir = sessionDirectoryForWorkspace(workspace);
  const hiddenIds = new Set(await readHiddenHistoryIds(workspace));
  let entries = [];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const items = [];
  const seen = new Set();
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && /^session-.+\.json$/i.test(entry.name))
    .map((entry) => join(sessionDir, entry.name));
  for (const file of sessionFiles) {
    try {
      const item = await readSessionListItem(file);
      if (item.value) {
        item.hidden = hiddenIds.has(item.value);
        seen.add(item.value);
        items.push(item);
      }
    } catch {
      // Ignore corrupt or partially written snapshots.
    }
  }

  const latestPath = join(sessionDir, "latest.json");
  try {
    const latest = await readSessionListItem(latestPath);
    if (latest.value && !seen.has(latest.value)) {
      latest.hidden = hiddenIds.has(latest.value);
      items.push(latest);
    }
  } catch {
    // latest.json is optional.
  }

  const sorted = sortHistoryItems(items);
  if (options.includeCreatedAt) {
    return sorted;
  }
  return sorted.map(({ createdAt, ...item }) => item);
}

function sortHistoryItems(items) {
  return items.sort((left, right) => {
    return compareHistoryItems(left, right);
  });
}

function parseHistoryPageParams(params) {
  const rawLimit = Number.parseInt(params.get("limit") || "", 10);
  const rawOffset = Number.parseInt(params.get("offset") || "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : null;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

function paginateHistoryItems(items, page) {
  if (!page?.limit) {
    return { options: items, hasMore: false, nextOffset: items.length };
  }
  const offset = Math.min(page.offset, items.length);
  const nextOffset = Math.min(offset + page.limit, items.length);
  return {
    options: items.slice(offset, nextOffset),
    hasMore: nextOffset < items.length,
    nextOffset,
  };
}

async function listAllWorkspaceHistory(scope = defaultWorkspaceScope()) {
  const workspaces = await listWorkspaces(scope);
  const grouped = await Promise.all(workspaces.map(async (workspace) => {
    const items = await listWorkspaceHistory(workspace, { includeCreatedAt: true });
    return items.map(({ createdAt, ...item }) => ({
      ...item,
      titleSortKey: item.description || item.label || item.value || "",
      description: item.description ? `${workspace.name} · ${item.description}` : workspace.name,
      workspace,
      createdAt,
    }));
  }));
  return grouped
    .flat()
    .sort((left, right) => compareHistoryItems(left, right))
    .map(({ createdAt, titleSortKey, ...item }) => item);
}

function createEmptyUserStats(clientId = "", clientAddress = "") {
  return {
    viewerIp: clientAddress,
    totalVisitCount: 0,
    todayVisitCount: 0,
    dailyActiveIpCount: 0,
    currentIpVisitCount: 0,
    currentIpTodayVisitCount: 0,
    workspaceCount: 0,
    conversationCount: 0,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    activeSessionCount: [...sessions.values()].filter((session) =>
      !session.shuttingDown && (!clientId || session.clientId === clientId)
    ).length,
    activeIpSessionCount: [...sessions.values()].filter((session) =>
      !session.shuttingDown && (!clientAddress || session.clientAddress === clientAddress)
    ).length,
    firstConversationAt: null,
    latestConversationAt: null,
    ipBreakdown: [],
    dailyBreakdown: [],
    dailyIpBreakdown: [],
    currentWorkspaceName: "",
    currentWorkspaceConversationCount: 0,
    workspaceBreakdown: [],
  };
}

function countMessageStats(messages) {
  const stats = {
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }
    stats.messageCount += 1;
    if (message.role === "user") {
      stats.userMessageCount += 1;
    }
    if (message.role === "assistant") {
      stats.assistantMessageCount += 1;
    }
    if (Array.isArray(message.content)) {
      stats.toolUseCount += message.content.filter((block) => block?.type === "tool_use").length;
    }
  }
  return stats;
}

async function readSessionStatsItem(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const info = await stat(path);
  const createdAt = historyOrderTimestamp(data, info);
  return {
    ...countMessageStats(data.messages),
    createdAt,
  };
}

async function listWorkspaceSessionStatFiles(workspace) {
  const sessionDir = sessionDirectoryForWorkspace(workspace);
  let entries = [];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /^session-.+\.json$/i.test(entry.name))
    .map((entry) => join(sessionDir, entry.name));
}

function appendWebUsageStats(stats, webUsage, clientAddress = "") {
  const today = localDateKey();
  const dailyMap = new Map();
  const dailyIpMap = new Map();
  const ipItems = Object.values(webUsage.byIp || {}).map((entry) => {
    const daily = entry?.daily && typeof entry.daily === "object" ? entry.daily : {};
    const todayStats = daily[today] && typeof daily[today] === "object" ? daily[today] : {};
    for (const [date, day] of Object.entries(daily)) {
      const visits = Number(day?.visits || 0);
      const current = dailyMap.get(date) || { date, visitCount: 0, activeIpCount: 0 };
      current.visitCount += visits;
      current.activeIpCount += visits > 0 ? 1 : 0;
      dailyMap.set(date, current);
      if (visits > 0) {
        const ip = String(entry?.ip || "");
        const currentIps = dailyIpMap.get(date) || [];
        currentIps.push({
          ip,
          visitCount: visits,
          firstSeenAt: Number(day?.firstSeenAt || 0) || null,
          lastSeenAt: Number(day?.lastSeenAt || 0) || null,
        });
        dailyIpMap.set(date, currentIps);
      }
    }
    return {
      ip: String(entry?.ip || ""),
      visitCount: Number(entry?.visitCount || 0),
      todayVisitCount: Number(todayStats.visits || 0),
      firstSeenAt: Number(entry?.firstSeenAt || 0) || null,
      lastSeenAt: Number(entry?.lastSeenAt || 0) || null,
      activeSessionCount: [...sessions.values()].filter((session) =>
        !session.shuttingDown && session.clientAddress === entry?.ip
      ).length,
    };
  }).filter((entry) => entry.ip);

  stats.totalVisitCount = Number(webUsage.totalVisits || 0);
  stats.todayVisitCount = [...dailyMap.values()]
    .find((entry) => entry.date === today)?.visitCount || 0;
  stats.dailyActiveIpCount = [...dailyMap.values()]
    .find((entry) => entry.date === today)?.activeIpCount || 0;
  stats.ipBreakdown = ipItems.sort((left, right) => {
    const byLastSeen = Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
    return byLastSeen || right.visitCount - left.visitCount || left.ip.localeCompare(right.ip);
  });
  stats.dailyBreakdown = [...dailyMap.values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 14);
  stats.dailyIpBreakdown = stats.dailyBreakdown.map((entry) => ({
    date: entry.date,
    ipBreakdown: (dailyIpMap.get(entry.date) || [])
      .filter((item) => item.ip)
      .sort((left, right) => right.visitCount - left.visitCount || left.ip.localeCompare(right.ip))
      .slice(0, 50),
  }));

  const currentIpStats = stats.ipBreakdown.find((entry) => entry.ip === clientAddress);
  stats.currentIpVisitCount = currentIpStats?.visitCount || 0;
  stats.currentIpTodayVisitCount = currentIpStats?.todayVisitCount || 0;
}

async function collectUserStats(scope = defaultWorkspaceScope(), currentWorkspace = null, clientId = "", clientAddress = "") {
  const stats = createEmptyUserStats(clientId, clientAddress);
  appendWebUsageStats(stats, await readWebUsageStats(), clientAddress);
  const workspaces = await listWorkspaces(scope);
  stats.workspaceCount = workspaces.length;
  stats.currentWorkspaceName = currentWorkspace?.name || "";

  for (const workspace of workspaces) {
    const files = await listWorkspaceSessionStatFiles(workspace);
    const workspaceStats = {
      name: workspace.name,
      path: workspace.path,
      conversationCount: 0,
      messageCount: 0,
      latestConversationAt: null,
    };
    for (const file of files) {
      try {
        const item = await readSessionStatsItem(file);
        workspaceStats.conversationCount += 1;
        workspaceStats.messageCount += item.messageCount;
        stats.conversationCount += 1;
        stats.messageCount += item.messageCount;
        stats.userMessageCount += item.userMessageCount;
        stats.assistantMessageCount += item.assistantMessageCount;
        stats.toolUseCount += item.toolUseCount;
        if (item.createdAt) {
          workspaceStats.latestConversationAt = Math.max(workspaceStats.latestConversationAt || 0, item.createdAt);
          stats.firstConversationAt = stats.firstConversationAt ? Math.min(stats.firstConversationAt, item.createdAt) : item.createdAt;
          stats.latestConversationAt = Math.max(stats.latestConversationAt || 0, item.createdAt);
        }
      } catch {
        // Ignore corrupt or partially written snapshots.
      }
    }
    if (currentWorkspace?.path && workspace.path === currentWorkspace.path) {
      stats.currentWorkspaceConversationCount = workspaceStats.conversationCount;
    }
    stats.workspaceBreakdown.push(workspaceStats);
  }

  stats.workspaceBreakdown.sort((left, right) => {
    const byConversationCount = right.conversationCount - left.conversationCount;
    return byConversationCount || left.name.localeCompare(right.name);
  });
  return stats;
}

function workspaceFromHistoryRequest(paramsOrBody = {}, scope = defaultWorkspaceScope()) {
  const workspacePath = String(paramsOrBody.workspacePath || "").trim();
  const workspaceName = String(paramsOrBody.workspaceName || paramsOrBody.name || "").trim();
  if (workspacePath) {
    return workspaceFromPath(workspacePath, scope);
  }
  if (workspaceName) {
    return workspaceFromDirectoryName(workspaceName, scope);
  }
  return workspacePathFromName(defaultWorkspaceName, scope);
}

function sessionBelongsToWorkspace(session, workspace) {
  const sessionPath = String(session?.workspace?.path || "").trim();
  const workspacePath = String(workspace?.path || "").trim();
  if (sessionPath && workspacePath) {
    return sessionPath === workspacePath;
  }
  const sessionName = String(session?.workspace?.name || "").trim();
  const workspaceName = String(workspace?.name || "").trim();
  if (sessionName && workspaceName) {
    return sessionName === workspaceName;
  }
  return true;
}

function detachDeletedSavedSession(workspace, sessionId) {
  const cleanId = String(sessionId || "").trim();
  if (!cleanId) {
    return;
  }
  for (const session of sessions.values()) {
    if (String(session.savedSessionId || "").trim() !== cleanId || !sessionBelongsToWorkspace(session, workspace)) {
      continue;
    }
    session.savedSessionId = "";
    session.title = "";
    try {
      sendBackend(session, { type: "delete_session", value: cleanId });
    } catch (error) {
      writeRuntimeLog("history_delete_detach_failed", {
        session_id: session.id,
        saved_session_id: cleanId,
        error: errorPayload(error),
      });
    }
  }
}

async function deleteWorkspaceHistoryItem(workspace, sessionId) {
  const cleanId = String(sessionId || "").trim();
  if (!cleanId) {
    throw new Error("Session id is required");
  }
  const sessionDir = sessionDirectoryForWorkspace(workspace);
  const target = join(sessionDir, `session-${cleanId}.json`);
  let deleted = false;
  try {
    await rm(target);
    deleted = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  for (const latestPath of await latestSnapshotPaths(sessionDir)) {
    try {
      const latest = JSON.parse(await readFile(latestPath, "utf8"));
      if (String(latest.session_id || "latest") === cleanId || cleanId === "latest") {
        await rm(latestPath);
        deleted = true;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  await forgetHiddenWorkspaceHistoryItem(workspace, cleanId);
  return deleted;
}

async function latestSnapshotPaths(sessionDir) {
  const paths = [join(sessionDir, "latest.json")];
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^latest-.+\.json$/i.test(entry.name)) {
        paths.push(join(sessionDir, entry.name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return paths;
}

async function updateMatchingLatestSnapshots(sessionDir, sessionId, payload) {
  for (const latestPath of await latestSnapshotPaths(sessionDir)) {
    try {
      const latest = JSON.parse(await readFile(latestPath, "utf8"));
      if (String(latest.session_id || "") === sessionId) {
        await writeJsonFileAtomic(latestPath, payload);
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
}

async function updateWorkspaceHistoryTitle(workspace, sessionId, title) {
  const cleanId = String(sessionId || "").trim();
  const cleanTitle = compactText(title, 80);
  if (!cleanId) {
    throw new Error("Session id is required");
  }
  if (!cleanTitle) {
    throw new Error("Session title is required");
  }
  const sessionDir = sessionDirectoryForWorkspace(workspace);
  const target = join(sessionDir, `session-${cleanId}.json`);
  const payload = JSON.parse(await readFile(target, "utf8"));
  payload.summary = cleanTitle;
  payload.tool_metadata = {
    ...(payload.tool_metadata && typeof payload.tool_metadata === "object" ? payload.tool_metadata : {}),
    session_title: cleanTitle,
    session_title_user_edited: true,
  };
  await writeJsonFileAtomic(target, payload);
  await updateMatchingLatestSnapshots(sessionDir, cleanId, payload);
  return payload;
}

async function updateWorkspaceHistoryPin(workspace, sessionId, pinned) {
  const cleanId = String(sessionId || "").trim();
  if (!cleanId) {
    throw new Error("Session id is required");
  }
  const sessionDir = sessionDirectoryForWorkspace(workspace);
  const target = join(sessionDir, `session-${cleanId}.json`);
  const payload = JSON.parse(await readFile(target, "utf8"));
  payload.pinned = pinned === true;
  await writeJsonFileAtomic(target, payload);
  await updateMatchingLatestSnapshots(sessionDir, cleanId, payload);
  return payload;
}

async function resolveSessionWorkspace(options = {}) {
  const scope = workspaceScopeOrDefault(options.workspaceScope);
  if (options.cwd) {
    const workspace = workspaceFromPath(options.cwd, scope);
    try {
      const info = await stat(workspace.path);
      if (info.isDirectory()) {
        return workspace;
      }
    } catch {
      return ensureWorkspace(workspace.name, scope);
    }
    return workspace;
  }
  return ensureWorkspace(defaultWorkspaceName, scope);
}

function sendBackend(session, payload) {
  if (!session.process || session.process.killed || session.process.stdin.destroyed) {
    return false;
  }
  session.process.stdin.write(`${JSON.stringify(payload)}\n`);
  return true;
}

function isSharedWorkspaceSession(session) {
  return isSharedWorkspaceScope(session?.workspace?.scope);
}

function queueSharedRuntimeChoice(session, choice) {
  if (!session || !choice) {
    return;
  }
  const pending = Array.isArray(session.pendingSharedRuntimeChoices)
    ? session.pendingSharedRuntimeChoices
    : [];
  const withoutReplaced = pending.filter((item) => {
    if (choice.command === "provider") {
      return item.command !== "provider" && item.command !== "model";
    }
    return item.command !== choice.command;
  });
  session.pendingSharedRuntimeChoices = [...withoutReplaced, choice];
}

function flushPendingSharedRuntimeChoices(session) {
  if (
    !session
    || session.shuttingDown
    || session.busy
    || !session.ready
    || !Array.isArray(session.pendingSharedRuntimeChoices)
    || !session.pendingSharedRuntimeChoices.length
  ) {
    return;
  }
  const choices = session.pendingSharedRuntimeChoices;
  session.pendingSharedRuntimeChoices = [];
  for (let index = 0; index < choices.length; index += 1) {
    const choice = choices[index];
    const ok = sendBackend(session, choice);
    if (!ok) {
      session.pendingSharedRuntimeChoices = [choice, ...choices.slice(index + 1), ...session.pendingSharedRuntimeChoices];
      return;
    }
  }
}

function sendOrQueueSharedRuntimeChoice(session, choice) {
  if (!session || !choice || session.shuttingDown) {
    return;
  }
  if (!session.ready || session.busy) {
    queueSharedRuntimeChoice(session, choice);
    return;
  }
  const ok = sendBackend(session, choice);
  if (!ok) {
    queueSharedRuntimeChoice(session, choice);
  }
}

function broadcastSharedRuntimeChoice(sourceSession, choice) {
  if (!sourceSession || !choice) {
    return;
  }
  for (const session of sessions.values()) {
    if (session.id === sourceSession.id || !isSharedWorkspaceSession(session)) {
      continue;
    }
    sendOrQueueSharedRuntimeChoice(session, choice);
  }
}

function trimShellOutput(value) {
  const text = String(value || "");
  if (text.length <= shellOutputMaxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, shellOutputMaxChars)}\n\n[output truncated]`,
    truncated: true,
  };
}

async function shellCommandForPlatform(command) {
  if (process.platform === "win32") {
    const pythonHeredoc = pythonHeredocCommandForWindows(command);
    if (pythonHeredoc) {
      return pythonHeredoc;
    }
    const pythonCommand = directPythonCommandForWindows(command);
    if (pythonCommand) {
      return pythonCommand;
    }
    const { shell } = await readShellSettings();
    return windowsShellCommand(command, shell);
  }
  return {
    file: process.env.SHELL || "/bin/sh",
    args: ["-lc", command],
  };
}

function windowsShellCommand(command, shell) {
  const preference = normalizeShellPreference(shell);
  if (preference === "auto" || preference === "powershell") {
    const powershell = resolveWindowsPowerShell();
    if (powershell || preference === "powershell") {
      return {
        file: powershell || "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          powershellUtf8Command(command),
        ],
      };
    }
  }
  if (preference === "auto" || preference === "git-bash") {
    const gitBash = resolveGitBash();
    if (gitBash || preference === "git-bash") {
      return {
        file: gitBash || "bash.exe",
        args: ["-lc", command],
      };
    }
  }
  return {
    file: resolveCommandOnPath("cmd.exe") || "cmd.exe",
    args: ["/d", "/s", "/c", `chcp 65001>nul & ${command}`],
  };
}

function resolveWindowsPowerShell() {
  return resolveCommandOnPath("pwsh.exe")
    || resolveCommandOnPath("pwsh")
    || resolveCommandOnPath("powershell.exe")
    || (process.env.SystemRoot
      ? existingPath(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
      : "");
}

function resolveGitBash() {
  const candidates = [
    resolveCommandOnPath("git-bash.exe"),
    resolveCommandOnPath("bash.exe"),
    process.env.MYHARNESS_GIT_BASH,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : "",
    process.env.LocalAppData ? join(process.env.LocalAppData, "Programs", "Git", "bin", "bash.exe") : "",
  ];
  return candidates.find((candidate) => candidate && looksLikeGitBash(candidate)) || "";
}

function resolveCommandOnPath(commandName) {
  const pathEnv = process.env.PATH || "";
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = join(entry, commandName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function existingPath(path) {
  return path && existsSync(path) ? path : "";
}

function looksLikeGitBash(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("/bash.exe") && normalized.includes("/git/") && existsSync(path);
}

function powershellUtf8Command(command) {
  return "[Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; "
    + "$OutputEncoding = [Console]::OutputEncoding; "
    + command;
}

function directPythonCommandForWindows(command) {
  if (hasUnquotedShellOperator(command)) {
    return null;
  }
  let parts;
  try {
    parts = splitWindowsCommand(command);
  } catch {
    return null;
  }
  if (parts[0] === "&") {
    parts = parts.slice(1);
  }
  if (!parts.length) {
    return null;
  }
  const executable = basename(String(parts[0] || "").replace(/^["']|["']$/g, "")).toLowerCase();
  if (!["python", "python.exe", "python3", "python3.exe"].includes(executable)) {
    return null;
  }
  const remaining = parts.slice(1);
  const python = resolvePythonCommand(parts[0], []);
  return {
    file: python.file,
    args: [...python.args, ...remaining],
  };
}

function pythonHeredocCommandForWindows(command) {
  const match = String(command || "").match(/^\s*(?<prefix>python3?(?:\.exe)?)\s+-\s+<<\s*(?<quote>['"]?)(?<tag>[A-Za-z_][A-Za-z0-9_]*)\k<quote>\s*\r?\n(?<body>[\s\S]*)\r?\n\k<tag>\s*$/i);
  if (!match?.groups) {
    return null;
  }
  const prefixParts = match.groups.prefix.trim().split(/\s+/);
  const python = resolvePythonCommand(prefixParts[0], prefixParts.slice(1));
  return {
    file: python.file,
    args: [...python.args, "-c", String(match.groups.body || "").replace(/\r\n/g, "\n")],
  };
}

function shellEnvironment(extra = {}) {
  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

function backendPythonCommand() {
  return resolvePythonCommand("", []);
}

function resolvePythonCommand(requestedExecutable = "", requestedArgs = []) {
  const requestedName = String(requestedExecutable || "").trim();
  const requestedBase = basename(requestedName).toLowerCase();
  const requestedIsGeneric = ["", "python", "python.exe", "python3", "python3.exe"].includes(requestedBase);
  const requestedHasPath = requestedName.includes("\\") || requestedName.includes("/") || isAbsolute(requestedName);
  const candidates = [];

  if (requestedIsGeneric) {
    const cached = loadCachedWindowsPythonLauncher();
    if (cached) {
      candidates.push({
        file: cached.file,
        args: cached.args,
        label: "cached python",
        cacheable: false,
      });
    }
  }

  if (requestedName && (requestedHasPath || !requestedIsGeneric)) {
    candidates.push({
      file: resolveExecutable(requestedName),
      args: requestedArgs,
      label: [requestedName, ...requestedArgs].join(" "),
      cacheable: requestedIsGeneric,
    });
  }

  if (requestedIsGeneric) {
    candidates.push(...defaultPythonCandidates());
    if (requestedName && !requestedHasPath) {
      candidates.push({
        file: resolveExecutable(requestedName),
        args: requestedArgs,
        label: [requestedName, ...requestedArgs].join(" "),
      });
    }
  } else {
    candidates.push(...defaultPythonCandidates());
  }

  const seen = new Set();
  const attempts = [];
  for (const candidate of candidates) {
    const key = [candidate.file, ...(candidate.args || [])].join("\u0000");
    if (!candidate.file || seen.has(key)) {
      continue;
    }
    seen.add(key);
    attempts.push(candidate.label || [candidate.file, ...(candidate.args || [])].join(" "));
    if (pythonCandidateIsUsable(candidate)) {
      const resolved = { file: candidate.file, args: candidate.args || [] };
      if (requestedIsGeneric && candidate.label !== "cached python") {
        storeCachedWindowsPythonLauncher(resolved, candidate.label || "detected");
      }
      return resolved;
    }
  }

  throw new Error(`No usable Python 3.10+ found. Tried: ${attempts.join(", ") || "none"}`);
}

function resolveExecutable(commandName) {
  return existingPath(commandName) || resolveCommandOnPath(commandName) || commandName;
}

function defaultPythonCandidates() {
  const candidates = [];
  const configured = String(process.env.MYHARNESS_PYTHON || "").trim();
  if (configured) {
    candidates.push({ file: configured, args: [], label: "MYHARNESS_PYTHON" });
  }

  const envPython = String(process.env.PYTHON || "").trim();
  if (envPython) {
    candidates.push({ file: envPython, args: [], label: "PYTHON" });
  }

  if (process.platform === "win32") {
    candidates.push(
      { file: resolveCommandOnPath("python.exe") || resolveCommandOnPath("python") || "python", args: [], label: "python" },
      { file: resolveCommandOnPath("python3.exe") || resolveCommandOnPath("python3") || "python3", args: [], label: "python3" },
    );
  } else {
    candidates.push(
      { file: resolveCommandOnPath("python3") || "python3", args: [], label: "python3" },
      { file: resolveCommandOnPath("python") || "python", args: [], label: "python" },
    );
  }
  return candidates;
}

function hasUnquotedShellOperator(command) {
  let quote = "";
  for (let index = 0; index < String(command || "").length; index += 1) {
    const char = command[index];
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote === char ? "" : char;
      continue;
    }
    if (!quote && "<>|&;".includes(char)) {
      return true;
    }
  }
  return false;
}

function splitWindowsCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  let started = false;
  const text = String(command || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char) && !quote) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote === char ? "" : char;
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new Error("No closing quotation");
  }
  if (started) {
    parts.push(current);
  }
  return parts;
}

function loadCachedWindowsPythonLauncher() {
  const path = windowsPythonLauncherCachePath();
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (!payload || payload.version !== 1 || !Array.isArray(payload.launcher)) {
      return null;
    }
    const [file, ...args] = payload.launcher;
    if (typeof file !== "string" || !file || args.some((arg) => typeof arg !== "string")) {
      return null;
    }
    if ((isAbsolute(file) && !existsSync(file)) || (!isAbsolute(file) && !resolveCommandOnPath(file))) {
      return null;
    }
    const candidate = { file, args };
    return pythonCandidateIsUsable(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function storeCachedWindowsPythonLauncher(python, source) {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const path = windowsPythonLauncherCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        launcher: [python.file, ...(python.args || [])],
        source,
      }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Cache failures should never block Python execution.
  }
}

function windowsPythonLauncherCachePath() {
  return join(process.env.MYHARNESS_DATA_DIR || join(appConfigRoot, "data"), "runtime", "windows_python_launcher.json");
}

function pythonCandidateIsUsable(candidate) {
  const check = "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)";
  try {
    const result = spawnSync(candidate.file, [...(candidate.args || []), "-c", check], {
      cwd: repoRoot,
      env: shellEnvironment(),
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

async function runShellCommand(options = {}) {
  const command = String(options.command || "").trim();
  if (!command) {
    throw new Error("Command is required");
  }
  const scope = workspaceScopeOrDefault(options.workspaceScope);
  const workspace = options.cwd
    ? workspaceFromPath(options.cwd, scope)
    : options.session?.workspace || await ensureWorkspace(defaultWorkspaceName, scope);
  const { file, args } = await shellCommandForPlatform(command);
  return await new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: workspace.path,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: shellEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, shellCommandTimeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: workspace.path,
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        timedOut: false,
        truncated: false,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const trimmedStdout = trimShellOutput(stdout);
      const trimmedStderr = trimShellOutput(stderr);
      resolve({
        command,
        cwd: workspace.path,
        exitCode: timedOut ? null : code ?? 0,
        stdout: trimmedStdout.text,
        stderr: trimmedStderr.text,
        timedOut,
        truncated: trimmedStdout.truncated || trimmedStderr.truncated,
      });
    });
  });
}

async function streamShellCommand(options = {}, request, response) {
  const command = String(options.command || "").trim();
  if (!command) {
    throw new Error("Command is required");
  }
  const scope = workspaceScopeOrDefault(options.workspaceScope);
  const workspace = options.cwd
    ? workspaceFromPath(options.cwd, scope)
    : options.session?.workspace || await ensureWorkspace(defaultWorkspaceName, scope);
  const { file, args } = await shellCommandForPlatform(command);

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();

  let outputChars = 0;
  let truncated = false;
  let timedOut = false;
  let finished = false;

  const writeEvent = (event) => {
    if (!response.writableEnded && !response.destroyed) {
      response.write(`${JSON.stringify(event)}\n`);
    }
  };

  const writeText = (type, chunk) => {
    if (truncated) {
      return;
    }
    const text = chunk.toString("utf8");
    const remaining = shellOutputMaxChars - outputChars;
    if (remaining <= 0) {
      truncated = true;
      writeEvent({ type: "truncated" });
      return;
    }
    const visible = text.length > remaining ? text.slice(0, remaining) : text;
    outputChars += visible.length;
    if (visible) {
      writeEvent({ type, text: visible });
    }
    if (text.length > remaining) {
      truncated = true;
      writeEvent({ type: "truncated" });
    }
  };

  const child = spawn(file, args, {
    cwd: workspace.path,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: shellEnvironment(),
  });

  const finish = (event) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    writeEvent({ ...event, truncated });
    response.end();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, shellCommandTimeoutMs);
  timer.unref?.();

  response.on("close", () => {
    if (!finished) {
      killProcessTree(child);
    }
  });

  writeEvent({ type: "start", command, cwd: workspace.path });
  child.stdout.on("data", (chunk) => writeText("stdout", chunk));
  child.stderr.on("data", (chunk) => writeText("stderr", chunk));
  child.on("error", (error) => {
    writeEvent({ type: "stderr", text: error.message });
    finish({ type: "exit", exitCode: 1, timedOut: false });
  });
  child.on("exit", (code) => {
    finish({ type: "exit", exitCode: timedOut ? null : code ?? 0, timedOut });
  });
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const mediaType = String(attachment.media_type || attachment.mediaType || "").trim();
  const data = String(attachment.data || "").trim();
  if (!mediaType || !data) {
    return null;
  }
  return {
    media_type: mediaType,
    data,
    name: String(attachment.name || ""),
  };
}

function safeClientUploadSegment(value) {
  const raw = String(value || "anonymous").trim() || "anonymous";
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

function safeClientAttachmentName(value) {
  const name = basename(String(value || "attachment").replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 160);
  return name || "attachment";
}

function normalizeAttachmentRef(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const path = normalizeProjectFilePath(attachment.path || attachment.rel || attachment.relativePath || "");
  if (!path || path === clientAttachmentRootRel || !path.startsWith(`${clientAttachmentRootRel}/`)) {
    return null;
  }
  const size = Math.max(0, Math.trunc(Number(attachment.size) || 0));
  return {
    id: String(attachment.id || crypto.randomUUID()),
    name: safeClientAttachmentName(attachment.name || basename(path)),
    path,
    size,
    media_type: String(attachment.media_type || attachment.mediaType || "application/octet-stream").trim(),
  };
}

function normalizeComposeOptions(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const options = {};
  const outputSurface = String(value.output_surface || value.outputSurface || "").trim().toLowerCase();
  if (outputSurface === "chat" || outputSurface === "artifact") {
    options.output_surface = outputSurface;
  }
  const artifactAction = String(value.artifact_action || value.artifactAction || "").trim().toLowerCase();
  if (artifactAction === "auto" || artifactAction === "create" || artifactAction === "edit") {
    options.artifact_action = artifactAction;
  }
  const lengthPreset = String(value.length_preset || value.lengthPreset || "").trim().toLowerCase();
  if (["default", "long", "very_long", "extended", "extra_long"].includes(lengthPreset)) {
    options.length_preset = lengthPreset;
  }
  const rawTarget = Number(value.target_output_tokens ?? value.targetOutputTokens ?? 0);
  if (Number.isFinite(rawTarget) && rawTarget > 0) {
    options.target_output_tokens = Math.max(1, Math.min(composeTargetOutputTokenMax, Math.trunc(rawTarget)));
  }
  const activeArtifactPath = normalizeProjectFilePath(value.active_artifact_path || value.activeArtifactPath || "");
  if (activeArtifactPath) {
    options.active_artifact_path = activeArtifactPath;
  }
  return Object.keys(options).length ? options : null;
}

async function saveClientAttachments(fields, files, scope) {
  const params = new URLSearchParams();
  for (const name of ["session", "clientId", "workspacePath", "workspaceName"]) {
    const value = String(fields.get(name) || "").trim();
    if (value) params.set(name, value);
  }
  const liveSession = params.get("session")
    ? sessionFromIdForClient(params.get("session"), params.get("clientId"))
    : null;
  const session = liveSession || await workspaceTargetSessionFromRequest(params, "", scope);
  const uploadFiles = files.filter((file) => file.fieldName === "files" || file.fieldName === "file");
  if (!uploadFiles.length) {
    throw new Error("No files were uploaded");
  }
  if (uploadFiles.length > clientAttachmentMaxFiles) {
    throw new Error(`You can attach up to ${clientAttachmentMaxFiles} files at once`);
  }
  let totalBytes = 0;
  for (const file of uploadFiles) {
    const size = file.data?.length || 0;
    totalBytes += size;
    if (size <= 0) {
      throw new Error("Uploaded file is empty");
    }
    if (size > clientAttachmentMaxBytes) {
      const error = new Error("Each uploaded file must be 32MB or smaller");
      error.status = 413;
      throw error;
    }
  }
  if (totalBytes > clientAttachmentTotalMaxBytes) {
    const error = new Error("Uploaded files exceed the 80MB total limit");
    error.status = 413;
    throw error;
  }

  const bucket = safeClientUploadSegment(params.get("session") || params.get("clientId") || "pending");
  const batch = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const baseRel = `${clientAttachmentRootRel}/${bucket}/${batch}`;
  const counts = new Map();
  const attachments = [];
  for (const file of uploadFiles) {
    const safeName = safeClientAttachmentName(file.filename);
    const currentCount = counts.get(safeName) || 0;
    counts.set(safeName, currentCount + 1);
    const storedName = currentCount
      ? `${safeName.replace(/(\.[^.]*)?$/, `-${currentCount + 1}$1`)}`
      : safeName;
    const { target, rel } = workspaceRelativeTarget(session.workspace.path, `${baseRel}/${storedName}`);
    if (rel !== clientAttachmentRootRel && !rel.startsWith(`${clientAttachmentRootRel}/`)) {
      throw new Error("Attachment path must stay inside the client upload directory");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
    attachments.push({
      id: crypto.randomUUID(),
      name: safeName,
      path: rel,
      size: file.data.length,
      media_type: file.media_type || "application/octet-stream",
    });
  }
  invalidateProjectFileCache(session.workspace.path);
  return { workspace: session.workspace, attachments };
}

function visibleSubmittedUserText(line, attachments = [], attachmentRefs = []) {
  const cleanLine = String(line || "").trim();
  const text = cleanLine || (attachments.length || attachmentRefs.length ? "(파일 첨부)" : "");
  if (!attachments.length && !attachmentRefs.length) {
    return text;
  }
  const parts = [];
  if (attachments.length) {
    parts.push(`image attachments: ${attachments.length}`);
  }
  if (attachmentRefs.length) {
    const names = attachmentRefs
      .map((attachment) => attachment.name || basename(attachment.path || "file"))
      .filter(Boolean)
      .join(", ");
    parts.push(`file attachments: ${names || attachmentRefs.length}`);
  }
  const suffix = ` [${parts.join("; ")}]`;
  return text ? `${text}${suffix}` : suffix.trim();
}

function writeSseEvent(client, event, id = null) {
  client.socket?.setNoDelay?.(true);
  if (id !== null && id !== undefined) {
    client.write(`id: ${id}\n`);
  }
  client.write(`data: ${JSON.stringify(event)}\n\n`);
  client.flush?.();
}

function emit(session, event) {
  updateSessionReplayState(session.replayState, event);
  const eventId = session.nextEventId;
  session.nextEventId += 1;
  appendRawSessionEvent(session.events, eventId, event);
  for (const client of session.clients) {
    writeSseEvent(client, event, eventId);
  }
}

function isNoisyBackendLogLine(line) {
  const text = String(line || "").trim();
  return (
    /\bINFO\b\s+Processing request of type\b/.test(text)
    || /^[A-Za-z]+Request$/.test(text)
  );
}

function shouldReplayEvent(event) {
  return shouldReplayRawEvent(event);
}

function lastEventIdFromRequest(request, params) {
  return String(request.headers["last-event-id"] || params.get("lastEventId") || "").trim();
}

function killProcessTree(child) {
  if (!child || child.killed || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process already exited.
  }
}

function shutdownSession(session, reason = "shutdown") {
  if (!session || session.shuttingDown) {
    return;
  }
  session.shuttingDown = true;
  clearAiEditHeartbeat(session);
  if (session.clientCloseTimer) {
    clearTimeout(session.clientCloseTimer);
    session.clientCloseTimer = null;
  }
  sendBackend(session, { type: "shutdown", reason });
  try {
    session.process.stdin.end();
  } catch {
    // stdin may already be closed.
  }
  session.forceKillTimer = setTimeout(() => {
    killProcessTree(session.process);
  }, 1200);
  session.forceKillTimer.unref?.();
}

function shutdownAllSessions(reason = "server shutdown") {
  for (const session of sessions.values()) {
    shutdownSession(session, reason);
  }
}

function scheduleIdleClientClose(session, reason = "idle client disconnect") {
  if (!session || session.shuttingDown || session.clients.size > 0 || session.busy) {
    return;
  }
  if (session.clientCloseTimer) {
    clearTimeout(session.clientCloseTimer);
  }
  session.clientCloseTimer = setTimeout(() => {
    session.clientCloseTimer = null;
    if (!session.shuttingDown && session.clients.size === 0 && !session.busy) {
      shutdownSession(session, reason);
    }
  }, backendIdleClientCloseMs);
  session.clientCloseTimer.unref?.();
}

function cancelIdleClientClose(session) {
  if (!session?.clientCloseTimer) {
    return;
  }
  clearTimeout(session.clientCloseTimer);
  session.clientCloseTimer = null;
}

function getLanUrl() {
  if (!isWildcardListenHost(effectiveHost)) {
    return "";
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        return `http://${address.address}:${port}`;
      }
    }
  }
  return "";
}

async function createBackendSession(options = {}) {
  const id = crypto.randomUUID();
  const workspace = await resolveSessionWorkspace(options);
  const clientId = String(options.clientId || "").trim();
  const clientAddress = normalizeClientAddress(options.clientAddress || "");
  if ([...sessions.values()].filter((session) => !session.shuttingDown).length >= maxActiveSessions) {
    throw httpError(429, activeSessionLimitMessage);
  }
  if (clientId && countBusySessionsForClient(clientId) >= 3) {
    throw httpError(429, clientResponseLimitMessage);
  }
  if (countBusySessions() >= maxBusySessions) {
    throw httpError(429, serverResponseLimitMessage);
  }
  const python = backendPythonCommand();
  const args = [...python.args, "-m", "myharness", "--backend-only", "--cwd", workspace.path];
  const env = {
    ...process.env,
    PYTHONPATH: [join(repoRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  if (clientId) {
    env.MYHARNESS_WEB_CLIENT_ID = clientId;
  }

  const permissionMode = options.permissionMode || await defaultPermissionMode();
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  const subagentModel = String(options.subagentModel || options.subagent_model || "").trim();
  if (subagentModel) {
    args.push("--subagent-model", subagentModel);
  }
  const subagentEffort = String(options.subagentEffort || options.subagent_effort || "").trim();
  if (subagentEffort) {
    args.push("--subagent-effort", subagentEffort);
  }
  const activeProfile = String(options.activeProfile || options.active_profile || "").trim();
  if (activeProfile) {
    args.push("--active-profile", activeProfile);
  }
  const effort = String(options.effort || "").trim();
  if (effort) {
    args.push("--effort", effort);
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", String(options.systemPrompt));
  }

  const child = spawn(python.file, args, {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = {
    id,
    process: child,
    clients: new Set(),
    events: [],
    nextEventId: 1,
    replayState: createSessionReplayState(),
    createdAt: Date.now(),
    workspace,
    clientId,
    clientAddress,
    busy: false,
    ready: false,
    runtimePreferences: {
      activeProfile: cleanRuntimePreference(options.activeProfile || options.active_profile),
      model: cleanRuntimePreference(options.model),
      effort: normalizeRuntimeEffortValue(options.effort),
    },
    pendingSharedRuntimeChoices: [],
    savedSessionId: "",
    title: "",
    shuttingDown: false,
    clientCloseTimer: null,
    forceKillTimer: null,
    aiEditHeartbeat: null,
    aiEditHeartbeatTimer: null,
    stdoutReader: null,
    stderrReader: null,
  };
  sessions.set(id, session);

  emit(session, {
    type: "web_session",
    session_id: id,
    message: "Starting MyHarness backend...",
    workspace,
  });

  session.stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  session.stdoutReader.on("line", (line) => {
    if (!line.startsWith(protocolPrefix)) {
      if (isNoisyBackendLogLine(line)) {
        return;
      }
      emit(session, { type: "transcript_item", item: { role: "log", text: line } });
      return;
    }
    try {
      const event = JSON.parse(line.slice(protocolPrefix.length));
      stopAiEditHeartbeatForBackendEvent(session, event);
      updateSessionStateFromBackendEvent(session, event);
      emit(session, event);
    } catch (error) {
      emit(session, { type: "error", message: `Could not parse backend event: ${error.message}` });
    }
  });

  session.stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  session.stderrReader.on("line", (line) => {
    if (isNoisyBackendLogLine(line)) {
      return;
    }
    emit(session, { type: "transcript_item", item: { role: "log", text: line } });
  });

  child.on("error", (error) => {
    emit(session, { type: "error", message: `Failed to start backend: ${error.message}` });
  });

  child.on("exit", (code, signal) => {
    if (session.forceKillTimer) {
      clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
    }
    if (session.clientCloseTimer) {
      clearTimeout(session.clientCloseTimer);
      session.clientCloseTimer = null;
    }
    clearAiEditHeartbeat(session);
    session.stdoutReader?.close?.();
    session.stderrReader?.close?.();
    writeRuntimeLog("backend_session_exit", {
      session_id: id,
      code: code ?? null,
      signal: signal || "",
      workspace: session.workspace?.path || "",
      shutting_down: Boolean(session.shuttingDown),
    });
    emit(session, { type: "shutdown", code, message: `Backend exited with code ${code ?? 0}` });
    sessions.delete(id);
  });

  return session;
}

function countBusySessionsForClient(clientId) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.clientId === clientId && session.busy && !session.shuttingDown) {
      count += 1;
    }
  }
  return count;
}

function countBusySessions() {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.busy && !session.shuttingDown) {
      count += 1;
    }
  }
  return count;
}

function updateSessionStateFromBackendEvent(session, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (event.type === "ready") {
    session.ready = true;
  }
  if (event.type === "shutdown") {
    session.ready = false;
  }
  if ((event.type === "ready" || event.type === "state_snapshot") && event.state && typeof event.state === "object") {
    session.runtimePreferences = {
      activeProfile: cleanRuntimePreference(event.state.active_profile || session.runtimePreferences?.activeProfile),
      model: cleanRuntimePreference(event.state.model || session.runtimePreferences?.model),
      effort: normalizeRuntimeEffortValue(event.state.effort || session.runtimePreferences?.effort),
    };
  }
  if (event.type === "active_session") {
    session.savedSessionId = String(event.value || "").trim();
  }
  if (event.type === "session_title") {
    session.title = String(event.message ?? event.value ?? "").trim();
  }
  if (
    event.type === "status" ||
    event.type === "tool_started" ||
    event.type === "tool_input_delta" ||
    event.type === "tool_progress" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_complete"
  ) {
    session.busy = true;
    cancelIdleClientClose(session);
  }
  if (event.type === "line_complete" || event.type === "error" || event.type === "shutdown") {
    session.busy = false;
    scheduleIdleClientClose(session);
  }
  flushPendingSharedRuntimeChoices(session);
}

function liveSessionPayload(session) {
  return {
    sessionId: session.id,
    savedSessionId: session.savedSessionId || "",
    title: session.title || "",
    workspace: session.workspace,
    busy: Boolean(session.busy),
    createdAt: session.createdAt,
  };
}

const settingsAdminMessage = "Global settings can only be changed from the local MyHarness host";
const settingsApiRoutes = {
  "/api/settings/pgpt": {
    read: () => readPgptSettings(),
    write: (body) => savePgptSettings(body),
    readError: "Could not read P-GPT settings",
    writeError: "Could not save P-GPT settings",
  },
  "/api/settings/workspace-scope": {
    read: (request) => readWorkspaceScopeSettings(request),
    write: (body, request) => saveWorkspaceScopeSettings(body, request),
    readError: "Could not read workspace scope settings",
    writeError: "Could not save workspace scope settings",
  },
  "/api/settings/learned-skills": {
    read: () => readLearnedSkillsSettings(),
    write: (body) => saveLearnedSkillsSettings(body),
    readError: "Could not read learned skill settings",
    writeError: "Could not save learned skill settings",
  },
  "/api/settings/shell": {
    read: () => readShellSettings(),
    write: (body) => saveShellSettings(body),
    readError: "Could not read shell settings",
    writeError: "Could not save shell settings",
  },
  "/api/settings/yolo-mode": {
    read: () => readYoloModeSettings(),
    write: (body) => saveYoloModeSettings(body),
    readError: "Could not read Yolo mode settings",
    writeError: "Could not save Yolo mode settings",
  },
  "/api/settings/output-tokens": {
    read: () => readOutputTokenSettings(),
    write: (body) => saveOutputTokenSettings(body),
    readError: "Could not read output token settings",
    writeError: "Could not save output token settings",
  },
};

async function writeApiJsonResult(response, action, fallbackMessage, useErrorStatus = false) {
  try {
    json(response, 200, await action());
  } catch (error) {
    json(response, useErrorStatus ? error?.status || 400 : 400, { error: error?.message || fallbackMessage });
  }
}

async function handleSettingsApi(request, response, pathname) {
  const settingsRoute = settingsApiRoutes[pathname];
  if (settingsRoute && request.method === "GET") {
    await writeApiJsonResult(response, () => settingsRoute.read(request), settingsRoute.readError);
    return true;
  }

  if (settingsRoute && request.method === "POST") {
    await writeApiJsonResult(response, async () => {
      if (pathname !== "/api/settings/output-tokens") {
        requireLocalAdminRequest(request, settingsAdminMessage);
      }
      const body = await readJson(request);
      return settingsRoute.write(body, request);
    }, settingsRoute.writeError, true);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dialog/folder") {
    await writeApiJsonResult(response, async () => {
      requireLocalAdminRequest(request, "Folder picker can only be opened from the local MyHarness host");
      const body = await readJson(request);
      return openFolderDialog(body.initialPath);
    }, "Could not open folder picker", true);
    return true;
  }

  return false;
}

async function handleApi(request, response, pathname) {
  const workspaceScope = workspaceScopeFromRequest(request);
  const clientAddress = normalizeClientAddress(forwardedAddressFromRequest(request));
  if (request.method === "POST" && pathname === "/api/visit") {
    try {
      if (!consumeRecentDevRedirectVisit(request)) {
        await recordWebVisit(request);
      }
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not record visit" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/share/base-url") {
    json(response, 200, { baseUrl: publicBaseUrlForRequest(request) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/token-count") {
    try {
      const body = await readJson(request);
      const text = String(body.text || "");
      if (text.length > tokenCountMaxChars) {
        throw new Error("Text is too long to count tokens");
      }
      json(response, 200, { tokens: countTokens(text), encoding: "o200k_base" });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not count tokens" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/html-preview") {
    try {
      const body = await readJson(request);
      const id = storeChatHtmlPreview(body.content);
      json(response, 200, { id, url: `/api/html-preview/${id}` });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not create HTML preview" });
    }
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/html-preview/")) {
    pruneChatHtmlPreviews();
    const id = decodeURIComponent(pathname.slice("/api/html-preview/".length));
    const preview = chatHtmlPreviews.get(id);
    if (!preview) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("HTML preview not found");
      return true;
    }
    preview.expiresAt = Date.now() + chatHtmlPreviewTtlMs;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self' http: https: data: blob:; script-src 'self' http: https: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' http: https: 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src * data: blob:; frame-src http: https: data: blob:; worker-src blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(preview.content);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/workspaces") {
    const workspaces = await listWorkspaces(workspaceScope);
    json(response, 200, { root: workspaceScope.root, scope: workspaceScope, workspaces });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces") {
    try {
      const body = await readJson(request);
      const workspace = await ensureWorkspace(body.name, workspaceScope);
      const workspaces = await listWorkspaces(workspaceScope);
      json(response, 200, { workspace, workspaces });
    } catch (error) {
      json(response, 400, { error: error.message || "Invalid workspace" });
    }
    return true;
  }

  if (request.method === "DELETE" && pathname === "/api/workspaces") {
    try {
      const body = await readJson(request);
      const workspace = await deleteWorkspace(body.name, workspaceScope);
      const workspaces = await listWorkspaces(workspaceScope);
      json(response, 200, { deleted: workspace, workspaces });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not delete workspace" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/history") {
    try {
      const params = new URL(request.url, `http://localhost:${port}`).searchParams;
      const workspacePath = params.get("workspacePath");
      const workspaceName = params.get("workspaceName");
      const page = parseHistoryPageParams(params);
      if (workspacePath || workspaceName) {
        const workspace = workspaceFromHistoryRequest({ workspacePath, workspaceName }, workspaceScope);
        const paged = paginateHistoryItems(await listWorkspaceHistory(workspace), page);
        json(response, 200, {
          workspace,
          options: paged.options.map((item) => ({ ...item, workspace })),
          hasMore: paged.hasMore,
          nextOffset: paged.nextOffset,
        });
      } else {
        const paged = paginateHistoryItems(await listAllWorkspaceHistory(workspaceScope), page);
        json(response, 200, {
          workspace: null,
          options: paged.options,
          hasMore: paged.hasMore,
          nextOffset: paged.nextOffset,
        });
      }
    } catch (error) {
      json(response, 400, { error: error.message || "Could not list history" });
    }
    return true;
  }

  if (request.method === "DELETE" && pathname === "/api/history") {
    try {
      const body = await readJson(request);
      const workspace = workspaceFromHistoryRequest(body, workspaceScope);
      const deleted = await withWorkspaceMutation(workspace.path, () => deleteWorkspaceHistoryItem(workspace, body.sessionId));
      if (deleted) {
        detachDeletedSavedSession(workspace, body.sessionId);
      }
      json(response, deleted ? 200 : 404, { deleted, workspace });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not delete history" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/history/hide") {
    try {
      const body = await readJson(request);
      const workspace = workspaceFromHistoryRequest(body, workspaceScope);
      const hidden = await withWorkspaceMutation(workspace.path, () => hideWorkspaceHistoryItem(workspace, body.sessionId));
      json(response, 200, { hidden, workspace });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not hide history" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/history/title") {
    try {
      const body = await readJson(request);
      const workspace = workspaceFromHistoryRequest(body, workspaceScope);
      const snapshot = await withWorkspaceMutation(workspace.path, () => updateWorkspaceHistoryTitle(workspace, body.sessionId, body.title));
      json(response, 200, {
        ok: true,
        workspace,
        sessionId: snapshot.session_id || body.sessionId,
        title: snapshot.summary,
      });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not update history title" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/history/pin") {
    try {
      const body = await readJson(request);
      const workspace = workspaceFromHistoryRequest(body, workspaceScope);
      const snapshot = await withWorkspaceMutation(workspace.path, () => updateWorkspaceHistoryPin(workspace, body.sessionId, body.pinned === true));
      json(response, 200, {
        ok: true,
        workspace,
        sessionId: snapshot.session_id || body.sessionId,
        pinned: snapshot.pinned === true,
      });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not update history pin" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/session") {
    try {
      const options = await readJson(request);
      options.workspaceScope = workspaceScope;
      options.clientAddress = clientAddress;
      await applySharedRuntimePreferencesToSessionOptions(options, workspaceScope);
      const session = await createBackendSession(options);
      json(response, 200, { sessionId: session.id, workspace: session.workspace });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not start session" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/session/restart") {
    try {
      const body = await readJson(request);
      const oldSessionId = String(body.sessionId || "").trim();
      const oldSession = oldSessionId ? sessionFromIdForClient(oldSessionId, body.clientId) : null;
      const options = {
        permissionMode: body.permissionMode || await defaultPermissionMode(),
        clientId: oldSession?.clientId || String(body.clientId || "").trim(),
        clientAddress: oldSession?.clientAddress || clientAddress,
        cwd: body.cwd || oldSession?.workspace?.path,
        activeProfile: body.activeProfile || body.active_profile,
        model: body.model,
        subagentModel: body.subagentModel || body.subagent_model,
        subagentEffort: body.subagentEffort || body.subagent_effort,
        effort: body.effort,
        systemPrompt: body.systemPrompt,
        workspaceScope,
      };
      await applySharedRuntimePreferencesToSessionOptions(options, workspaceScope);
      writeRuntimeLog("backend_session_restart_requested", {
        old_session_id: oldSessionId,
        old_child_pid: oldSession?.process?.pid || null,
        workspace: body.cwd || oldSession?.workspace?.path || "",
        client_id: options.clientId,
      });
      if (oldSession) {
        shutdownSession(oldSession, "ui restart");
        killProcessTree(oldSession.process);
      }
      const session = await createBackendSession(options);
      writeRuntimeLog("backend_session_restart_created", {
        old_session_id: oldSessionId,
        new_session_id: session.id,
        new_child_pid: session.process?.pid || null,
        workspace: session.workspace?.path || "",
        client_id: session.clientId || "",
      });
      json(response, 200, {
        ok: true,
        oldSessionId,
        sessionId: session.id,
        workspace: session.workspace,
      });
    } catch (error) {
      writeRuntimeLog("backend_session_restart_failed", {
        error: errorPayload(error),
      });
      json(response, error.status || 400, { error: error.message || "Could not restart session" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/live-sessions") {
    const searchParams = new URL(request.url, `http://localhost:${port}`).searchParams;
    const clientId = searchParams.get("clientId") || "";
    const workspacePath = searchParams.get("workspacePath") || "";
    const liveSessions = [...sessions.values()]
      .filter((session) => (
        !session.shuttingDown
        && session.clientId
        && session.clientId === clientId
      ))
      .filter((session) => !workspacePath || session.workspace?.path === workspacePath)
      .map(liveSessionPayload)
      .sort((left, right) => left.createdAt - right.createdAt);
    json(response, 200, { sessions: liveSessions });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/user-stats") {
    try {
      const params = new URL(request.url, `http://localhost:${port}`).searchParams;
      const currentWorkspace = workspaceFromHistoryRequest({
        workspacePath: params.get("workspacePath"),
        workspaceName: params.get("workspaceName"),
      }, workspaceScope);
      json(response, 200, await collectUserStats(workspaceScope, currentWorkspace, params.get("clientId") || "", clientAddress));
    } catch (error) {
      json(response, 400, { error: error.message || "Could not load user stats" });
    }
    return true;
  }

  if (await handleSettingsApi(request, response, pathname)) {
    return true;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    const id = params.get("session");
    let session;
    try {
      session = sessionFromIdForClient(id, params.get("clientId"));
    } catch (error) {
      json(response, error.status || 403, { error: error.message || "Forbidden session" });
      return true;
    }
    if (!session) {
      json(response, 404, { error: "Unknown session" });
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.socket?.setNoDelay?.(true);
    response.flushHeaders?.();
    session.clients.add(response);
    cancelIdleClientClose(session);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(": heartbeat\n\n");
        response.flush?.();
      }
    }, sseHeartbeatMs);
    heartbeat.unref?.();
    const lastEventId = lastEventIdFromRequest(request, params);
    if (lastEventId && canReplayFromLastEventId(session.events, lastEventId)) {
      for (const entry of rawEventsAfterLastEventId(session.events, lastEventId)) {
        writeSseEvent(response, entry.event, entry.id);
      }
    } else {
      writeSseEvent(response, { type: "clear_transcript" });
      for (const event of replayEventsForState(session.replayState).filter(shouldReplayEvent)) {
        writeSseEvent(response, event);
      }
    }
    const cleanupClient = () => {
      clearInterval(heartbeat);
      session.clients.delete(response);
      scheduleIdleClientClose(session);
    };
    response.socket?.on("close", cleanupClient);
    response.on("error", cleanupClient);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifact") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const session = await workspaceTargetSessionFromRequest(params, params.get("path"), workspaceScope);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = await readArtifactPreview(session, params.get("path"));
      json(response, 200, payload);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not preview artifact" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifact/resolve") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const session = await workspaceTargetSessionFromRequest(params, params.get("path"), workspaceScope);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = await readArtifactMetadata(session, params.get("path"));
      json(response, 200, payload);
    } catch (error) {
      json(response, error.status || 404, { error: error.message || "Artifact not found" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/artifact") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.session) params.set("session", body.session);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = await workspaceTargetSessionFromRequest(params, body.path, workspaceScope);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = await withWorkspaceMutation(session.workspace.path, () =>
        overwriteHtmlArtifactFile(session, body.path, body.content, { expectedMtimeMs: body.expectedMtimeMs })
      );
      json(response, 200, payload);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not overwrite artifact" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/artifact/rename") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.session) params.set("session", body.session);
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = await workspaceTargetSessionFromRequest(params, body.path, workspaceScope);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = await withWorkspaceMutation(session.workspace.path, () =>
        renameArtifactFile(session, body.path, body.name, { expectedMtimeMs: body.expectedMtimeMs })
      );
      json(response, 200, payload);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not rename artifact" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/artifact/ai-edit") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.session) params.set("session", body.session);
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = sessionFromIdForClient(body.session, body.clientId)
        || await workspaceTargetSessionFromRequest(params, body.path, workspaceScope);
      if (!session?.process) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = await submitAiArtifactEdit(session, body.path, body.comments);
      json(response, 200, payload);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not submit AI edit" });
    }
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/artifact/asset/")) {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const rawAssetPath = pathname.slice("/api/artifact/asset/".length);
      const assetParts = rawAssetPath.split("/");
      const maybeToken = decodeURIComponent(assetParts.shift() || "");
      const tokenSession = artifactAssetSessionFromToken(maybeToken);
      const assetPath = tokenSession
        ? decodeURIComponent(assetParts.join("/"))
        : decodeURIComponent(rawAssetPath);
      const session = tokenSession || await workspaceTargetSessionFromRequest(params, assetPath, workspaceScope);
      const payload = await artifactAssetTarget(session, assetPath);
      response.writeHead(200, {
        "Content-Type": payload.mime,
        "Content-Length": String(payload.size),
        "Cache-Control": "no-store",
      });
      createReadStream(payload.target).pipe(response);
    } catch (error) {
      json(response, error.status || 404, { error: error.message || "Artifact asset not found" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifact/download") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const artifactPath = params.get("path");
      const session = await workspaceTargetSessionFromRequest(params, artifactPath, workspaceScope);
      const payload = await artifactDownloadTarget(session, artifactPath);
      const encodedName = encodeURIComponent(payload.name).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      );
      const fallbackName = asciiHeaderFilename(payload.name);
      const body = await readDownloadableArtifactBody(payload.target, payload.ext);
      response.writeHead(200, {
        "Content-Type": payload.mime,
        "Content-Length": String(body?.length || payload.size),
        "Content-Disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "no-store",
      });
      if (body) {
        response.end(body);
      } else {
        createReadStream(payload.target).pipe(response);
      }
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not download artifact" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifact/raw") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const artifactPath = params.get("path");
      const session = await workspaceTargetSessionFromRequest(params, artifactPath, workspaceScope);
      const payload = await artifactDownloadTarget(session, artifactPath);
      response.writeHead(200, {
        "Content-Type": payload.mime,
        "Content-Length": String(payload.size),
        "Content-Disposition": `inline; filename="${asciiHeaderFilename(payload.name)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(payload.target).pipe(response);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not open artifact" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/artifact/save-copy") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.session) params.set("session", body.session);
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = await workspaceTargetSessionFromRequest(params, body.path, workspaceScope);
      const saved = await copyArtifactToFolder(session, body.path, body.folderPath);
      json(response, 200, { saved });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not save artifact" });
    }
    return true;
  }

  if (request.method === "DELETE" && pathname === "/api/artifact") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.session) params.set("session", body.session);
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = await workspaceTargetSessionFromRequest(params, body.path, workspaceScope);
      const deleted = await withWorkspaceMutation(session.workspace.path, () =>
        deleteArtifactFile(session, body.path, { expectedMtimeMs: body.expectedMtimeMs })
      );
      json(response, 200, { deleted });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not delete artifact" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/artifact/save") {
    const body = await readJson(request);
    try {
      const session = sessionFromIdForClient(body.session, body.clientId);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const artifact = await withWorkspaceMutation(session.workspace.path, () => saveArtifactFile(session, body.path, body.content));
      json(response, 200, { artifact });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not save artifact" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifacts") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const session = sessionFromIdForClient(params.get("session"), params.get("clientId"));
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      json(response, 200, {
        workspace: session.workspace,
        files: await listProjectArtifacts(session),
      });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not list project files" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/project-files") {
    const params = new URL(request.url, `http://localhost:${port}`).searchParams;
    try {
      const session = await workspaceTargetSessionFromRequest(params, "", workspaceScope);
      const scope = params.get("scope") === "all" ? "all" : "default";
      const force = params.get("force") === "true" || params.get("force") === "1";
      json(response, 200, {
        workspace: session.workspace,
        scope,
        files: await listProjectFiles(session, { scope, force }),
      });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not list project files" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/project-files/organize") {
    try {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body.session) params.set("session", body.session);
      if (body.clientId) params.set("clientId", body.clientId);
      if (body.workspacePath) params.set("workspacePath", body.workspacePath);
      if (body.workspaceName) params.set("workspaceName", body.workspaceName);
      const session = await workspaceTargetSessionFromRequest(params, "", workspaceScope);
      const files = await withWorkspaceMutation(session.workspace.path, () =>
        organizeRootProjectFiles(session, body.paths, { expectedMtimes: body.expectedMtimes })
      );
      json(response, 200, { workspace: session.workspace, files });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not organize project files" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/client-attachments") {
    try {
      const buffer = await readRequestBuffer(request, clientAttachmentTotalMaxBytes + 1024 * 1024);
      const { fields, files } = parseMultipartFormData(buffer, request.headers["content-type"]);
      const result = await saveClientAttachments(fields, files, workspaceScope);
      json(response, 200, result);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not upload client attachments" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/message") {
    const body = await readJson(request);
    try {
      const session = sessionFromIdForClient(body.sessionId, body.clientId);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const line = String(body.line || "").trim();
      const attachments = Array.isArray(body.attachments)
        ? body.attachments.map(normalizeAttachment).filter(Boolean)
        : [];
      const rawAttachmentRefs = Array.isArray(body.attachmentRefs)
        ? body.attachmentRefs
        : Array.isArray(body.attachment_refs)
          ? body.attachment_refs
          : [];
      const attachmentRefs = rawAttachmentRefs.map(normalizeAttachmentRef).filter(Boolean);
      const composeOptions = normalizeComposeOptions(body.composeOptions || body.compose_options);
      const deliveryMode = String(body.mode || "").trim().toLowerCase();
      if (!line && attachments.length === 0 && attachmentRefs.length === 0) {
        json(response, 400, { error: "Message is empty" });
        return true;
      }
      if (session.busy) {
        if (attachments.length > 0 || attachmentRefs.length > 0) {
          json(response, 409, { error: "현재 대화가 응답 중이라 첨부파일은 보낼 수 없습니다. 답변이 끝난 뒤 다시 시도하세요." });
          return true;
        }
        const queued = deliveryMode === "queue" || deliveryMode === "queued";
        const ok = sendBackend(session, { type: queued ? "queue_line" : "steer_line", line });
        json(response, ok ? 200 : 409, { ok, queued, steering: !queued });
        return true;
      }
      if (session.clientId && countBusySessionsForClient(session.clientId) >= 3) {
        json(response, 429, { error: clientResponseLimitMessage });
        return true;
      }
      if (countBusySessions() >= maxBusySessions) {
        json(response, 429, { error: serverResponseLimitMessage });
        return true;
      }
      if (body.suppressUserTranscript === true && !line.startsWith("!")) {
        rememberSuppressedUserTranscript(session.replayState, visibleSubmittedUserText(line, attachments, attachmentRefs));
      }
      session.busy = true;
      const backendPayload = {
        type: "submit_line",
        line,
        attachments,
        attachment_refs: attachmentRefs,
        suppress_user_transcript: body.suppressUserTranscript === true,
      };
      if (composeOptions) {
        backendPayload.compose_options = composeOptions;
      }
      const ok = sendBackend(session, backendPayload);
      if (!ok) {
        session.busy = false;
      }
      json(response, ok ? 200 : 409, { ok });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not send message" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/shell") {
    try {
      const body = await readJson(request);
      const session = ownedActiveSessionFromIdForClient(
        body.sessionId,
        body.clientId,
        "Shell command requires an active session owned by this client",
      );
      const result = await runShellCommand({
        command: body.command,
        cwd: body.cwd,
        session,
        workspaceScope,
      });
      json(response, 200, result);
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not run command" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/shell/stream") {
    try {
      const body = await readJson(request);
      const session = ownedActiveSessionFromIdForClient(
        body.sessionId,
        body.clientId,
        "Shell command requires an active session owned by this client",
      );
      await streamShellCommand({
        command: body.command,
        cwd: body.cwd,
        session,
        workspaceScope,
      }, request, response);
    } catch (error) {
      if (!response.headersSent) {
        json(response, error.status || 400, { error: error.message || "Could not run command" });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/respond") {
    const body = await readJson(request);
    try {
      const session = sessionFromIdForClient(body.sessionId, body.clientId);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const payload = body.payload || {};
      if (payload?.type === "set_plugin_enabled") {
        await updatePluginPreferenceFiles(payload.value, payload.enabled, session);
      }
      if (payload?.type === "set_mcp_enabled") {
        await updateMcpPreferenceFiles(payload.value, payload.enabled, session);
      }
      const sharedRuntimeChoice = isSharedWorkspaceScope(workspaceScope)
        ? sharedRuntimeChoiceFromPayload(payload)
        : null;
      const ok = sendBackend(session, payload);
      if (ok && sharedRuntimeChoice) {
        await saveSharedRuntimeChoice(session, sharedRuntimeChoice);
        broadcastSharedRuntimeChoice(session, sharedRuntimeChoice);
      }
      json(response, ok ? 200 : 409, { ok });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not respond to session" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/cancel") {
    const body = await readJson(request);
    try {
      const session = sessionFromIdForClient(body.sessionId, body.clientId);
      if (!session) {
        json(response, 404, { error: "Unknown session" });
        return true;
      }
      const ok = sendBackend(session, { type: "cancel_current" });
      json(response, ok ? 200 : 409, { ok });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not cancel session" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/shutdown") {
    const body = await readJson(request);
    try {
      const session = sessionFromIdForClient(body.sessionId, body.clientId);
      if (session) {
        shutdownSession(session, "api shutdown");
      }
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, error.status || 400, { error: error.message || "Could not shutdown session" });
    }
    return true;
  }

  return false;
}

server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://localhost:${port}`).pathname;
  if (request.method === "GET" && isPageVisitPath(pathname)) {
    try {
      await recordWebVisit(request);
    } catch (error) {
      writeRuntimeLog("web_visit_record_failed", { error: errorPayload(error) });
    }
  }
  if (shouldRedirectDevUiRequest(request, pathname)) {
    const location = devUiRedirectLocation(request);
    if (location) {
      rememberDevRedirectVisit(request);
      response.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
  }
  if (pathname.startsWith("/api/") && (await handleApi(request, response, pathname))) {
    return;
  }
  if (pathname.startsWith("/share/") && (await handleShare(request, response, pathname))) {
    return;
  }

  const filePath = resolvePath(request.url || "/");

  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

function stopServer(signal = "shutdown") {
  writeRuntimeLog("server_stop_requested", {
    signal,
    active_sessions: sessions.size,
  });
  shutdownAllSessions(signal);
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.once("SIGINT", () => stopServer("SIGINT"));
process.once("SIGTERM", () => stopServer("SIGTERM"));
process.once("SIGHUP", () => stopServer("SIGHUP"));
process.once("uncaughtException", (error) => {
  writeRuntimeLog("server_uncaught_exception", { error: errorPayload(error), active_sessions: sessions.size });
  shutdownAllSessions("uncaught exception");
  process.exit(1);
});
process.once("unhandledRejection", (reason) => {
  writeRuntimeLog("server_unhandled_rejection", { error: errorPayload(reason), active_sessions: sessions.size });
  shutdownAllSessions("unhandled rejection");
  process.exit(1);
});
process.on("warning", (warning) => {
  writeRuntimeLog("server_warning", { warning: errorPayload(warning) });
});
process.once("exit", (code) => {
  writeRuntimeLog("server_process_exit", {
    code,
    active_sessions: sessions.size,
  });
  shutdownAllSessions("process exit");
});

if (!String(process.env.MYHARNESS_WORKSPACE_SCOPE || "").trim()) {
  const savedScopeSettings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  workspaceScopeMode = normalizeWorkspaceScopeMode(savedScopeSettings.web_workspace_scope || savedScopeSettings.workspace_scope || workspaceScopeMode);
}
if (!String(process.env.MYHARNESS_SHELL || "").trim()) {
  const savedShellSettings = await readJsonFileIfExists(join(globalConfigDir(), "settings.json")) || {};
  shellPreference = normalizeShellPreference(savedShellSettings.shell || savedShellSettings.web_shell || shellPreference);
}

let retriedLoopbackListen = false;
server.on("error", (error) => {
  if (!retriedLoopbackListen && isWildcardListenHost(effectiveHost) && error?.code === "EACCES") {
    retriedLoopbackListen = true;
    const fallbackHost = "127.0.0.1";
    writeRuntimeLog("server_listen_fallback", {
      from_host: effectiveHost,
      to_host: fallbackHost,
      port,
      error: errorPayload(error),
    });
    console.warn(`[WARN] Could not listen on ${effectiveHost}:${port}; retrying on ${fallbackHost}:${port}.`);
    effectiveHost = fallbackHost;
    setImmediate(() => server.listen(port, effectiveHost));
    return;
  }
  if (error?.code === "EADDRINUSE") {
    writeRuntimeLog("server_listen_port_in_use", {
      host: effectiveHost,
      port,
      error: errorPayload(error),
    });
    console.error(`[ERROR] Port ${port} is already in use.`);
    console.error("Edit this folder's myharness.local.env and set another PORT, for example:");
    console.error("  PORT=4274");
    process.exit(1);
  }
  throw error;
});

server.listen(port, effectiveHost, () => {
  const localUrl = `http://localhost:${port}`;
  const lanUrl = getLanUrl();
  if (isWildcardListenHost(effectiveHost)) {
    console.log(`Listening on all network interfaces.`);
  } else if (effectiveHost !== host) {
    console.log(`Listening on ${effectiveHost} after network-interface bind fallback.`);
  }
  console.log("");
  console.log("MyHarness web is ready:");
  console.log(`  ${localUrl}`);
  if (lanUrl) {
    console.log(`  ${lanUrl}`);
  }
  console.log(`Workspace scope: ${workspaceScopeMode}`);
  console.log(`Shell: ${shellPreference}`);
});
