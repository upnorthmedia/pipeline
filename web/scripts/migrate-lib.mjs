/**
 * The pipeline schema migration, as a library.
 *
 * `scripts/migrate.mjs` is the command (`pnpm db:migrate`) and
 * `scripts/predeploy.ts` is the deploy hook, and they run the same
 * `meta/_journal.json` walk through `drizzle-orm`: same sha256 file hashes,
 * same `drizzle.__drizzle_migrations` bookkeeping, so a database migrated by
 * either is migrated for both. `src/db/migration-scripts.test.ts` pins that
 * against drizzle-kit in both directions.
 *
 * A separate file from the command on purpose. The command used to hold both
 * halves and decide which it was with
 * `pathToFileURL(process.argv[1]).href === import.meta.url`, which esbuild
 * turns into a lie: bundled into `scripts/predeploy.mjs`, both sides of that
 * comparison are the bundle, so importing the migration ran it, unlocked,
 * before the hook took its advisory lock. Measured inside the built image, and
 * invisible on macOS, where `os.tmpdir()` sits behind a symlink that makes the
 * comparison false for the wrong reason.
 *
 * Deliberately `.mjs` and dependency-free beyond `drizzle-orm` and `pg`: it has
 * to load under bare node inside the runtime image, where there is no pnpm
 * script, no repo-root `.env` and no TypeScript loader for `src/`.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"

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

/**
 * Applies every unapplied migration in `drizzle/` and answers how many the
 * database has recorded in total.
 *
 * Takes the pool rather than the connection string, because the pre-deploy hook
 * holds an advisory lock across three migration steps and this is one of them.
 *
 * @param {import("pg").Pool} pool
 * @returns {Promise<number>} migrations recorded in `drizzle.__drizzle_migrations`
 */
export async function applyMigrations(pool) {
  await migrate(drizzle(pool), { migrationsFolder })
  const { rows } = await pool.query(
    'select count(*)::int as applied from drizzle."__drizzle_migrations"',
  )
  return rows[0].applied
}
