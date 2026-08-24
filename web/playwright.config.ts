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
    reuseExistingServer: true,
    timeout: 30000,
  },
});
