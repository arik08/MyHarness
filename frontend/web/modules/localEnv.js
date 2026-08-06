import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readLocalEnvValue(repoRoot, name) {
  const envPath = join(repoRoot, "myharness.local.env");
  if (!existsSync(envPath)) {
    return "";
  }

  const prefix = `${name}=`;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.startsWith(prefix)) {
      continue;
    }
    const value = line.slice(prefix.length).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1).trim();
    }
    return value;
  }
  return "";
}

export function configuredPort(repoRoot, fallback = 4174) {
  const localPort = process.env.MYHARNESS_IGNORE_LOCAL_ENV === "1" ? "" : readLocalEnvValue(repoRoot, "PORT");
  const rawPort = localPort || process.env.PORT || String(fallback);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT '${rawPort}'. Set PORT to a number from 1 to 65535 in myharness.local.env.`);
  }
  return port;
}

export function configuredDevPort(repoRoot, backendPort) {
  const localPort = process.env.MYHARNESS_IGNORE_LOCAL_ENV === "1"
    ? ""
    : readLocalEnvValue(repoRoot, "MYHARNESS_DEV_PORT");
  const rawPort = localPort
    || process.env.MYHARNESS_DEV_PORT
    || process.env.MYHARNESS_WEB_PORT
    || process.env.VITE_PORT
    || "auto";
  const port = String(rawPort).trim().toLowerCase() === "auto" ? backendPort + 100 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === backendPort) {
    throw new Error(
      `Invalid MYHARNESS_DEV_PORT '${rawPort}'. Use 'auto' or a port different from backend PORT ${backendPort}.`,
    );
  }
  return port;
}
