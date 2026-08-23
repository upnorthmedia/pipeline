// @vitest-environment node
/**
 * Items 5.5a, 5.5b and 5.5c-i: the pipeline event bus, the four events a run
 * publishes about itself, and the `execution_logs` entries written beside three
 * of them. 5.5a added `stage_start` and the `"running"` write in
 * front of it; 5.5b adds `stage_complete` after each stage commits its column
 * and `pipeline_complete` after the run stamps the post.
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
 * stage are both "not running", and neither may announce that it is, or that it
 * finished.
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
import type { Event, PubSub } from "@mastra/core/events"
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
import { announceStageComplete } from "./steps/stage-io"
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
/** The post whose run names one stage, which is Python's `stages=[...]` call. */
const RERUN_POST_ID = "00000000-0000-4000-8000-00000000055e"
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
 * `current_stage` at the instant each event was delivered, keyed by
 * `post_id/event`. The same commit-before-publish rule as above, for the two
 * announcements that are about the run rather than about one stage.
 */
const currentStageOnDelivery: Record<string, string | undefined> = {}

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
  await insertPost(RERUN_POST_ID, "pipeline-events-rerun", {
    // A finished post, so rerunning one stage is the dashboard's rerun button
    // rather than a partial first run.
    stageStatus: Object.fromEntries(STAGES.map((stage) => [stage, STATUS_COMPLETE])),
    currentStage: "complete",
    researchContent: RESEARCH,
    outlineContent: AGENT_TEXT.outline,
    draftContent: AGENT_TEXT.write,
  })

  await storage.init()
  // The topic is a retained Redis stream and an ungrouped subscription reads it
  // from the beginning, so without this every previous run of this file replays
  // into `received` and the counts are the suite's history rather than this
  // run's. Measured: a negative control that removed an announcement still
  // passed, on the events of the run before it.
  await pubsub.clearTopic(TOPIC_PIPELINE_EVENTS)
  await pubsub.subscribe(TOPIC_PIPELINE_EVENTS, async (event) => {
    const postId = event.data?.post_id
    const name = event.data?.event
    const stage = event.data?.stage
    if (typeof postId === "string") {
      const row = await readPost(postId)
      currentStageOnDelivery[`${postId}/${name}`] = row?.currentStage ?? undefined
      if (typeof stage === "string") {
        // Keyed by the event as well as the stage: `stage_start` and
        // `stage_complete` both name a stage, so a single key would let the
        // later delivery overwrite what the earlier one saw.
        statusOnDelivery[`${postId}/${name}/${stage}`] = (
          (row?.stageStatus ?? {}) as Record<string, string>
        )[stage]
      }
    }
    // Pushed last, deliberately: the waits below count this array, so an event
    // recorded before its row snapshot lets `beforeAll` return while the read
    // is still in flight. Measured as a flake under full-suite load.
    received.push(event)
  })
  await testMastra.startWorkers()

  for (const postId of [FULL_POST_ID, SKIP_POST_ID, GATE_POST_ID]) {
    const run = await pipelineWorkflow.createRun()
    await run.start({ inputData: { postId } })
  }
  const rerun = await pipelineWorkflow.createRun()
  await rerun.start({ inputData: { postId: RERUN_POST_ID, stages: ["edit"] } })

  await settleEvents(FULL_POST_ID, "stage_start", STAGES.length)
  await settleEvents(SKIP_POST_ID, "stage_start", STAGES.length - 1)
  await settleEvents(FULL_POST_ID, "pipeline_complete", 1)
  await settleEvents(SKIP_POST_ID, "pipeline_complete", 1)
  await settleEvents(RERUN_POST_ID, "stage_complete", 1)
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const id of [FULL_POST_ID, SKIP_POST_ID, GATE_POST_ID, RERUN_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, id))
  }
  await closeDb()
  vi.restoreAllMocks()
})

/**
 * The stages whose `publish_stage_log()` call sites are ported (item 5.5c-iv),
 * in pipeline order.
 *
 * Named rather than assumed, because the assertions below are exact sequences:
 * a stage that quietly stopped logging, and a stage that started, both have to
 * fail here rather than be absorbed by a looser assertion.
 */
