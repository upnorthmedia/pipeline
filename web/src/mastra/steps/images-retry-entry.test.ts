// @vitest-environment node
/**
 * Item 5.5c-iii-b-2-b-ii: the `warning` / `retry` entry, written from inside
 * the three `images` sub-steps.
 *
 * `workflows/images-retry.test.ts` covers this through a real failing nested
 * run, which is where the interleaving with `stage_start` is pinned, but that
 * run can only ever fail in `images-manifest`: a failing manifest never reaches
 * the fan-out, and `generateOneImage` is documented as never throwing, so the
 * other two sub-steps' catch blocks are unreachable from a real run. These
 * drive each sub-step's `execute` directly against the real database so that
 * all three are covered, along with the boundary a real run cannot reach (the
 * last attempt writes nothing, because nothing follows it).
 *
 * Requires `docker compose up -d db`.
 */
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { MAX_ATTEMPTS } from "../state"
import { imagesAssembleStep } from "./images-assemble"
import { imagesGenerateStep } from "./images-generate"
import { imagesManifestStep } from "./images-manifest"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  // Every sub-step resolves a credential before it does anything else, so this
  // is the one boundary that has to answer for the step to reach the code the
  // forced failure sits in.
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

const POST_ID = "00000000-0000-4000-8000-00000005c3bc"
const BOOM = "sub-step exploded"

const db = getDb()

type ManifestParams = Parameters<typeof imagesManifestStep.execute>[0]
type GenerateParams = Parameters<typeof imagesGenerateStep.execute>[0]
type AssembleParams = Parameters<typeof imagesAssembleStep.execute>[0]

async function readLogs(): Promise<Record<string, unknown>[]> {
  const [row] = await db
    .select({ logs: posts.executionLogs })
    .from(posts)
    .where(eq(posts.id, POST_ID))
  return (row?.logs ?? []) as Record<string, unknown>[]
}

/**
 * Only the `retry` entries. `images-manifest` announces the stage before it
 * reaches the agent, so its trail also carries the `stage_start` 5.5c-i wrote;
 * the other two sub-steps announce nothing. The whole trail for the manifest
 * case is asserted on its own below, so filtering here is not hiding it.
 */
async function readRetries(): Promise<Record<string, unknown>[]> {
  return (await readLogs()).filter((entry) => entry.event === "retry")
}

/**
 * `images-manifest` fails on the agent call, which is the failure the real run
 * exercises. `mastra.getAgent` throwing reaches the same catch and needs no
 * agent registry behind it.
 */
function runManifest(retryCount: number): Promise<unknown> {
  return imagesManifestStep.execute({
    inputData: { postId: POST_ID },
    retryCount,
    suspend: async () => {
      throw new Error("the gate must not fire: the row is seeded with auto settings")
    },
    mastra: {
      getAgent: () => {
        throw new Error(BOOM)
      },
      getLogger: () => undefined,
      pubsub: { publish: async () => {} },
    },
  } as unknown as ManifestParams)
}

/**
 * `images-generate` fails on its own output parse: the spec it hands back is
 * the one place after the credential read where a throw is reachable, since
 * `generateOneImage` catches everything.
 */
function runGenerate(retryCount: number): Promise<unknown> {
  return imagesGenerateStep.execute({
    inputData: {
      postId: POST_ID,
      mediaDir: "/nonexistent",
      index: 0,
      // `prompt` is not a string, so the provider is never called and the
      // no-prompt entry comes straight back; the entry carries the
      // unserialisable value through, which `imageSpecSchema` then rejects.
      spec: { prompt: () => {} },
    },
    retryCount,
  } as unknown as GenerateParams)
}

/**
 * `images-assemble` fails after `getStepResult`, which is where its post id
 * comes from. `getStepResult` throwing is the one blind spot, recorded in the
 * step.
 */
function runAssemble(retryCount: number): Promise<unknown> {
  return imagesAssembleStep.execute({
    inputData: [],
    retryCount,
    getStepResult: () => ({
      postId: POST_ID,
      stages: undefined,
      skipped: false,
      parseFailed: false,
      stageStartedAtMs: Date.now(),
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      // A value `imageManifestSchema` rejects, so the parse of the folded
      // document throws before the step writes anything.
      manifest: { unserialisable: () => {} },
    }),
    mastra: { pubsub: { publish: async () => {} } },
  } as unknown as AssembleParams)
}

const SUB_STEPS = [
  { id: "images-manifest", run: runManifest },
  { id: "images-generate", run: runGenerate },
  { id: "images-assemble", run: runAssemble },
] as const

beforeEach(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "images-retry-entry",
    topic: "retrying",
    // Explicit, because the column default predates the gate removal and would
    // park `images-manifest` at its review gate before it reaches the agent.
    stageSettings: {
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    },
  })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe.each(SUB_STEPS)("$id on the way out", ({ run }) => {
  it("writes the stage's retry entry while attempts remain", async () => {
    await expect(run(0)).rejects.toThrow()
    expect(await readRetries()).toEqual([
      {
        ts: expect.any(String),
        // The stage's name, not the sub-step's: the log reader groups on
        // `stage` and Python only ever wrote `images` here. Which sub-step
        // threw is recoverable from the `error` text.
        stage: "images",
        level: "warning",
        event: "retry",
        message: "Pipeline attempt 1 failed, retrying...",
        data: { attempt: 1, max_attempts: MAX_ATTEMPTS, error: expect.any(String) },
      },
    ])
  })

  it("writes nothing on the attempt that spends the last one", async () => {
    await expect(run(MAX_ATTEMPTS - 1)).rejects.toThrow()
    expect(await readRetries()).toEqual([])
  })

  it("rethrows the error unchanged, so the engine still sees the failure", async () => {
    // The record is a side effect of the failure, never a substitute for it:
    // swallowing here would make a broken stage look like a successful one.
    await expect(run(0)).rejects.toThrow(Error)
  })
})

describe("images-manifest, which is the sub-step a real failing run reaches", () => {
  it("leaves the announcement it already wrote in front of the retry", async () => {
    // The one sub-step that announces the stage before it can fail, so the one
    // place the interleaving is visible from a direct call. The real nested run
    // in `workflows/images-retry.test.ts` pins the repeated form of this.
    await expect(runManifest(0)).rejects.toThrow(BOOM)
    expect((await readLogs()).map((entry) => `${entry.level}/${entry.event}`)).toEqual([
      "info/stage_start",
      // The two progress lines the attempt reaches before the agent throws
      // (item 5.5c-iv-d-1).
      "info/log",
      "info/log",
      "warning/retry",
    ])
  })

  it("records the error the agent threw, not the step's own wrapper", async () => {
    await expect(runManifest(0)).rejects.toThrow(BOOM)
    expect((await readRetries())[0]?.data).toEqual({
      attempt: 1,
      max_attempts: MAX_ATTEMPTS,
      error: BOOM,
    })
  })
})
