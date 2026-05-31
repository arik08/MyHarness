import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSseEvent(url, predicate, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ timeout: true })),
      ]);
      if (result.timeout) {
        break;
      }
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart());
        if (!dataLines.length) {
          continue;
        }
        const event = JSON.parse(dataLines.join("\n"));
        if (predicate(event)) {
          return event;
        }
      }
    }
    throw new Error(`Timed out waiting for SSE event from ${url}`);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

async function waitForSessionClosed(baseUrl, clientId, sessionId, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/live-sessions?clientId=${encodeURIComponent(clientId)}`);
    const payload = await response.json();
    if (!payload.sessions?.some((session) => session.sessionId === sessionId)) {
      return;
    }
    await sleep(100);
  }
}

async function rmWithRetry(path, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, options);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") {
        throw error;
      }
      await sleep(200);
    }
  }
  throw lastError;
}

async function requestWithHost(baseUrl, path, host) {
  const url = new URL(path, baseUrl);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function openPort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const probe = createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
      return port;
    } catch {
      if (probe.listening) {
        await new Promise((resolve) => probe.close(resolve));
      }
    }
  }
  throw new Error("Could not find an open test port");
}

async function startWebServer({ host = "127.0.0.1", env = {} } = {}) {
  const port = await openPort();
  const configDir = await mkdtemp(join(tmpdir(), "myharness-web-security-"));
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    MYHARNESS_CONFIG_DIR: configDir,
    MYHARNESS_DATA_DIR: join(configDir, "data"),
    MYHARNESS_LOGS_DIR: join(configDir, "logs"),
    MYHARNESS_HOME: configDir,
    ...env,
  };

  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  const waitForReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for server startup:\n${output.join("")}`));
    }, 15_000);

    function onData(chunk) {
      const text = chunk.toString();
      output.push(text);
      if (text.includes("MyHarness web is ready")) {
        clearTimeout(timeout);
        resolve();
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup with code ${code}:\n${output.join("")}`));
    });
  });

  await waitForReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    configDir,
    port,
    output,
    async stop() {
      if (!child.killed) {
        child.kill();
      }
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 2_000);
      });
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

test("rejects shell command requests without an owned active session", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/shell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "echo should-not-run" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.error, /active session/i);
});

test("explains session limits as multi-user busy state", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared", MYHARNESS_MAX_ACTIVE_SESSIONS: "1" },
  });
  t.after(() => app.stop());

  const firstResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "limit-a" }),
  });
  assert.equal(firstResponse.status, 200);

  const secondResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "limit-b" }),
  });
  const secondPayload = await secondResponse.json();

  assert.equal(secondResponse.status, 429);
  assert.match(secondPayload.error, /여러 명이 동시에 사용 중/);
});

test("shares main runtime choices across shared workspace sessions", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  t.after(() => app.stop());

  async function createRuntimeSession(clientId, overrides = {}) {
    const response = await fetch(`${app.baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        activeProfile: "p-gpt",
        model: "gpt-5.5",
        effort: "low",
        ...overrides,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(payload.sessionId);
    const ready = await waitForSseEvent(
      `${app.baseUrl}/api/events?session=${payload.sessionId}&clientId=${encodeURIComponent(clientId)}`,
      (event) => event.type === "ready" && event.state?.model,
      { timeoutMs: 20_000 },
    );
    return { sessionId: payload.sessionId, ready };
  }

  const admin = await createRuntimeSession("runtime-admin");
  const peer = await createRuntimeSession("runtime-peer");

  const peerProviderUpdate = waitForSseEvent(
    `${app.baseUrl}/api/events?session=${peer.sessionId}&clientId=runtime-peer`,
    (event) => event.type === "state_snapshot" && event.state?.active_profile === "openai-compatible",
    { timeoutMs: 10_000 },
  );
  const providerResponse = await fetch(`${app.baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: admin.sessionId,
      clientId: "runtime-admin",
      payload: { type: "apply_select_command", command: "provider", value: "openai-compatible" },
    }),
  });
  assert.equal(providerResponse.status, 200);
  await peerProviderUpdate;

  const peerModelUpdate = waitForSseEvent(
    `${app.baseUrl}/api/events?session=${peer.sessionId}&clientId=runtime-peer`,
    (event) => event.type === "state_snapshot" && event.state?.model === "gpt-5.4-mini",
    { timeoutMs: 10_000 },
  );
  const modelResponse = await fetch(`${app.baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: admin.sessionId,
      clientId: "runtime-admin",
      payload: { type: "apply_select_command", command: "model", value: "gpt-5.4-mini" },
    }),
  });
  assert.equal(modelResponse.status, 200);
  await peerModelUpdate;

  const peerEffortUpdate = waitForSseEvent(
    `${app.baseUrl}/api/events?session=${peer.sessionId}&clientId=runtime-peer`,
    (event) => event.type === "state_snapshot" && event.state?.effort === "high",
    { timeoutMs: 10_000 },
  );
  const effortResponse = await fetch(`${app.baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: admin.sessionId,
      clientId: "runtime-admin",
      payload: { type: "apply_select_command", command: "effort", value: "high" },
    }),
  });
  assert.equal(effortResponse.status, 200);
  await peerEffortUpdate;

  const settings = JSON.parse(await readFile(join(app.configDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.web_shared_runtime_preferences, {
    version: 1,
    active_profile: "openai-compatible",
    model: "gpt-5.4-mini",
    effort: "high",
  });

  const newcomer = await createRuntimeSession("runtime-newcomer", {
    model: "gpt-5.5",
    effort: "low",
  });
  assert.equal(newcomer.ready.state.active_profile, "openai-compatible");
  assert.equal(newcomer.ready.state.model, "gpt-5.4-mini");
  assert.equal(newcomer.ready.state.effort, "high");
});

test("keeps main runtime choices client-scoped for ip workspace sessions", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const createdResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "runtime-ip", activeProfile: "p-gpt", model: "gpt-5.5" }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);
  assert.ok(created.sessionId);

  const modelResponse = await fetch(`${app.baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: created.sessionId,
      clientId: "runtime-ip",
      payload: { type: "apply_select_command", command: "model", value: "gpt-5.4-mini" },
    }),
  });
  assert.equal(modelResponse.status, 200);

  const settings = JSON.parse(await readFile(join(app.configDir, "settings.json"), "utf8").catch(() => "{}"));
  assert.equal(settings.web_shared_runtime_preferences, undefined);
});

