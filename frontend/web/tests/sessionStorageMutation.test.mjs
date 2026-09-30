import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import test from "node:test";
import { mutateSessionStorage } from "../modules/sessionStorageMutation.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const python = { file: "python", args: [] };
const writerScript = `
import json, sys
from pathlib import Path
import myharness.services.session_storage as storage
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
project = Path(sys.argv[1])
gated = sys.argv[2] == 'gated'
messages = [ConversationMessage.from_user_text('first'), ConversationMessage(role='assistant', content=[{'type':'text','text':'answer'}])]
if gated:
    messages += [ConversationMessage.from_user_text('new question'), ConversationMessage(role='assistant', content=[{'type':'text','text':'new answer'}])]
    original = storage.atomic_write_text
    def pause(path, data, **kwargs):
        if Path(path).name == 'session-fixture.json':
            print('LOCKED', flush=True)
            sys.stdin.readline()
        return original(path, data, **kwargs)
    storage.atomic_write_text = pause
storage.save_session_snapshot(cwd=project, model='fixture', system_prompt='fixture', messages=messages, usage=UsageSnapshot(), session_id='fixture', tool_metadata={'session_title':'first','session_title_source':'conversation'})
print('DONE', flush=True)
`;
function writer(project, gated) {
  const child = spawn("python", ["-c", writerScript, project, gated ? "gated" : "plain"], {
    cwd: repoRoot, windowsHide: true,
    env: { ...process.env, PYTHONPATH: [join(repoRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter), PYTHONIOENCODING: "utf8" },
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  const locked = new Promise((resolve, reject) => {
    lines.on("line", (line) => { if (line === "LOCKED") resolve(); });
    child.on("error", reject);
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { lines.close(); code === 0 ? resolve() : reject(new Error(diagnostic)); });
  });
  return { child, locked, done };
}

for (const [field, value] of [["title", "Manual title"], ["pinned", true], ["liked", true]]) {
  test(`real Node/Python ${field} mutation preserves a concurrently saved answer and metadata pointers`, async () => {
    const project = await mkdtemp(join(tmpdir(), "myharness-session-test-"));
    let active;
    try {
      await writer(project, false).done;
      active = writer(project, true);
      await active.locked;
      let completed = false;
      const marker = join(project, "mutation-lock-attempted");
      const signalLockAttempt = `
import sys
from pathlib import Path
import myharness.services.session_storage as storage
original_lock = storage.exclusive_file_lock
def signal_lock(path, **kwargs):
    Path(${JSON.stringify(marker)}).write_text('attempted', encoding='utf8')
    return original_lock(path, **kwargs)
storage.exclusive_file_lock = signal_lock
exec(sys.argv[-1])
`;
      const edit = mutateSessionStorage({ file: "python", args: ["-c", signalLockAttempt] }, repoRoot, { operation: "metadata", cwd: project, sessionId: "fixture", patch: { [field]: value } });
      edit.then(() => { completed = true; }, () => {});
      const deadline = Date.now() + 5000;
      while (!await stat(marker).catch(() => null)) {
        assert.ok(Date.now() < deadline, "Metadata process did not attempt the storage lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(completed, false);
      active.child.stdin.end("release\n");
      await active.done;
      await edit;
      const directory = join(project, ".myharness", "sessions");
      const payload = JSON.parse(await readFile(join(directory, "session-fixture.json"), "utf8"));
      assert.equal(payload.messages.length, 4);
      assert.equal(payload.messages.at(-1).content[0].text, "new answer");
      assert.equal(payload[field === "title" ? "summary" : field], value);
      for (const file of ["session-fixture.meta", "latest.meta"]) {
        const metadata = JSON.parse(await readFile(join(directory, file), "utf8"));
        assert.equal(metadata.message_count, 4);
        assert.equal(metadata[field === "title" ? "summary" : field], value);
      }
      assert.equal(JSON.parse(await readFile(join(directory, "latest.json"), "utf8")).session_id, "fixture");
    } finally {
      active?.child.kill();
      if (active) await active.done.catch(() => {});
      await rm(project, { recursive: true, force: true });
    }
  });
}

test("failed metadata requests and killed lock owners release the OS lock", async () => {
  const project = await mkdtemp(join(tmpdir(), "myharness-session-test-"));
  let active;
  try {
    await writer(project, false).done;
    await assert.rejects(mutateSessionStorage(python, repoRoot, { operation: "metadata", cwd: project, sessionId: "fixture", patch: { title: "" } }));
    active = writer(project, true);
    await active.locked;
    active.child.kill();
    await active.done.catch(() => {});
    const result = await mutateSessionStorage(python, repoRoot, { operation: "metadata", cwd: project, sessionId: "fixture", patch: { pinned: true } });
    assert.equal(result.pinned, true);
  } finally {
    active?.child.kill();
    await rm(project, { recursive: true, force: true });
  }
});
