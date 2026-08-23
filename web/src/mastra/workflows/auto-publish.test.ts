// @vitest-environment node
/**
 * The auto-publish half of `_post_completion_hook` end to end (ledger item
 * 5.11): a full pipeline run that finishes publishes the post by itself.
 *
 * `../auto-publish.test.ts` owns the decision table. This file owns the wiring,
 * and it is wiring that only a real run can prove: the completion step writes
 * the marker, reads it back and starts a *second* workflow over the same Redis
 * Streams transport, which the worker then executes. Three runs, and the
 * destinations are real HTTP servers on loopback ports rather than stubs, so
 * "the publish started" is asserted by a request arriving at a site.
 *
 * 1. **`output_format == "wordpress"`, profile configured.** The WordPress
 *    site must receive the create request and the row must end `published`.
 * 2. **`output_format == "nextjs"`, profile configured.** The webhook receiver
 *    must receive the signed payload and the row must end `published`.
 * 3. **A named-stage rerun of a configured WordPress post.** Python gated the
 *    whole hook on `if is_full_pipeline`, so rerunning one stage of a finished
 *    post must not re-publish it. This is the run that would otherwise
 *    re-upload every image to someone's live site every time a stage is rerun
 *    from the dashboard.
 *
 * Every post is seeded with all six stages already complete, so the two full
 * runs skip every stage: the subject here is what happens after the last stage,
 * and a run that generates an article to get there would take minutes and cost
 * money. The rerun names `edit`, which by definition runs its stage again
 * whatever the stage status says, so that one stage does execute. Every agent
 * is stubbed, so nothing here can reach a provider either way.
 *
 * Own `Mastra` instance and own Redis key prefix, for the reason
 * `pipeline.test.ts` records.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts, websiteProfiles } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import { editAgent } from "../agents/edit"
import { imagesAgent } from "../agents/images"
import { outlineAgent } from "../agents/outline"
import { readyAgent } from "../agents/ready"
import { researchAgent } from "../agents/research"
import { writeAgent } from "../agents/write"
import { STAGES, STATUS_COMPLETE } from "../state"
import { imagesWorkflow } from "./images"
import { nextjsPublishWorkflow } from "./nextjs-publish"
import { pipelineWorkflow } from "./pipeline"
import { wordpressPublishWorkflow } from "./wordpress-publish"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = Buffer.alloc(32, 13).toString("base64url")

/**
 * Ids have to be unique across the whole suite, not just this file: vitest runs
 * files in parallel, and the first draft of this one reused
 * `sitemap-crawl.test.ts`'s profile ids. That file's cleanup then tried to
 * delete a profile this file's posts still referenced and died on
 * `posts_profile_id_fkey`, taking a passing suite red from the outside.
 */
const WP_PROFILE_ID = "00000000-0000-4000-8000-000000000620"
const NEXTJS_PROFILE_ID = "00000000-0000-4000-8000-000000000621"
const PROFILE_IDS = [WP_PROFILE_ID, NEXTJS_PROFILE_ID]

const WP_POST_ID = "00000000-0000-4000-8000-000000000622"
const NEXTJS_POST_ID = "00000000-0000-4000-8000-000000000623"
const RERUN_POST_ID = "00000000-0000-4000-8000-000000000624"
const POST_IDS = [WP_POST_ID, NEXTJS_POST_ID, RERUN_POST_ID]

const TITLE = "How Bees Navigate"

/**
 * Stage -> the text its stubbed agent returns, so no run can reach a provider.
 * Only the rerun's `edit` should ever call one, which `generated` asserts.
 */
const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify({ version: "1.0", images: [] }),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

/** Which stages actually called their agent, across all three runs. */
const generated: string[] = []

/**
 * The publish steps announce themselves on the instance logger. Captured rather
 * than printed, both to keep the run's output clean and because "the publish
 * hook ran" is worth asserting; see `rerun-completion.test.ts` for the same
 * treatment of the edit stage's warnings.
 */
const logged: string[] = []

function readyMarkdown(title: string): string {
  return ["---", `title: ${title}`, "---", "", "Bees navigate by polarised light.", ""].join("\n")
}

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:auto-publish",
})
const storage = new PostgresStore({ id: "auto-publish-test", pool: getPool() })
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
  workflows: {
    pipeline: pipelineWorkflow,
    images: imagesWorkflow,
    wordpressPublish: wordpressPublishWorkflow,
    nextjsPublish: nextjsPublishWorkflow,
  },
  agents,
})

