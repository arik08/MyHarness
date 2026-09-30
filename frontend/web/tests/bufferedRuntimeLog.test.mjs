import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createBufferedRuntimeLog } from "../modules/bufferedRuntimeLog.js";

test("buffered logs preserve order across automatic, size-limit and exit flushes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myharness-buffered-log-"));
  try {
    const path = join(directory, "nested", "runtime.log");
    const log = createBufferedRuntimeLog(path, { maxBufferBytes: 20 });
    const lines = Array.from({ length: 100 }, (_, index) => `${JSON.stringify({ index, text: "한글" })}\n`);
    for (const line of lines) log.write(line);
    log.flush();
    await new Promise(setImmediate);
    assert.equal(await readFile(path, "utf8"), lines.join(""));
    const exitPath = join(directory, "exit.log");
    const moduleUrl = new URL("../modules/bufferedRuntimeLog.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {createBufferedRuntimeLog} from ${JSON.stringify(moduleUrl)};
      const log=createBufferedRuntimeLog(${JSON.stringify(exitPath)});
      process.once('exit',()=>{log.write('exit\\n');log.flush();});
      log.write('first\\n');log.write('last\\n');process.exit(0);
    `], { windowsHide: true });
    assert.equal(child.status, 0, child.stderr.toString());
    assert.equal(await readFile(exitPath, "utf8"), "first\nlast\nexit\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a log write failure does not propagate into the request handler", () => {
  const log = createBufferedRuntimeLog(join(import.meta.filename, "invalid", "runtime.log"));
  assert.doesNotThrow(() => { log.write("diagnostic\n"); log.flush(); });
});
