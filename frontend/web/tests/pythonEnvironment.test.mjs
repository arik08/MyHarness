import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, isAbsolute } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { pythonEnvironmentCandidates } from "../modules/pythonEnvironment.js";
import { pythonCommandCandidates } from "../modules/pythonCommandCandidates.js";

const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const resolver = serverSource.slice(serverSource.indexOf("function resolvePythonCommand("), serverSource.indexOf("\nfunction resolveExecutable("));

for (const platform of ["darwin", "linux", "win32"]) {
  test(`Python selection honors overrides and skips unusable environments on ${platform}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "myharness-python-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    function environment(name) {
      const directory = join(root, name);
      const file = platform === "win32" ? join(directory, "Scripts", "python.exe") : join(directory, "bin", "python");
      mkdirSync(join(directory, platform === "win32" ? "Scripts" : "bin"), { recursive: true });
      writeFileSync(file, "test interpreter");
      return { directory, file };
    }
    const installed = environment(".myharness-venv");
    const standard = environment(".venv");
    const active = environment("activated");
    const env = {};
    const unusable = new Set();
    const context = vm.createContext({
      basename, isAbsolute, pythonCommandCandidates,
      loadCachedWindowsPythonLauncher: () => null,
      storeCachedWindowsPythonLauncher() {},
      resolveExecutable: (name) => name,
      defaultPythonCandidates: () => [...pythonEnvironmentCandidates(root, env, platform), { file: "path-python", args: [] }],
      pythonCandidateIsUsable: ({ file }) => !unusable.has(file),
    });
    vm.runInContext(resolver, context);
    const selected = () => context.resolvePythonCommand().file;
    assert.equal(selected(), installed.file, "direct npm launch finds installer environment");
    unusable.add(installed.file);
    assert.equal(selected(), standard.file, "a broken installer environment does not block a usable .venv");
    env.VIRTUAL_ENV = active.directory;
    assert.equal(selected(), active.file);
    env.PYTHON = "custom-python";
    assert.equal(selected(), "custom-python");
    env.MYHARNESS_PYTHON = "explicit-python";
    assert.equal(selected(), "explicit-python");
    assert.equal(context.resolvePythonCommand("/explicit/bin/python").file, "/explicit/bin/python");
    for (const file of [active.file, standard.file, "custom-python", "explicit-python"]) unusable.add(file);
    assert.equal(selected(), "path-python");
    unusable.add("path-python");
    assert.throws(selected, /No usable Python/);
  });
}
