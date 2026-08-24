import { describe, expect, it } from "vitest"

import { buildRunTrace } from "./run-trace"
import type { PipelineStage, StageStatusMap } from "./api"

/** A `stage_complete` entry in the shape `announceStageComplete()` stores. */
function complete(
  stage: string,
  overrides: Record<string, unknown> = {},
  ts = "2026-08-23T10:00:00.000Z",
) {
  return {
    ts,
    stage,
    level: "info",
    event: "stage_complete",
    message: `Stage ${stage} complete`,
    data: {
      model: "claude-opus-4-6",
      tokens_in: 1000,
      tokens_out: 500,
      duration_s: 12.5,
      cost_usd: 0.0525,
      ...overrides,
    },
  }
}

function start(stage: string, ts = "2026-08-23T09:59:00.000Z") {
  return { ts, stage, level: "info", event: "stage_start", message: `Starting ${stage}...` }
}

function trace(
  entries: unknown[],
  stageStatus: StageStatusMap = {},
  liveStart: { stage: PipelineStage; at: string } | null = null,
) {
  return buildRunTrace({ entries, stageStatus, liveStart })
}

describe("buildRunTrace", () => {
  it("returns one pending row per stage for a post that has never run", () => {
    const result = trace([])
    expect(result.stages.map((row) => row.stage)).toEqual([
      "research",
      "outline",
      "write",
      "edit",
      "images",
      "ready",
    ])
    expect(result.stages.every((row) => row.status === "pending")).toBe(true)
    expect(result.totals).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, durationS: 0 })
    expect(result.runError).toBeNull()
  })

  it("reads the model, tokens, duration and cost a completed stage stored", () => {
    const result = trace([start("research"), complete("research")], { research: "complete" })
    expect(result.stages[0]).toMatchObject({
      status: "complete",
      model: "claude-opus-4-6",
      tokensIn: 1000,
      tokensOut: 500,
      durationS: 12.5,
      costUsd: 0.0525,
      startedAt: "2026-08-23T09:59:00.000Z",
      error: null,
    })
  })

  it("totals tokens, cost and stage duration across the run", () => {
    const result = trace(
      [
        complete("research", {
          tokens_in: 1000,
          tokens_out: 500,
          cost_usd: 0.0525,
          duration_s: 12.5,
        }),
        complete("outline", { tokens_in: 2000, tokens_out: 800, cost_usd: 0.09, duration_s: 7.25 }),
      ],
      { research: "complete", outline: "complete" },
    )
    expect(result.totals).toEqual({
      tokensIn: 3000,
      tokensOut: 1300,
      costUsd: 0.1425,
      durationS: 19.75,
    })
  })

  it("keeps the sum free of float noise", () => {
    const result = trace(
      [
        complete("research", { cost_usd: 0.000015, duration_s: 0.1 }),
        complete("outline", { cost_usd: 0.00009, duration_s: 0.2 }),
      ],
      { research: "complete", outline: "complete" },
    )
    expect(result.totals.costUsd).toBe(0.000105)
    expect(result.totals.durationS).toBe(0.3)
  })

  it("takes the status from the row rather than from the log", () => {
    const result = trace([start("research")], { research: "running" })
    expect(result.stages[0].status).toBe("running")
    expect(result.stages[0].durationS).toBeNull()
  })

  it("surfaces a suspension as its own status", () => {
    const result = trace([], { research: "complete", outline: "review" })
    expect(result.stages[1].status).toBe("review")
  })

  it("shows a stage failure with the recorded error text", () => {
    const result = trace(
      [
        start("write"),
        {
          ts: "2026-08-23T10:01:00.000Z",
          stage: "write",
          level: "error",
          event: "stage_error",
          message: "Pipeline failed after 3 attempts: provider timeout",
          data: { error: "provider timeout", attempts: 3, moved_to_dlq: true },
        },
      ],
      { write: "failed" },
    )
    expect(result.stages[2]).toMatchObject({ status: "failed", error: "provider timeout" })
    expect(result.runError).toBeNull()
  })

  it("surfaces a failure that named no stage at the run level", () => {
    const result = trace([
      {
        ts: "2026-08-23T10:01:00.000Z",
        stage: "",
        level: "error",
        event: "stage_error",
        message: "Pipeline failed after 3 attempts: worker died",
        data: { error: "worker died", attempts: 3, moved_to_dlq: true },
      },
    ])
    expect(result.runError).toBe("worker died")
    expect(result.stages.every((row) => row.error === null)).toBe(true)
  })

  it("keeps retries recorded before the attempt they caused", () => {
    const result = trace(
      [
        start("write", "2026-08-23T10:00:00.000Z"),
        {
          ts: "2026-08-23T10:00:30.000Z",
          stage: "write",
          level: "warning",
          event: "retry",
          message: "Pipeline attempt 1 failed, retrying...",
          data: { attempt: 1, max_attempts: 3, error: "429 rate limited" },
        },
        start("write", "2026-08-23T10:00:31.000Z"),
        complete("write", {}, "2026-08-23T10:01:00.000Z"),
      ],
      { write: "complete" },
    )
    const write = result.stages[2]
    expect(write.retries).toEqual([{ attempt: 1, maxAttempts: 3, error: "429 rate limited" }])
    expect(write.startedAt).toBe("2026-08-23T10:00:31.000Z")
    expect(write.status).toBe("complete")
  })

  it("drops a previous run's retries and numbers when the stage is started again", () => {
    const result = trace(
      [
        start("write", "2026-08-23T10:00:00.000Z"),
        {
          ts: "2026-08-23T10:00:30.000Z",
          stage: "write",
          level: "warning",
          event: "retry",
          message: "Pipeline attempt 1 failed, retrying...",
          data: { attempt: 1, max_attempts: 3, error: "429 rate limited" },
        },
        start("write", "2026-08-23T10:00:31.000Z"),
        complete("write", { tokens_in: 9, tokens_out: 9 }, "2026-08-23T10:01:00.000Z"),
        // A rerun days later: no retry immediately before it, so the previous
        // run's history goes with it.
        start("write", "2026-08-25T09:00:00.000Z"),
      ],
      { write: "running" },
    )
    const write = result.stages[2]
    expect(write.retries).toEqual([])
    expect(write.tokensIn).toBe(0)
    expect(write.model).toBeNull()
    expect(write.durationS).toBeNull()
    expect(write.startedAt).toBe("2026-08-25T09:00:00.000Z")
  })

  it("drops a completed stage's numbers once a rerun resets it to pending", () => {
    const result = trace(
      [start("edit"), complete("edit"), start("ready"), complete("ready")],
      // What `POST /rerun` writes for a rerun from `ready` on a finished post:
      // the stage goes back to pending while its `stage_complete` entry stays.
      { edit: "complete", ready: "pending" },
    )
    expect(result.stages[3]).toMatchObject({ status: "complete", tokensIn: 1000 })
    expect(result.stages[5]).toMatchObject({
      status: "pending",
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationS: null,
      startedAt: null,
    })
    expect(result.totals.tokensIn).toBe(1000)
  })

  it("drops them for a stage the row already calls running again", () => {
    const result = buildRunTrace({
      entries: [start("ready"), complete("ready")],
      // The `stage_start` SSE frame has arrived and set the status optimistically;
      // the entry it announces is not on the client until the next refetch.
      stageStatus: { ready: "running" },
      liveStart: { stage: "ready", at: "2026-08-23T11:00:00.000Z" },
    })
    expect(result.stages[5]).toMatchObject({
      status: "running",
      model: null,
      durationS: null,
      costUsd: 0,
      startedAt: "2026-08-23T11:00:00.000Z",
    })
  })

  it("keeps a completed stage's numbers when the row still calls it complete", () => {
    const result = trace([start("ready"), complete("ready")], { ready: "complete" })
    expect(result.stages[5]).toMatchObject({ status: "complete", tokensIn: 1000, durationS: 12.5 })
  })

  it("uses the live stage_start frame when no entry for it has been fetched yet", () => {
    const result = buildRunTrace({
      entries: [],
      stageStatus: { research: "running" },
      liveStart: { stage: "research", at: "2026-08-23T10:00:00.000Z" },
    })
    expect(result.stages[0].startedAt).toBe("2026-08-23T10:00:00.000Z")
  })

  it("prefers the stored start time over the live frame", () => {
    const result = buildRunTrace({
      entries: [start("research", "2026-08-23T09:59:00.000Z")],
      stageStatus: { research: "running" },
      liveStart: { stage: "research", at: "2026-08-23T10:00:00.000Z" },
    })
    expect(result.stages[0].startedAt).toBe("2026-08-23T09:59:00.000Z")
  })

  it("ignores entries that are not objects or carry no usable data", () => {
    const result = trace(
      [
        null,
        "junk",
        7,
        { event: "log", stage: "research", message: "loaded rules" },
        { stage: "research" },
      ],
      { research: "running" },
    )
    expect(result.stages[0]).toMatchObject({ status: "running", tokensIn: 0, model: null })
    expect(result.runError).toBeNull()
  })

  it("treats missing token and cost fields as zero rather than NaN", () => {
    const result = trace([{ ts: "x", stage: "images", event: "stage_complete", data: {} }], {
      images: "complete",
    })
    expect(result.stages[4]).toMatchObject({
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationS: null,
      model: null,
    })
    expect(result.totals.costUsd).toBe(0)
  })
})

