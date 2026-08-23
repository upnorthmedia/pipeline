/**
 * Cross-file mutual exclusion on the `settings.api_keys` row.
 *
 * Nothing ever writes an `api_keys` row with a `user_id`, and Alembic 012's
 * NULLS NOT DISTINCT constraint allows only one row without one, so there is
 * exactly one `api_keys` row for the whole database and no column to isolate a
 * test file on. Eight test files swap it for a fixture
 * encrypted under their own throwaway `WP_ENCRYPTION_KEY` and restore it
 * afterwards. Vitest runs test files in parallel processes against that one
 * shared database, so without coordination one file's restore lands while
 * another is mid-assertion and the reader either sees the wrong plaintext or
 * fails to decrypt at all.
 *
 * A Postgres session advisory lock serialises exactly those files and nothing
 * else, which is why this is preferred over turning off file parallelism for
 * the whole suite. The lock is held on a dedicated pooled client for the
 * lifetime of the file; if the process dies the connection closes and Postgres
 * releases it, so a crashed file cannot wedge the suite.
 */
import type { PoolClient } from "pg"

import { getPool } from "@/db"

/**
 * Arbitrary but fixed. Advisory lock keys share one namespace per database, so
 * this only has to avoid colliding with another lock in this repo, and nothing
 * else in it takes advisory locks.
 */
const API_KEYS_ROW_LOCK = 510_120_261

let client: PoolClient | undefined

/**
 * Blocks until this process owns the `api_keys` row. Call it first in
 * `beforeAll`, before reading the row to save it.
 */
export async function lockApiKeysRow(): Promise<void> {
  if (client) throw new Error("api_keys row lock already held by this process")
  const held = await getPool().connect()
  try {
    await held.query("select pg_advisory_lock($1)", [API_KEYS_ROW_LOCK])
  } catch (error) {
    held.release()
    throw error
  }
  client = held
}

/**
 * Releases the row. Call it last in `afterAll`, after restoring the row and
 * before `closeDb()`, which would otherwise hang waiting on the checked-out
 * client.
 */
export async function unlockApiKeysRow(): Promise<void> {
  if (!client) return
  const held = client
  client = undefined
  try {
    await held.query("select pg_advisory_unlock($1)", [API_KEYS_ROW_LOCK])
  } finally {
    held.release()
  }
}
