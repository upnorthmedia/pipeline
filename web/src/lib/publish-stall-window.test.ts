// @vitest-environment node
/**
 * Ledger item P4.3. `PUBLISH_STALL_AFTER_MS` is not a taste judgement about
 * how long a publish may take: it is the transport's own reclaim window, and
 * the two have to stay equal or the banner starts lying in one of two
 * directions.
 *
 * Below the window, a publish that has gone quiet may still be recoverable
 * without the reader: `RedisStreamsPubSub`'s reclaim loop `XAUTOCLAIM`s a step
 * message once its consumer has held it for `reclaimIdleMs`, and re-delivers
 * it to a live worker. Calling that stalled would offer a retry for something
 * about to finish on its own, and a WordPress retry is not free: the step
 * creates a second post when the first attempt died before recording
 * `wp_post_id`. Above the window, either no worker is alive to reclaim it or
 * the reclaimed copy went quiet too, and nothing is going to move the row.
 *
 * The value is read out of the source text rather than imported, because
 * `src/mastra/index.ts` builds the Mastra instance at module scope: importing
 * it here would open a Postgres store and a Redis connection to assert on a
 * number.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { PUBLISH_STALL_AFTER_MS } from "./publish-report"

describe("the publish stall window", () => {
  it("is the reclaim window the transport actually uses", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/mastra/index.ts"),
      "utf8",
    )
    const declaration = /export const RECLAIM_IDLE_MS = (\d[\d_]*) \* (\d[\d_]*)/.exec(source)
    expect(declaration, "RECLAIM_IDLE_MS is no longer declared as `<n> * <n>`").not.toBeNull()

    const reclaimIdleMs =
      Number(declaration![1].replaceAll("_", "")) * Number(declaration![2].replaceAll("_", ""))
    expect(reclaimIdleMs).toBe(PUBLISH_STALL_AFTER_MS)
  })
})
