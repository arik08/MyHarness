import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFileExclusive } from "../modules/moveFileExclusive.js";

test("concurrent moves never overwrite another destination or lose the losing source", async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), "myharness-exclusive-move-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = [join(directory, "first.html"), join(directory, "second.html")];
  await Promise.all(sources.map((path, index) => fs.writeFile(path, `content-${index}`)));
  const destination = join(directory, "result.html");
  const results = await Promise.allSettled(sources.map(path => moveFileExclusive(path, destination)));
  const winner = results.findIndex(result => result.status === "fulfilled");
  const loser = 1 - winner;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results[loser].reason.code, "EEXIST");
  assert.equal(await fs.readFile(destination, "utf8"), `content-${winner}`);
  assert.equal(await fs.readFile(sources[loser], "utf8"), `content-${loser}`);
  await assert.rejects(fs.stat(sources[winner]), { code: "ENOENT" });
});

test("filesystems without hard links use exclusive copying", async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), "myharness-copy-move-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(fs, "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  const source = join(directory, "source.txt");
  const destination = join(directory, "destination.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(destination, "existing");
  await assert.rejects(moveFileExclusive(source, destination), { code: "EEXIST" });
  assert.equal(await fs.readFile(source, "utf8"), "source");
  assert.equal(await fs.readFile(destination, "utf8"), "existing");
  const fresh = join(directory, "fresh.txt");
  await moveFileExclusive(source, fresh);
  assert.equal(await fs.readFile(fresh, "utf8"), "source");
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});

test("a failed source removal preserves both copies", async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), "myharness-retained-move-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.txt");
  const destination = join(directory, "destination.txt");
  await fs.writeFile(source, "valuable content");
  t.mock.method(fs, "unlink", async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); });
  await assert.rejects(moveFileExclusive(source, destination), { code: "EPERM" });
  assert.equal(await fs.readFile(source, "utf8"), "valuable content");
  assert.equal(await fs.readFile(destination, "utf8"), "valuable content");
});