/**
 * The publish leg. Both publish steps write their `execution_logs` entries
 * with `stage: ""`, so every one of them fell through the `!isStage` branch
 * above and the view built for watching a run said nothing about the last
 * thing a run does (ledger P3.2b-ii, `todo.md` P2.108).
 */
describe("buildRunTrace publish leg", () => {
  const WP_START = {
    ts: "2026-08-23T11:00:00.000Z",
    stage: "",
    level: "info",
    event: "publish_start",
    message: "Publishing to WordPress...",
    data: { target: "wordpress" },
  }
  const WP_COMPLETE = {
    ts: "2026-08-23T11:00:09.000Z",
    stage: "",
    level: "info",
    event: "publish_complete",
    message: "Published to WordPress: https://example.com/?p=900",
    data: { target: "wordpress" },
  }
  const WP_ERROR = {
    ts: "2026-08-23T11:00:04.500Z",
    stage: "",
    level: "error",
    event: "publish_error",
    message: "WordPress publish failed: 401 Unauthorized",
    data: { target: "wordpress" },
  }

  it("reports no publish leg for a post whose format names no destination", () => {
    expect(trace([WP_START, WP_COMPLETE]).publish).toBeNull()
  })

  it("reads the destination's status off the row, as the stages do", () => {
    const result = buildRunTrace({
      entries: [],
      stageStatus: {},
      publish: { target: "wordpress", status: "pending" },
    })
    expect(result.publish).toEqual({
      target: "wordpress",
      status: "pending",
      startedAt: null,
      durationS: null,
      error: null,
    })
  })

  it("maps the publishing column onto a running leg with its start time", () => {
    const result = buildRunTrace({
      entries: [WP_START],
      stageStatus: {},
      publish: { target: "wordpress", status: "publishing" },
    })
    expect(result.publish).toMatchObject({
      status: "running",
      startedAt: "2026-08-23T11:00:00.000Z",
      durationS: null,
      error: null,
    })
  })

  it("times a finished publish from its own two entries", () => {
    const result = buildRunTrace({
      entries: [WP_START, WP_COMPLETE],
      stageStatus: {},
      publish: { target: "wordpress", status: "published" },
    })
    expect(result.publish).toMatchObject({ status: "complete", durationS: 9, error: null })
  })

  it("carries the reason a failed publish recorded, stripped of its destination prefix", () => {
    const result = buildRunTrace({
      entries: [WP_START, WP_ERROR],
      stageStatus: {},
      publish: { target: "wordpress", status: "failed" },
    })
    expect(result.publish).toMatchObject({
      status: "failed",
      durationS: 4.5,
      error: "401 Unauthorized",
    })
  })

  it("drops a superseded failure once a later attempt succeeded", () => {
    const result = buildRunTrace({
      entries: [WP_START, WP_ERROR, WP_START, WP_COMPLETE],
      stageStatus: {},
      publish: { target: "wordpress", status: "published" },
    })
    expect(result.publish).toMatchObject({ status: "complete", error: null, durationS: 9 })
  })

  it("ignores entries belonging to the other destination", () => {
    const result = buildRunTrace({
      entries: [WP_START, WP_ERROR],
      stageStatus: {},
      publish: { target: "nextjs", status: "failed" },
    })
    expect(result.publish).toMatchObject({ target: "nextjs", startedAt: null, error: null })
  })

  it("attributes an entry stored before data.target by the prefix its message carries", () => {
    // Both halves matter: the prefix is the only thing that identifies a
    // historic entry's destination, so without it the WordPress failure below
    // would be read as the Next.js leg's.
    const historic = {
      ts: "2026-08-23T11:00:00.000Z",
      stage: "",
      event: "publish_error",
      message: "WordPress publish failed: 401 Unauthorized",
    }
    expect(
      buildRunTrace({
        entries: [historic],
        stageStatus: {},
        publish: { target: "wordpress", status: "failed" },
      }).publish,
    ).toMatchObject({ status: "failed", error: "401 Unauthorized" })
    expect(
      buildRunTrace({
        entries: [historic],
        stageStatus: {},
        publish: { target: "nextjs", status: "failed" },
      }).publish,
    ).toMatchObject({ target: "nextjs", error: null })
  })

  it("does not carry the previous attempt's reason into a retry that is still running", () => {
    const result = buildRunTrace({
      entries: [WP_START, WP_ERROR, WP_START],
      stageStatus: {},
      publish: { target: "wordpress", status: "publishing" },
    })
    expect(result.publish).toMatchObject({ status: "running", error: null, durationS: null })
  })

  it("leaves the stage totals alone: a publish is not a stage and costs no tokens", () => {
    const result = buildRunTrace({
      entries: [start("ready"), complete("ready"), WP_START, WP_COMPLETE],
      stageStatus: { ready: "complete" },
      publish: { target: "wordpress", status: "published" },
    })
    expect(result.totals).toEqual({
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.0525,
      durationS: 12.5,
    })
  })

  it("does not read a publish entry as the run-level failure", () => {
    const result = buildRunTrace({
      entries: [WP_ERROR],
      stageStatus: {},
      publish: { target: "wordpress", status: "failed" },
    })
    expect(result.runError).toBeNull()
  })
})

