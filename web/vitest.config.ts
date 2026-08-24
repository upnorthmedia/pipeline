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
    // `BETTER_AUTH_SECRET` is required at import of `src/lib/auth.ts` and the
    // repo `.env` is the only place it can come from, so the suite supplies a
    // fixed one when that file has none. Every session it signs is minted and
    // validated inside the same run by `src/test/session.ts`, so the value
    // never has to match anything; what matters is that it is not better-auth's
    // published fallback. A real `.env` value still wins.
    // `STAGE_RETRY_DELAY_MS` goes last for the same reason as `MEDIA_DIR`: it
    // switches off the ten-second pause a stage holds between attempts
    // (`RETRY_DELAY_MS` in `src/mastra/steps/stage-io.ts`), which five suites
    // that drive real failing runs would otherwise pay twice per run, past the
    // 45s budget above. `src/mastra/steps/stage-retry.test.ts` fails when this
    // stops being set, and covers the pause itself with its own override.
    env: {
      BETTER_AUTH_SECRET: "vitest-fixed-secret-not-used-outside-the-suite",
      ...repoRootEnv(__dirname),
      MEDIA_DIR: testMediaRoot(),
      STAGE_RETRY_DELAY_MS: "0",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
