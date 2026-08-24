import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

import { testMediaRoot } from "./src/test/test-media-root";

/**
 * The repo keeps one `.env` at its root (shared by compose, `next.config.ts`
 * and the Mastra CLI). Vitest runs from `web/`, so load it here to give
 * database tests their connection string without duplicating credentials.
 */
function repoRootEnv(): Record<string, string> {
  const file = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["./src/test/global-setup.ts"],
    css: false,
    // `MEDIA_DIR` goes last, and deliberately outranks the repo `.env`: its
    // fallback is the repository's own `media/`, so a run that inherits it
    // writes post directories into the working tree.
    // `src/test/media-root-isolation.test.ts` fails when this stops being set.
    env: { ...repoRootEnv(), MEDIA_DIR: testMediaRoot() },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