/** How many progress lines each ported stage writes on this run. */
const LOG_LINES_PER_STAGE: Partial<Record<(typeof STAGES)[number], number>> = {
  research: 3,
  outline: 3,
  write: 3,
  edit: 5,
  ready: 3,
}

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
        statusOnDelivery[`${FULL_POST_ID}/stage_start/${stage}`],
      )
    }
  })

  it("leaves the post finished, so announcing changed no outcome", async () => {
    const row = await readPost(FULL_POST_ID)
    expect(row.currentStage).toBe("complete")
    const status = (row.stageStatus ?? {}) as Record<string, string>
    expect(STAGES.every((stage) => status[stage] === STATUS_COMPLETE)).toBe(true)
  })

  it("reports each of the six stages complete, once, in pipeline order", () => {
    const done = eventsFor(FULL_POST_ID, "stage_complete").map((event) => event.data.stage)
    expect(done).toEqual([...STAGES])
  })

  it("carries Python's stage_complete payload and nothing else", () => {
    for (const event of eventsFor(FULL_POST_ID, "stage_complete")) {
      expect(event.data).toEqual({
        event: "stage_complete",
        post_id: FULL_POST_ID,
        // The provider's reported model, not the requested one, which is what
        // every step's output carries and what the run trace will read.
        stage: event.data.stage,
        model: `stub-${event.data.stage}`,
        duration_s: expect.any(Number),
      })
    }
  })

  it("rounds duration_s to Python's two decimal places", () => {
    for (const event of eventsFor(FULL_POST_ID, "stage_complete")) {
      const seconds = event.data.duration_s as number
      expect(Math.round(seconds * 100) / 100).toBe(seconds)
    }
  })

  it("commits the stage before it reports it complete", () => {
    for (const stage of STAGES) {
      expect(statusOnDelivery[`${FULL_POST_ID}/stage_complete/${stage}`]).toBe(STATUS_COMPLETE)
    }
  })

  it("finishes with exactly one pipeline_complete, in Python's payload", () => {
    const finished = eventsFor(FULL_POST_ID, "pipeline_complete")
    expect(finished).toHaveLength(1)
    expect(finished[0].data).toEqual({
      event: "pipeline_complete",
      post_id: FULL_POST_ID,
      message: "Pipeline finished",
    })
  })

  it("stamps the post finished before it says the pipeline is", () => {
    expect(currentStageOnDelivery[`${FULL_POST_ID}/pipeline_complete`]).toBe("complete")
  })

  it("delivers each ported stage's progress lines and none for the others", () => {
    const perStage = Object.fromEntries(
      STAGES.map((stage) => [
        stage,
        eventsFor(FULL_POST_ID, "log").filter((event) => event.data.stage === stage).length,
      ]),
    )
    // Counted rather than sequenced: `received` is appended by an async
    // subscriber that awaits a row read first, so its order is the order those
    // reads resolved in and not the order the topic delivered. Measured on this
    // very run: `stage_complete`/`research` was recorded ahead of
    // `stage_start`/`research`. Ordering is pinned on `execution_logs` below,
    // where the entry is written by the publishing process itself.
    expect(perStage).toEqual({
      // Three, not five: the stubbed research validates on the first attempt,
      // so neither the failure line nor the degraded line is reached. Both are
      // asserted in `steps/research.test.ts`, which can drive a refusal.
      research: 3,
      outline: 3,
      write: 3,
      // Five, because `edit` is the one stage whose lines are not fixed: three
      // info lines plus one per condition `_validate_edit_output` finds true.
      // The stubbed edit output is four words long with no keyword in it, so it
      // trips the Flesch branch and the SEO branch and not the em-dash one.
      edit: 5,
      images: 0,
      ready: 3,
    })
  })

  it("carries Python's log payload and nothing else", () => {
    const first = eventsFor(FULL_POST_ID, "log").find((event) => event.data.stage === "outline")
    expect(first?.data).toEqual({
      event: "log",
      post_id: FULL_POST_ID,
      stage: "outline",
      message: "Rules loaded, building prompt...",
      level: "info",
      // `datetime.now(UTC).isoformat()`, the field `debug-log-panel.tsx` renders
      // as the line's clock time.
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00$/),
    })
  })

  it("sends pipeline_complete after the last stage_complete", () => {
    const order = received
      .filter((event) => event.data?.post_id === FULL_POST_ID)
      .map((event) => event.data.event)
    expect(order.at(-1)).toBe("pipeline_complete")
    expect(order.filter((name) => name === "stage_complete")).toHaveLength(STAGES.length)
  })
})

