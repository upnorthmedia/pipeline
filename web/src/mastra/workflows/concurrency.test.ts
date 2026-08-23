// @vitest-environment node
/**
 * Concurrency (ledger item 4.6): two pipelines running at once must not
 * interleave writes to the same post row, and must not exhaust the connection
 * pool.
 *
 * Two separate claims, two separate groups of runs.
 *
 * **Interleaving.** Every stage commits its column with
 * `saveStageOutput(postId, stage, content, patch)`, and the `stage_status`
 * argument used to be the whole map the step had read at its start. That is a
 * read-modify-write across a shared column: two runs on one post that both load
 * the row before either writes each hold a snapshot of `stage_status` taken
 * before the other's stage finished, so whichever writes second erases the
 * first's entry. The dashboard reads that column to decide what has run, so a
 * lost entry means a finished stage is reported as never having run and a full
 * pipeline re-bills it.
 *
 * The overlap here is forced rather than raced. Both stubbed agents wait on a
 * two-party barrier, and the barrier is downstream of `loadPipelineState` and
 * upstream of `saveStageOutput` in both steps, so by construction both runs
 * have read the row before either one writes it. Without the barrier this test
 * would pass or fail on scheduler luck.
 *
 * **Cross-post writes and the pool.** Four full pipelines run at once on four
 * posts, each carrying a distinct marker in its topic that every stubbed agent
 * echoes back. A row that ends up holding another post's marker is a run
 * writing to the wrong `postId`. While they run, the shared `pg` pool is
 * sampled: the pool is shared with Mastra's `PostgresStore`, so the engine's
 * own storage traffic is competing for the same ten connections as the stage
 * steps. A checked-out connection that is never released is what actually
 * exhausts a pool in production, so the settled pool is asserted to hold no
 * borrowed clients.
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
import { eq, inArray } from "drizzle-orm"
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

/** Stage -> the text its stubbed agent returns, before the post's marker. */
const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

/** The one stage whose output is a manifest rather than prose, so it carries no marker. */
const IMAGES_MANIFEST = JSON.stringify({ version: "1.0", images: [] })

const SHARED_POST_ID = "00000000-0000-4000-8000-0000000005c1"
/** One post per concurrent full pipeline, each with its own marker. */
const MARKERS = ["alpha", "bravo", "charlie", "delta"] as const
const MARKED_POST_IDS = [
  "00000000-0000-4000-8000-0000000005c2",
  "00000000-0000-4000-8000-0000000005c3",
  "00000000-0000-4000-8000-0000000005c4",
  "00000000-0000-4000-8000-0000000005c5",
]
const POST_IDS = [SHARED_POST_ID, ...MARKED_POST_IDS]

/**
 * The marker is carried in both the topic and the slug. Five of the six stage
 * prompts come from `buildStagePrompt`, which renders the topic; `ready` has
 * its own builder that drops the configuration block in favour of the slug, so
 * without the slug carrying it too the last stage would see no marker at all.
 */
function topicFor(marker: string): string {
  return `concurrency-marker-${marker} pipelines`
}

function slugFor(marker: string): string {
  return `concurrency-marker-${marker}`
}

const MARKER_RE = /concurrency-marker-([a-z]+)/

const db = getDb()
const pool = getPool()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:concurrency",
})
const storage = new PostgresStore({ id: "concurrency-test", pool })
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
let markedResults: PipelineResult[]

/** `edit`'s readability and SEO warnings, captured so they do not reach stderr. */
let warnings: string[]
/** Where the `images` stage writes, so a run cannot touch the repo's `media/`. */
let mediaRootDir: string

/**
 * A two-party rendezvous, armed only for the shared-post group.
 *
 * `arrive()` resolves once both parties have called it, so both stage steps sit
 * inside their agent call (after the row read, before the column write) at the
 * same instant. It races a timeout so a regression that stops one party from
 * arriving fails the suite rather than hanging it.
 */
function makeBarrier(parties: number, timeoutMs: number) {
  let release: () => void = () => {}
  const reached = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  return async function arrive(): Promise<void> {
    arrived += 1
    if (arrived >= parties) release()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      reached,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    clearTimeout(timer)
  }
}

let barrier: (() => Promise<void>) | null = null

/** Peak pool figures sampled while the four marked pipelines were in flight. */
const poolPeak = { total: 0, waiting: 0, borrowed: 0 }

function samplePool() {
  poolPeak.total = Math.max(poolPeak.total, pool.totalCount)
  poolPeak.waiting = Math.max(poolPeak.waiting, pool.waitingCount)
  poolPeak.borrowed = Math.max(poolPeak.borrowed, pool.totalCount - pool.idleCount)
}

