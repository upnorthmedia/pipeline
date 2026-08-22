import { defineConfig } from "drizzle-kit"

/**
 * Drizzle points at the database Alembic owns. There is no `migrations`
 * workflow here on purpose: `src/db/schema.ts` mirrors the existing schema, it
 * does not generate it. Use `drizzle-kit check`/`pull` to detect drift.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL_SYNC ?? "postgresql://pipeline:pipeline@localhost:5433/content_pipeline",
  },
})
