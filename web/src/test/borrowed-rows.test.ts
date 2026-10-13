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
import fs from "node:fs"
import path from "node:path"

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

/** When they put it there. Any stamp far enough from now to be unambiguous. */
const EDITED_AT = new Date("2026-07-04T09:15:00.000Z")

async function read(key: string): Promise<unknown | undefined> {
  const found = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), isNull(settings.userId)))
    .limit(1)
  return found.length ? found[0].value : undefined
}

async function readUpdatedAt(key: string): Promise<Date | null | undefined> {
  const found = await getDb()
    .select({ updatedAt: settings.updatedAt })
    .from(settings)
    .where(and(eq(settings.key, key), isNull(settings.userId)))
    .limit(1)
  return found.length ? found[0].updatedAt : undefined
}

async function write(key: string, value: object): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

/**
 * A write shaped like the ones the borrowers make. `PUT /api/settings` and
 * every test file that borrows a row set `updated_at` alongside `value`, so a
 * placeholder written the lazy way would not exercise the restore at all.
 */
async function writeLikeTheApp(key: string, value: object): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: [settings.key, settings.userId],
      set: { value, updatedAt: new Date() },
    })
}

async function stamp(key: string, updatedAt: Date): Promise<void> {
  await getDb()
    .update(settings)
    .set({ updatedAt })
    .where(and(eq(settings.key, key), isNull(settings.userId)))
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

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

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

  it("puts back the row's own updated_at, not the moment of the restore", async () => {
    // `GET /api/settings` serves `updated_at` for every row, so a borrow that
    // restored the value under a fresh stamp would still have changed what the
    // settings page reports about when a human last touched the row.
    await write(FIRST_KEY, REAL_VALUE)
    await stamp(FIRST_KEY, EDITED_AT)

    await rows.borrow()
    await writeLikeTheApp(FIRST_KEY, { anthropic: "sk-ant-not-a-real-key" })
    await rows.giveBack()

    expect(await readUpdatedAt(FIRST_KEY)).toEqual(EDITED_AT)
  })

  it("puts back the updated_at a dead borrower left behind too", async () => {
    await write(FIRST_KEY, REAL_VALUE)
    await stamp(FIRST_KEY, EDITED_AT)

    await rows.borrow()
    await writeLikeTheApp(FIRST_KEY, { anthropic: "sk-ant-not-a-real-key" })
    await rows.abandonForTest()

    await rows.borrow()
    await rows.giveBack()

    expect(await readUpdatedAt(FIRST_KEY)).toEqual(EDITED_AT)
  })

  it("clears the rows on request and still puts them back", async () => {
    // What a file asserting on a default needs: the borrow alone leaves
    // whatever a human put in the row, and the assertion would be about that.
    await write(FIRST_KEY, REAL_VALUE)
    await stamp(FIRST_KEY, EDITED_AT)

    await rows.borrow({ clear: true })
    expect(await read(FIRST_KEY)).toBeUndefined()
    await rows.giveBack()

    expect(await read(FIRST_KEY)).toEqual(REAL_VALUE)
    expect(await readUpdatedAt(FIRST_KEY)).toEqual(EDITED_AT)
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

describe("the lock is reachable only through a borrow", () => {
  // Holding the lock is not the part that protects the row. A file that took
  // it, remembered the pre-borrow value in a module variable and wrote it back
  // in `afterAll` is exactly what lost the developer's `api_keys` row during
  // the port, and the same shape was still on the `stage_models` row until
  // P2.89. So `row-lock.ts` has one importer, and it is the module that keeps
  // the snapshot in the database.
  it("is imported by borrowed-rows.ts and nothing else", () => {
    const root = path.join(process.cwd(), "src")
    const importers = sourceFiles(root)
      .filter((file) => /from\s+"(?:[./][^"]*|@\/test\/)row-lock"/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
      .sort()

    expect(importers).toEqual(["test/borrowed-rows.ts"])
  })
})
