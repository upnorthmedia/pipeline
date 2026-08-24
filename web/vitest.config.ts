import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

import { repoRootEnv } from "./repo-env";
import { testMediaRoot } from "./src/test/test-media-root";

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
    env: { ...repoRootEnv(__dirname), MEDIA_DIR: testMediaRoot() },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
