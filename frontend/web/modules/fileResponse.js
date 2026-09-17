import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export async function sendFileResponse(response, path, headers) {
  let handle;
  try {
    handle = await fs.open(path, "r");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") error.status = 404;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error("Artifact is not a file"), { status: 404 });
    // The size and content must describe the same open file, even during replacement.
    response.writeHead(200, { ...headers, "Content-Length": String(info.size) });
    try {
      await pipeline(handle.createReadStream(), response);
    } catch {
      // Headers may already be sent. End this transfer, never the server process.
      response.destroy();
    }
  } finally {
    await handle.close();
  }
}
