// @vitest-environment node
/**
 * Item 5.5a: the pipeline event bus, and the stage-start write plus its event.
 *
 * The first three suites are real runs of the real workflow on a real evented
 * engine, a real Redis Streams transport and the real database, with only the
 * provider boundaries stubbed. What they assert is what a browser would see:
 * the events that reached an independent fan-out subscription on the shared
 * topic, and the row as it stood at the moment each one was delivered.
 *
 * Three posts, because the three answers a stage can give are all worth
 * pinning: one that runs every stage, one whose first stage is already complete
 * and is skipped, and one parked at a review gate. A skipped stage and a gated
 * stage are both "not running", and neither may announce that it is.
 *
 * The fourth suite publishes through the transport directly, which is the only
 * way to see the wire shape of an event whose payload carries fields no stage
 * sends, and to see what an event with no payload at all looks like.
 *
 * It runs on its own `Mastra` instance with its own Redis key prefix, for the
 * reason `pipeline.test.ts` records: vitest runs files in parallel and two
 * processes subscribed to the same evented topics would share the work.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import type { Event } from "@mastra/core/events"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../db"
import { editAgent } from "./agents/edit"
import { imagesAgent } from "./agents/images"
import { outlineAgent } from "./agents/outline"
import { readyAgent } from "./agents/ready"
import { researchAgent } from "./agents/research"
import { writeAgent } from "./agents/write"
import { TOPIC_PIPELINE_EVENTS, publishPipelineEvent } from "./pipeline-events"
import { STAGES, STATUS_COMPLETE, STATUS_RUNNING } from "./state"
import { imagesWorkflow } from "./workflows/images"
import { pipelineWorkflow } from "./workflows/pipeline"

vi.mock("./api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: realtime pipeline events",
  "## Pain point",
  "the dashboard cannot tell a running stage from a finished one.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

/**
 * A manifest with no images, so the `images` stage reaches its own
 * `saveStageOutput` without the Gemini boundary being touched at all. This file
 * is about announcements, not about generation, and `images.test.ts` already
 * owns the fan-out.
 */
const MANIFEST = { version: "1.0", style_brief: { palette: "cool" }, images: [] }

const AGENT_TEXT = {
  research: RESEARCH,
  outline: "# Outline\n\n1. Opening\n2. Body\n3. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify(MANIFEST),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

/** The post that runs all six stages. */
const FULL_POST_ID = "00000000-0000-4000-8000-00000000055a"
/** The post whose `research` is already complete, so the stage is skipped. */
const SKIP_POST_ID = "00000000-0000-4000-8000-00000000055b"
/** The post whose `research` is configured for review, so the run suspends. */
const GATE_POST_ID = "00000000-0000-4000-8000-00000000055c"
/** The post id the direct-publish suite uses; no row is ever inserted for it. */
const WIRE_POST_ID = "00000000-0000-4000-8000-00000000055d"

const ALL_AUTO = {
  research: "auto",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
} as const

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:pipeline-events",
})
const storage = new PostgresStore({ id: "pipeline-events-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  agents: {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  },
})

/** Every event delivered on the topic, in delivery order. */
const received: Event[] = []
/**
 * What `stage_status` said for the announced stage at the instant the event was
 * delivered, keyed by `post_id/stage`. This is the assertion that the row is
 * committed before the event goes out: a browser that reacts to `stage_start`
 * by refetching the post must never read a row that still calls the stage
 * unstarted.
 */
const statusOnDelivery: Record<string, string | undefined> = {}

/**
 * `edit`'s quality warnings, captured rather than printed: the stubbed draft is
 * three lines long, so every readability and SEO check it runs fails.
 */
let warnings: string[]

async function insertPost(
  id: string,
  slug: string,
  overrides: Partial<typeof posts.$inferInsert> = {},
) {
  await db.delete(posts).where(eq(posts.id, id))
  await db.insert(posts).values({
    id,
    slug,
    topic: "realtime pipeline events",
    currentStage: "pending",
    // Explicit, for the reason `pipeline.test.ts` records: the column default
    // predates the gate removal and would park every run at the first gate.
    stageSettings: ALL_AUTO,
    stageStatus: {},
    ...overrides,
  })
}

async function readPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id))
  return row
}

function eventsFor(postId: string, name: string) {
  return received.filter((event) => event.data?.post_id === postId && event.data?.event === name)
}

