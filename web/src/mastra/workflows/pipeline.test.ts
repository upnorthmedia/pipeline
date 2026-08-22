// @vitest-environment node
/**
 * The six stages composed and executed as one workflow (item 4.1).
 *
 * Each stage already has its own parity test against the Python fixtures, so
 * this file asserts only what composition adds: that the six run in the order
 * `_run_pipeline()` ran them, that each one sees the row the previous one
 * committed rather than a snapshot, that the nested `images` workflow chains
 * like any step, and that one run leaves the post row in the same end state the
 * Python pipeline left it in.
 *
 * Every provider boundary is stubbed and nothing else: six agent calls and the
 * Gemini image call. The database, Redis and the evented engine are real, and
 * `validateLinks` is stubbed only because it makes live HTTP requests to
 * whatever URLs the stubbed model invents.
 *
 * It runs on its own `Mastra` instance with its own Redis key prefix rather
 * than on the one `index.ts` exports, for the reason `images.test.ts` records:
 * vitest runs files in parallel, and two processes subscribed to the same
 * evented topics would share the work between them, so a step of this run could
 * execute in another file's thread where these stubs do not exist.
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
import corpus from "../images/data/image-generation-parity.json"
import { STAGES } from "../state"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

vi.mock("../images/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../images/gemini")>()),
  generateImage: vi.fn(),
}))

vi.mock("../links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../links")>()),
  validateLinks: async (content: string) => ({ content, removed: [] }),
}))

const { generateImage } = await import("../images/gemini")
const generateImageMock = vi.mocked(generateImage)

const PNG = Buffer.from(corpus.png_base64, "base64")

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: composable pipelines",
  "## Pain point",
  "runs die halfway and nobody knows which stage was last.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

const MANIFEST = {
  version: "1.0",
  style_brief: { palette: "cool" },
  images: [
    { id: "hero", filename: "hero.png", prompt: "a hero image", type: "featured" },
    { id: "inline", filename: "inline.png", prompt: "an inline diagram" },
  ],
}

/** Stage -> the text its stubbed agent returns, so each column is identifiable. */
const AGENT_TEXT = {
  research: RESEARCH,
  outline: "# Outline\n\n1. Opening\n2. Body\n3. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify(MANIFEST),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

const POST_ID = "00000000-0000-4000-8000-00000000041a"

const db = getDb()
let mediaRootDir: string
/** Stage ids in the order their agent was called, the assertion on ordering. */
let callOrder: string[]
/** The prompt each stage was handed, to prove it read the previous stage's row. */
let prompts: Record<string, string>
/**
 * `edit`'s quality warnings, captured rather than printed. The stubbed draft is
 * three lines long, so every readability and SEO check it runs fails; letting
 * those reach stderr would bury a real warning from a later change.
 */
let warnings: string[]

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:pipeline",
})
const storage = new PostgresStore({ id: "pipeline-workflow-test", pool: getPool() })
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

type PipelineResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof pipelineWorkflow.createRun>>["start"]>
>

let result: PipelineResult

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "pipeline-workflow-"))
  process.env.MEDIA_DIR = mediaRootDir

  callOrder = []
  prompts = {}
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
    vi.spyOn(agent, "generate").mockImplementation((async (prompt: string) => {
      callOrder.push(stage)
      prompts[stage] = prompt
      return {
        text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
        response: { modelId: `stub-${stage}` },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    }) as never)
  }

  generateImageMock.mockResolvedValue({
    imageBytes: PNG,
    model: "gemini-3.1-flash-image-preview",
    tokensIn: 7,
    tokensOut: 11,
  })

  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "pipeline-workflow-run",
    topic: "composable pipelines",
    currentStage: "pending",
    // Explicit, because the `stage_settings` column's database default predates
    // the gate removal and still reads five stages as `"review"`, while
    // SQLAlchemy sent all-auto on every insert. A row that inherits the column
    // default parks at the first review gate; a post created by the app does
    // not, and this run is the app's case.
    stageSettings: {
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    },
    stageStatus: {},
  })

  await storage.init()
  await testMastra.startWorkers()

  const run = await pipelineWorkflow.createRun()
  result = await run.start({ inputData: { postId: POST_ID } })
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

