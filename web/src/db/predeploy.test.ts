// @vitest-environment node
/**
 * Ledger item P2.77b-ii: the pre-deploy hook, run the way a deployment runs it.
 *
 * `src/db/migration-scripts.test.ts` proves the two documented commands work
 * from a `web/` checkout, where `node_modules` is one directory up and holds
 * everything. The image is not that: `/app` is the Next standalone output, its
 * `node_modules` holds only what file tracing copied, and `better-auth`,
 * `@better-auth/stripe`, `stripe`, `resend` and `@mastra/pg` are not reachable
 * from `/app/scripts` at all. So these cases build the bundle
 * `scripts/build-predeploy.mjs` produces, put it in a directory that has no
 * `node_modules` anywhere above it, and run it as a command against a scratch
 * database with nothing but environment variables.
 *
 * Requires the dev database from `docker compose up -d db redis`; the
 * connection string comes from the repo-root `.env` (`DATABASE_URL_SYNC`).
 */
import { execFile } from "node:child_process"
import { cp, mkdtemp, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { bundlePredeploy, predeployBundlePath } from "../../scripts/build-predeploy.mjs"

const run = promisify(execFile)

/** Rebuilt on every run, so their names must never collide with a real database. */
const SCRATCH_DB = "content_pipeline_predeploy_check"
/** A second one, because the concurrency case needs a database nothing has touched. */
const RACE_DB = "content_pipeline_predeploy_race"

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const devUrl = (
  process.env.DATABASE_URL_SYNC ?? "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"
).replace("postgresql+asyncpg://", "postgresql://")

function withDatabase(name: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${name}`
  return url.toString()
}

async function recreate(name: string): Promise<void> {
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
}

async function drop(name: string): Promise<void> {
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}

/**
 * The shape `/app` has: the bundle under `scripts/`, the migration folder
 * beside it, and no `node_modules` on the way up to the filesystem root. A
 * `package.json` with no dependencies is what stops Node walking out of the
 * temporary directory into the repository's own modules.
 */
let deployRoot: string
/** A working directory with nothing in it, because Railway sets none. */
let elsewhere: string

/**
 * Everything the hook is given on Railway and nothing else. `BETTER_AUTH_SECRET`
 * comes from the suite's own environment because `src/lib/auth.ts` refuses to
 * load without one, which is the same requirement the `web` service has.
 */
function childEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    DATABASE_URL_SYNC: databaseUrl,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  }
}

function bundleFile(): string {
  return path.join(deployRoot, predeployBundlePath)
}

async function tableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  )
  return rows.map((r) => r.table_name).sort()
}

let scratchPool: Pool

beforeAll(async () => {
  // Resolved, not as `mkdtemp` returns it. On macOS `os.tmpdir()` sits behind a
  // symlink, so `process.argv[1]` and the module's own `import.meta.url` differ
  // by that link and any `argv[1] === import.meta.url` check inside the bundle
  // quietly answers false. Linux has no such link, and neither does the image,
  // so an unresolved path here is a test that cannot see what a deploy would.
  deployRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "predeploy-image-")))
  elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "predeploy-cwd-")))
  await writeFile(
    path.join(deployRoot, "package.json"),
    JSON.stringify({ name: "standalone-stand-in", type: "module", private: true }),
  )
  await cp(path.join(webDir, "drizzle"), path.join(deployRoot, "drizzle"), { recursive: true })
  await bundlePredeploy(bundleFile())

  await recreate(SCRATCH_DB)
  scratchPool = new Pool({ connectionString: withDatabase(SCRATCH_DB) })
}, 120_000)

afterAll(async () => {
  await scratchPool?.end()
  await drop(SCRATCH_DB)
  await drop(RACE_DB)
})

describe("the pre-deploy hook, run the way an image runs it", () => {
  it("builds the whole schema under bare node with no node_modules to resolve", async () => {
    const { stdout } = await run("node", [bundleFile()], {
      cwd: elsewhere,
      env: childEnv(withDatabase(SCRATCH_DB)),
    })

    // Nothing before the lock. `scripts/migrate.mjs` used to hold both the
    // command and the migration and tell them apart with
    // `pathToFileURL(process.argv[1]).href === import.meta.url`; bundled, both
    // sides of that are this bundle, so importing the migration ran it,
    // unlocked, before the lock was ever taken. Measured in the built image as
    // `schema up to date: 4 migrations recorded from /app/drizzle` printed
    // above the first `pre-deploy:` line. `scripts/migrate-lib.mjs` is the fix.
    expect(stdout.trim().split("\n")[0]).toContain("holding advisory lock")

    // All three steps, which is the point of one hook rather than three.
    expect(stdout).toMatch(/pipeline schema up to date, [1-9]\d* migrations recorded/)
    expect(stdout).toContain("auth schema updated")
    expect(stdout).toContain("Mastra run-state tables ready")

    const tables = await tableNames(scratchPool)
    expect(tables).toEqual(
      expect.arrayContaining([
        // The pipeline schema.
        "posts",
        "website_profiles",
        // BetterAuth, which `pnpm auth:migrate --apply` writes on a laptop.
        "auth_accounts",
        "auth_sessions",
        "auth_users",
        "auth_verifications",
        // Mastra run state, which nothing but a running process used to create.
        "mastra_workflow_snapshot",
      ]),
    )
  }, 180_000)

  it("is idempotent, because every deploy of either service runs it", async () => {
    const { stdout } = await run("node", [bundleFile()], {
      cwd: elsewhere,
      env: childEnv(withDatabase(SCRATCH_DB)),
    })
    expect(stdout).toContain("auth schema up to date")
    expect(stdout).toContain("pre-deploy: done")
  }, 180_000)

  it("refuses a deployment that names the database some other way", async () => {
    // `src/lib/auth.ts` reads `DATABASE_URL_SYNC` directly, so a hook that
    // accepted `DATABASE_URL` alone would migrate the pipeline schema into one
    // database and the auth tables into another.
    const env = { ...childEnv(withDatabase(SCRATCH_DB)) }
    delete env.DATABASE_URL_SYNC
    await expect(
      run("node", [bundleFile()], { cwd: elsewhere, env }),
    ).rejects.toThrow(/DATABASE_URL_SYNC must be set/)
  }, 60_000)

  it("survives both services deploying at once, which is what Railway does", async () => {
    // The kill check is the advisory lock in `scripts/predeploy.ts`. Measured
    // with it removed: one of the two exits 1 on `duplicate key value violates
    // unique constraint "pg_type_typname_nsp_index"` inside drizzle's own
    // `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations`, before either
    // reaches `@mastra/pg`'s first-init DDL (ledger item P2.99), which fails
    // the deploy of whichever service lost.
    await recreate(RACE_DB)
    const both = await Promise.allSettled([
      run("node", [bundleFile()], { cwd: elsewhere, env: childEnv(withDatabase(RACE_DB)) }),
      run("node", [bundleFile()], { cwd: elsewhere, env: childEnv(withDatabase(RACE_DB)) }),
    ])
    const failures = both
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason))
    expect(failures).toEqual([])

    const racePool = new Pool({ connectionString: withDatabase(RACE_DB) })
    try {
      const { rows } = await racePool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
        ["idx_knowledge_nodes_identity"],
      )
      expect(rows.map((r) => r.indexname)).toEqual(["idx_knowledge_nodes_identity"])
      expect(await tableNames(racePool)).toEqual(expect.arrayContaining(["posts", "auth_users"]))
    } finally {
      await racePool.end()
    }
  }, 300_000)
})
