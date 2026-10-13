// @vitest-environment node
/**
 * Item 5.5c-ii: the run-level `pipeline_start` entry.
 *
 * Python wrote one line to `execution_logs` before it did anything else, gated
 * on `is_full_pipeline` (`api/src/worker.py:117`). It is the only record that a
 * full run was ever started: a run that dies before its first stage commits
 * leaves `current_stage` reading whatever it read before, and without this
 * entry `GET /api/posts/{id}/logs` would show nothing at all for it.
 *
 * Against the real database, because the subject is a column write and the
 * assertions worth making are that it lands, that it lands exactly once, and
 * that it disturbs nothing else on the row.
 *
 * The head-of-chain assertion is here too. The entry has to precede every
 * stage's `stage_start`, and the only thing that guarantees that is the step's
 * position in the registered workflow, so the position is asserted rather than
 * assumed. The real runs that prove the ordering end to end are in
 * `../pipeline-events.test.ts`.
 *
 * Requires `docker compose up -d db`.
 */
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { pipelineWorkflow } from "../workflows/pipeline"
import { pipelineStartStep } from "./pipeline-start"

const POST_ID = "00000000-0000-4000-8000-0000000055d1"

const db = getDb()

type ExecuteParams = Parameters<typeof pipelineStartStep.execute>[0]

async function runStep(input: { postId: string; stages?: ("research" | "edit")[] }) {
  return await pipelineStartStep.execute({ inputData: input } as unknown as ExecuteParams)
}

async function readRow() {
  const [row] = await db.select().from(posts).where(eq(posts.id, POST_ID))
  return row
}

beforeEach(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({ id: POST_ID, slug: "pipeline-start", topic: "starting" })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("a run with no stage selection", () => {
  it("writes Python's pipeline_start entry and nothing else", async () => {
    await runStep({ postId: POST_ID })
    const logs = (await readRow()).executionLogs as Record<string, unknown>[]
    expect(logs).toHaveLength(1)
    // `stage` is `""`: this entry is about the run, and `GET /logs` filtering by
    // stage is meant to skip it. The message is Python's string verbatim, since
    // `debug-log-panel.tsx` renders it straight into the log line.
    expect(logs[0]).toMatchObject({
      stage: "",
      level: "info",
      event: "pipeline_start",
      message: "Full pipeline run initiated",
    })
    // Python passed no `data`, and `append_execution_log`'s `if data:` meant the
    // key was absent rather than empty.
    expect("data" in logs[0]).toBe(false)
  })

  it("leaves the columns that describe where the run is alone", async () => {
    const before = await readRow()
    await runStep({ postId: POST_ID })
    const after = await readRow()
    expect(after.currentStage).toBe(before.currentStage)
    expect(after.stageStatus).toEqual(before.stageStatus)
    expect(after.stageLogs).toEqual(before.stageLogs)
    // `appendExecutionLog` deliberately does not stamp `updated_at`, matching
    // Python's raw-SQL append, so a started run does not reorder the posts list.
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  it("passes its input through unchanged, so the chain is untouched", async () => {
    const input = { postId: POST_ID }
    expect(await runStep(input)).toEqual(input)
  })
})

describe("a run that names its stages", () => {
  it("writes nothing, because Python gated the entry on is_full_pipeline", async () => {
    await runStep({ postId: POST_ID, stages: ["edit"] })
    expect((await readRow()).executionLogs).toEqual([])
  })

  it("still passes its input through, selection included", async () => {
    const input = { postId: POST_ID, stages: ["edit"] as ("research" | "edit")[] }
    expect(await runStep(input)).toEqual(input)
  })
})

describe("the step's position in the registered workflow", () => {
  it("is the head of the chain, ahead of research", () => {
    const ids = pipelineWorkflow.stepGraph.map((entry) =>
      entry.type === "step" ? entry.step.id : entry.type,
    )
    expect(ids[0]).toBe("pipeline-start")
    expect(ids.indexOf("pipeline-start")).toBeLessThan(ids.indexOf("research"))
  })
})
