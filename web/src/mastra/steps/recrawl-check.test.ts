// @vitest-environment node
/**
 * The pure half of the nightly re-crawl check (ledger item 5.2c-ii-2): the
 * decision of whether a profile is due. The database, scheduler and fan-out
 * half is `../workflows/recrawl-check.test.ts`.
 *
 * `data/recrawl-due-parity.json` is the oracle, produced by
 * `api/scripts/export_recrawl_parity.py`, which copies the branch out of
 * `check_recrawl_schedules` verbatim and runs it on the `api/` interpreter
 * against a fixed reference `now`.
 *
 * The case worth naming: a profile that has never been crawled is due even when
 * its interval is one the job does not recognise, because Python's
 * `if not profile.last_crawled_at` short-circuits before the interval is read.
 * The boundary cases are the other half of the value here, one second either
 * side of each of the three thresholds.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { isDue, RECRAWL_INTERVAL_DAYS } from "./recrawl-check"

interface DueCase {
  name: string
  recrawl_interval: string
  last_crawled_at: string | null
  enqueues: boolean
}

const oracle = JSON.parse(
  readFileSync(path.join(__dirname, "data", "recrawl-due-parity.json"), "utf-8"),
) as { python_version: string; now: string; cases: DueCase[] }

const NOW = new Date(oracle.now)

describe("the due decision", () => {
  it("has an oracle covering every branch of the Python job", () => {
    expect(oracle.cases.length).toBe(16)
  })

  it.each(oracle.cases)(
    "matches check_recrawl_schedules for $name",
    ({ recrawl_interval, last_crawled_at, enqueues }) => {
      const last = last_crawled_at === null ? null : new Date(last_crawled_at)
      expect(isDue(recrawl_interval, last, NOW)).toBe(enqueues)
    },
  )

  it("reads only its own intervals, not Object.prototype", () => {
    // `recrawl_interval` is an unconstrained varchar(20), so a client can send
    // "constructor". An object literal would resolve it to a function and the
    // `>= days` comparison would be silently false; a Map cannot.
    for (const hostile of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(RECRAWL_INTERVAL_DAYS.get(hostile)).toBeUndefined()
      expect(isDue(hostile, new Date(NOW.getTime() - 400 * 86_400_000), NOW)).toBe(false)
    }
  })

  it("keeps the three intervals the job understood", () => {
    expect([...RECRAWL_INTERVAL_DAYS.entries()]).toEqual([
      ["weekly", 7],
      ["biweekly", 14],
      ["monthly", 30],
    ])
  })
})
