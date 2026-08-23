/**
 * The Postgres advisory lock behind the shared-row locks in this directory.
 *
 * Several `settings` rows are process-global singletons: there is one
 * `api_keys` row for the whole database, and one global (`user_id IS NULL`)
 * `stage_models` row. Test files swap them for fixtures and restore them
 * afterwards, and vitest runs test files in parallel processes against one
 * database, so without coordination one file's restore lands while another is
 * mid-assertion.
 *
 * A session advisory lock serialises exactly the files that touch a given row
 * and nothing else, which is why this is preferred over turning off file
 * parallelism for the whole suite. The lock is held on a dedicated pooled
 * client for the lifetime of the file; if the process dies the connection
 * closes and Postgres releases it, so a crashed file cannot wedge the suite.
 *
 * A file that needs more than one of these must take them in the order they
 * are declared in `api-keys-row.ts` and `stage-models-row.ts`, so two files
 * cannot deadlock by taking the same pair in opposite orders.
 */
import type { PoolClient } from "pg"

import { getPool } from "@/db"

export interface RowLock {
  /** Blocks until this process owns the row. Call it first in `beforeAll`. */
  lock: () => Promise<void>
  /**
   * Releases the row. Call it last in `afterAll`, after restoring the row and
   * before `closeDb()`, which would otherwise hang waiting on the checked-out
   * client.
   */
  unlock: () => Promise<void>
}

/**
 * `key` is arbitrary but fixed. Advisory lock keys share one namespace per
 * database, so it only has to avoid colliding with another lock in this repo.
 */
export function createRowLock(key: number, label: string): RowLock {
  let client: PoolClient | undefined

  return {
    async lock() {
      if (client) throw new Error(`${label} lock already held by this process`)
      const held = await getPool().connect()
      try {
        await held.query("select pg_advisory_lock($1)", [key])
      } catch (error) {
        held.release()
        throw error
      }
      client = held
    },

    async unlock() {
      if (!client) return
      const held = client
      client = undefined
      try {
        await held.query("select pg_advisory_unlock($1)", [key])
      } finally {
        held.release()
      }
    },
  }
}