test("uploads client attachments as sanitized workspace-relative copies", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `ClientUpload${Date.now().toString(36)}` }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  const form = new FormData();
  form.set("clientId", "client-upload-test");
  form.set("workspacePath", workspacePath);
  form.append("files", new Blob(["hello from client"], { type: "text/plain" }), "../unsafe:name.txt");

  const response = await fetch(`${app.baseUrl}/api/client-attachments`, {
    method: "POST",
    body: form,
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  const attachment = payload.attachments?.[0];
  assert.ok(attachment);
  assert.equal(attachment.name, "unsafe_name.txt");
  assert.match(attachment.path, /^\.myharness\/client-uploads\//);
  assert.equal(attachment.path.includes(".."), false);
  assert.equal(/[<>:"\\|?*]/.test(attachment.path), false);
  assert.equal(await readFile(join(workspacePath, attachment.path), "utf8"), "hello from client");
});

test("overwrites only HTML artifacts through the preview edit API", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  let alternateWorkspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
    if (alternateWorkspacePath) {
      await rm(alternateWorkspacePath, { recursive: true, force: true });
    }
  });

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `PreviewEdit${Date.now().toString(36)}` }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  const htmlPath = join(workspacePath, "outputs", "report.html");
  const textPath = join(workspacePath, "outputs", "notes.txt");
  const pdfPath = join(workspacePath, "outputs", "review.pdf");
  await writeFile(htmlPath, "<!doctype html><html><body><h1>Old</h1></body></html>", "utf8");
  await writeFile(textPath, "Old", "utf8");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n% MyHarness PDF smoke\n", "utf8"));

  const sessionResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "preview-editor", cwd: workspacePath }),
  });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  assert.ok(session.sessionId);

  const alternateWorkspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `PreviewEditAlt${Date.now().toString(36)}` }),
  });
  const alternateWorkspacePayload = await alternateWorkspaceResponse.json();
  assert.equal(alternateWorkspaceResponse.status, 200);
  alternateWorkspacePath = alternateWorkspacePayload.workspace?.path || "";
  assert.ok(alternateWorkspacePath);
  await mkdir(join(alternateWorkspacePath, "outputs"), { recursive: true });
  const alternateHtmlPath = join(alternateWorkspacePath, "outputs", "other.html");
  await writeFile(alternateHtmlPath, "<!doctype html><html><body><h1>Other Old</h1></body></html>", "utf8");

  const historyParams = new URLSearchParams({
    session: session.sessionId,
    clientId: "preview-editor",
    workspacePath: alternateWorkspacePath,
    path: "outputs/other.html",
  });
  const historyResolveResponse = await fetch(`${app.baseUrl}/api/artifact/resolve?${historyParams.toString()}`);
  const historyResolvePayload = await historyResolveResponse.json();
  assert.equal(historyResolveResponse.status, 200);
  assert.equal(historyResolvePayload.path, "outputs/other.html");

  const historyReadResponse = await fetch(`${app.baseUrl}/api/artifact?${historyParams.toString()}`);
  const historyReadPayload = await historyReadResponse.json();
  assert.equal(historyReadResponse.status, 200);
  assert.equal(historyReadPayload.content, "<!doctype html><html><body><h1>Other Old</h1></body></html>");

  const historyFilesResponse = await fetch(
    `${app.baseUrl}/api/project-files?${new URLSearchParams({
      session: session.sessionId,
      clientId: "preview-editor",
      workspacePath: alternateWorkspacePath,
      scope: "all",
    }).toString()}`,
  );
  const historyFilesPayload = await historyFilesResponse.json();
  assert.equal(historyFilesResponse.status, 200);
  assert.ok(historyFilesPayload.files.some((file) => file.path === "outputs/other.html"));

  const overwriteResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      path: "outputs/report.html",
      content: "<!doctype html><html><body><h1>New</h1></body></html>",
    }),
  });
  const overwritePayload = await overwriteResponse.json();
  assert.equal(overwriteResponse.status, 200);
  assert.equal(overwritePayload.artifact.path, "outputs/report.html");
  assert.equal(overwritePayload.payload.content, "<!doctype html><html><body><h1>New</h1></body></html>");
  assert.equal(await readFile(htmlPath, "utf8"), "<!doctype html><html><body><h1>New</h1></body></html>");

  const alternateOverwriteResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      workspacePath: alternateWorkspacePath,
      path: "outputs/other.html",
      content: "<!doctype html><html><body><h1>Other New</h1></body></html>",
    }),
  });
  const alternateOverwritePayload = await alternateOverwriteResponse.json();
  assert.equal(alternateOverwriteResponse.status, 200);
  assert.equal(alternateOverwritePayload.artifact.path, "outputs/other.html");
  assert.equal(await readFile(alternateHtmlPath, "utf8"), "<!doctype html><html><body><h1>Other New</h1></body></html>");

  const searchOverwriteResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "preview-editor",
      path: "outputs/other.html",
      content: "<!doctype html><html><body><h1>Other Search Saved</h1></body></html>",
    }),
  });
  const searchOverwritePayload = await searchOverwriteResponse.json();
  assert.equal(searchOverwriteResponse.status, 200);
  assert.equal(searchOverwritePayload.artifact.path, "outputs/other.html");
  assert.equal(await readFile(alternateHtmlPath, "utf8"), "<!doctype html><html><body><h1>Other Search Saved</h1></body></html>");

  const livePreviewSaveResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      workspacePath,
      path: "outputs/live-preview-only.html",
      content: "<!doctype html><html><body><h1>Live Saved</h1></body></html>",
    }),
  });
  const livePreviewSavePayload = await livePreviewSaveResponse.json();
  assert.equal(livePreviewSaveResponse.status, 200);
  assert.equal(livePreviewSavePayload.artifact.path, "outputs/live-preview-only.html");
  assert.equal(
    await readFile(join(workspacePath, "outputs", "live-preview-only.html"), "utf8"),
    "<!doctype html><html><body><h1>Live Saved</h1></body></html>",
  );

  const saveCopyResponse = await fetch(`${app.baseUrl}/api/artifact/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      path: "outputs/report.html",
      content: "<!doctype html><html><body><h1>Copy</h1></body></html>",
    }),
  });
  const saveCopyPayload = await saveCopyResponse.json();
  assert.equal(saveCopyResponse.status, 200);
  assert.equal(saveCopyPayload.artifact.path, "outputs/report-2.html");
  assert.equal(await readFile(htmlPath, "utf8"), "<!doctype html><html><body><h1>New</h1></body></html>");

  const textResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      path: "outputs/notes.txt",
      content: "New",
    }),
  });
  const textPayload = await textResponse.json();
  assert.equal(textResponse.status, 400);
  assert.match(textPayload.error, /Only HTML artifacts/i);
  assert.equal(await readFile(textPath, "utf8"), "Old");

  const pdfParams = new URLSearchParams({
    session: session.sessionId,
    clientId: "preview-editor",
    path: "outputs/review.pdf",
  });
  const pdfPreviewResponse = await fetch(`${app.baseUrl}/api/artifact?${pdfParams.toString()}`);
  const pdfPreviewPayload = await pdfPreviewResponse.json();
  assert.equal(pdfPreviewResponse.status, 200);
  assert.equal(pdfPreviewPayload.kind, "pdf");
  assert.equal(pdfPreviewPayload.mime, "application/pdf");
  assert.equal(pdfPreviewPayload.dataUrl, undefined);

  const pdfRawResponse = await fetch(`${app.baseUrl}/api/artifact/raw?${pdfParams.toString()}`);
  assert.equal(pdfRawResponse.status, 200);
  assert.equal(pdfRawResponse.headers.get("content-type"), "application/pdf");
  assert.match(pdfRawResponse.headers.get("content-disposition") || "", /^inline;/);
  assert.equal(await pdfRawResponse.text(), "%PDF-1.4\n% MyHarness PDF smoke\n");

  const outsideResponse = await fetch(`${app.baseUrl}/api/artifact`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "preview-editor",
      path: "../escape.html",
      content: "<html></html>",
    }),
  });
  const outsidePayload = await outsideResponse.json();
  assert.equal(outsideResponse.status, 400);
  assert.match(outsidePayload.error, /inside the current project/i);
});

test("enhances downloaded Mermaid HTML artifacts with zoom controls", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  let downloadDir = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rmWithRetry(workspacePath, { recursive: true, force: true });
    }
    if (downloadDir) {
      await rmWithRetry(downloadDir, { recursive: true, force: true });
    }
  });

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `MermaidDownload${Date.now().toString(36)}` }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  const html = [
    "<!doctype html><html><body>",
    "<h1>Workflow</h1>",
    '<div class="mermaid"><svg id="mermaid-test" viewBox="0 0 100 40"><rect width="100" height="40"></rect></svg></div>',
    "</body></html>",
  ].join("");
  const rawMermaidHtml = [
    "<!doctype html><html><body>",
    "<h1>Raw workflow</h1>",
    '<pre><code class="language-mermaid">flowchart LR',
    "A --> B",
    "</code></pre>",
    "</body></html>",
  ].join("\n");
  const dataMermaidHtml = [
    "<!doctype html><html><body>",
    "<h1>Manual workflow</h1>",
    '<div data-mermaid="flowchart LR"><svg id="manual-flow" viewBox="0 0 100 40"><rect width="100" height="40"></rect></svg></div>',
    "</body></html>",
  ].join("");
  await writeFile(join(workspacePath, "outputs", "workflow.html"), html, "utf8");
  await writeFile(join(workspacePath, "outputs", "raw-workflow.html"), rawMermaidHtml, "utf8");
  await writeFile(join(workspacePath, "outputs", "data-workflow.html"), dataMermaidHtml, "utf8");
  await writeFile(join(workspacePath, "outputs", "plain.html"), "<!doctype html><html><body><h1>Plain</h1></body></html>", "utf8");

  const mermaidParams = new URLSearchParams({
    workspacePath,
    path: "outputs/workflow.html",
  });
  const downloadResponse = await fetch(`${app.baseUrl}/api/artifact/download?${mermaidParams.toString()}`);
  const downloaded = await downloadResponse.text();
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-disposition") || "", /workflow\.html/);
  assert.match(downloaded, /data-myharness-mermaid-zoom-script/);
  assert.match(downloaded, /myharness-mermaid-expand-button/);
  assert.match(downloaded, /Mermaid 다이어그램 크게 보기/);
  assert.doesNotMatch(downloaded, /data-myharness-mermaid-renderer-script/);
  assert.doesNotMatch(downloaded, /mermaid@11\.14\.0/);
  assert.doesNotMatch(downloaded, /renderRawMermaidBlocks/);
  assert.doesNotMatch(downloaded, /화면에 맞춤/);

  const rawMermaidParams = new URLSearchParams({
    workspacePath,
    path: "outputs/raw-workflow.html",
  });
  const rawDownloadResponse = await fetch(`${app.baseUrl}/api/artifact/download?${rawMermaidParams.toString()}`);
  const rawDownloaded = await rawDownloadResponse.text();
  assert.equal(rawDownloadResponse.status, 200);
  assert.match(rawDownloaded, /data-myharness-mermaid-renderer-script/);
  assert.match(rawDownloaded, /data-myharness-mermaid-renderer-init/);
  assert.match(rawDownloaded, /data-myharness-mermaid-zoom-script/);
  assert.doesNotMatch(rawDownloaded, /"\\\\<\/body>"/);

  const dataMermaidParams = new URLSearchParams({
    workspacePath,
    path: "outputs/data-workflow.html",
  });
  const dataMermaidDownloadResponse = await fetch(`${app.baseUrl}/api/artifact/download?${dataMermaidParams.toString()}`);
  const dataMermaidDownloaded = await dataMermaidDownloadResponse.text();
  assert.equal(dataMermaidDownloadResponse.status, 200);
  assert.match(dataMermaidDownloaded, /data-myharness-mermaid-zoom-script/);
  assert.match(dataMermaidDownloaded, /\[data-mermaid\] svg/);

  const plainParams = new URLSearchParams({
    workspacePath,
    path: "outputs/plain.html",
  });
  const plainResponse = await fetch(`${app.baseUrl}/api/artifact/download?${plainParams.toString()}`);
  const plainDownloaded = await plainResponse.text();
  assert.equal(plainResponse.status, 200);
  assert.doesNotMatch(plainDownloaded, /data-myharness-mermaid-zoom-script/);

  const rawResponse = await fetch(`${app.baseUrl}/share/artifact/raw?${mermaidParams.toString()}`);
  const rawHtml = await rawResponse.text();
  assert.equal(rawResponse.status, 200);
  assert.match(rawHtml, /data-myharness-mermaid-zoom-script/);
  assert.match(rawHtml, /myharness-mermaid-expand-button/);
  assert.match(rawHtml, /Mermaid 다이어그램 크게 보기/);

  const sharedRawResponse = await fetch(`${app.baseUrl}/share/artifact/raw?${rawMermaidParams.toString()}`);
  const sharedRawHtml = await sharedRawResponse.text();
  assert.equal(sharedRawResponse.status, 200);
  assert.match(sharedRawHtml, /data-myharness-mermaid-renderer-script/);
  assert.match(sharedRawHtml, /data-myharness-mermaid-zoom-script/);

  downloadDir = await mkdtemp(join(tmpdir(), "myharness-mermaid-download-"));
  const saveCopyResponse = await fetch(`${app.baseUrl}/api/artifact/save-copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      path: "outputs/workflow.html",
      folderPath: downloadDir,
    }),
  });
  const saveCopyPayload = await saveCopyResponse.json();
  assert.equal(saveCopyResponse.status, 200);
  assert.equal(saveCopyPayload.saved.name, "workflow.html");
  const savedHtml = await readFile(join(downloadDir, "workflow.html"), "utf8");
  assert.match(savedHtml, /data-myharness-mermaid-zoom-script/);
  assert.match(savedHtml, /myharness-mermaid-expand-button/);
  assert.doesNotMatch(savedHtml, /renderRawMermaidBlocks/);

  const saveRawCopyResponse = await fetch(`${app.baseUrl}/api/artifact/save-copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      path: "outputs/raw-workflow.html",
      folderPath: downloadDir,
    }),
  });
  const saveRawCopyPayload = await saveRawCopyResponse.json();
  assert.equal(saveRawCopyResponse.status, 200);
  assert.equal(saveRawCopyPayload.saved.name, "raw-workflow.html");
  const savedRawHtml = await readFile(join(downloadDir, "raw-workflow.html"), "utf8");
  assert.match(savedRawHtml, /data-myharness-mermaid-renderer-script/);
  assert.match(savedRawHtml, /data-myharness-mermaid-zoom-script/);
});

test("serves shared artifact links read-only from workspace-relative paths", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rmWithRetry(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceName = `ShareLinks${Date.now().toString(36)}`;
  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  await writeFile(join(workspacePath, "outputs", "report.html"), "<!doctype html><html><head></head><body>Shared HTML</body></html>", "utf8");
  await writeFile(join(workspacePath, "outputs", "notes.md"), "# Shared Notes\n<script>blocked</script>", "utf8");
  await writeFile(join(workspacePath, "outputs", "report.pdf"), "%PDF-1.4\n", "utf8");

  const htmlParams = new URLSearchParams({ workspace: workspaceName, path: "outputs/report.html" });
  const shellResponse = await fetch(`${app.baseUrl}/share/artifact?${htmlParams.toString()}`);
  const shell = await shellResponse.text();
  assert.equal(shellResponse.status, 200);
  assert.match(shell, /<iframe[^>]+\/share\/artifact\/raw\?/);
  assert.match(shell, /data-action="toggle-source"/);
  assert.match(shell, /data-action="copy-source"/);
  assert.match(shell, /\/share\/artifact\/download\?/);
  assert.match(shell, /report\.html/);
  assert.doesNotMatch(shell, /<small>html<\/small>/);

  const rawHtmlResponse = await fetch(`${app.baseUrl}/share/artifact/raw?${htmlParams.toString()}`);
  const rawHtml = await rawHtmlResponse.text();
  assert.equal(rawHtmlResponse.status, 200);
  assert.match(rawHtmlResponse.headers.get("content-type") || "", /text\/html/);
  assert.match(rawHtml, /<base href="\/api\/artifact\/asset\//);
  assert.match(rawHtml, /Shared HTML/);

  const sourceHtmlResponse = await fetch(`${app.baseUrl}/share/artifact/source?${htmlParams.toString()}`);
  const sourceHtml = await sourceHtmlResponse.text();
  assert.equal(sourceHtmlResponse.status, 200);
  assert.match(sourceHtmlResponse.headers.get("content-type") || "", /text\/plain/);
  assert.match(sourceHtml, /Shared HTML/);
  assert.doesNotMatch(sourceHtml, /<base href=/);

  const downloadHtmlResponse = await fetch(`${app.baseUrl}/share/artifact/download?${htmlParams.toString()}`);
  const downloadHtml = await downloadHtmlResponse.text();
  assert.equal(downloadHtmlResponse.status, 200);
  assert.match(downloadHtmlResponse.headers.get("content-disposition") || "", /attachment/);
  assert.match(downloadHtmlResponse.headers.get("content-disposition") || "", /report\.html/);
  assert.match(downloadHtml, /Shared HTML/);

  const textParams = new URLSearchParams({ workspace: workspaceName, path: "outputs/notes.md" });
  const textResponse = await fetch(`${app.baseUrl}/share/artifact?${textParams.toString()}`);
  const textShell = await textResponse.text();
  assert.equal(textResponse.status, 200);
  assert.match(textShell, /# Shared Notes/);
  assert.match(textShell, /&lt;script&gt;blocked&lt;\/script&gt;/);

  const pdfParams = new URLSearchParams({ workspace: workspaceName, path: "outputs/report.pdf" });
  const rawPdfResponse = await fetch(`${app.baseUrl}/share/artifact/raw?${pdfParams.toString()}`);
  assert.equal(rawPdfResponse.status, 200);
  assert.match(rawPdfResponse.headers.get("content-type") || "", /application\/pdf/);

  const outsideParams = new URLSearchParams({ workspace: workspaceName, path: "../outside.html" });
  const outsideResponse = await fetch(`${app.baseUrl}/share/artifact?${outsideParams.toString()}`);
  assert.equal(outsideResponse.status, 400);
  assert.match(await outsideResponse.text(), /inside the current project/i);
});

test("renames artifacts and keeps old history links resolvable", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rmWithRetry(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `RenameArtifact${Date.now().toString(36)}` }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  const oldHtmlPath = join(workspacePath, "outputs", "report.html");
  const renamedHtmlPath = join(workspacePath, "outputs", "renamed-report.html");
  const finalHtmlPath = join(workspacePath, "outputs", "final-report.html");
  await writeFile(oldHtmlPath, "<!doctype html><html><body><h1>Old Link</h1></body></html>", "utf8");

  const sessionResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "artifact-rename", cwd: workspacePath }),
  });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);

  const renameResponse = await fetch(`${app.baseUrl}/api/artifact/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "artifact-rename",
      path: "outputs/report.html",
      name: "renamed-report.html",
    }),
  });
  const renamePayload = await renameResponse.json();
  assert.equal(renameResponse.status, 200);
  assert.equal(renamePayload.artifact.path, "outputs/renamed-report.html");
  assert.equal(await readFile(renamedHtmlPath, "utf8"), "<!doctype html><html><body><h1>Old Link</h1></body></html>");
  await assert.rejects(() => readFile(oldHtmlPath, "utf8"), /ENOENT/);

  const oldLinkParams = new URLSearchParams({
    session: session.sessionId,
    clientId: "artifact-rename",
    path: "outputs/report.html",
  });
  const oldResolveResponse = await fetch(`${app.baseUrl}/api/artifact/resolve?${oldLinkParams.toString()}`);
  const oldResolvePayload = await oldResolveResponse.json();
  assert.equal(oldResolveResponse.status, 200);
  assert.equal(oldResolvePayload.path, "outputs/renamed-report.html");

  const oldReadResponse = await fetch(`${app.baseUrl}/api/artifact?${oldLinkParams.toString()}`);
  const oldReadPayload = await oldReadResponse.json();
  assert.equal(oldReadResponse.status, 200);
  assert.equal(oldReadPayload.path, "outputs/renamed-report.html");
  assert.equal(oldReadPayload.content, "<!doctype html><html><body><h1>Old Link</h1></body></html>");

  const secondRenameResponse = await fetch(`${app.baseUrl}/api/artifact/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "artifact-rename",
      path: "outputs/renamed-report.html",
      name: "final-report.html",
    }),
  });
  const secondRenamePayload = await secondRenameResponse.json();
  assert.equal(secondRenameResponse.status, 200);
  assert.equal(secondRenamePayload.artifact.path, "outputs/final-report.html");
  assert.equal(await readFile(finalHtmlPath, "utf8"), "<!doctype html><html><body><h1>Old Link</h1></body></html>");

  const oldResolveAfterSecondResponse = await fetch(`${app.baseUrl}/api/artifact/resolve?${oldLinkParams.toString()}`);
  const oldResolveAfterSecondPayload = await oldResolveAfterSecondResponse.json();
  assert.equal(oldResolveAfterSecondResponse.status, 200);
  assert.equal(oldResolveAfterSecondPayload.path, "outputs/final-report.html");

  const extensionChangeResponse = await fetch(`${app.baseUrl}/api/artifact/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "artifact-rename",
      path: "outputs/final-report.html",
      name: "final-report.md",
    }),
  });
  const extensionChangePayload = await extensionChangeResponse.json();
  assert.equal(extensionChangeResponse.status, 400);
  assert.match(extensionChangePayload.error, /extension/i);
});

