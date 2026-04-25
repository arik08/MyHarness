import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = normalize(join(root, "../.."));
const webRoot = normalize(root);
const assetsRoot = normalize(join(repoRoot, "assets"));
const vendorRoot = normalize(join(root, "node_modules"));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const protocolPrefix = "OHJSON:";
const sessions = new Map();

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

function createBackendSession(options = {}) {
  const id = crypto.randomUUID();
  const args = ["-3", "-m", "openharness", "--backend-only", "--cwd", repoRoot];
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
  };
  sessions.set(id, session);

  emit(session, { type: "web_session", session_id: id, message: "Starting OpenHarness backend..." });

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
  if (request.method === "POST" && pathname === "/api/session") {
    const options = await readJson(request);
    const session = createBackendSession(options);
    json(response, 200, { sessionId: session.id });
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
  console.log("OpenHarness web is ready:");
  console.log(`  ${localUrl}`);
  if (lanUrl) {
    console.log(`  ${lanUrl}`);
  }
});
