// @vitest-environment node
/**
 * Proves the two documented commands that build a database actually run.
 *
 * `drizzle/README.md` and `CLAUDE.md` both tell a reader to bring a fresh
 * database up with `pnpm db:migrate` followed by `pnpm auth:migrate --apply`,
 * and ledger item P2.77 is about running that pair on deploy. Nothing executed
 * either as a command, so `src/db/baseline-parity.test.ts` could stay green off
 * the same migration folder while the script wrapping it was unrunnable.
 *
 * These cases spawn the real scripts against a scratch database, which is the
 * only thing that catches a break in the entry point rather than in the schema.
 *
 * Requires the dev database from `docker compose up -d db redis`; the
 * connection string comes from the repo-root `.env` (`DATABASE_URL_SYNC`).
 */
import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { databaseUrl } from "../../scripts/migrate.mjs"

import { toNodePostgresUrl } from "./index"

const run = promisify(execFile)

/** Rebuilt from scratch on every run, so its name must never collide with a real database. */
const SCRATCH_DB = "content_pipeline_migrate_check"

/** The same, for the drizzle-kit half of the bookkeeping comparison. */
const KIT_SCRATCH_DB = "content_pipeline_migrate_check_kit"

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const devUrl =
  process.env.DATABASE_URL_SYNC?.replace("postgresql+asyncpg://", "postgresql://") ??
  "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"

/** Swap the database name on the dev connection string, keeping host and credentials. */
function withDatabase(name: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${name}`
  return url.toString()
}

const scratchUrl = withDatabase(SCRATCH_DB)
const kitUrl = withDatabase(KIT_SCRATCH_DB)

/**
 * The child gets the scratch connection string and nothing else that could
 * point it at the dev database. `applyRepoRootEnv()` and node's `--env-file`
 * both leave an already-set variable alone, so `DATABASE_URL_SYNC` here wins
 * over the repo-root `.env` the scripts load for themselves.
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL_SYNC: scratchUrl,
    DATABASE_URL: scratchUrl,
  }
}

/** The rows both migration commands write, in the order they were applied. */
async function migrationLedger(pool: Pool): Promise<{ hash: string; created_at: string }[]> {
  const { rows } = await pool.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at::text FROM drizzle."__drizzle_migrations" ORDER BY created_at',
  )
  return rows
}

async function tableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  )
  return rows.map((r) => r.table_name).sort()
}

let scratchPool: Pool

beforeAll(async () => {
  // CREATE DATABASE cannot run inside the target database, so drive it from `postgres`.
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`)
  } finally {
    await admin.end()
  }
  scratchPool = new Pool({ connectionString: scratchUrl })
}, 60_000)

afterAll(async () => {
  await scratchPool?.end()
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
})