test("submits AI artifact edits with the next version target path", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `AiEditArtifact${Date.now().toString(36)}` }),
  });
  const workspacePayload = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  workspacePath = workspacePayload.workspace?.path || "";
  assert.ok(workspacePath);

  await mkdir(join(workspacePath, "outputs"), { recursive: true });
  await writeFile(join(workspacePath, "outputs", "report.html"), "<!doctype html><html><body><h1>Old</h1></body></html>", "utf8");
  await writeFile(join(workspacePath, "outputs", "report v1.html"), "<!doctype html><html><body><h1>Version 1</h1></body></html>", "utf8");

  const sessionResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "artifact-ai-edit", cwd: workspacePath }),
  });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  assert.ok(session.sessionId);
  const transcriptPromise = waitForSseEvent(
    `${app.baseUrl}/api/events?session=${session.sessionId}&clientId=artifact-ai-edit`,
    (event) => event.type === "transcript_item"
      && event.item?.role === "user"
      && String(event.item?.text || "").includes("outputs/report.html"),
  );
  const aiEditHeartbeatPromise = waitForSseEvent(
    `${app.baseUrl}/api/events?session=${session.sessionId}&clientId=artifact-ai-edit`,
    (event) => event.type === "status"
      && event.quiet === true
      && String(event.message || "").includes("AI 자동편집")
      && String(event.message || "").includes("outputs/report_v2.html"),
  );

  const invalidResponse = await fetch(`${app.baseUrl}/api/artifact/ai-edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "artifact-ai-edit",
      path: "outputs/report.html",
      comments: [],
    }),
  });
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400);
  assert.match(invalidPayload.error, /comment/i);

  const editResponse = await fetch(`${app.baseUrl}/api/artifact/ai-edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.sessionId,
      clientId: "artifact-ai-edit",
      path: "outputs/report.html",
      comments: [
        {
          text: "Old",
          start: 0,
          end: 3,
          before: "",
          after: "",
          instruction: "Make the heading more current",
        },
        {
          comment: "Make the whole document more executive-ready",
        },
      ],
    }),
  });
  const editPayload = await editResponse.json();
  assert.equal(editResponse.status, 200);
  assert.equal(editPayload.sourcePath, "outputs/report.html");
  assert.equal(editPayload.targetPath, "outputs/report_v2.html");
  const copiedTarget = await readFile(join(workspacePath, "outputs", "report_v2.html"), "utf8");
  assert.equal(copiedTarget, "<!doctype html><html><body><h1>Old</h1></body></html>");
  const heartbeatEvent = await aiEditHeartbeatPromise;
  assert.match(heartbeatEvent.message, /0초 경과|1초 경과/);
  const transcriptEvent = await transcriptPromise;
  assert.match(transcriptEvent.item.text, /AI/);
  assert.match(transcriptEvent.item.text, /outputs\/report\.html/);
  assert.match(transcriptEvent.item.text, /outputs\/report_v2\.html/);
  assert.match(transcriptEvent.item.text, /Make the whole document more executive-ready/);
  assert.doesNotMatch(transcriptEvent.item.text, /<!doctype html>/i);
  const shutdownResponse = await fetch(`${app.baseUrl}/api/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, clientId: "artifact-ai-edit" }),
  });
  assert.equal(shutdownResponse.status, 200);
  await waitForSessionClosed(app.baseUrl, "artifact-ai-edit", session.sessionId);
  await sleep(1500);
});

test("pins history snapshots and lists pinned chats first", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceName = `PinTest${Date.now().toString(36)}`;
  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const workspacePayload = await workspaceResponse.json();
  const workspace = workspacePayload.workspace;
  workspacePath = workspace?.path || "";
  assert.equal(workspaceResponse.status, 200);
  assert.ok(workspace?.path);

  const sessionDir = join(workspace.path, ".myharness", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session-newer.json"),
    JSON.stringify({
      session_id: "newer",
      created_at: 300,
      summary: "newer session",
      messages: [],
      message_count: 1,
    }),
  );
  await writeFile(
    join(sessionDir, "session-zeta.json"),
    JSON.stringify({
      session_id: "zeta",
      created_at: 200,
      summary: "zeta pinned session",
      messages: [],
      message_count: 1,
    }),
  );
  await writeFile(
    join(sessionDir, "latest-client-zeta.json"),
    JSON.stringify({
      session_id: "zeta",
      created_at: 200,
      summary: "zeta pinned session",
      messages: [],
      message_count: 1,
    }),
  );
  await writeFile(
    join(sessionDir, "session-alpha.json"),
    JSON.stringify({
      session_id: "alpha",
      created_at: 100,
      summary: "alpha pinned session",
      messages: [],
      message_count: 1,
    }),
  );

  const pinZetaResponse = await fetch(`${app.baseUrl}/api/history/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "zeta", pinned: true, workspacePath: workspace.path, workspaceName: workspace.name }),
  });
  const pinZetaPayload = await pinZetaResponse.json();
  assert.equal(pinZetaResponse.status, 200);
  assert.equal(pinZetaPayload.pinned, true);
  const latestClientZeta = JSON.parse(await readFile(join(sessionDir, "latest-client-zeta.json"), "utf8"));
  assert.equal(latestClientZeta.pinned, true);
  const pinAlphaResponse = await fetch(`${app.baseUrl}/api/history/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "alpha", pinned: true, workspacePath: workspace.path, workspaceName: workspace.name }),
  });
  const pinAlphaPayload = await pinAlphaResponse.json();
  assert.equal(pinAlphaResponse.status, 200);
  assert.equal(pinAlphaPayload.pinned, true);

  const historyResponse = await fetch(`${app.baseUrl}/api/history?workspacePath=${encodeURIComponent(workspace.path)}`);
  const historyPayload = await historyResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.deepEqual(historyPayload.options.map((item) => item.value), ["alpha", "zeta", "newer"]);
  assert.equal(historyPayload.options[0].pinned, true);
  assert.equal(historyPayload.options[1].pinned, true);
});

test("marks hidden history snapshots so remote admin clients can show the hidden indicator", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceName = `HiddenHistoryTest${Date.now().toString(36)}`;
  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const workspacePayload = await workspaceResponse.json();
  const workspace = workspacePayload.workspace;
  workspacePath = workspace?.path || "";
  assert.equal(workspaceResponse.status, 200);
  assert.ok(workspace?.path);

  const sessionDir = join(workspace.path, ".myharness", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session-shared-hidden.json"),
    JSON.stringify({
      session_id: "shared-hidden",
      created_at: 100,
      summary: "hidden from another browser",
      messages: [],
      message_count: 1,
    }),
  );

  const hideResponse = await fetch(`${app.baseUrl}/api/history/hide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "shared-hidden", workspacePath: workspace.path, workspaceName: workspace.name }),
  });
  const hidePayload = await hideResponse.json();
  assert.equal(hideResponse.status, 200);
  assert.equal(hidePayload.hidden, true);

  const historyResponse = await fetch(`${app.baseUrl}/api/history?workspacePath=${encodeURIComponent(workspace.path)}`);
  const historyPayload = await historyResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.equal(historyPayload.options[0].value, "shared-hidden");
  assert.equal(historyPayload.options[0].hidden, true);
});

