import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = normalize(join(root, "../.."));
const webRoot = normalize(root);
const assetsRoot = normalize(join(repoRoot, "assets"));
const vendorRoot = normalize(join(root, "node_modules"));
const playgroundRoot = normalize(join(repoRoot, "Playground"));
const defaultWorkspaceName = "Default";
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const protocolPrefix = "OHJSON:";
const sessions = new Map();
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

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${port}`).pathname);
  const relativePath = pathname.replace(/^\/+/, "");
  const filePath =
    pathname === "/"
      ? join(root, "index.html")
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
      : relativePath.startsWith("assets/")
        ? join(repoRoot, relativePath)
        : join(root, relativePath);
  const normalized = normalize(filePath);

  if (
    normalized !== webRoot &&
    !normalized.startsWith(webRoot) &&
    !normalized.startsWith(assetsRoot) &&
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

function workspacePathFromName(name) {
  const validation = validateWorkspaceName(name);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const workspacePath = normalize(join(playgroundRoot, validation.name));
  const rel = relative(playgroundRoot, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Workspace path must stay inside Playground");
  }
  return { name: validation.name, path: workspacePath };
}

function workspaceFromDirectoryName(name) {
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
  const workspacePath = normalize(join(playgroundRoot, displayName));
  const rel = relative(playgroundRoot, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\") || rel.includes("/")) {
    throw new Error("Workspace path must stay inside Playground");
  }
  return { name: displayName, path: workspacePath };
}

function workspaceFromPath(candidate) {
  const workspacePath = normalize(String(candidate || ""));
  const rel = relative(playgroundRoot, workspacePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\") || rel.includes("/")) {
    throw new Error("Workspace cwd must be a direct Playground child");
  }
  return workspaceFromDirectoryName(rel);
}

async function ensureWorkspace(name = defaultWorkspaceName) {
  const workspace = workspacePathFromName(name);
  await mkdir(playgroundRoot, { recursive: true });
  await mkdir(workspace.path, { recursive: true });
  return workspace;
}

async function deleteWorkspace(name) {
  const workspace = workspacePathFromName(name);
  await rm(workspace.path, { recursive: true, force: true });
  return workspace;
}

async function listWorkspaces() {
  await mkdir(playgroundRoot, { recursive: true });
  const entries = await readdir(playgroundRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return workspaceFromDirectoryName(entry.name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!directories.length) {
    return [await ensureWorkspace(defaultWorkspaceName)];
  }
  return directories;
}

async function resolveSessionWorkspace(options = {}) {
  if (options.cwd) {
    const workspace = workspaceFromPath(options.cwd);
    try {
      const info = await stat(workspace.path);
      if (info.isDirectory()) {
        return workspace;
      }
    } catch {
      return ensureWorkspace(defaultWorkspaceName);
    }
    return workspace;
  }
  return ensureWorkspace(defaultWorkspaceName);
}

function sendBackend(session, payload) {
  if (!session.process || session.process.killed || session.process.stdin.destroyed) {
    return false;
  }
  session.process.stdin.write(`${JSON.stringify(payload)}\n`);
  return true;
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

function emit(session, event) {
  session.events.push(event);
  if (session.events.length > 400) {
    session.events.splice(0, session.events.length - 400);
  }
  for (const client of session.clients) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function getLanUrl() {
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
  const args = ["-3", "-m", "openharness", "--backend-only", "--cwd", workspace.path];
  const env = {
    ...process.env,
    PYTHONPATH: [join(repoRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
  };

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", String(options.systemPrompt));
  }

  const child = spawn("py", args, {
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
    createdAt: Date.now(),
    workspace,
  };
  sessions.set(id, session);

  emit(session, {
    type: "web_session",
    session_id: id,
    message: "Starting MyHarness backend...",
    workspace,
  });

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith(protocolPrefix)) {
      emit(session, { type: "transcript_item", item: { role: "log", text: line } });
      return;
    }
    try {
      emit(session, JSON.parse(line.slice(protocolPrefix.length)));
    } catch (error) {
      emit(session, { type: "error", message: `Could not parse backend event: ${error.message}` });
    }
  });

  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    emit(session, { type: "transcript_item", item: { role: "log", text: line } });
  });

  child.on("error", (error) => {
    emit(session, { type: "error", message: `Failed to start backend: ${error.message}` });
  });

  child.on("exit", (code) => {
    emit(session, { type: "shutdown", code, message: `Backend exited with code ${code ?? 0}` });
    sessions.delete(id);
  });

  return session;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/workspaces") {
    const workspaces = await listWorkspaces();
    json(response, 200, { root: playgroundRoot, workspaces });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces") {
    try {
      const body = await readJson(request);
      const workspace = await ensureWorkspace(body.name);
      const workspaces = await listWorkspaces();
      json(response, 200, { workspace, workspaces });
    } catch (error) {
      json(response, 400, { error: error.message || "Invalid workspace" });
    }
    return true;
  }

  if (request.method === "DELETE" && pathname === "/api/workspaces") {
    try {
      const body = await readJson(request);
      const workspace = await deleteWorkspace(body.name);
      const workspaces = await listWorkspaces();
      json(response, 200, { deleted: workspace, workspaces });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not delete workspace" });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/session") {
    try {
      const options = await readJson(request);
      const session = await createBackendSession(options);
      json(response, 200, { sessionId: session.id, workspace: session.workspace });
    } catch (error) {
      json(response, 400, { error: error.message || "Could not start session" });
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    const id = new URL(request.url, `http://localhost:${port}`).searchParams.get("session");
    const session = sessions.get(id);
    if (!session) {
      json(response, 404, { error: "Unknown session" });
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    session.clients.add(response);
    for (const event of session.events) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    request.on("close", () => {
      session.clients.delete(response);
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/message") {
    const body = await readJson(request);
    const session = sessions.get(body.sessionId);
    if (!session) {
      json(response, 404, { error: "Unknown session" });
      return true;
    }
    const line = String(body.line || "").trim();
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.map(normalizeAttachment).filter(Boolean)
      : [];
    if (!line && attachments.length === 0) {
      json(response, 400, { error: "Message is empty" });
      return true;
    }
    const ok = sendBackend(session, { type: "submit_line", line, attachments });
    json(response, ok ? 200 : 409, { ok });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/respond") {
    const body = await readJson(request);
    const session = sessions.get(body.sessionId);
    if (!session) {
      json(response, 404, { error: "Unknown session" });
      return true;
    }
    const ok = sendBackend(session, body.payload || {});
    json(response, ok ? 200 : 409, { ok });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/shutdown") {
    const body = await readJson(request);
    const session = sessions.get(body.sessionId);
    if (session) {
      sendBackend(session, { type: "shutdown" });
      session.process.kill();
    }
    json(response, 200, { ok: true });
    return true;
  }

  return false;
}

createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://localhost:${port}`).pathname;
  if (pathname.startsWith("/api/") && (await handleApi(request, response, pathname))) {
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
}).listen(port, host, () => {
  const localUrl = `http://localhost:${port}`;
  const lanUrl = getLanUrl();
  if (host === "0.0.0.0" || host === "::") {
    console.log(`Listening on all network interfaces.`);
  }
  console.log("");
  console.log("MyHarness web is ready:");
  console.log(`  ${localUrl}`);
  if (lanUrl) {
    console.log(`  ${lanUrl}`);
  }
});
