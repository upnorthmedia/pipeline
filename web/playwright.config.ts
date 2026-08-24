import { defineConfig, devices } from "@playwright/test";

import { BASE_URL, STORAGE_STATE } from "./e2e/e2e-user";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    // Signs the one e2e account in against the real BetterAuth endpoints and
    // writes its cookie jar. Every other project inherits that jar, because
    // src/middleware.ts sends a cookieless request to /auth/sign-in.
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: BASE_URL,
    // Locally this attaches to whatever `pnpm dev` is already up. On CI there
    // is never one to attach to, and silently adopting a stale server would be
    // a way to test the wrong build, so CI always starts its own.
    reuseExistingServer: !process.env.CI,
    // A cold Turbopack start answers in about a second on a developer machine
    // (measured: `Ready in 386ms`, first 307 at ~1s, with `.next` deleted).
    // A two-core runner is not that machine, and a webServer timeout is fatal
    // rather than retried, so CI gets four times the headroom.
    timeout: process.env.CI ? 120_000 : 30_000,
  },
});