test("uses the Korean new-chat title for empty saved history snapshots", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceName = `EmptyTitleTest${Date.now().toString(36)}`;
  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const workspacePayload = await workspaceResponse.json();
  const workspace = workspacePayload.workspace;
  workspacePath = workspace?.path || "";
  assert.equal(workspaceResponse.status, 200);
  assert.ok(workspace?.path);

  const sessionDir = join(workspace.path, ".myharness", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session-empty.json"),
    JSON.stringify({
      session_id: "empty",
      created_at: 100,
      summary: "",
      messages: [],
      message_count: 0,
    }),
  );

  const historyResponse = await fetch(`${app.baseUrl}/api/history?workspacePath=${encodeURIComponent(workspace.path)}`);
  const historyPayload = await historyResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.equal(historyPayload.options[0].description, "새 대화");
  assert.match(historyPayload.options[0].label, /새 대화$/);
});

test("deletes a project after stopping active backend sessions in that project", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "shared" },
  });
  let workspacePath = "";
  t.after(async () => {
    await app.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const workspaceName = `DeleteLiveTest${Date.now().toString(36)}`;
  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const workspacePayload = await workspaceResponse.json();
  const workspace = workspacePayload.workspace;
  workspacePath = workspace?.path || "";
  assert.equal(workspaceResponse.status, 200);
  assert.ok(workspacePath);

  const sessionResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "stale-client", cwd: workspacePath }),
  });
  assert.equal(sessionResponse.status, 200);

  const deleteResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: workspaceName }),
  });
  const deletePayload = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.equal(deletePayload.deleted.name, workspaceName);
  assert.equal(deletePayload.workspaces.some((item) => item.name === workspaceName), false);
});

