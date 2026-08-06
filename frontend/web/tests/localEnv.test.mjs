import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredDevPort, configuredPort } from "../modules/localEnv.js";

test("configuredPort reads the repository-local PORT first", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "myharness-local-env-"));
  const previousPort = process.env.PORT;
  try {
    process.env.PORT = "4999";
    await writeFile(join(repoRoot, "myharness.local.env"), "# local settings\nPORT=4174\n", "utf8");
    assert.equal(configuredPort(repoRoot), 4174);
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("configuredPort rejects invalid repository-local ports", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "myharness-local-env-"));
  try {
    await writeFile(join(repoRoot, "myharness.local.env"), "PORT=not-a-port\n", "utf8");
    assert.throws(() => configuredPort(repoRoot), /Invalid PORT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("configuredPort allows isolated test servers to use an explicit process port", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "myharness-local-env-"));
  const previousPort = process.env.PORT;
  const previousIgnore = process.env.MYHARNESS_IGNORE_LOCAL_ENV;
  try {
    process.env.PORT = "4999";
    process.env.MYHARNESS_IGNORE_LOCAL_ENV = "1";
    await writeFile(join(repoRoot, "myharness.local.env"), "PORT=4174\n", "utf8");
    assert.equal(configuredPort(repoRoot), 4999);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousIgnore === undefined) delete process.env.MYHARNESS_IGNORE_LOCAL_ENV;
    else process.env.MYHARNESS_IGNORE_LOCAL_ENV = previousIgnore;
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("configuredDevPort derives the backend port plus 100 when configured as auto", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "myharness-local-env-"));
  try {
    await writeFile(join(repoRoot, "myharness.local.env"), "PORT=4174\nMYHARNESS_DEV_PORT=auto\n", "utf8");
    assert.equal(configuredDevPort(repoRoot, 4174), 4274);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("configuredDevPort rejects the backend port", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "myharness-local-env-"));
  try {
    await writeFile(join(repoRoot, "myharness.local.env"), "PORT=4174\nMYHARNESS_DEV_PORT=4174\n", "utf8");
    assert.throws(() => configuredDevPort(repoRoot, 4174), /different from backend/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
