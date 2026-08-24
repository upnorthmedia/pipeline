/**
 * Applies the pipeline schema migrations in `drizzle/` to the database
 * `DATABASE_URL_SYNC` names.
 *
 * `pnpm db:migrate` was `drizzle-kit migrate` until ledger item P2.77b.
 * drizzle-kit is a devDependency, so neither runtime image carries it and
 * nothing could migrate a database on deploy. The walk itself lives in
 * `scripts/migrate-lib.mjs`, which `scripts/predeploy.ts` runs too; this file
 * is only the command around it, and has no exports for that reason.
 *
 * Usage, from `web/`:
 *   pnpm db:migrate                 # loads the repo-root `.env` first
 *   node scripts/migrate.mjs        # environment already set, which is the deploy shape
 */
import { Pool } from "pg"

import { applyMigrations, databaseUrl, migrationsFolder } from "./migrate-lib.mjs"

const pool = new Pool({ connectionString: databaseUrl() })
try {
  const applied = await applyMigrations(pool)
  console.log(`schema up to date: ${applied} migrations recorded from ${migrationsFolder}`)
} finally {
  await pool.end()
}
