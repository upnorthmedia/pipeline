// @vitest-environment node
/**
 * Ledger item P0.3a: borrowing a global `settings` row cannot destroy what was
 * in it, including when the borrowing process dies mid-file.
 *
 * The scenario in the last test is the one that happened for real during the
 * port: a file snapshotted the encrypted `api_keys` row, wrote a placeholder
 * over it, died before restoring, and the next run snapshotted the placeholder
 * and wrote it back as if it were the developer's keys. The row was only
 * recovered because the loss was noticed inside the Postgres WAL retention
 * window.
 *
 * This exercises the real `createBorrowedRows` code on its own throwaway
 * `settings` keys and its own advisory lock, so it never touches `api_keys`
 * and cannot collide with the files that borrow it.
 *
 * Requires `docker compose up -d db redis`.
 */
import { and, eq, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import { createBorrowedRows } from "./borrowed-rows"

const FIRST_KEY = "borrowed_rows__test_subject_a"
const SECOND_KEY = "borrowed_rows__test_subject_b"
const BACKUP_KEY = "borrowed_rows__test_backup"

const rows = createBorrowedRows({
  lockKey: 510_120_299,
  label: "borrowed-rows test subject",
  keys: [FIRST_KEY, SECOND_KEY],
  backupKey: BACKUP_KEY,
})

/** What a human put in the row before any test borrowed it. */
const REAL_VALUE = { anthropic: "gAAAAA-standing-in-for-a-real-fernet-token" }

async function read(key: string): Promise<unknown | undefined> {
  const found = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), isNull(settings.userId)))
    .limit(1)
  return found.length ? found[0].value : undefined
}

async function write(key: string, value: object): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

async function wipe(): Promise<void> {
  for (const key of [FIRST_KEY, SECOND_KEY, BACKUP_KEY]) {
    await getDb()
      .delete(settings)
      .where(and(eq(settings.key, key), isNull(settings.userId)))
  }
}

beforeEach(wipe)

afterEach(async () => {
  // A failing test leaves the lock held, and `closeDb()` would then hang on
  // the client it is held on, hiding the assertion behind a hook timeout.
  await rows.abandonForTest()
  await wipe()
})

afterAll(async () => {
  await closeDb()
})

describe("createBorrowedRows", () => {
  it("puts back the value the row held before the borrow", async () => {
    await write(FIRST_KEY, REAL_VALUE)

    await rows.borrow()
    await write(FIRST_KEY, { anthropic: "sk-ant-not-a-real-key" })
    await rows.giveBack()

    expect(await read(FIRST_KEY)).toEqual(REAL_VALUE)
  })

  it("deletes a row the borrower created that was not there before", async () => {
    expect(await read(SECOND_KEY)).toBeUndefined()

    await rows.borrow()
    await write(SECOND_KEY, { anthropic: false })
    await rows.giveBack()

    expect(await read(SECOND_KEY)).toBeUndefined()
  })

  it("leaves no backup row behind once the rows are given back", async () => {
    await write(FIRST_KEY, REAL_VALUE)

    await rows.borrow()
    expect(await read(BACKUP_KEY)).toBeDefined()
    await rows.giveBack()

    expect(await read(BACKUP_KEY)).toBeUndefined()
  })

  it("restores WP_ENCRYPTION_KEY, including when it was unset", async () => {
    const saved = process.env.WP_ENCRYPTION_KEY
    delete process.env.WP_ENCRYPTION_KEY
    try {
      await rows.borrow({ encryptionKey: "not-a-real-fernet-key" })
      expect(process.env.WP_ENCRYPTION_KEY).toBe("not-a-real-fernet-key")
      await rows.giveBack()
      expect("WP_ENCRYPTION_KEY" in process.env).toBe(false)

      process.env.WP_ENCRYPTION_KEY = "the-developers-key"
      await rows.borrow({ encryptionKey: "not-a-real-fernet-key" })
      await rows.giveBack()
      expect(process.env.WP_ENCRYPTION_KEY).toBe("the-developers-key")
    } finally {
      if (saved === undefined) delete process.env.WP_ENCRYPTION_KEY
      else process.env.WP_ENCRYPTION_KEY = saved
    }
  })

  it("repairs the rows a dead borrower left behind instead of adopting its placeholder", async () => {
    await write(FIRST_KEY, REAL_VALUE)

    // A borrow that never returns: the process is killed with the placeholder
    // in the row, which is what a ctrl-c during `pnpm test` leaves.
    await rows.borrow()
    await write(FIRST_KEY, { anthropic: "sk-ant-not-a-real-key" })
    await rows.abandonForTest()

    // The next run. It must not snapshot the placeholder, or the placeholder
    // becomes the value every later run restores.
    await rows.borrow()
    expect(await read(FIRST_KEY)).toEqual(REAL_VALUE)
    await write(FIRST_KEY, { anthropic: "sk-ant-not-a-real-key" })
    await rows.giveBack()

    expect(await read(FIRST_KEY)).toEqual(REAL_VALUE)
    expect(await read(BACKUP_KEY)).toBeUndefined()
  })
})