test("keeps live sessions isolated for different clients on the same browser address", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const createdResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "client-old" }),
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 200);
  assert.ok(created.sessionId);

  const liveResponse = await fetch(`${app.baseUrl}/api/live-sessions?clientId=client-new`);
  const live = await liveResponse.json();

  assert.equal(liveResponse.status, 200);
  assert.equal(live.sessions.some((session) => session.sessionId === created.sessionId), false);

  const eventsResponse = await fetch(`${app.baseUrl}/api/events?session=${created.sessionId}&clientId=client-new`);
  await eventsResponse.body?.cancel().catch(() => {});
  assert.equal(eventsResponse.status, 403);

  const shutdownResponse = await fetch(`${app.baseUrl}/api/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: created.sessionId, clientId: "client-new" }),
  });

  assert.equal(shutdownResponse.status, 403);
});

test("shuts down idle backend sessions after the event stream closes", async (t) => {
  const app = await startWebServer({
    env: {
      MYHARNESS_WORKSPACE_SCOPE: "ip",
      MYHARNESS_BACKEND_IDLE_CLIENT_CLOSE_MS: "50",
    },
  });
  t.after(() => app.stop());

  const createdResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "client-idle" }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);

  const controller = new AbortController();
  const eventsResponse = await fetch(
    `${app.baseUrl}/api/events?session=${created.sessionId}&clientId=client-idle`,
    { signal: controller.signal },
  );
  assert.equal(eventsResponse.status, 200);
  controller.abort();
  await eventsResponse.body?.cancel().catch(() => {});
  await sleep(200);

  const liveResponse = await fetch(`${app.baseUrl}/api/live-sessions?clientId=client-idle`);
  const live = await liveResponse.json();

  assert.equal(liveResponse.status, 200);
  assert.equal(live.sessions.some((session) => session.sessionId === created.sessionId), false);
});

test("event streams disable proxy buffering and send heartbeats", async (t) => {
  const app = await startWebServer({
    env: {
      MYHARNESS_WORKSPACE_SCOPE: "ip",
      MYHARNESS_SSE_HEARTBEAT_MS: "25",
    },
  });
  t.after(() => app.stop());

  const createdResponse = await fetch(`${app.baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "client-sse-headers" }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);

  const controller = new AbortController();
  const eventsResponse = await fetch(
    `${app.baseUrl}/api/events?session=${created.sessionId}&clientId=client-sse-headers`,
    { signal: controller.signal },
  );
  assert.equal(eventsResponse.status, 200);
  assert.equal(eventsResponse.headers.get("x-accel-buffering"), "no");
  assert.match(eventsResponse.headers.get("cache-control") || "", /no-transform/);

  const reader = eventsResponse.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 800;
  try {
    while (Date.now() < deadline && !buffer.includes(": heartbeat")) {
      const result = await Promise.race([
        reader.read(),
        sleep(Math.max(1, deadline - Date.now())).then(() => ({ timeout: true })),
      ]);
      if (result.timeout || result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
    }
    assert.match(buffer, /: heartbeat/);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test("defaults to shared workspaces when listening on LAN interfaces", async (t) => {
  const app = await startWebServer({
    host: "0.0.0.0",
    env: { MYHARNESS_WORKSPACE_SCOPE: undefined },
  });
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/settings/workspace-scope`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.mode, "shared");
  assert.equal(payload.scope.mode, "shared");
});

test("user stats include clickable daily IP visit breakdown", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  await fetch(`${app.baseUrl}/`, { headers: { "x-forwarded-for": "10.0.0.7" } });
  await fetch(`${app.baseUrl}/`, { headers: { "x-forwarded-for": "10.0.0.7" } });
  await fetch(`${app.baseUrl}/`, { headers: { "x-forwarded-for": "10.0.0.8" } });

  const response = await fetch(`${app.baseUrl}/api/user-stats?clientId=client-stats`, {
    headers: { "x-forwarded-for": "10.0.0.7" },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.todayVisitCount, 3);
  assert.equal(payload.dailyActiveIpCount, 2);
  assert.equal(payload.currentIpTodayVisitCount, 2);

  const today = payload.dailyBreakdown?.[0]?.date;
  assert.ok(today);
  const day = payload.dailyIpBreakdown?.find((item) => item.date === today);
  assert.deepEqual(day?.ipBreakdown?.map((item) => [item.ip, item.visitCount]), [
    ["10.0.0.7", 2],
    ["10.0.0.8", 1],
  ]);
});

test("user stats preserve concurrent page visits in JSON storage", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  const visits = Array.from({ length: 20 }, (_, index) =>
    fetch(`${app.baseUrl}/`, { headers: { "x-forwarded-for": `10.0.1.${index % 4}` } }),
  );
  await Promise.all(visits);

  const statsPath = join(app.configDir, "data", "web-usage-stats.json");
  const stored = JSON.parse(await readFile(statsPath, "utf8"));

  assert.equal(stored.totalVisits, 20);
  assert.equal(
    Object.values(stored.byIp || {}).reduce((total, entry) => total + Number(entry?.visitCount || 0), 0),
    20,
  );
});

test("user stats record visits reported from the React app", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  const visitResponse = await fetch(`${app.baseUrl}/api/visit`, {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.2.7" },
  });
  const statsResponse = await fetch(`${app.baseUrl}/api/user-stats?clientId=client-stats`, {
    headers: { "x-forwarded-for": "10.0.2.8" },
  });
  const payload = await statsResponse.json();

  assert.equal(visitResponse.status, 200);
  assert.equal(payload.todayVisitCount, 1);
  assert.equal(payload.dailyActiveIpCount, 1);
  assert.deepEqual(payload.ipBreakdown?.map((item) => [item.ip, item.visitCount]), [["10.0.2.7", 1]]);
});

test("dev launcher backend entry redirects page visits to Vite on the same host", async (t) => {
  const app = await startWebServer({
    env: {
      MYHARNESS_DEV_UI_REDIRECT: "1",
      MYHARNESS_DEV_UI_PORT: "5173",
    },
  });
  t.after(() => app.stop());

  const response = await requestWithHost(app.baseUrl, "/", `172.17.64.1:${app.port}`);

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "http://172.17.64.1:5173/");
});

test("can still use IP-scoped workspaces when explicitly configured", async (t) => {
  const app = await startWebServer({
    host: "0.0.0.0",
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/settings/workspace-scope`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.mode, "ip");
  assert.equal(payload.scope.mode, "ip");
});

test("IP-scoped workspaces isolate the same project name per client IP", async (t) => {
  const app = await startWebServer({
    host: "0.0.0.0",
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const firstResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "10.10.0.11",
    },
    body: JSON.stringify({ name: "ScopedSkills" }),
  });
  const secondResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "10.10.0.12",
    },
    body: JSON.stringify({ name: "ScopedSkills" }),
  });
  const first = await firstResponse.json();
  const second = await secondResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(first.workspace.name, "ScopedSkills");
  assert.equal(second.workspace.name, "ScopedSkills");
  assert.notEqual(first.workspace.path, second.workspace.path);
  assert.equal(first.workspace.scope.name, "10.10.0.11");
  assert.equal(second.workspace.scope.name, "10.10.0.12");
});

