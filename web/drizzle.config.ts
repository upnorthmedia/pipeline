import { defineConfig } from "drizzle-kit"

import { applyRepoRootEnv } from "./repo-env"

/**
 * drizzle-kit has no env loader of its own, so without this `pnpm db:migrate`
 * silently falls through to the hardcoded fallback below and fails to connect
 * on any machine whose Postgres is not on 5433. An exported DATABASE_URL_SYNC
 * still wins, which is what the compose and Railway paths rely on.
 */
applyRepoRootEnv(__dirname)

/**
 * `src/db/schema.ts` mirrors the shape the live databases already have rather
 * than defining a new one, so `drizzle-kit generate` is not a routine command
 * here: it exists to keep the `drizzle/` baseline in step with `schema.ts`, and
 * `src/db/baseline-parity.test.ts` proves the baseline builds the same database
 * the dev one is. `drizzle/README.md` has the fresh-database procedure. Use
 * `drizzle-kit check`/`pull` to detect drift.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL_SYNC ?? "postgresql://pipeline:pipeline@localhost:5433/content_pipeline",
  },
})
