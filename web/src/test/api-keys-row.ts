/**
 * Cross-file mutual exclusion on the `settings.api_keys` row.
 *
 * Nothing ever writes an `api_keys` row with a `user_id`, and Alembic 012's
 * NULLS NOT DISTINCT constraint allows only one row without one, so there is
 * exactly one `api_keys` row for the whole database and no column to isolate a
 * test file on. Eight test files swap it for a fixture encrypted under their
 * own throwaway `WP_ENCRYPTION_KEY` and restore it afterwards, and vitest runs
 * those files in parallel processes against that one shared database. See
 * `row-lock.ts` for the mechanics and for the lock ordering rule; this is the
 * first lock in that order.
 */
import { createRowLock } from "./row-lock"

const apiKeysRow = createRowLock(510_120_261, "api_keys row")

/**
 * Blocks until this process owns the `api_keys` row. Call it first in
 * `beforeAll`, before reading the row to save it.
 */
export const lockApiKeysRow = apiKeysRow.lock

/**
 * Releases the row. Call it last in `afterAll`, after restoring the row and
 * before `closeDb()`, which would otherwise hang waiting on the checked-out
 * client.
 */
export const unlockApiKeysRow = apiKeysRow.unlock