async function readPost() {
  const [row] = await db.select().from(posts).where(eq(posts.id, POST_ID))
  return row
}

describe("the pipeline workflow", () => {
  it("runs to a success", () => {
    expect(result.status).toBe("success")
  })

  it("runs the six stages in the order the Python runner ran them", () => {
    expect(callOrder).toEqual([...STAGES])
  })

  it("commits every stage's column", async () => {
    const row = await readPost()

    expect(row.researchContent).toBe(AGENT_TEXT.research)
    expect(row.outlineContent).toBe(AGENT_TEXT.outline)
    expect(row.draftContent).toBe(AGENT_TEXT.write)
    expect(row.finalMdContent).toBe(AGENT_TEXT.edit)
    expect(row.readyContent).toBe(AGENT_TEXT.ready)
    expect((row.imageManifest as Record<string, unknown>).total_generated).toBe(2)
  })

  /**
   * `current_stage` reads `"complete"` rather than `"ready"` because the chain
   * ends at the `pipeline-complete` step (item 4.7b), Python's
   * `_post_completion_hook`. `pipeline-completion.test.ts` owns that rule's own
   * coverage; here it is only the last thing this run does.
   */
  it("leaves the post complete on every stage, and marked complete", async () => {
    const row = await readPost()

    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, "complete"])))
    expect(row.currentStage).toBe("complete")
    expect(row.completedAt).toBeInstanceOf(Date)
  })

  /**
   * The composition's real contract: nothing is handed forward in memory, so a
   * stage can only see an earlier stage's output if it read the committed row.
   */
  it("feeds each stage the rows the earlier stages committed", () => {
    expect(prompts.outline).toContain(AGENT_TEXT.research)
    expect(prompts.write).toContain(AGENT_TEXT.outline)
    expect(prompts.edit).toContain(AGENT_TEXT.write)
    expect(prompts.images).toContain(AGENT_TEXT.edit)
    expect(prompts.ready).toContain(AGENT_TEXT.edit)
    // The manifest `images` committed, not the one Claude wrote: the URL only
    // exists after the fan-out optimized the bytes to webp. `inline` rather
    // than `hero`, because the featured entry is renamed to a timestamp.
    expect(prompts.ready).toContain("inline.webp")
  })

  it("chains the nested images workflow like any other step", () => {
    expect(generateImageMock).toHaveBeenCalledTimes(MANIFEST.images.length)
    // `ready` ran after it, which is only possible if the nested workflow's
    // output satisfied `ready`'s input schema.
    expect(callOrder.indexOf("ready")).toBeGreaterThan(callOrder.indexOf("images"))
  })

  it("routes a stage's warnings to the instance logger", () => {
    expect(warnings.some((w) => w.startsWith("Flesch reading ease"))).toBe(true)
    expect(warnings.some((w) => w.startsWith("SEO checks still failing"))).toBe(true)
  })

  it("returns the last stage's meta as the run's output", () => {
    const output = result.status === "success" ? result.result : undefined

    expect(output?.postId).toBe(POST_ID)
    expect(output?.stage).toBe("ready")
    expect(output?.model).toBe("stub-ready")
    expect(output?.tokensIn).toBe(100)
    expect(output?.tokensOut).toBe(20)
  })

  it("exposes every stage's meta on the finished run", () => {
    const steps = result.steps as Record<string, { status: string; output?: unknown }>

    for (const stage of STAGES) {
      const step = stage === "images" ? steps.images : steps[stage]
      expect(step?.status, stage).toBe("success")
    }
    expect((steps.research.output as { model: string }).model).toBe("stub-research")
  })
})