function seedValues(postId: string, marker: string) {
  return {
    id: postId,
    slug: slugFor(marker),
    topic: topicFor(marker),
    currentStage: "pending",
    // Explicit, because the `stage_settings` column's database default predates
    // the gate removal and still reads five stages as `"review"`; a row that
    // inherits it parks at the first gate, which a post created by the app
    // never does.
    stageSettings: Object.fromEntries(STAGES.map((stage) => [stage, "auto"])),
    stageStatus: {},
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
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "concurrency-"))
  process.env.MEDIA_DIR = mediaRootDir

  warnings = []
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation(((message: string) => {
    warnings.push(message)
  }) as never)

  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async (prompt: string) => {
      if (barrier && (stage === "research" || stage === "outline")) await barrier()
      const marker = MARKER_RE.exec(prompt)?.[1] ?? "unmarked"
      const text =
        stage === "images"
          ? IMAGES_MANIFEST
          : `${AGENT_TEXT[stage as keyof typeof AGENT_TEXT]}\n\nmarker:${marker}`
      return {
        text,
        response: { modelId: `stub-${stage}` },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    }) as never)
  }

  await db.delete(posts).where(inArray(posts.id, POST_IDS))
  await db.insert(posts).values(seedValues(SHARED_POST_ID, "shared"))
  for (const [index, postId] of MARKED_POST_IDS.entries()) {
    await db.insert(posts).values(seedValues(postId, MARKERS[index]))
  }

  await storage.init()
  await testMastra.startWorkers()

  // Group one: two named-stage runs on the same row, forced to overlap.
  barrier = makeBarrier(2, 15_000)
  const [research, outline] = await Promise.all([
    run(SHARED_POST_ID, ["research"]),
    run(SHARED_POST_ID, ["outline"]),
  ])
  results.research = research
  results.outline = outline
  barrier = null

  // Group two: four full pipelines at once on four rows, with the pool watched.
  const sampler = setInterval(samplePool, 20)
  try {
    markedResults = await Promise.all(MARKED_POST_IDS.map((postId) => run(postId)))
  } finally {
    clearInterval(sampler)
  }
}, 300_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await db.delete(posts).where(inArray(posts.id, POST_IDS))
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("two runs writing the same post row at once", () => {
  it("both succeed", () => {
    expect(results.research.status).toBe("success")
    expect(results.outline.status).toBe("success")
  })

  it("keeps both stages in stage_status rather than losing the earlier write", async () => {
    const row = await readPost(SHARED_POST_ID)

    expect(row.stageStatus).toEqual({
      research: STATUS_COMPLETE,
      outline: STATUS_COMPLETE,
    })
  })

  it("commits both content columns", async () => {
    const row = await readPost(SHARED_POST_ID)

    expect(row.researchContent).toContain("Keyword analysis")
    expect(row.outlineContent).toContain("Outline")
  })

  /**
   * `current_stage` is a scalar that both runs set to their own stage, so the
   * later write wins and there is no ordering to prefer. The guarantee is that
   * it holds one of the two stages, not a torn or stale value.
   */
  it("leaves current_stage on one of the two stages that ran", async () => {
    const row = await readPost(SHARED_POST_ID)

    expect(["research", "outline"]).toContain(row.currentStage)
  })
})

describe("four full pipelines at once on four different posts", () => {
  it("all succeed", () => {
    expect(markedResults.map((result) => result.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ])
  })

  it("writes every stage column of every post", async () => {
    for (const postId of MARKED_POST_IDS) {
      const row = await readPost(postId)
      expect(row.stageStatus).toEqual(
        Object.fromEntries(STAGES.map((stage) => [stage, STATUS_COMPLETE])),
      )
    }
  })

  it("never writes one post's output into another post's row", async () => {
    for (const [index, postId] of MARKED_POST_IDS.entries()) {
      const row = await readPost(postId)
      const own = `marker:${MARKERS[index]}`
      const columns = [
        row.researchContent,
        row.outlineContent,
        row.draftContent,
        row.finalMdContent,
        row.readyContent,
      ]
      for (const value of columns) {
        expect(value).toContain(own)
        for (const other of MARKERS.filter((marker) => marker !== MARKERS[index])) {
          expect(value).not.toContain(`marker:${other}`)
        }
      }
    }
  })

  it("reports each stage's quality warnings on its own post's log, not to the logger", async () => {
    // Item 5.5c-iv-c moved these off `logger.warn` and onto
    // `publish_stage_log(..., level="warning")`. On four concurrent runs that
    // also pins the routing per post: a warning filed against the wrong row
    // would leave one of these four empty.
    for (const postId of MARKED_POST_IDS) {
      const stored = ((await readPost(postId)).executionLogs ?? []) as Record<string, unknown>[]
      const reported = stored
        .filter((entry) => entry.event === "log" && entry.level === "warning")
        .map((entry) => String(entry.message))

      expect(reported.some((message) => message.startsWith("Flesch reading ease"))).toBe(true)
    }
    expect(warnings).toEqual([])
  })
})

describe("the connection pool under concurrent pipelines", () => {
  it("never opened more connections than the pool allows", () => {
    const max = pool.options.max ?? 10

    expect(poolPeak.total).toBeGreaterThan(0)
    expect(poolPeak.total).toBeLessThanOrEqual(max)
  })

  /**
   * A borrowed client that is never given back is what exhausts a pool over a
   * long-lived worker's life, so the settled pool must hold none.
   */
  it("returns every borrowed connection once the runs settle", () => {
    expect(pool.waitingCount).toBe(0)
    expect(pool.totalCount - pool.idleCount).toBe(0)
  })
})
