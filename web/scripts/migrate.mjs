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
 *   pnpm db:migrate --baseline      # adopt a database that already has the schema
 *   node scripts/migrate.mjs        # environment already set, which is the deploy shape
 */
import { Pool } from "pg"

import {
  applyMigrations,
  baselineMigrations,
  databaseUrl,
  MigrationHalted,
  migrationsFolder,
} from "./migrate-lib.mjs"

const baseline = process.argv.slice(2).includes("--baseline")
const pool = new Pool({ connectionString: databaseUrl() })
try {
  if (baseline) {
    const recorded = await baselineMigrations(pool)
    console.log(
      `baseline recorded ${recorded} migrations from ${migrationsFolder} as already applied; ` +
        "nothing was run against the database",
    )
  } else {
    const applied = await applyMigrations(pool)
    console.log(`schema up to date: ${applied} migrations recorded from ${migrationsFolder}`)
  }
} catch (error) {
  // A state with a remedy prints the remedy. Anything else keeps its stack.
  if (!(error instanceof MigrationHalted)) throw error
  console.error(error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
