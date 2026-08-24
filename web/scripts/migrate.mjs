/**
 * Applies the pipeline schema migrations in `drizzle/` to the database
 * `DATABASE_URL_SYNC` names.
 *
 * `pnpm db:migrate` was `drizzle-kit migrate` until ledger item P2.77b.
 * drizzle-kit is a devDependency, so neither runtime image carries it and
 * nothing could migrate a database on deploy. This runs the same migration
 * folder through `drizzle-orm`, which is a runtime dependency: same
 * `meta/_journal.json` walk, same sha256 file hashes, same
 * `drizzle.__drizzle_migrations` bookkeeping, so a database migrated by either
 * command is migrated for both. `src/db/migration-scripts.test.ts` pins that.
 *
 * Deliberately `.mjs` and dependency-free beyond `drizzle-orm` and `pg`: it has
 * to start under bare node inside the runtime image, where there is no pnpm
 * script, no repo-root `.env` and no TypeScript loader for `src/`.
 *
 * Usage, from `web/`:
 *   pnpm db:migrate                 # loads the repo-root `.env` first
 *   node scripts/migrate.mjs        # environment already set, which is the deploy shape
 */
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/** The folder `drizzle.config.ts` writes and `drizzle/README.md` documents. */
export const migrationsFolder = path.resolve(scriptDir, "../drizzle")

/**
 * The same variable and the same driver-prefix normalisation as
 * `connectionString()` in `src/db/index.ts`, copied rather than imported
 * because that module reaches `./schema` without a file extension and bare node
 * cannot resolve that. `src/db/migration-scripts.test.ts` holds the two answers
 * together so the copy cannot drift.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function databaseUrl(env = process.env) {
  const url = env.DATABASE_URL_SYNC ?? env.DATABASE_URL
  if (!url) {
    throw new Error("DATABASE_URL_SYNC (or DATABASE_URL) must be set to reach the database")
  }
  return url.replace(/^postgresql\+\w+:\/\//, "postgresql://")
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
    const { rows } = await pool.query(
      'select count(*)::int as applied from drizzle."__drizzle_migrations"',
    )
    console.log(`schema up to date: ${rows[0].applied} migrations recorded from ${migrationsFolder}`)
  } finally {
    await pool.end()
  }
}

// Importing this module has to be free of side effects, so the test can read
// `databaseUrl()` without migrating whatever the environment happens to name.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
