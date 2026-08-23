// @vitest-environment node
/**
 * The full-pipeline completion hook (item 4.7b), ported from
 * `_post_completion_hook` in `api/src/worker.py:426` and the
 * `if is_full_pipeline:` block at `api/src/worker.py:277` that calls it.
 *
 * A full run ends by stamping the post finished: `current_stage = "complete"`
 * and `completed_at = now()`. Until this item there was nothing at the end of
 * the chain at all, so a full run left `current_stage` reading whichever stage
 * happened to run last and `completed_at` null for good, which is the pair the
 * dashboard reads to tell a finished post from one still moving.
 *
 * Four real runs, one per branch of the rule:
 *
 * 1. **Full run that finishes.** Five stages already complete, no selection.
 *    Both columns must be set.
 * 2. **Named-stage run.** Same shape of post, but `stages: ["edit"]`. Python
 *    gated the hook on `if is_full_pipeline`, so `current_stage` is promoted by
 *    the rerun check (item 4.2b) while `completed_at` must stay null. This is
 *    the pair that keeps the two paths distinguishable.
 * 3. **Full run with nothing left to do.** All six stages already complete, so
 *    every step skips and no provider is called. Python's hook is outside the
 *    stage loop and runs regardless, so both columns must still be stamped.
 * 4. **Full run parked at a review gate.** The hook is the last step in the
 *    chain, so a suspended run must not reach it: a post that reported itself
 *    complete while still waiting on its reviewer would be worse than one that
 *    reported nothing.
 *
 * The three runs that finish also carry item 5.4c-ii's evidence: the step is
 * where `_record_job_completed()` lands, so a run that reaches it must leave a
 * fresh `mastra:worker:last_completed`. The key is deleted immediately before
 * each of those runs, so "the worker recorded this run" is distinguishable
 * from "the key was already set".
 *
 * The suspended run deliberately carries no matching negative. The key is
 * global to the Redis instance and vitest runs files in parallel, so another
 * file's run completing during this one would flip it; the fact it would be
 * asserting, that a suspended run never reaches the step at all, is already
 * pinned by that run's null `completed_at` below.
 *
 * Auto-publish, the other half of `_post_completion_hook`, depends on the
 * `wordpress` and `nextjs` routers and belongs to Phase 5. It is deliberately
 * not asserted here.
 *
 * Every provider boundary is stubbed and nothing else. The database, Redis and
 * the evented engine are real. Own `Mastra` instance and own Redis key prefix,
 * for the reason `pipeline.test.ts` records.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { createClient } from "redis"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import { editAgent } from "../agents/edit"
import { imagesAgent } from "../agents/images"
import { outlineAgent } from "../agents/outline"
import { readyAgent } from "../agents/ready"
import { researchAgent } from "../agents/research"
import { writeAgent } from "../agents/write"
import { CURRENT_STAGE_COMPLETE, STAGES, STATUS_COMPLETE, STATUS_REVIEW } from "../state"
import { WORKER_LAST_COMPLETED_KEY, readLastCompleted } from "../worker-health"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

/** Stage -> the text its stubbed agent returns. */
const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify({ version: "1.0", images: [] }),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

const FULL_RUN_POST_ID = "00000000-0000-4000-8000-00000000061a"
const NAMED_RUN_POST_ID = "00000000-0000-4000-8000-00000000061b"
const NOTHING_TO_DO_POST_ID = "00000000-0000-4000-8000-00000000061c"
const GATED_POST_ID = "00000000-0000-4000-8000-00000000061d"
/**
 * Ids have to be unique across the whole suite, not just this file. Vitest runs
 * files in parallel, so two files seeding the same row delete and re-insert it
 * underneath each other: the first draft of this file reused
 * `review-gates.test.ts`'s ids and both files went intermittently red, this one
 * reporting runs that suspended on gates it never configured.
 */
const POST_IDS = [
  FULL_RUN_POST_ID,
  NAMED_RUN_POST_ID,
  NOTHING_TO_DO_POST_ID,
  GATED_POST_ID,
]