interface Recorded {
  method: string
  url: string
  signature: string | undefined
  body: string
}

let wpServer: Server
let hookServer: Server
let wpBase = ""
let hookUrl = ""
const wpRequests: Recorded[] = []
const hookRequests: Recorded[] = []

let mediaRootDir: string
let savedEncryptionKey: string | undefined
let savedMediaDir: string | undefined

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function record(into: Recorded[]) {
  return (req: IncomingMessage, body: string) => {
    into.push({
      method: req.method ?? "",
      url: req.url ?? "",
      signature: req.headers["x-jena-signature"] as string | undefined,
      body,
    })
  }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

/**
 * The publish runs are started with `startAsync`, which is Python's
 * `enqueue_job`: it returns as soon as the event is on the bus, so the pipeline
 * run finishes before the publish has been executed. Poll rather than sleep.
 */
async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function seedValues(postId: string, outputFormat: string, profileId: string) {
  return {
    id: postId,
    profileId,
    slug: `auto-publish-run-${postId.slice(-3)}`,
    topic: "composable pipelines",
    outputFormat,
    currentStage: "pending",
    completedAt: null,
    // Explicit, because the column's database default predates the gate removal
    // and still reads five stages as `"review"`; see `rerun-completion.test.ts`.
    stageSettings: Object.fromEntries(STAGES.map((stage) => [stage, "auto"])),
    stageStatus: Object.fromEntries(STAGES.map((stage) => [stage, STATUS_COMPLETE])),
    researchContent: "seeded research",
    outlineContent: "seeded outline",
    draftContent: "seeded draft",
    finalMdContent: readyMarkdown(TITLE),
    readyContent: readyMarkdown(TITLE),
    imageManifest: { images: [] },
  }
}

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  savedMediaDir = process.env.MEDIA_DIR
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "auto-publish-"))
  process.env.MEDIA_DIR = mediaRootDir

  const recordWp = record(wpRequests)
  wpServer = createServer((req, res) => {
    void (async () => {
      recordWp(req, await readBody(req))
      const payload = JSON.stringify({ id: 900, link: `${wpBase}/?p=900` })
      res.writeHead(req.url?.includes("/posts/") ? 200 : 201, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      })
      res.end(payload)
    })()
  })
  const recordHook = record(hookRequests)
  hookServer = createServer((req, res) => {
    void (async () => {
      recordHook(req, await readBody(req))
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 2 })
      res.end("{}")
    })()
  })
  await new Promise<void>((resolve) => wpServer.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve))
  wpBase = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/api/jena/publish`

  for (const level of ["info", "warn"] as const) {
    vi.spyOn(testMastra.getLogger(), level).mockImplementation(((message: string) => {
      logged.push(message)
    }) as never)
  }

  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => {
      generated.push(stage)
      return {
        text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
        response: { modelId: `stub-${stage}` },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    }) as never)
  }

  for (const postId of POST_IDS) await db.delete(posts).where(eq(posts.id, postId))
  for (const id of PROFILE_IDS) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))

  await db.insert(websiteProfiles).values([
    {
      id: WP_PROFILE_ID,
      name: "auto-publish wordpress",
      websiteUrl: "http://127.0.0.1:9/wp",
      wpUrl: wpBase,
      wpUsername: "editor",
      wpAppPassword: encryptWithKey("app pass word", TEST_KEY),
      wpDefaultStatus: "draft",
    },
    {
      id: NEXTJS_PROFILE_ID,
      name: "auto-publish nextjs",
      websiteUrl: "http://127.0.0.1:9/nextjs",
      nextjsWebhookUrl: hookUrl,
      nextjsWebhookSecret: encryptWithKey("webhook secret", TEST_KEY),
    },
  ])
  await db.insert(posts).values(seedValues(WP_POST_ID, "wordpress", WP_PROFILE_ID))
  await db.insert(posts).values(seedValues(NEXTJS_POST_ID, "nextjs", NEXTJS_PROFILE_ID))
  await db.insert(posts).values(seedValues(RERUN_POST_ID, "wordpress", WP_PROFILE_ID))

  await storage.init()
  await testMastra.startWorkers()

  const full = async (postId: string) => {
    const run = await pipelineWorkflow.createRun()
    return await run.start({ inputData: { postId } })
  }

  expect((await full(WP_POST_ID)).status).toBe("success")
  expect((await full(NEXTJS_POST_ID)).status).toBe("success")

  const rerun = await pipelineWorkflow.createRun()
  const rerunResult = await rerun.start({
    inputData: { postId: RERUN_POST_ID, stages: ["edit"] },
  })
  expect(rerunResult.status).toBe("success")

  await waitFor("the WordPress publish to finish", async () => {
    return (await readPost(WP_POST_ID)).wpPublishStatus === "published"
  })
  await waitFor("the Next.js publish to finish", async () => {
    return (await readPost(NEXTJS_POST_ID)).nextjsPublishStatus === "published"
  })
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await new Promise<void>((resolve) => wpServer.close(() => resolve()))
  await new Promise<void>((resolve) => hookServer.close(() => resolve()))
  for (const postId of POST_IDS) await db.delete(posts).where(eq(posts.id, postId))
  for (const id of PROFILE_IDS) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
  if (savedMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = savedMediaDir
  vi.restoreAllMocks()
})

describe("a finished wordpress post", () => {
  it("reaches the site without anybody pressing publish", () => {
    const creates = wpRequests.filter((entry) => entry.url === "/wp-json/wp/v2/posts")

    expect(creates).toHaveLength(1)
    expect(creates[0].method).toBe("POST")
    expect(JSON.parse(creates[0].body)).toMatchObject({ title: TITLE, status: "draft" })
  })

  it("ends published, with the id the site handed back", async () => {
    const row = await readPost(WP_POST_ID)

    expect(row.wpPublishStatus).toBe("published")
    expect(row.wpPostId).toBe(900)
    expect(logged).toContain(`Post ${WP_POST_ID} published to WordPress: ${wpBase}/?p=900`)
  })

  it("does not also publish to Next.js", async () => {
    const row = await readPost(WP_POST_ID)

    expect(row.nextjsPublishStatus).toBeNull()
    expect(hookRequests.map((entry) => JSON.parse(entry.body).post_id)).not.toContain(WP_POST_ID)
  })
})

describe("a finished nextjs post", () => {
  it("reaches the webhook receiver, signed", () => {
    const delivered = hookRequests.filter(
      (entry) => JSON.parse(entry.body).post_id === NEXTJS_POST_ID,
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0].method).toBe("POST")
    expect(delivered[0].url).toBe("/api/jena/publish")
    // The signature's construction is `lib/hmac-signing`'s contract and is
    // asserted there; what matters here is that the header arrived at all.
    expect(delivered[0].signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it("ends published", async () => {
    const row = await readPost(NEXTJS_POST_ID)

    expect(row.nextjsPublishStatus).toBe("published")
    expect(row.nextjsPublishedAt).toBeInstanceOf(Date)
    expect(logged).toContain(`Published post ${NEXTJS_POST_ID} to Next.js at ${hookUrl}`)
  })

  it("does not also publish to WordPress", () => {
    const creates = wpRequests.filter((entry) => entry.url === "/wp-json/wp/v2/posts")

    expect(creates).toHaveLength(1)
    expect(JSON.parse(creates[0].body).title).toBe(TITLE)
  })
})

/**
 * Python's `if is_full_pipeline:`. The rerun runs to completion and settles
 * `current_stage` through the rerun check, but the hook never fires, so the
 * post is not published a second time. The two runs above have already been
 * observed reaching their destinations by the time these assertions run, so a
 * publish that this run had started would have had every chance to arrive.
 */
describe("a named-stage rerun of a configured post", () => {
  /**
   * The two full runs skip every stage, so the only agent call in the file is
   * the stage the rerun named. A stage that ran on a full run would mean the
   * seeding is wrong and these three runs are not the runs described above.
   */
  it("is the only run that executed a stage", () => {
    expect(generated).toEqual(["edit"])
  })

  it("writes no publish marker", async () => {
    const row = await readPost(RERUN_POST_ID)

    expect(row.wpPublishStatus).toBeNull()
    expect(row.nextjsPublishStatus).toBeNull()
  })

  it("sends nothing to the site", () => {
    const forRerun = wpRequests.filter((entry) => entry.body.includes(RERUN_POST_ID))

    expect(forRerun).toEqual([])
  })
})
