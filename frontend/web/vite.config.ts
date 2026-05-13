import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const backendPort = Number(process.env.PORT || 4273);
const webPort = Number(process.env.MYHARNESS_WEB_PORT || process.env.VITE_PORT || 4174);
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
    port: webPort,
    proxy: {
      "/api": backendOrigin,
      "/assets": backendOrigin,
      "/vendor": backendOrigin,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
