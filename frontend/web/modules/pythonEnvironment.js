import { existsSync } from "node:fs";
import { join } from "node:path";

// Shared by the server and subprocess integration tests. Explicit overrides win.
export function pythonEnvironmentCandidates(repoRoot, env = process.env, platform = process.platform) {
  const candidates = [];
  for (const key of ["MYHARNESS_PYTHON", "PYTHON"]) {
    const file = String(env[key] || "").trim();
    if (file) candidates.push({ file, args: [], label: key });
  }
  for (const directory of [env.VIRTUAL_ENV, join(repoRoot, ".myharness-venv"), join(repoRoot, ".venv")]) {
    if (!directory) continue;
    const file = platform === "win32"
      ? join(directory, "Scripts", "python.exe")
      : join(directory, "bin", "python");
    if (existsSync(file)) candidates.push({ file, args: [], label: file });
  }
  return candidates;
}
