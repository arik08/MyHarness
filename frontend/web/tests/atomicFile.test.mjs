import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { writeTextFileAtomic } from "../modules/atomicFile.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "myharness-atomic-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "report.html");
  await fs.writeFile(path, "Original document", "utf8");
  return { dir, path };
}

test("atomic text saves preserve exact UTF-8 and newlines and leave no temporary file", async (t) => {
  const { dir, path } = await fixture(t);
  const content = "\ufeff한글\r\nHTML\n끝\r";
  await writeTextFileAtomic(path, content);
  assert.equal(await fs.readFile(path, "utf8"), content);
  assert.deepEqual(await fs.readdir(dir), ["report.html"]);
  const nested = join(dir, "new", "settings.json");
  await writeTextFileAtomic(nested, '{"enabled":true}\n');
  assert.deepEqual(JSON.parse(await fs.readFile(nested, "utf8")), { enabled: true });
});

for (const failure of ["write", "sync", "rename"]) {
  test(`failed ${failure} preserves the original and cleans the temporary file`, async (t) => {
    const { dir, path } = await fixture(t);
    const fail = () => { throw Object.assign(new Error(`injected ${failure} failure`), { code: "EIO" }); };
    const originalOpen = fs.open.bind(fs);
    if (failure === "rename") {
      t.mock.method(fs, "rename", fail);
    } else {
      t.mock.method(fs, "open", async (...args) => {
        const handle = await originalOpen(...args);
        return {
          writeFile: async (...writeArgs) => {
            if (failure === "write") { await handle.writeFile("Partial content"); fail(); }
            return handle.writeFile(...writeArgs);
          },
          sync: failure === "sync" ? fail : () => handle.sync(),
          close: () => handle.close(),
        };
      });
    }
    await assert.rejects(writeTextFileAtomic(path, "New document"), /injected/);
    assert.equal(await fs.readFile(path, "utf8"), "Original document");
    assert.deepEqual(await fs.readdir(dir), ["report.html"]);
  });
}

test("atomic save preserves existing POSIX permissions", { skip: process.platform === "win32" }, async (t) => {
  const { path } = await fixture(t);
  await fs.chmod(path, 0o600);
  await writeTextFileAtomic(path, "Saved");
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
});
