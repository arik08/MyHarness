import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { sendFileResponse } from "../modules/fileResponse.js";

async function fixture(t, handler) {
  const dir = await fs.mkdtemp(join(tmpdir(), "myharness-file-response-"));
  const server = createServer((request, response) => {
    handler(request, response, dir).catch((error) => {
      response.writeHead(error.status || 500);
      response.end("File unavailable");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, url: `http://127.0.0.1:${server.address().port}` };
}

test("file response uses current file size, preserves binary content and handles empty files", async (t) => {
  const { dir, url } = await fixture(t, async (request, response, root) => {
    await sendFileResponse(response, join(root, request.url.slice(1)), {
      "Content-Type": "application/octet-stream", "Content-Length": "999",
    });
  });
  for (const bytes of [Buffer.from([0, 1, 255, 13, 10]), Buffer.alloc(0)]) {
    await fs.writeFile(join(dir, "report.bin"), bytes);
    const response = await fetch(`${url}/report.bin`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const missing = await fetch(`${url}/missing.bin`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "File unavailable");
});

for (const failure of ["read error", "client disconnect"]) {
  test(`${failure} closes the file stream without terminating the server`, async (t) => {
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    let stream;
    let closed = false;
    const { dir, url } = await fixture(t, async (request, response, root) => {
      if (request.url === "/health") { response.end("healthy"); return; }
      try {
        await sendFileResponse(response, join(root, "report.bin"), {});
      } finally {
        finish();
      }
    });
    await fs.writeFile(join(dir, "report.bin"), "Original");
    const originalOpen = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args) => {
      const handle = await originalOpen(...args);
      let sent = false;
      stream = new Readable({
        read() {
          if (failure === "read error" && sent) {
            this.destroy(Object.assign(new Error("Injected disk failure"), { code: "EIO" }));
            return;
          }
          sent = true;
          this.push(Buffer.alloc(64 * 1024));
        },
      });
      return {
        stat: async () => ({ isFile: () => true, size: 1024 * 1024 * 1024 }),
        createReadStream: () => stream,
        close: async () => { await handle.close(); closed = true; },
      };
    });
    if (failure === "read error") {
      await assert.rejects(async () => {
        const response = await fetch(url);
        await response.arrayBuffer();
      });
    } else {
      const response = await fetch(url);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel();
    }
    await finished;
    assert.equal(stream.destroyed, true);
    assert.equal(closed, true);
    assert.equal(await (await fetch(`${url}/health`)).text(), "healthy");
  });
}
