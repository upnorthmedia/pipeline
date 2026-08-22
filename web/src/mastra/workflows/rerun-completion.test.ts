// @vitest-environment node
/**
 * The single-stage rerun completion check (item 4.2b), ported from
 * `api/src/worker.py:234`.
 *
 * `current_stage` is the column the dashboard reads to say where a post is. A
 * full pipeline run leaves it at the last stage it ran and the completion hook
 * at the end of the run promotes it to `"complete"`. A run that names its
 * stages never reaches that hook, so Python re-read `stage_status` after every
 * named stage and promoted `current_stage` the moment the selection filled the
 * last gap. Without it, rerunning `edit` on a post whose other five stages are
 * complete would leave the row reading `current_stage = "edit"` for good.
 *
 * Four real runs, on four posts, one per branch of the rule:
 *
 * 1. **Fills the last gap.** Five stages complete, `stages: ["edit"]`.
 *    `current_stage` must end as `"complete"`, not `"edit"`.
 * 2. **Leaves a gap.** Four stages complete with `edit` and `ready` missing,
 *    `stages: ["edit"]`. `current_stage` must stay `"edit"`: the promotion is
 *    conditional on every stage, not on the one that just ran.
 * 3. **Fills the last gap from inside the nested workflow.** Five stages
 *    complete, `stages: ["images"]`. `images` is three steps and a fan-out
 *    rather than one step, so its promotion is a separate code path from the
 *    other five stages'.
 * 4. **Full run.** Five stages complete, no selection. The stage runs, but the
 *    promotion must not happen here, because Python gated it on
 *    `if not is_full_pipeline` and the full path's own completion hook (which
 *    also stamps `completed_at` and queues publishing) is not ported yet.
 *    Promoting here would half-complete a post: `current_stage` saying
 *    `"complete"` with `completed_at` still null.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import { editAgent } from "../agents/edit"
import { imagesAgent } from "../agents/images"
import { outlineAgent } from "../agents/outline"
import { readyAgent } from "../agents/ready"
import { researchAgent } from "../agents/research"
import { writeAgent } from "../agents/write"
import { STAGES, STATUS_COMPLETE } from "../state"
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

const FILLS_GAP_POST_ID = "00000000-0000-4000-8000-0000000004b1"
const LEAVES_GAP_POST_ID = "00000000-0000-4000-8000-0000000004b2"
const IMAGES_POST_ID = "00000000-0000-4000-8000-0000000004b3"
const FULL_RUN_POST_ID = "00000000-0000-4000-8000-0000000004b4"
const POST_IDS = [FILLS_GAP_POST_ID, LEAVES_GAP_POST_ID, IMAGES_POST_ID, FULL_RUN_POST_ID]

/** Every stage but `edit`, so a run naming `edit` fills the last gap. */
const ALL_BUT_EDIT = STAGES.filter((stage) => stage !== "edit")
/** Also missing `ready`, so a run naming `edit` cannot complete the post. */
const ALL_BUT_EDIT_AND_READY = ALL_BUT_EDIT.filter((stage) => stage !== "ready")
/** Every stage but `images`, so a run naming `images` fills the last gap. */
const ALL_BUT_IMAGES = STAGES.filter((stage) => stage !== "images")

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:rerun-completion",
})
const storage = new PostgresStore({ id: "rerun-completion-test", pool: getPool() })
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

/**
 * `edit`'s quality warnings, captured rather than printed. The stubbed draft is
 * three lines long, so every readability and SEO check it runs fails; letting
 * those reach stderr would bury a real warning from a later change.
 */
let warnings: string[]
/** Where the `images` stage writes, so a run cannot touch the repo's `media/`. */
let mediaRootDir: string

function seedValues(postId: string, complete: readonly string[]) {
  return {
    id: postId,
    slug: `rerun-completion-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
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

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "rerun-completion-"))
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
  await db.insert(posts).values(seedValues(FILLS_GAP_POST_ID, ALL_BUT_EDIT))
  await db.insert(posts).values(seedValues(LEAVES_GAP_POST_ID, ALL_BUT_EDIT_AND_READY))
  await db.insert(posts).values(seedValues(IMAGES_POST_ID, ALL_BUT_IMAGES))
  await db.insert(posts).values(seedValues(FULL_RUN_POST_ID, ALL_BUT_EDIT))

  await storage.init()
  await testMastra.startWorkers()

  results.fillsGap = await run(FILLS_GAP_POST_ID, ["edit"])
  results.leavesGap = await run(LEAVES_GAP_POST_ID, ["edit"])
  results.images = await run(IMAGES_POST_ID, ["images"])
  results.fullRun = await run(FULL_RUN_POST_ID)
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const postId of POST_IDS) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("a named-stage run that completes the last outstanding stage", () => {
  it("succeeds", () => {
    expect(results.fillsGap.status).toBe("success")
  })

  it("promotes current_stage to complete rather than leaving it on the stage", async () => {
    const row = await readPost(FILLS_GAP_POST_ID)

    expect(row.currentStage).toBe("complete")
  })

  it("still committed the stage's own column and status", async () => {
    const row = await readPost(FILLS_GAP_POST_ID)

    expect(row.finalMdContent).toBe(AGENT_TEXT.edit)
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })

  it("routes the stage's quality warnings to the instance logger", () => {
    expect(warnings.some((w) => w.startsWith("Flesch reading ease"))).toBe(true)
    expect(warnings.some((w) => w.startsWith("SEO checks still failing"))).toBe(true)
  })
})

describe("a named-stage run that leaves another stage outstanding", () => {
  it("succeeds", () => {
    expect(results.leavesGap.status).toBe("success")
  })

  it("leaves current_stage on the stage it ran", async () => {
    const row = await readPost(LEAVES_GAP_POST_ID)

    expect(row.currentStage).toBe("edit")
    expect((row.stageStatus as Record<string, string>).ready).toBeUndefined()
  })
})

describe("a named-stage run of the nested images workflow", () => {
  it("succeeds", () => {
    expect(results.images.status).toBe("success")
  })

  /**
   * `images` commits its column from `images-assemble`, on the far side of the
   * `.foreach()` fan-out, so its promotion is a code path of its own.
   */
  it("promotes current_stage to complete from inside the nested workflow", async () => {
    const row = await readPost(IMAGES_POST_ID)

    expect(row.currentStage).toBe("complete")
    expect((row.imageManifest as Record<string, unknown>).total_generated).toBe(0)
  })
})

describe("a full run that completes the last outstanding stage", () => {
  it("succeeds", () => {
    expect(results.fullRun.status).toBe("success")
  })

  /**
   * The promotion is the named-stage path's business only. The full path ends
   * at a completion hook that is not ported yet, and promoting here would leave
   * a post reading `"complete"` with `completed_at` still null.
   */
  it("does not promote current_stage", async () => {
    const row = await readPost(FULL_RUN_POST_ID)

    expect(row.currentStage).toBe("edit")
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })
})