test("output token settings expose official model caps and save valid values", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  const initialResponse = await fetch(`${app.baseUrl}/api/settings/output-tokens`);
  const initial = await initialResponse.json();

  assert.equal(initialResponse.status, 200);
  assert.deepEqual(initial.values, {
    "gpt-5.5": 42000,
    "gpt-5.4": 42000,
    "gpt-5.4-mini": 42000,
  });
  assert.deepEqual(
    initial.models.map((model) => [model.id, model.officialMax]),
    [
      ["gpt-5.5", 128000],
      ["gpt-5.4", 128000],
      ["gpt-5.4-mini", 128000],
    ],
  );

  const saveResponse = await fetch(`${app.baseUrl}/api/settings/output-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { "gpt-5.5": 64000, "gpt-5.4": 42000, "gpt-5.4-mini": 32000 } }),
  });
  const saved = await saveResponse.json();
  const settings = JSON.parse(await readFile(join(app.configDir, "settings.json"), "utf8"));

  assert.equal(saveResponse.status, 200);
  assert.equal(saved.values["gpt-5.5"], 64000);
  assert.equal(settings.model_output_token_limits["gpt-5.4-mini"], 32000);
});

test("output token settings can be saved from forwarded remote clients", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  const saveResponse = await fetch(`${app.baseUrl}/api/settings/output-tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.20",
    },
    body: JSON.stringify({ values: { "gpt-5.5": 52000 } }),
  });
  const saved = await saveResponse.json();
  const settings = JSON.parse(await readFile(join(app.configDir, "settings.json"), "utf8"));

  assert.equal(saveResponse.status, 200);
  assert.equal(saved.values["gpt-5.5"], 52000);
  assert.equal(settings.model_output_token_limits["gpt-5.5"], 52000);
});

test("output token settings reject values above official model caps", async (t) => {
  const app = await startWebServer();
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/settings/output-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { "gpt-5.5": 128001 } }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /128,000/);
});

test("rejects global settings writes from forwarded remote clients", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/settings/workspace-scope`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify({ mode: "shared" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.error, /local/i);
});

test("allows global settings writes from forwarded admin-mode clients", async (t) => {
  const app = await startWebServer({
    env: { MYHARNESS_WORKSPACE_SCOPE: "ip" },
  });
  t.after(() => app.stop());

  const response = await fetch(`${app.baseUrl}/api/settings/workspace-scope`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      "x-myharness-admin-mode": "1",
    },
    body: JSON.stringify({ mode: "shared" }),
  });
  const payload = await response.json();
  const settings = JSON.parse(await readFile(join(app.configDir, "settings.json"), "utf8"));

  assert.equal(response.status, 200);
  assert.equal(payload.mode, "shared");
  assert.equal(settings.web_workspace_scope, "shared");
});