/** An `image_generated` / `image_failed` entry, in the shape the fan-out stores. */
function image(
  outcome: "generated" | "failed",
  index: number,
  ts = "2026-08-23T10:00:10.000Z",
) {
  return outcome === "generated"
    ? {
        ts,
        stage: "images",
        level: "info",
        event: "image_generated",
        message: `Image ${index} generated (91231 bytes)`,
        data: { index, bytes: 91231, path: `/media/p1/image-${index}.png` },
      }
    : {
        ts,
        stage: "images",
        level: "error",
        event: "image_failed",
        message: `Image ${index} failed: 429 RESOURCE_EXHAUSTED`,
        data: { index, error: "429 RESOURCE_EXHAUSTED" },
      }
}

/**
 * Item P3.2c. The `images` stage is the only one whose work is a fan-out, so
 * it is the only one where "running" hides a count: five images can be four
 * successes and a failure and the stage still finishes.
 */
describe("buildRunTrace image progress", () => {
  it("counts the fan-out's per-image entries onto the images row", () => {
    const result = trace(
      [start("images"), image("generated", 0), image("generated", 1), image("failed", 2)],
      { images: "running" },
    )
    expect(result.stages[4].images).toEqual({ generated: 2, failed: 1 })
  })

  it("leaves every other stage's progress null, because only images fans out", () => {
    const result = trace([start("images"), image("generated", 0)], { images: "running" })
    expect(result.stages.filter((row) => row.stage !== "images").map((row) => row.images)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it("leaves images null when the stage has published no per-image line yet", () => {
    expect(trace([start("images")], { images: "running" }).stages[4].images).toBeNull()
  })

  it("takes the last outcome for an index, so a retried image counts once", () => {
    const result = trace(
      [start("images"), image("failed", 1), image("generated", 1)],
      { images: "complete" },
    )
    expect(result.stages[4].images).toEqual({ generated: 1, failed: 0 })
  })

  it("counts entries that carry no index separately rather than collapsing them", () => {
    const result = trace(
      [
        start("images"),
        { ts: "2026-08-23T10:00:10.000Z", stage: "images", event: "image_failed", message: "x" },
        { ts: "2026-08-23T10:00:11.000Z", stage: "images", event: "image_failed", message: "y" },
      ],
      { images: "complete" },
    )
    expect(result.stages[4].images).toEqual({ generated: 0, failed: 2 })
  })

  it("drops a previous attempt's images when the stage starts again", () => {
    const result = trace(
      [
        start("images", "2026-08-23T09:00:00.000Z"),
        image("generated", 0, "2026-08-23T09:00:10.000Z"),
        image("generated", 1, "2026-08-23T09:00:11.000Z"),
        start("images", "2026-08-23T10:00:00.000Z"),
        image("failed", 0, "2026-08-23T10:00:10.000Z"),
      ],
      { images: "running" },
    )
    expect(result.stages[4].images).toEqual({ generated: 0, failed: 1 })
  })

  it("drops the counts of a stage the row has since disowned", () => {
    // `POST /rerun` resets the stage to `pending` and deletes its files, but
    // `execution_logs` is append-only, so the finished attempt's per-image
    // lines are still the last thing the log says about it.
    const result = trace(
      [start("images"), image("generated", 0), complete("images")],
      { images: "pending" },
    )
    expect(result.stages[4].images).toBeNull()
  })

  it("folds the live frames in with the stored ones without counting an index twice", () => {
    const result = buildRunTrace({
      entries: [start("images"), image("generated", 0)],
      stageStatus: { images: "running" },
      liveImages: [
        { index: 0, outcome: "generated" },
        { index: 1, outcome: "failed" },
      ],
    })
    expect(result.stages[4].images).toEqual({ generated: 1, failed: 1 })
  })

  it("shows live progress for a stage whose stored trail has not been refetched yet", () => {
    const result = buildRunTrace({
      entries: [],
      stageStatus: { images: "running" },
      liveStart: { stage: "images", at: "2026-08-23T10:00:00.000Z" },
      liveImages: [{ index: 0, outcome: "generated" }],
    })
    expect(result.stages[4].images).toEqual({ generated: 1, failed: 0 })
  })

  it("drops the stored attempt when the live restart is newer than it", () => {
    // The retry button re-runs one stage. The `stage_start` frame lands
    // immediately; the row's log still describes the attempt before it, and
    // nothing refetches until the stage ends.
    const result = buildRunTrace({
      entries: [
        start("images", "2026-08-23T09:00:00.000Z"),
        image("generated", 0, "2026-08-23T09:00:10.000Z"),
        image("generated", 1, "2026-08-23T09:00:11.000Z"),
      ],
      stageStatus: { images: "running" },
      liveStart: { stage: "images", at: "2026-08-23T10:00:00.000Z" },
      liveImages: [{ index: 0, outcome: "generated" }],
    })
    expect(result.stages[4].images).toEqual({ generated: 1, failed: 0 })
  })

  it("keeps the stored attempt when the live start belongs to it", () => {
    const result = buildRunTrace({
      entries: [
        start("images", "2026-08-23T10:00:00.000Z"),
        image("generated", 0, "2026-08-23T10:00:10.000Z"),
      ],
      stageStatus: { images: "running" },
      liveStart: { stage: "images", at: "2026-08-23T09:59:59.000Z" },
      liveImages: [],
    })
    expect(result.stages[4].images).toEqual({ generated: 1, failed: 0 })
  })
})
