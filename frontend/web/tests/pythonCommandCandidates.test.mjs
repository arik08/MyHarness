import assert from "node:assert/strict";
import test from "node:test";
import { pythonCommandCandidates } from "../modules/pythonCommandCandidates.js";

const defaults = [
  { file: "configured", args: [], label: "MYHARNESS_PYTHON" },
  { file: "environment", args: [], label: "PYTHON" },
  { file: "path-python", args: [], label: "python" },
];
const options = { defaults, cached: { file: "old-cache", args: ["-3"] }, resolveExecutable: (name) => name };

test("configured Python takes precedence over a previously cached interpreter", () => {
  const candidates = pythonCommandCandidates(options);
  assert.deepEqual(candidates.map((candidate) => candidate.file), ["configured", "environment", "old-cache", "path-python"]);
});

for (const name of ["C:/custom/python.exe", "C:\\custom\\python.exe", "/custom/python", "./venv/python", "custom-python"]) {
  test(`explicit interpreter ${name} cannot silently switch to cache or defaults`, () => {
    const candidates = pythonCommandCandidates({ ...options, requestedExecutable: name, requestedArgs: ["-I"] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].file, name);
    assert.deepEqual(candidates[0].args, ["-I"]);
  });
}

test("automatic discovery retains cached launcher arguments and PATH fallback", () => {
  const candidates = pythonCommandCandidates({ ...options, defaults: defaults.slice(2) });
  assert.deepEqual(candidates.map((candidate) => candidate.file), ["old-cache", "path-python"]);
  assert.deepEqual(candidates[0].args, ["-3"]);
});

test("missing cache does not suppress default discovery", () => {
  assert.deepEqual(pythonCommandCandidates({ ...options, cached: null }), defaults);
});
