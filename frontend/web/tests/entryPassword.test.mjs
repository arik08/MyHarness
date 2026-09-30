import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEntryPasswordStore } from "../modules/entryPassword.js";

test("password rotation persists hashes, replaces fallback and rotates cookie key", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "entry-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "password.json");
  const store = await createEntryPasswordStore(path, "old");
  const key = store.cookieKey();
  await store.change("old", "새 비밀번호 🔑", "새 비밀번호 🔑");
  assert.notEqual(store.cookieKey(), key);
  assert.equal(await store.verify("old"), false);
  assert.equal(await store.verify("새 비밀번호 🔑"), true);
  assert.ok(!(await readFile(path, "utf8")).includes("새 비밀번호"));
  const restarted = await createEntryPasswordStore(path, "old");
  assert.equal(await restarted.verify("새 비밀번호 🔑"), true);
  assert.equal(restarted.cookieKey(), store.cookieKey());
  for (const args of [["wrong", "next", "next"], ["새 비밀번호 🔑", "next", "mismatch"], ["새 비밀번호 🔑", " ", " "], ["새 비밀번호 🔑", "x".repeat(257), "x".repeat(257)]]) {
    await assert.rejects(restarted.change(...args), { status: 400 });
    assert.equal(await restarted.verify("새 비밀번호 🔑"), true);
  }
});

test("failed save preserves working password; malformed file never falls back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "entry-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = join(dir, "blocked");
  const store = await createEntryPasswordStore(join(parent, "password.json"), "old");
  await writeFile(parent, "not a directory");
  await assert.rejects(store.change("old", "next", "next"));
  assert.equal(await store.verify("old"), true);
  await assert.rejects(createEntryPasswordStore(parent, "old"));
});

test("either password authenticates; rotating either kind preserves the other across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "entry-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "password.json");
  const store = await createEntryPasswordStore(path, "core");
  assert.equal(await store.authenticate("visitor"), null);
  await store.change("core", "visitor", "visitor", "guest");
  const primaryKey = store.cookieKey();
  const guestKey = store.cookieKey("guest");
  assert.equal(await store.authenticate("core"), "primary");
  assert.equal(await store.authenticate("visitor"), "guest");
  await assert.rejects(store.change("visitor", "bad", "bad", "guest"), { status: 400 });
  await assert.rejects(store.change("core", "core", "core", "guest"), { status: 400 });
  await assert.rejects(store.change("core", "bad", "bad", "unknown"), { status: 400 });
  await store.change("core", "visitor2", "visitor2", "guest");
  assert.equal(store.cookieKey(), primaryKey);
  assert.notEqual(store.cookieKey("guest"), guestKey);
  assert.equal(await store.authenticate("visitor"), null);
  const nextGuestKey = store.cookieKey("guest");
  await store.change("core", "core2", "core2", "primary");
  assert.equal(store.cookieKey("guest"), nextGuestKey);
  const restarted = await createEntryPasswordStore(path, "core");
  assert.equal(await restarted.authenticate("core"), null);
  assert.equal(await restarted.authenticate("core2"), "primary");
  assert.equal(await restarted.authenticate("visitor2"), "guest");
});

test("concurrent changes are rejected and password-free entry can be enabled", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "entry-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createEntryPasswordStore(join(dir, "password.json"), "");
  assert.equal(store.enabled, false);
  const first = store.change("", "next", "next");
  await assert.rejects(store.change("", "other", "other"), { status: 409 });
  await first;
  assert.equal(store.enabled, true);
  assert.equal(await store.verify("next"), true);
});
