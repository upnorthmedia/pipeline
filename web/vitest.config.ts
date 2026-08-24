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
    // Vitest's default is 5s, and this suite talks to a real Postgres and a
    // real Redis: `src/app/api/events/events.test.ts` waits 10s for a replayed
    // frame, and five more files wait 15s or 30s for a run to start or fail,
    // from inside the test body rather than from a hook. Every one of those
    // budgets was unreachable, so under load the test died on the harness's
    // 5s with `Test timed out in 5000ms` instead of its own message naming
    // what never arrived. Measured on a ten-core Linux container, which is
    // more machine than a GitHub runner: two of `events.test.ts`'s replay
    // tests fail that way in a full parallel run and pass in 2.7s each when
    // the file runs alone. This is above the largest budget
    // any test declares, so a wait can always report its own failure first;
    // `src/test/wait-budgets.test.ts` is what keeps the two in step.
    testTimeout: 45_000,
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
