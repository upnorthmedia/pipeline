import { defineConfig } from "drizzle-kit"

/**
 * Drizzle points at the database Alembic owns today. `src/db/schema.ts` still
 * mirrors that schema rather than defining it, so `drizzle-kit generate` is not
 * a routine command here: it exists to keep the `drizzle/` baseline in step
 * with `schema.ts`, and `src/db/baseline-parity.test.ts` proves the baseline
 * builds the same database the Alembic chain builds. `drizzle/README.md` has
 * the fresh-database procedure. Use `drizzle-kit check`/`pull` to detect drift.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL_SYNC ?? "postgresql://pipeline:pipeline@localhost:5433/content_pipeline",
  },
})
