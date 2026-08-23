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