/** Resolves once the topic has delivered `count` events for a post. */
async function waitForEvents(postId: string, name: string, count: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = eventsFor(postId, name)
    if (found.length >= count) return found
    if (Date.now() > deadline) {
      throw new Error(`only ${found.length} of ${count} ${name} events arrived for ${postId}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The same wait, but it gives up quietly.
 *
 * `beforeAll` uses this rather than the throwing form on purpose: an
 * announcement that never arrives is exactly what these tests exist to catch,
 * and a `beforeAll` that throws reports thirteen skips instead of the two or
 * three failures that name the missing event.
 */
async function settleEvents(postId: string, name: string, count: number) {
  try {
    await waitForEvents(postId, name, count, 15_000)
  } catch {
    // Assertions below report what did and did not arrive.
  }
}

beforeAll(async () => {
  warnings = []
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation(((message: string) => {
    warnings.push(message)
  }) as never)

  const agents = {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  } as const
  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => ({
      text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
      response: { modelId: `stub-${stage}` },
      usage: { inputTokens: 100, outputTokens: 20 },
    })) as never)
  }

  await insertPost(FULL_POST_ID, "pipeline-events-full")
  await insertPost(SKIP_POST_ID, "pipeline-events-skip", {
    // A stage the full-pipeline skip rule will pass over, with its column
    // already filled so the stages after it have the input they read.
    stageStatus: { research: STATUS_COMPLETE },
    researchContent: RESEARCH,
  })
  await insertPost(GATE_POST_ID, "pipeline-events-gate", {
    stageSettings: { ...ALL_AUTO, research: "review" },
  })

  await storage.init()
  // The topic is a retained Redis stream and an ungrouped subscription reads it
  // from the beginning, so without this every previous run of this file replays
  // into `received` and the counts are the suite's history rather than this
  // run's. Measured: a negative control that removed an announcement still
  // passed, on the events of the run before it.
  await pubsub.clearTopic(TOPIC_PIPELINE_EVENTS)
  await pubsub.subscribe(TOPIC_PIPELINE_EVENTS, async (event) => {
    received.push(event)
    const postId = event.data?.post_id
    const stage = event.data?.stage
    if (typeof postId === "string" && typeof stage === "string") {
      const row = await readPost(postId)
      statusOnDelivery[`${postId}/${stage}`] = (
        (row?.stageStatus ?? {}) as Record<string, string>
      )[stage]
    }
  })
  await testMastra.startWorkers()

  for (const postId of [FULL_POST_ID, SKIP_POST_ID, GATE_POST_ID]) {
    const run = await pipelineWorkflow.createRun()
    await run.start({ inputData: { postId } })
  }

  await settleEvents(FULL_POST_ID, "stage_start", STAGES.length)
  await settleEvents(SKIP_POST_ID, "stage_start", STAGES.length - 1)
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const id of [FULL_POST_ID, SKIP_POST_ID, GATE_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, id))
  }
  await closeDb()
  vi.restoreAllMocks()
})

describe("a run that executes every stage", () => {
  it("announces each of the six stages exactly once, in pipeline order", () => {
    const announced = eventsFor(FULL_POST_ID, "stage_start").map((event) => event.data.stage)
    expect(announced).toEqual([...STAGES])
  })

  it("carries Python's payload and nothing else", () => {
    const [first] = eventsFor(FULL_POST_ID, "stage_start")
    expect(first.data).toEqual({
      event: "stage_start",
      post_id: FULL_POST_ID,
      stage: "research",
      message: "Starting research...",
    })
  })

  it("names the event on the envelope too, so a subscriber can filter without parsing", () => {
    for (const event of eventsFor(FULL_POST_ID, "stage_start")) {
      expect(event.type).toBe("stage_start")
      expect(event.runId).toBe(FULL_POST_ID)
    }
  })

  it("commits the row before the event goes out", () => {
    // `running` if the browser beat the stage's own completion write, `complete`
    // if it did not. What it must never be is the value the row carried before
    // the stage started, which for a fresh post is no entry at all.
    for (const stage of STAGES) {
      expect([STATUS_RUNNING, STATUS_COMPLETE]).toContain(
        statusOnDelivery[`${FULL_POST_ID}/${stage}`],
      )
    }
  })

  it("leaves the post finished, so announcing changed no outcome", async () => {
    const row = await readPost(FULL_POST_ID)
    expect(row.currentStage).toBe("complete")
    const status = (row.stageStatus ?? {}) as Record<string, string>
    expect(STAGES.every((stage) => status[stage] === STATUS_COMPLETE)).toBe(true)
  })
})

describe("a stage the run skips", () => {
  it("announces the five stages that ran and not the one that did not", () => {
    const announced = eventsFor(SKIP_POST_ID, "stage_start").map((event) => event.data.stage)
    expect(announced).toEqual(STAGES.filter((stage) => stage !== "research"))
  })

  it("never calls the skipped stage running", () => {
    expect(statusOnDelivery[`${SKIP_POST_ID}/research`]).toBeUndefined()
  })
})

describe("a stage parked at a review gate", () => {
  it("announces nothing, because a stage waiting for a human is not running", () => {
    expect(eventsFor(GATE_POST_ID, "stage_start")).toEqual([])
  })

  it("leaves the row on the gate's own status rather than on running", async () => {
    const row = await readPost(GATE_POST_ID)
    const status = (row.stageStatus ?? {}) as Record<string, string>
    expect(status.research).toBe("review")
    expect(row.currentStage).toBe("research")
  })
})

describe("publishPipelineEvent", () => {
  it("flattens the caller's fields alongside the event name and post id", async () => {
    await publishPipelineEvent(pubsub, WIRE_POST_ID, "stage_complete", {
      stage: "edit",
      model: "stub-edit",
      duration_s: 1.25,
    })
    const [event] = await waitForEvents(WIRE_POST_ID, "stage_complete", 1)
    expect(event.data).toEqual({
      event: "stage_complete",
      post_id: WIRE_POST_ID,
      stage: "edit",
      model: "stub-edit",
      duration_s: 1.25,
    })
  })

  it("publishes an event with no payload as the two fields Python always sent", async () => {
    await publishPipelineEvent(pubsub, WIRE_POST_ID, "pipeline_complete")
    const [event] = await waitForEvents(WIRE_POST_ID, "pipeline_complete", 1)
    expect(event.data).toEqual({ event: "pipeline_complete", post_id: WIRE_POST_ID })
  })

  it("lets a caller's field override nothing it should not: post_id stays the argument", async () => {
    await publishPipelineEvent(pubsub, WIRE_POST_ID, "log", { level: "info", message: "hello" })
    const [event] = await waitForEvents(WIRE_POST_ID, "log", 1)
    expect(event.data.post_id).toBe(WIRE_POST_ID)
    expect(event.data.level).toBe("info")
  })
})

describe("the run's own quality warnings", () => {
  it("are the stubbed draft's, not a new one from announcing", () => {
    expect(warnings.every((message) => !message.includes("stage_start"))).toBe(true)
  })
})
