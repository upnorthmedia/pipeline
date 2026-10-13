/**
 * The borrow of the `settings.api_keys` row.
 *
 * Nothing ever writes an `api_keys` row with a `user_id`, and Alembic 012's
 * NULLS NOT DISTINCT constraint allows only one row without one, so there is
 * exactly one `api_keys` row for the whole database and no column to isolate a
 * test file on. Nine test files swap it for a fixture encrypted under their
 * own throwaway `WP_ENCRYPTION_KEY`, and vitest runs those files in parallel
 * processes against that one shared database.
 *
 * `api_keys_validation` is a global singleton read by the same settings page
 * and is borrowed alongside, so a file that touches only one of the two cannot
 * leave the other behind.
 *
 * See `borrowed-rows.ts` for why the snapshot lives in the database rather
 * than in the borrower's memory, and `row-lock.ts` for the lock ordering rule.
 * This is the first lock in that order.
 */
import { API_KEYS_SETTING_KEY, API_KEYS_VALIDATION_SETTING_KEY } from "@/mastra/api-keys"

import { createBorrowedRows } from "./borrowed-rows"

const apiKeysRow = createBorrowedRows({
  lockKey: 510_120_261,
  label: "api_keys row",
  keys: [API_KEYS_SETTING_KEY, API_KEYS_VALIDATION_SETTING_KEY],
  backupKey: "api_keys__test_borrow_backup",
})

/**
 * Takes the `api_keys` row for this process. Call it first in `beforeAll`,
 * passing the throwaway Fernet key the file's fixtures are encrypted under.
 */
export const borrowApiKeysRow = apiKeysRow.borrow

/**
 * Puts the row back and releases it. Call it last in `afterAll`, before
 * `closeDb()`, which would otherwise hang waiting on the checked-out client.
 */
export const returnApiKeysRow = apiKeysRow.giveBack
