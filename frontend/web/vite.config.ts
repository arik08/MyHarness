import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { configuredDevPort, configuredPort } from "./modules/localEnv.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backendPort = configuredPort(repoRoot);
const devPort = configuredDevPort(repoRoot, backendPort);
const backendOrigin = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "web-assets",
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    proxy: {
      "/api": { target: backendOrigin, xfwd: true },
      "/share": { target: backendOrigin, xfwd: true },
      "/vendor": backendOrigin,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
