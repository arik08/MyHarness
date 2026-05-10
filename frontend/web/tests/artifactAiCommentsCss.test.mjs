import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps AI edit comments controls on one row until progress is shown", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  const comments = css.match(/\.artifact-ai-comments\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const withProgress = css.match(/\.artifact-ai-comments\.with-progress\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const header = css.match(/\.artifact-ai-comments-header\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const status = css.match(/\.artifact-ai-status\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const submit = css.match(/\.artifact-ai-submit\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const progress = css.match(/\.artifact-ai-progress\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(comments, /flex-wrap:\s*nowrap;/);
  assert.match(withProgress, /flex-wrap:\s*wrap;/);
  assert.match(withProgress, /align-items:\s*center;/);
  assert.doesNotMatch(withProgress, /align-items:\s*flex-start;/);
  assert.match(header, /display:\s*contents;/);
  assert.doesNotMatch(header, /flex:\s*1\s+0\s+100%/);
  assert.match(status, /flex:\s*0\s+1\s+auto;/);
  assert.match(submit, /margin-left:\s*auto;/);
  assert.match(progress, /align-self:\s*stretch;/);
  assert.match(progress, /flex:\s*1\s+0\s+100%;/);
});
