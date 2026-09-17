import fs from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function writeTextFileAtomic(path, content) {
  await fs.mkdir(dirname(path), { recursive: true });
  let mode;
  try {
    mode = (await fs.stat(path)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, "wx", mode ?? 0o666);
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
