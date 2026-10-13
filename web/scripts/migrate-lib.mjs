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
import { readMigrationFiles } from "drizzle-orm/migrator"

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
 * A reason to stop that the operator can act on, printed as one sentence
 * instead of a stack. `scripts/migrate.mjs` prints `message` and exits 1.
 */
export class MigrationHalted extends Error {
  constructor(message) {
    super(message)
    this.name = "MigrationHalted"
  }
}

/** The bookkeeping `drizzle-orm`'s own migrator creates, verbatim. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`

/**
 * The Postgres codes a first migration hits when the objects it creates are
 * already there: duplicate table, schema, object (a constraint or a type) and
 * column. `pg` puts the driver error under `cause` when drizzle wraps it.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isAlreadyPresent(error) {
  const codes = new Set(["42P07", "42P06", "42710", "42701"])
  for (let current = error; current; current = current.cause) {
    if (codes.has(current.code)) return true
  }
  return false
}

const ADOPT_HINT =
  "This database already has the pipeline tables but records no migration, which is what a " +
  "database carried over from the Python stack looks like.\n" +
  "Record the migrations it already has, without running any of them:\n\n" +
  "  pnpm db:migrate --baseline\n"

/**
 * The number of migrations `drizzle.__drizzle_migrations` records, creating the
 * bookkeeping if the database has none.
 *
 * @param {import("pg").Pool} pool
 * @returns {Promise<number>}
 */
async function recordedMigrations(pool) {
  await pool.query('CREATE SCHEMA IF NOT EXISTS "drizzle"')
  await pool.query(MIGRATIONS_TABLE)
  const { rows } = await pool.query(
    'select count(*)::int as applied from drizzle."__drizzle_migrations"',
  )
  return rows[0].applied
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
  try {
    await migrate(drizzle(pool), { migrationsFolder })
  } catch (error) {
    // The baseline is the whole schema, so a database that already has the
    // tables fails inside its first statement. That is a state with a remedy,
    // not a bug, and a `DrizzleQueryError` stack says none of it (P4.8).
    if (isAlreadyPresent(error)) throw new MigrationHalted(ADOPT_HINT)
    throw error
  }
  const { rows } = await pool.query(
    'select count(*)::int as applied from drizzle."__drizzle_migrations"',
  )
  return rows[0].applied
}

/**
 * Records every migration in `drizzle/` as applied without running one of them,
 * for a database that already has the schema they build.
 *
 * The rows are the ones `applyMigrations` would have written: the same sha256
 * of each file and the same `meta/_journal.json` timestamp, so a database
 * adopted here and a database built from empty are indistinguishable
 * afterwards, and the next real migration applies to both.
 *
 * It refuses a database that is already recording migrations, which is what
 * keeps the flag from being a way to mark an unapplied migration as done, and a
 * database with no pipeline tables, which needs the migrations run rather than
 * recorded.
 *
 * @param {import("pg").Pool} pool
 * @returns {Promise<number>} migrations recorded
 */
export async function baselineMigrations(pool) {
  const applied = await recordedMigrations(pool)
  if (applied > 0) {
    throw new MigrationHalted(
      `This database already records ${applied} migrations, so there is nothing to adopt. ` +
        "Run `pnpm db:migrate` to apply whatever is outstanding.",
    )
  }
  const { rows } = await pool.query("select to_regclass('public.posts') as present")
  if (!rows[0].present) {
    throw new MigrationHalted(
      "This database has no pipeline tables, so there is nothing to adopt. " +
        "Run `pnpm db:migrate` to build it.",
    )
  }

  const files = readMigrationFiles({ migrationsFolder })
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    for (const file of files) {
      await client.query(
        'insert into drizzle."__drizzle_migrations" (hash, created_at) values ($1, $2)',
        [file.hash, file.folderMillis],
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return files.length
}
