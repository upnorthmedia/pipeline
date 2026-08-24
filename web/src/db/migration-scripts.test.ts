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

const run = promisify(execFile)

/** Rebuilt from scratch on every run, so its name must never collide with a real database. */
const SCRATCH_DB = "content_pipeline_migrate_check"

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
