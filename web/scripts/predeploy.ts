/**
 * The command Railway runs before a new deployment takes traffic:
 * `preDeployCommand` on both services in `.railway/railway.ts`.
 *
 * It brings the database to the shape the image about to start expects, in one
 * place and in one order:
 *
 *   1. the pipeline schema, the same `drizzle/` walk as `pnpm db:migrate`;
 *   2. the BetterAuth tables, the same DDL as `pnpm auth:migrate --apply`;
 *   3. the `mastra_*` run-state tables, which `@mastra/pg` otherwise builds on
 *      whichever process opens a store first (ledger item P2.99).
 *
 * All three run under one Postgres advisory lock, because both services run
 * this and Railway deploys them together. The lock is what makes step 3
 * meaningful rather than a second racer: whichever service arrives first
 * creates the tables, the other waits its turn and then finds nothing to do,
 * and neither `node server.js` nor `node .mastra/worker/index.mjs` starts until
 * its own service's hook has returned. Steps 1 and 2 are idempotent taken one
 * at a time but not taken at once: run unlocked against a fresh database, the
 * pair collide inside drizzle's own `CREATE TABLE IF NOT EXISTS
 * drizzle.__drizzle_migrations` before they ever reach the Mastra tables.
 *
 * This file is never run as it stands. `scripts/build-predeploy.mjs` bundles it
 * to `.next/standalone/scripts/predeploy.mjs`, which is what the runtime images
 * carry, because the packages it reaches (`better-auth`, `@better-auth/stripe`,
 * `stripe`, `resend`, `@mastra/pg`) are bundled into the Next server chunks and
 * are not resolvable from a sibling script in the standalone tree.
 * `src/db/predeploy.test.ts` runs that bundle from a directory with no
 * `node_modules` at all, which is the shape the image gives it.
 */
import { setTimeout as sleep } from "node:timers/promises"

import { getMigrations } from "better-auth/db/migration"
import type { PoolClient } from "pg"
import { Pool } from "pg"

import { auth } from "../src/lib/auth.ts"
import { ensureMastraStorage } from "../src/lib/mastra-storage.ts"

import { applyMigrations, databaseUrl } from "./migrate-lib.mjs"

/**
 * The advisory lock every copy of this command contends for.
 *
 * Session-scoped rather than transaction-scoped (`pg_advisory_xact_lock`)
 * because the three steps below are many transactions, not one. The value is
 * the ASCII codes of "jena" run together, which is a constant with a reason
 * rather than a number someone else might reuse by coincidence.
 */
const LOCK_KEY = 106101110097

/** How long the second service waits before giving up and failing its deploy. */
const LOCK_DEADLINE_MS = 5 * 60_000

/** Between polls, because a session that is waiting is the whole problem below. */
const LOCK_POLL_MS = 500

/**
 * Takes the lock by polling `pg_try_advisory_lock`, never by waiting in
 * `pg_advisory_lock`.
 *
 * The difference is not style. A session blocked inside `pg_advisory_lock` is
 * running a statement, so it holds a virtual transaction id, and `@mastra/pg`
 * builds `mastra_scores_trace_id_span_id_created_at_idx` with `CREATE INDEX
 * CONCURRENTLY`, which waits for every concurrent virtual transaction to
 * finish before it completes. Two services deploying together therefore wait
 * on each other for good: measured as `wait_event = advisory` on one connection
 * and `wait_event = virtualxid` on the other, with neither process ever
 * exiting. Polling leaves this connection `idle` between attempts, which holds
 * no virtual transaction and lets the index build finish.
 */
async function acquireLock(client: PoolClient): Promise<void> {
  const deadline = Date.now() + LOCK_DEADLINE_MS
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [LOCK_KEY],
    )
    if (rows[0].locked) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another deployment has held the pre-deploy lock ${LOCK_KEY} for ` +
          `${LOCK_DEADLINE_MS / 1000}s; refusing to migrate underneath it`,
      )
    }
    await sleep(LOCK_POLL_MS)
  }
}

async function migrateAuth(): Promise<string> {
  // The DDL comes from the installed better-auth and from `auth.options`, so it
  // matches the field mappings in `src/lib/auth.ts` and the plugins mounted
  // there. That is the same source `scripts/auth-migrate.mts` reads; this one
  // cannot shell out to that script, because the image has no TypeScript loader
  // and no `better-auth` it could resolve.
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options)
  const created = toBeCreated.map((table) => table.table)
  const added = toBeAdded.map((table) => `${table.table}.{${Object.keys(table.fields).join(", ")}}`)
  if (!created.length && !added.length) {
    return "auth schema up to date"
  }
  await runMigrations()
  return `auth schema updated: created ${created.join(", ") || "(none)"}; added ${added.join(", ") || "(none)"}`
}

async function main(): Promise<void> {
  // `src/lib/auth.ts` builds its own pool from `DATABASE_URL_SYNC` alone, so a
  // deployment that only sets `DATABASE_URL` would migrate the pipeline schema
  // here and the auth tables somewhere else. Refuse instead of splitting.
  if (!process.env.DATABASE_URL_SYNC) {
    throw new Error(
      "DATABASE_URL_SYNC must be set: the BetterAuth step reads it directly, so any other " +
        "spelling migrates the pipeline schema and the auth tables into different databases",
    )
  }
  const url = databaseUrl()

  // One connection for the lock and one pool for the work: a session-level
  // advisory lock belongs to the connection that took it, so it cannot be
  // handed back to a pool between steps.
  const lockPool = new Pool({ connectionString: url, max: 1 })
  const pool = new Pool({ connectionString: url })
  const lock = await lockPool.connect()
  try {
    await acquireLock(lock)
    console.log(`pre-deploy: holding advisory lock ${LOCK_KEY}`)

    const applied = await applyMigrations(pool)
    console.log(`pre-deploy: pipeline schema up to date, ${applied} migrations recorded`)

    console.log(`pre-deploy: ${await migrateAuth()}`)

    await ensureMastraStorage(url)
    console.log("pre-deploy: Mastra run-state tables ready")
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {})
    lock.release()
    await Promise.all([lockPool.end(), pool.end()])
  }
  console.log("pre-deploy: done")
}

await main()
// `src/lib/auth.ts` and `@mastra/pg` both leave pools and timers behind, and a
// pre-deploy hook that does not exit blocks the deployment.
process.exit(0)
