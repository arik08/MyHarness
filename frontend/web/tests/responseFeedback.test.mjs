import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveResponseFeedback } from "../modules/responseFeedback.js";

test("feedback persists Unicode, keeps repeated answers distinct and validates input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myharness-feedback-"));
  try {
    const body = { rating: "up", comment: "한글 의견", answerText: "동일 응답", answerIndex: 0 };
    const results = await Promise.all([saveResponseFeedback(directory, body, "session-a"), saveResponseFeedback(directory, { ...body, rating: "down", answerIndex: 1, comment: "" }, "session-b")]);
    assert.notEqual(results[0].id, results[1].id);
    const saved = JSON.parse(await readFile(join(directory, `${results[0].id}.json`), "utf8"));
    assert.equal(saved.comment, "한글 의견");
    assert.equal(saved.sessionId, "session-a");
    for (const invalid of [{ rating: "unknown" }, { comment: "x".repeat(4001) }, { answerIndex: -1 }, { answerText: "" }]) {
      await assert.rejects(saveResponseFeedback(directory, { ...body, ...invalid }, "session-a"));
    }
    assert.equal((await readdir(directory)).length, 2);
    await assert.rejects(saveResponseFeedback(join(directory, `${results[0].id}.json`, "blocked"), body, "session-a"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