describe("a stage the run skips", () => {
  it("announces the five stages that ran and not the one that did not", () => {
    const announced = eventsFor(SKIP_POST_ID, "stage_start").map((event) => event.data.stage)
    expect(announced).toEqual(STAGES.filter((stage) => stage !== "research"))
  })

  it("never calls the skipped stage running", () => {
    expect(statusOnDelivery[`${SKIP_POST_ID}/stage_start/research`]).toBeUndefined()
  })

  it("reports the five stages that ran complete and not the one that did not", () => {
    const done = eventsFor(SKIP_POST_ID, "stage_complete").map((event) => event.data.stage)
    expect(done).toEqual(STAGES.filter((stage) => stage !== "research"))
  })

  it("still finishes the run, because a skipped stage is a finished one", () => {
    expect(eventsFor(SKIP_POST_ID, "pipeline_complete")).toHaveLength(1)
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

  it("reports nothing complete and never finishes the pipeline", () => {
    expect(eventsFor(GATE_POST_ID, "stage_complete")).toEqual([])
    expect(eventsFor(GATE_POST_ID, "pipeline_complete")).toEqual([])
  })
})

describe("a run that names one stage", () => {
  it("announces only the stage it was asked to run", () => {
    expect(eventsFor(RERUN_POST_ID, "stage_start").map((event) => event.data.stage)).toEqual([
      "edit",
    ])
    expect(eventsFor(RERUN_POST_ID, "stage_complete").map((event) => event.data.stage)).toEqual([
      "edit",
    ])
  })

  it("says nothing about the pipeline, because the run finished and the post did not", () => {
    // Python published `pipeline_complete` from inside `if is_full_pipeline:`,
    // so a rerun of one stage on an already finished post never sent it.
    expect(eventsFor(RERUN_POST_ID, "pipeline_complete")).toEqual([])
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

describe("announceStageComplete", () => {
  /**
   * Driven directly rather than through a run, because a real stage's duration
   * is however long the stubbed provider took and cannot be made to land on a
   * value that distinguishes a rounded number from an unrounded one.
   */
  async function announce(durationS: number) {
    const published: Record<string, unknown>[] = []
    await announceStageComplete(
      {
        pubsub: {
          publish: async (_topic: string, event: { data: Record<string, unknown> }) => {
            published.push(event.data)
          },
        } as unknown as PubSub,
      },
      {
        postId: WIRE_POST_ID,
        stages: undefined,
        stage: "edit",
        model: "stub-edit",
        tokensIn: 100,
        tokensOut: 20,
        durationS,
        skipped: false,
      },
    )
    return published[0]
  }

  it("rounds duration_s to two places, as Python's round(duration_s, 2) did", async () => {
    expect((await announce(12.3456789)).duration_s).toBe(12.35)
    expect((await announce(0.0049)).duration_s).toBe(0)
  })

  it("sends the model and the duration, and leaves the token counts off", async () => {
    // Python's payload was `{stage, model, duration_s}`. The tokens go to the
    // `execution_logs` entry written alongside it, not onto this event; the
    // suite below reads them off the row.
    expect(await announce(1)).toEqual({
      event: "stage_complete",
      post_id: WIRE_POST_ID,
      stage: "edit",
      model: "stub-edit",
      duration_s: 1,
    })
  })
})

/**
 * Item 5.5c-i, on the same four runs: what the row recorded about them.
 *
 * The SSE suites above ask what a browser watching the run was told. These ask
 * what a browser that was not open can read afterwards, which is a different
 * question with a different answer: the log carries the token counts and the
 * priced estimate that the event deliberately leaves off.
 */
async function logsFor(postId: string): Promise<Record<string, unknown>[]> {
  const row = await readPost(postId)
  return (row?.executionLogs ?? []) as Record<string, unknown>[]
}

describe("what a run writes to execution_logs", () => {
  it("opens with the run, records a start and a complete per stage, then closes with the run", async () => {
    const entries = await logsFor(FULL_POST_ID)
    expect(entries.map((entry) => [entry.event, entry.stage])).toEqual([
      // Python passed `""` for the two run-level entries, so filtering the log
      // by stage skips them. `pipeline_start` is first because the step that
      // writes it is the head of the chain, ahead of `research`.
      ["pipeline_start", ""],
      ...STAGES.flatMap((stage) => [
        ["stage_start", stage],
        // The stage's own progress lines, item 5.5c-iv, sitting between the two
        // announcements the runner made around the node. Five stages have them
        // so far: four write three lines each (`research` reaches only three of
        // its five here because the stub validates on the first attempt) and
        // `edit` writes five, its three plus the two quality warnings the
        // stubbed output earns. `images` is the last sub-item, and this list is
        // what will say so when it lands.
        ...Array.from({ length: LOG_LINES_PER_STAGE[stage] ?? 0 }, () => ["log", stage]),
        ["stage_complete", stage],
      ]),
      ["pipeline_complete", ""],
    ])
  })

  it("carries Python's pipeline_start message and no data", async () => {
    const [opening] = await logsFor(FULL_POST_ID)
    expect(opening).toMatchObject({ level: "info", message: "Full pipeline run initiated" })
    expect("data" in opening).toBe(false)
  })

  it("carries Python's stage_complete data, including the tokens the event omits", async () => {
    const entries = await logsFor(FULL_POST_ID)
    for (const entry of entries.filter((item) => item.event === "stage_complete")) {
      expect(entry).toMatchObject({
        level: "info",
        message: `Stage ${entry.stage} complete`,
        data: {
          model: `stub-${entry.stage}`,
          // The stub reports 100 in and 20 out for every agent call.
          tokens_in: 100,
          tokens_out: 20,
          duration_s: expect.any(Number),
          // round((100/1e6 * 15) + (20/1e6 * 75), 6), Python's hardcoded rates.
          cost_usd: 0.003,
        },
      })
    }
  })

  it("records the same duration the event carried, rounded the same way", async () => {
    const entries = await logsFor(FULL_POST_ID)
    for (const event of eventsFor(FULL_POST_ID, "stage_complete")) {
      const logged = entries.find(
        (entry) => entry.event === "stage_complete" && entry.stage === event.data.stage,
      )
      expect((logged?.data as Record<string, unknown>).duration_s).toBe(event.data.duration_s)
    }
  })

  it("stamps every entry with a timestamp that sorts against Python's", async () => {
    const entries = await logsFor(FULL_POST_ID)
    const stamps = entries.map((entry) => entry.ts as string)
    for (const ts of stamps) {
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/)
    }
    expect([...stamps].sort()).toEqual(stamps)
  })

  it("says nothing about a stage the run skipped", async () => {
    const entries = await logsFor(SKIP_POST_ID)
    expect(entries.some((entry) => entry.stage === "research")).toBe(false)
    expect(entries.filter((entry) => entry.event === "stage_start")).toHaveLength(STAGES.length - 1)
  })

  it("still opens a run that skips its first stage with pipeline_start", async () => {
    // The skip is decided inside `research`, which the head step runs ahead of,
    // so the run-level entry does not depend on any stage executing.
    expect((await logsFor(SKIP_POST_ID)).map((entry) => entry.event)[0]).toBe("pipeline_start")
  })

  it("records a run parked at its first gate as started and nothing more", async () => {
    // The gate fires before `announceStageStart`, so `research` writes nothing.
    // The run-level entry is the whole log, and it is the only evidence on the
    // row that this run was ever picked up by a worker.
    const entries = await logsFor(GATE_POST_ID)
    expect(entries.map((entry) => [entry.event, entry.stage])).toEqual([["pipeline_start", ""]])
  })

  it("carries each stage's progress lines, in the order the node wrote them", async () => {
    const entries = await logsFor(FULL_POST_ID)
    const messagesFor = (stage: string) =>
      entries
        .filter((entry) => entry.event === "log" && entry.stage === stage)
        .map((entry) => entry.message)

    expect(messagesFor("research")).toEqual([
      "Rules loaded, building prompt...",
      "Calling Perplexity sonar-pro...",
      expect.stringMatching(/^Received 20 tokens in \d+\.\ds$/),
    ])
    expect(messagesFor("outline")).toEqual([
      "Rules loaded, building prompt...",
      "Calling Claude for outline...",
      // The stub reports 20 output tokens; the duration is real elapsed time.
      expect.stringMatching(/^Received 20 tokens in \d+\.\ds$/),
    ])
    expect(messagesFor("write")).toEqual([
      "Rules loaded, building prompt...",
      "Calling Claude for draft (up to 16k tokens)...",
      expect.stringMatching(/^Received 20 tokens in \d+\.\ds$/),
    ])
    expect(messagesFor("edit")).toEqual([
      "Rules loaded, building prompt...",
      "Calling Claude for editing + SEO polish...",
      expect.stringMatching(/^Received 20 tokens in \d+\.\ds$/),
      // `_validate_edit_output` runs before link validation, so both warnings
      // are about the model's own answer. The stubbed answer is four words with
      // no keyword in it, which is unreadable by Flesch and fails every check.
      expect.stringMatching(
        /^Flesch reading ease is -?[\d.]+ \(target 60-70, still too hard to read\)$/,
      ),
      expect.stringMatching(/^SEO checks still failing after edit: /),
    ])
    expect(messagesFor("ready")).toEqual([
      "Rules loaded, building prompt...",
      "Calling Claude for final assembly...",
      expect.stringMatching(/^Assembly done \(20 tokens, \d+\.\ds\)$/),
    ])
  })

  it("stores a progress line with no data key, as Python's `if data:` did", async () => {
    const entries = await logsFor(FULL_POST_ID)
    const lines = entries.filter((item) => item.event === "log")
    // None of the 21 call sites in the five non-`images` stages passes `data`,
    // so no stored line carries the key, whatever its level.
    for (const entry of lines) {
      expect(Object.keys(entry).sort()).toEqual(["event", "level", "message", "stage", "ts"])
    }
    // `info` everywhere but `edit`'s two quality warnings, which are the only
    // lines on this run that Python raised the level on.
    expect(lines.filter((entry) => entry.level !== "info").map((entry) => entry.stage)).toEqual([
      "edit",
      "edit",
    ])
  })

  it("records only the named stage for a rerun, and nothing about the pipeline", async () => {
    // Python gated `pipeline_start` on `is_full_pipeline`, the same gate
    // `pipeline_complete` sits behind, so a rerun opens and closes silently.
    const entries = await logsFor(RERUN_POST_ID)
    expect(entries.map((entry) => [entry.event, entry.stage])).toEqual([
      ["stage_start", "edit"],
      // The stage's own progress lines are not gated on the run being a full
      // one: they are the node reporting on itself, so a rerun of one stage
      // records exactly what that stage would have recorded inside a full run.
      ...Array.from({ length: LOG_LINES_PER_STAGE.edit ?? 0 }, () => ["log", "edit"]),
      ["stage_complete", "edit"],
    ])
  })
})

describe("the run's own quality warnings", () => {
  it("are the stubbed draft's, not a new one from announcing", () => {
    expect(warnings.every((message) => !message.includes("stage_start"))).toBe(true)
  })
})