describe("the documented fresh-database commands", () => {
  it("pnpm db:migrate builds the pipeline schema", async () => {
    await run("pnpm", ["db:migrate"], { cwd: webDir, env: childEnv() })
    expect(await tableNames(scratchPool)).toContain("posts")
  }, 120_000)

  it("runs as bare node with no pnpm and no repo-root .env, which is the deploy shape", async () => {
    // What a Railway `preDeployCommand` gets: no pnpm script, no `--env-file`,
    // and a working directory with no `../.env` beside it. `pnpm db:migrate`
    // is this same script with the repo-root `.env` loaded first, so if this
    // spelling cannot start, nothing can migrate a database on deploy.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "db-migrate-"))
    const { stdout } = await run("node", [path.join(webDir, "scripts/migrate.mjs")], {
      cwd: elsewhere,
      env: childEnv(),
    })
    expect(stdout).toMatch(/schema up to date: [1-9]\d* migrations recorded/)
  }, 120_000)

  it("agrees with drizzle-kit on the migration bookkeeping, in both directions", async () => {
    // `pnpm db:migrate` was `drizzle-kit migrate` until ledger item P2.77b, so
    // every database that already exists was built by that command and must not
    // be re-migrated by this one. Both walk `meta/_journal.json` and record a
    // sha256 of each file in `drizzle.__drizzle_migrations`; this asserts the
    // two really do write the same rows rather than assuming it.
    const admin = new Pool({ connectionString: withDatabase("postgres") })
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${KIT_SCRATCH_DB} WITH (FORCE)`)
      await admin.query(`CREATE DATABASE ${KIT_SCRATCH_DB}`)
    } finally {
      await admin.end()
    }
    const kitEnv = { ...childEnv(), DATABASE_URL_SYNC: kitUrl, DATABASE_URL: kitUrl }
    const kitPool = new Pool({ connectionString: kitUrl })
    try {
      await run("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: webDir, env: kitEnv })
      const afterKit = await migrationLedger(kitPool)
      expect(afterKit).toEqual(await migrationLedger(scratchPool))

      // The old command's database, handed to the new one: nothing to apply.
      await run("node", [path.join(webDir, "scripts/migrate.mjs")], { cwd: webDir, env: kitEnv })
      expect(await migrationLedger(kitPool)).toEqual(afterKit)

      // And the new command's database, handed back to the old one.
      await run("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: webDir, env: childEnv() })
      expect(await migrationLedger(scratchPool)).toEqual(afterKit)
    } finally {
      await kitPool.end()
      const cleanup = new Pool({ connectionString: withDatabase("postgres") })
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${KIT_SCRATCH_DB} WITH (FORCE)`)
      } finally {
        await cleanup.end()
      }
    }
  }, 180_000)

  it("pnpm auth:migrate --apply builds the BetterAuth tables", async () => {
    await run("pnpm", ["auth:migrate", "--apply"], { cwd: webDir, env: childEnv() })
    expect(await tableNames(scratchPool)).toEqual(
      expect.arrayContaining(["auth_accounts", "auth_sessions", "auth_users", "auth_verifications"]),
    )
  }, 120_000)

  it("pnpm auth:migrate is idempotent, which is what a pre-deploy hook needs", async () => {
    const { stdout } = await run("pnpm", ["auth:migrate"], { cwd: webDir, env: childEnv() })
    expect(stdout).toContain("schema is up to date")
  }, 120_000)

  it("auth:migrate runs where there is no repo-root .env, which is every image", async () => {
    // The deployed image carries no `.env`: Railway and compose inject the
    // environment directly. A hard `--env-file` makes the script exit before it
    // reads a single variable, so this drives it from a directory that has no
    // `../.env` beside it, with the connection string in the environment only.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "auth-migrate-"))
    const { stdout } = await run("node", [path.join(webDir, "scripts/auth-migrate.mts")], {
      cwd: elsewhere,
      env: childEnv(),
    })
    expect(stdout).toContain("schema is up to date")
  }, 120_000)
})

describe("the deploy script's connection string", () => {
  // `scripts/migrate.mjs` cannot import `src/db/index.ts` (that module reaches
  // `./schema` with no file extension, which bare node will not resolve), so it
  // carries its own copy of the same two lines. These hold the copy to the
  // original.
  const CASES = [
    "postgresql://pipeline:pipeline@localhost:5435/content_pipeline",
    "postgresql+asyncpg://pipeline:pipeline@db:5432/content_pipeline",
    "postgresql+psycopg://pipeline:pipeline@db:5432/content_pipeline",
  ]

  for (const url of CASES) {
    it(`normalises ${url.split("://")[0]} the way src/db/index.ts does`, () => {
      expect(databaseUrl({ DATABASE_URL_SYNC: url })).toBe(toNodePostgresUrl(url))
    })
  }

  it("prefers DATABASE_URL_SYNC and falls back to DATABASE_URL", () => {
    expect(databaseUrl({ DATABASE_URL_SYNC: CASES[0], DATABASE_URL: CASES[1] })).toBe(CASES[0])
    expect(databaseUrl({ DATABASE_URL: CASES[1] })).toBe(toNodePostgresUrl(CASES[1]))
  })

  it("refuses to run against nothing rather than a default", () => {
    expect(() => databaseUrl({})).toThrow(/DATABASE_URL_SYNC/)
  })
})
