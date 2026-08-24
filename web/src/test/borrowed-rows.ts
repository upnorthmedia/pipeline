/**
 * Borrowing a set of global `settings` rows for the duration of a test file.
 *
 * Some `settings` rows are process-global singletons: Alembic 012's NULLS NOT
 * DISTINCT constraint allows exactly one row per key with a null `user_id`,
 * and that is the row production code reads. A test file that needs a fixture
 * in one of them is writing it for every other file running at the same time,
 * so it takes the row's lock first (`row-lock.ts`) and puts the row back
 * afterwards.
 *
 * Mutual exclusion alone is not enough when the row being borrowed is a live
 * credential. A file that held its snapshot in memory and wrote it back in
 * `afterAll` lost the developer's real value outright whenever the process
 * died in between, and the next run then snapshotted the placeholder the dead
 * run had left and made it permanent. That is not hypothetical: the
 * `api_keys` row was lost that way during the port and had to be recovered
 * from the Postgres WAL.
 *
 * So the snapshot lives in the database, not in the borrower's memory: a
 * borrow writes the pre-borrow values into a backup row in the same table, and
 * a return reads them back from there and drops the backup. A borrower that
 * dies leaves the backup behind, and the next borrower finds it and repairs
 * the rows before taking its own snapshot. Recovery needs no live process, and
 * the value restored is always the last one written from outside a borrow
 * rather than whatever a dead run left.
 */
import { and, eq, isNull } from "drizzle-orm"

import { getDb, settings } from "@/db"

import { createRowLock } from "./row-lock"

/** One backed-up row: its value, or `null` when the row did not exist. */
type SavedRow = { value: unknown } | null

type Backup = Record<string, SavedRow>

export interface BorrowedRows {
  /**
   * Takes the rows for this process. Call it first in `beforeAll`, before
   * reading or writing any of them. `encryptionKey` is set on
   * `WP_ENCRYPTION_KEY` for the borrow and restored by `giveBack()`, so a file
   * whose fixtures are encrypted under a throwaway key does not have to
   * remember to put the real one back.
   */
  borrow: (options?: { encryptionKey?: string }) => Promise<void>
  /**
   * Puts the rows back and releases the lock. Call it last in `afterAll`,
   * before `closeDb()`, which would otherwise hang waiting on the client the
   * lock is held on.
   */
  giveBack: () => Promise<void>
  /**
   * Releases the lock without putting anything back, standing in for a
   * borrower whose process died. Only `borrowed-rows.test.ts` calls this: it
   * is how the recovery path is exercised without killing a vitest worker.
   */
  abandonForTest: () => Promise<void>
  /** The backup row's key, so a test can assert the backup is cleaned up. */
  backupKey: string
}

async function readGlobal(key: string): Promise<SavedRow> {
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), isNull(settings.userId)))
    .limit(1)
  return rows.length ? { value: rows[0].value } : null
}

async function writeGlobal(key: string, saved: SavedRow): Promise<void> {
  if (!saved) {
    await getDb()
      .delete(settings)
      .where(and(eq(settings.key, key), isNull(settings.userId)))
    return
  }
  const value = saved.value as object
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

/**
 * `lockKey` is arbitrary but fixed, and shares one namespace per database with
 * every other advisory lock in this repo. `backupKey` is a `settings` key no
 * production code reads.
 */
export function createBorrowedRows(config: {
  lockKey: number
  label: string
  keys: readonly string[]
  backupKey: string
}): BorrowedRows {
  const lock = createRowLock(config.lockKey, config.label)
  /** Present with `value: undefined` is a real state: the variable was unset. */
  let savedEncryptionKey: { value: string | undefined } | undefined

  async function readBackup(): Promise<Backup | undefined> {
    const saved = await readGlobal(config.backupKey)
    return saved ? (saved.value as Backup) : undefined
  }

  function restoreEncryptionKey() {
    if (!savedEncryptionKey) return
    const { value } = savedEncryptionKey
    savedEncryptionKey = undefined
    if (value === undefined) delete process.env.WP_ENCRYPTION_KEY
    else process.env.WP_ENCRYPTION_KEY = value
  }

  return {
    backupKey: config.backupKey,

    async borrow(options = {}) {
      await lock.lock()
      try {
        const leftover = await readBackup()
        if (leftover) {
          // A previous borrower died before giving the rows back. Its backup
          // holds the values from before that borrow, so those are the ones to
          // restore, and they stay the backup for this borrow too.
          for (const key of config.keys) await writeGlobal(key, leftover[key] ?? null)
        } else {
          const backup: Backup = {}
          for (const key of config.keys) backup[key] = await readGlobal(key)
          await writeGlobal(config.backupKey, { value: backup })
        }

        if (options.encryptionKey !== undefined) {
          savedEncryptionKey = { value: process.env.WP_ENCRYPTION_KEY }
          process.env.WP_ENCRYPTION_KEY = options.encryptionKey
        }
      } catch (error) {
        await lock.unlock()
        throw error
      }
    },

    async giveBack() {
      try {
        const backup = await readBackup()
        if (backup) {
          for (const key of config.keys) await writeGlobal(key, backup[key] ?? null)
          await writeGlobal(config.backupKey, null)
        }
      } finally {
        restoreEncryptionKey()
        await lock.unlock()
      }
    },

    async abandonForTest() {
      savedEncryptionKey = undefined
      await lock.unlock()
    },
  }
}
