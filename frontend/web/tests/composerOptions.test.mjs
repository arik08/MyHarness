import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const start = source.indexOf("function normalizeComposeOptions(value)");
const end = source.indexOf("async function saveClientAttachments", start);
const normalize = vm.runInNewContext(source.slice(start,end) + "\nnormalizeComposeOptions", { composeTargetOutputTokenMax: 40000, normalizeProjectFilePath: (value) => value });

test("passes research and chat preferences alongside independent artifact targets", () => {
  for (const analysis_depth of ["brief", "standard", "deep"]) {
    for (const answer_length of ["brief", "standard", "detailed"]) {
      const result=normalize({analysis_depth,answer_length,output_surface:"artifact",target_output_tokens:12000});
      assert.equal(result.analysis_depth,analysis_depth);
      assert.equal(result.answer_length,answer_length);
      assert.equal(result.target_output_tokens,12000);
    }
  }
});

test("omits automatic and unknown preferences and accepts API aliases", () => {
  assert.equal(normalize({analysis_depth:"auto",answer_length:"unknown"}),null);
  const result=normalize({analysisDepth:"deep",answerLength:"brief"});
  assert.equal(result.analysis_depth,"deep");
  assert.equal(result.answer_length,"brief");
});