/** Every stage but `edit`, so a run has exactly one stage left to do. */
const ALL_BUT_EDIT = STAGES.filter((stage) => stage !== "edit")

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:completion-hook",
})
const storage = new PostgresStore({ id: "pipeline-completion-test", pool: getPool() })
const agents = {
  research: researchAgent,
  outline: outlineAgent,
  write: writeAgent,
  edit: editAgent,
  images: imagesAgent,
  ready: readyAgent,
} as const
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  agents,
})

type PipelineResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof pipelineWorkflow.createRun>>["start"]>
>

const results: Record<string, PipelineResult> = {}

/** `edit`'s quality warnings, captured rather than printed. See `rerun-completion.test.ts`. */
let warnings: string[]
/** Where the `images` stage writes, so a run cannot touch the repo's `media/`. */
let mediaRootDir: string
/** Reads and clears the key the completion step writes, independent of it. */
let health: ReturnType<typeof createClient>

function seedValues(postId: string, complete: readonly string[], gatedStage?: string) {
  return {
    id: postId,
    slug: `pipeline-completion-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    completedAt: null,
    // Explicit, because the column's database default predates the gate removal
    // and still reads five stages as `"review"`; see `rerun-completion.test.ts`.
    stageSettings: Object.fromEntries(
      STAGES.map((stage) => [stage, stage === gatedStage ? STATUS_REVIEW : "auto"]),
    ),
    stageStatus: Object.fromEntries(complete.map((stage) => [stage, STATUS_COMPLETE])),
    researchContent: "seeded research",
    outlineContent: "seeded outline",
    draftContent: "seeded draft",
    finalMdContent: "seeded final markdown",
    readyContent: "seeded ready",
    imageManifest: { seeded: true },
  }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

async function run(postId: string, stages?: readonly string[]) {
  const workflowRun = await pipelineWorkflow.createRun()
  return await workflowRun.start({
    inputData: stages ? { postId, stages: stages as never } : { postId },
  })
}

/** Item 5.4c-ii: what the run left at `mastra:worker:last_completed`. */
const completionStamps: Record<string, { startedAt: number; recorded: string | null }> = {}

async function runRecordingCompletion(
  name: string,
  postId: string,
  stages?: readonly string[],
) {
  await health.del(WORKER_LAST_COMPLETED_KEY)
  const startedAt = Date.now()
  const result = await run(postId, stages)
  completionStamps[name] = {
    startedAt,
    recorded: await readLastCompleted({ client: health }),
  }
  return result
}

beforeAll(async () => {
  health = createClient({ url: process.env.REDIS_URL! })
  await health.connect()

  mediaRootDir = await mkdtemp(path.join(tmpdir(), "pipeline-completion-"))
  process.env.MEDIA_DIR = mediaRootDir

  warnings = []
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation(((message: string) => {
    warnings.push(message)
  }) as never)
  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => ({
      text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
      response: { modelId: `stub-${stage}` },
      usage: { inputTokens: 100, outputTokens: 20 },
    })) as never)
  }

  for (const postId of POST_IDS) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await db.insert(posts).values(seedValues(FULL_RUN_POST_ID, ALL_BUT_EDIT))
  await db.insert(posts).values(seedValues(NAMED_RUN_POST_ID, ALL_BUT_EDIT))
  await db.insert(posts).values(seedValues(NOTHING_TO_DO_POST_ID, STAGES))
  await db.insert(posts).values(seedValues(GATED_POST_ID, ALL_BUT_EDIT, "edit"))

  await storage.init()
  await testMastra.startWorkers()

  results.fullRun = await runRecordingCompletion("fullRun", FULL_RUN_POST_ID)
  results.namedRun = await runRecordingCompletion("namedRun", NAMED_RUN_POST_ID, ["edit"])
  results.nothingToDo = await runRecordingCompletion("nothingToDo", NOTHING_TO_DO_POST_ID)
  // No wait for the snapshot the way `review-gates.test.ts` does: nothing here
  // resumes the run, and the only row read afterwards is one `reviewGate`
  // commits before the step calls `suspend()`.
  results.gated = await run(GATED_POST_ID)
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await health.del(WORKER_LAST_COMPLETED_KEY)
  await health.close()
  for (const postId of POST_IDS) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("a full run that finishes", () => {
  it("succeeds", () => {
    expect(results.fullRun.status).toBe("success")
  })

  it("promotes current_stage to complete", async () => {
    const row = await readPost(FULL_RUN_POST_ID)

    expect(row.currentStage).toBe(CURRENT_STAGE_COMPLETE)
  })

  it("stamps completed_at", async () => {
    const row = await readPost(FULL_RUN_POST_ID)

    expect(row.completedAt).toBeInstanceOf(Date)
  })

  it("still committed the stage it ran", async () => {
    const row = await readPost(FULL_RUN_POST_ID)

    expect(row.finalMdContent).toBe(AGENT_TEXT.edit)
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })

  it("reports the stage's quality warnings on the post's own log, not to the logger", async () => {
    // Item 5.5c-iv-c moved these off `logger.warn` and onto
    // `publish_stage_log(..., level="warning")`, which is where Python wrote
    // them. The logger assertion is the other half of that: a warning that
    // still reached it would mean the stage reports the same problem twice.
    const row = await readPost(FULL_RUN_POST_ID)
    const stored = (row.executionLogs ?? []) as Record<string, unknown>[]
    const reported = stored
      .filter((entry) => entry.event === "log" && entry.level === "warning")
      .map((entry) => String(entry.message))

    expect(reported.some((message) => message.startsWith("Flesch reading ease"))).toBe(true)
    expect(reported.some((message) => message.startsWith("SEO checks still failing"))).toBe(true)
    expect(warnings).toEqual([])
  })

  it("records the run as the worker's last completed job", () => {
    const { startedAt, recorded } = completionStamps.fullRun

    expect(recorded).not.toBeNull()
    expect(Date.parse(recorded!)).toBeGreaterThanOrEqual(startedAt)
  })
})

describe("a named-stage run that finishes the post", () => {
  it("succeeds", () => {
    expect(results.namedRun.status).toBe("success")
  })

  /**
   * The rerun check (item 4.2b) owns `current_stage` on this path, and it does
   * not touch `completed_at`. Python gated the hook on `if is_full_pipeline`,
   * so a rerun of a single stage must not restamp the finish time of a post
   * that was finished days ago.
   */
  it("promotes current_stage without stamping completed_at", async () => {
    const row = await readPost(NAMED_RUN_POST_ID)

    expect(row.currentStage).toBe(CURRENT_STAGE_COMPLETE)
    expect(row.completedAt).toBeNull()
  })

  /**
   * The pair that makes this run different from the full one: Python gated the
   * `completed_at` stamp on `is_full_pipeline` and left
   * `_record_job_completed()` outside it, so a single-stage rerun records a
   * completed job while leaving the post's own finish time alone.
   */
  it("still records the run as the worker's last completed job", () => {
    const { startedAt, recorded } = completionStamps.namedRun

    expect(recorded).not.toBeNull()
    expect(Date.parse(recorded!)).toBeGreaterThanOrEqual(startedAt)
  })
})

describe("a full run with every stage already complete", () => {
  it("succeeds", () => {
    expect(results.nothingToDo.status).toBe("success")
  })

  /**
   * Every step skips, so nothing in the chain writes a content column. Python's
   * hook sits outside the stage loop and runs anyway, which is what makes
   * re-running a finished post a no-op that still reads as finished.
   */
  it("stamps both columns even though no stage ran", async () => {
    const row = await readPost(NOTHING_TO_DO_POST_ID)

    expect(row.currentStage).toBe(CURRENT_STAGE_COMPLETE)
    expect(row.completedAt).toBeInstanceOf(Date)
    expect(row.finalMdContent).toBe("seeded final markdown")
  })

  it("records the run as the worker's last completed job", () => {
    const { startedAt, recorded } = completionStamps.nothingToDo

    expect(recorded).not.toBeNull()
    expect(Date.parse(recorded!)).toBeGreaterThanOrEqual(startedAt)
  })
})

describe("a full run parked at a review gate", () => {
  it("suspends", () => {
    expect(results.gated.status).toBe("suspended")
  })

  /**
   * The hook is the last step in the chain, so this is what stops a post
   * waiting on its reviewer from reporting itself finished.
   */
  it("leaves the post unfinished", async () => {
    const row = await readPost(GATED_POST_ID)

    expect(row.currentStage).toBe("edit")
    expect(row.completedAt).toBeNull()
  })
})
