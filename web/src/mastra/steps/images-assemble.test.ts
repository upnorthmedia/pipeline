// @vitest-environment node
/**
 * Parity for step 3 of the `images` stage (item 3.5f-ii): the fold that turns
 * the fan-out's results back into the stored manifest, and the single write
 * that commits the stage.
 *
 * Two oracles, neither of them this port's own output:
 *
 * - the golden fixtures, where every Gemini call was a 429, so the stored
 *   manifest is a whole failed stage and `_stage_meta_gemini` records a stage
 *   that billed nothing;
 * - `images/data/image-generation-parity.json` (item 3.5e), captured by driving
 *   the real `images_node` with both providers intercepted, where 12 of 16
 *   entries succeeded and one of the four failures was billed anyway.
 *
 * The `images` array itself is passed through untouched by this step, so what
 * is asserted here is what the step decides: the two totals, the key order of
 * the stored document, both meta records, the stage status, and that the stage
 * writes exactly once.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { GEMINI_IMAGE_MODEL_ID } from "../images/gemini"
import { mastra, pubsub } from "../index"
import { imagesWorkflow } from "../workflows/images"
import { foldManifest, imagesAssembleStep, imagesStageOutputSchema } from "./images-assemble"
import type { GeneratedImageOutput } from "./images-generate"
import { imagesManifestStep } from "./images-manifest"
import type { ImagesManifestOutput } from "./images-manifest"

import corpus from "../images/data/image-generation-parity.json"

const goldenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/mastra-port/golden",
)

const FIXTURE_SLUGS = [
  "how-to-choose-a-crm-for-a-small-team",
  "best-time-tracking-tools-for-agencies",
] as const

type Fixture = {
  post_spec: Record<string, never>
  state_input: { stage_status: Record<string, string> }
  stage_output: {
    image_manifest: Record<string, unknown> & { images: Record<string, unknown>[] }
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
    _stage_meta_gemini: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "images.json"), "utf8"))
}

/** The keys `_generate_one` adds on top of the spec Claude wrote. */
const BOOKKEEPING_KEYS = ["generated", "index", "size_bytes", "url", "error"] as const

function specOf(stored: Record<string, unknown>): Record<string, unknown> {
  const spec = { ...stored }
  for (const key of BOOKKEEPING_KEYS) delete spec[key]
  return spec
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
/** Namespaced post ids, so this file's rows cannot collide with another suite's. */
const ID_NAMESPACE = "f2"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

/** The wall clock the manifest step would have recorded, and the elapsed stage. */
const STAGE_START_MS = Date.UTC(2026, 2, 7, 15, 4, 5)
const STAGE_ELAPSED_MS = 68_252

/**
 * The manifest step's output as it was for a fixture: the document Claude
 * wrote, with the entries stripped back to the specs Python parsed out of it.
 */
function manifestOutputOf(fixture: Fixture, postId: string): ImagesManifestOutput {
  const stored = fixture.stage_output.image_manifest
  const manifest = { ...stored } as Record<string, unknown>
  delete manifest.total_generated
  delete manifest.total_failed
  manifest.images = stored.images.map(specOf)
  return {
    postId,
    stageStartedAtMs: STAGE_START_MS,
    model: fixture.stage_output._stage_meta.model,
    tokensIn: fixture.stage_output._stage_meta.tokens_in,
    tokensOut: fixture.stage_output._stage_meta.tokens_out,
    parseFailed: false,
    manifest: manifest as ImagesManifestOutput["manifest"],
    images: manifest.images as ImagesManifestOutput["images"],
  }
}

/**
 * The fan-out's results for a fixture: every entry exactly as Python stored it,
 * and no usage anywhere, because every recorded Gemini call was a 429 and
 * `generate_image` raised before any token was reported.
 */
function fixtureResults(fixture: Fixture): GeneratedImageOutput[] {
  return fixture.stage_output.image_manifest.images.map((stored) => ({
    spec: stored as GeneratedImageOutput["spec"],
    usage: null,
  }))
}

/**
 * The fan-out's results for the 3.5e corpus.
 *
 * Usage is rebuilt from the exporter's own stub schedule (`tokensIn = 10 + n`,
 * `tokensOut = 100 + n` for the nth call, nothing at all when the call raised),
 * paired with the entries in manifest order. Two entries carry no prompt and so
 * made no call; the pairing is checked against the corpus' own 14 recorded
 * calls before it is used.
 */
function corpusResults(): GeneratedImageOutput[] {
  const inputs = corpus.input_manifest.images as Record<string, unknown>[]
  let call = 0
  return corpus.images.map((stored, index) => {
    const prompt = inputs[index].prompt
    if (typeof prompt !== "string" || prompt === "") {
      return { spec: stored as unknown as GeneratedImageOutput["spec"], usage: null }
    }
    call += 1
    return {
      spec: stored as unknown as GeneratedImageOutput["spec"],
      usage:
        prompt === "RAISE"
          ? null
          : { tokensIn: 10 + call, tokensOut: 100 + call, model: GEMINI_IMAGE_MODEL_ID },
    }
  })
}

type ExecuteParams = Parameters<typeof imagesAssembleStep.execute>[0]

async function runAssemble(manifestOutput: ImagesManifestOutput, results: GeneratedImageOutput[]) {
  const seen: unknown[] = []
  const output = await imagesAssembleStep.execute({
    inputData: results,
    getStepResult: (step: unknown) => {
      seen.push(step)
      return manifestOutput
    },
  } as unknown as ExecuteParams)
  return { output: imagesStageOutputSchema.parse(output), seen }
}

async function readRow(postId: string) {
  const rows = await db.select().from(posts).where(inArray(posts.id, [postId]))
  return rows[0]
}

async function insertFixturePosts() {
  for (const [index, fixture] of fixtures.entries()) {
    const spec = fixture.post_spec
    await db.insert(posts).values({
      id: fixtureIds[index],
      slug: spec.slug,
      topic: spec.topic,
      targetAudience: spec.target_audience,
      niche: spec.niche,
      intent: spec.intent,
      articleType: spec.article_type,
      outputFormat: spec.output_format,
      wordCount: spec.word_count,
      tone: spec.tone,
      websiteUrl: spec.website_url,
      relatedKeywords: spec.related_keywords,
      competitorUrls: spec.competitor_urls,
      imageStyle: spec.image_style,
      imageBrandColors: spec.image_brand_colors,
      imageExclude: spec.image_exclude,
      brandVoice: spec.brand_voice,
      avoid: spec.avoid,
      requiredMentions: spec.required_mentions,
      additionalInfo: spec.additional_info,
      currentStage: "edit",
      stageSettings: null,
      stageStatus: fixture.state_input.stage_status,
    })
  }
}

async function cleanup() {
  await db.delete(posts).where(inArray(posts.id, fixtureIds))
}

beforeAll(cleanup)

beforeEach(async () => {
  await cleanup()
  await insertFixturePosts()
  // Only `Date` is faked, so the stage duration is the difference this step
  // computes rather than however long the assertions take. Timers stay real so
  // the postgres driver's own timeouts still fire.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false })
  vi.setSystemTime(new Date(STAGE_START_MS + STAGE_ELAPSED_MS))
  return () => vi.useRealTimers()
})

afterAll(async () => {
  await cleanup()
  await pubsub.close()
  await closeDb()
})

describe("images workflow registration", () => {
  it("is registered on the Mastra instance as a workflow, not a step", () => {
    expect(mastra.getWorkflow("images")).toBe(imagesWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("images")
    expect(imagesWorkflow.id).toBe("images")
  })

  it("fans the manifest out with .foreach() at Python's semaphore width", () => {
    const graph = imagesWorkflow.serializedStepGraph as {
      type: string
      id?: string
      step?: { id?: string; step?: { id?: string } }
      opts?: { concurrency?: number }
    }[]

    expect(graph.map((entry) => entry.type)).toEqual(["step", "mapping", "foreach", "step"])
    expect(graph[0].step?.id).toBe("images-manifest")
    expect(graph[2].step?.step?.id).toBe("images-generate")
    // `asyncio.Semaphore(3)` in `images_node`.
    expect(graph[2].opts?.concurrency).toBe(3)
    expect(graph[3].step?.id).toBe("images-assemble")
  })
})

describe("images assemble step against the golden fixtures", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`stores the manifest Python stored for ${slug}`, async () => {
      const fixture = fixtures[index]
      const postId = fixtureIds[index]

      const { output } = await runAssemble(
        manifestOutputOf(fixture, postId),
        fixtureResults(fixture),
      )

      const row = await readRow(postId)
      expect(row.imageManifest).toEqual(fixture.stage_output.image_manifest)
      expect(output.totalGenerated).toBe(fixture.stage_output.image_manifest.total_generated)
      expect(output.totalFailed).toBe(fixture.stage_output.image_manifest.total_failed)
    })

    it(`reports both meta records for ${slug}`, async () => {
      const fixture = fixtures[index]

      const { output } = await runAssemble(
        manifestOutputOf(fixture, fixtureIds[index]),
        fixtureResults(fixture),
      )

      expect(output.stage).toBe("images")
      expect(output.model).toBe(fixture.stage_output._stage_meta.model)
      expect(output.tokensIn).toBe(fixture.stage_output._stage_meta.tokens_in)
      expect(output.tokensOut).toBe(fixture.stage_output._stage_meta.tokens_out)

      // Every recorded Gemini call was a 429, so the stage billed nothing and
      // still reports the model id it would have used.
      expect(output.gemini).toEqual({
        stage: "images_gemini",
        model: fixture.stage_output._stage_meta_gemini.model,
        tokensIn: fixture.stage_output._stage_meta_gemini.tokens_in,
        tokensOut: fixture.stage_output._stage_meta_gemini.tokens_out,
        durationS: STAGE_ELAPSED_MS / 1000,
      })
    })

    it(`advances stage_status the way Python did for ${slug}`, async () => {
      const fixture = fixtures[index]
      const postId = fixtureIds[index]

      await runAssemble(manifestOutputOf(fixture, postId), fixtureResults(fixture))

      const row = await readRow(postId)
      // "complete", even though every image failed: Python only reports the
      // stage failed when the *manifest* could not be parsed.
      expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
      expect(row.currentStage).toBe("images")
    })
  }

  it("writes the stage exactly once and touches nothing else on the row", async () => {
    const fixture = fixtures[0]
    const postId = fixtureIds[0]
    const before = await readRow(postId)

    await runAssemble(manifestOutputOf(fixture, postId), fixtureResults(fixture))

    const after = await readRow(postId)
    const changed = Object.keys(after).filter(
      (key) =>
        JSON.stringify(after[key as keyof typeof after]) !==
        JSON.stringify(before[key as keyof typeof before]),
    )
    expect(changed.sort()).toEqual(["currentStage", "imageManifest", "stageStatus", "updatedAt"])
  })

  it("reads the manifest back through getStepResult on the manifest step", async () => {
    const fixture = fixtures[0]

    const { seen } = await runAssemble(
      manifestOutputOf(fixture, fixtureIds[0]),
      fixtureResults(fixture),
    )

    expect(seen).toEqual([imagesManifestStep])
  })

  it("gives both meta records the one whole-stage duration", async () => {
    const fixture = fixtures[0]

    const { output } = await runAssemble(
      manifestOutputOf(fixture, fixtureIds[0]),
      fixtureResults(fixture),
    )

    expect(output.durationS).toBe(STAGE_ELAPSED_MS / 1000)
    expect(output.gemini?.durationS).toBe(output.durationS)
  })
})

describe("images assemble step against the 3.5e generation corpus", () => {
  it("counts the generated and failed entries the way Python counted them", async () => {
    const manifestOutput = {
      ...manifestOutputOf(fixtures[0], fixtureIds[0]),
      manifest: corpus.input_manifest as unknown as ImagesManifestOutput["manifest"],
      images: corpus.input_manifest.images as unknown as ImagesManifestOutput["images"],
    }

    const { output } = await runAssemble(manifestOutput, corpusResults())

    expect(output.totalGenerated).toBe(corpus.total_generated)
    expect(output.totalFailed).toBe(corpus.total_failed)

    const row = await readRow(fixtureIds[0])
    const stored = row.imageManifest as Record<string, unknown>
    expect(stored.images).toEqual(corpus.images)
    expect(stored.total_generated).toBe(corpus.total_generated)
    expect(stored.total_failed).toBe(corpus.total_failed)
  })

  it("bills every call the provider answered, including the one the optimizer rejected", async () => {
    const results = corpusResults()
    // The corpus recorded 14 outbound calls over 16 entries; the pairing that
    // produces the usage below has to agree with that before its sums mean
    // anything.
    expect(results.filter((result) => result.usage !== null)).toHaveLength(
      corpus.gemini_calls.filter((call) => call.prompt !== "RAISE").length,
    )
    // Four entries failed, and one of them (`BADBYTES`) failed *after* the
    // provider answered, so it is counted as failed and billed all the same.
    const billedFailures = results.filter(
      (result) => result.usage !== null && result.spec.generated !== true,
    )
    expect(billedFailures).toHaveLength(1)

    const manifestOutput = {
      ...manifestOutputOf(fixtures[0], fixtureIds[0]),
      manifest: corpus.input_manifest as unknown as ImagesManifestOutput["manifest"],
      images: corpus.input_manifest.images as unknown as ImagesManifestOutput["images"],
    }
    const { output } = await runAssemble(manifestOutput, results)

    expect(output.gemini).toEqual({
      stage: "images_gemini",
      model: corpus.stage_meta_gemini.model,
      tokensIn: corpus.stage_meta_gemini.tokens_in,
      tokensOut: corpus.stage_meta_gemini.tokens_out,
      durationS: STAGE_ELAPSED_MS / 1000,
    })
  })
})

describe("the fold itself", () => {
  /**
   * Postgres `jsonb` sorts object keys by length and then bytes, so the order
   * Python's dict carried is gone by the time the row is read back and cannot
   * be asserted on it. It is still the order every in-process reader sees
   * between the fold and the write, and it is the one property of the fold a
   * `toEqual` on the row cannot check, so it is pinned on the document itself.
   */
  it("keeps `images` in place and appends the two totals", () => {
    const folded = foldManifest(
      corpus.input_manifest as unknown as Record<string, unknown>,
      corpus.images as unknown as Record<string, unknown>[],
    )

    expect(Object.keys(folded)).toEqual(corpus.manifest_keys)
    expect(Object.keys(corpus.input_manifest)).toEqual(["version", "style_brief", "images"])
  })

  it("appends `images` when the model wrote a manifest without one", () => {
    const folded = foldManifest({ style_brief: {} }, [])

    expect(Object.keys(folded)).toEqual(["style_brief", "images", "total_generated", "total_failed"])
    expect(folded.total_generated).toBe(0)
    expect(folded.total_failed).toBe(0)
  })
})

describe("images assemble step on the parse-failure branch", () => {
  /** What `_parse_manifest` synthesises when it recovers nothing. */
  const FAILED_MANIFEST = {
    images: [],
    style_brief: {},
    error: "Failed to parse manifest",
  } as unknown as ImagesManifestOutput["manifest"]

  function failedOutput(postId: string): ImagesManifestOutput {
    return {
      ...manifestOutputOf(fixtures[0], postId),
      parseFailed: true,
      manifest: FAILED_MANIFEST,
      images: [],
    }
  }

  it("stores the synthesised manifest verbatim, with no totals added", async () => {
    const postId = fixtureIds[0]

    await runAssemble(failedOutput(postId), [])

    const row = await readRow(postId)
    expect(row.imageManifest).toEqual(FAILED_MANIFEST)
    // No `total_generated` / `total_failed`: Python returns before the fold.
    expect(Object.keys(row.imageManifest as object).sort()).toEqual([
      "error",
      "images",
      "style_brief",
    ])
  })

  it("marks the stage failed while still advancing current_stage", async () => {
    const postId = fixtureIds[0]

    await runAssemble(failedOutput(postId), [])

    const row = await readRow(postId)
    expect((row.stageStatus as Record<string, string>).images).toBe("failed")
    expect(row.currentStage).toBe("images")
  })

  it("reports duration 0 and no Gemini record", async () => {
    const { output } = await runAssemble(failedOutput(fixtureIds[0]), [])

    // `StageTimer.duration` is still 0 here: Python returns from inside the
    // `with` block and the elapsed time is only computed in `__exit__`.
    expect(output.durationS).toBe(0)
    expect(output.parseFailed).toBe(true)
    // No image was attempted, so there is no `_stage_meta_gemini` at all.
    expect(output.gemini).toBeNull()
    expect(output.totalGenerated).toBe(0)
    expect(output.totalFailed).toBe(0)
  })

  it("still reports Claude's usage for the manifest it paid for", async () => {
    const { output } = await runAssemble(failedOutput(fixtureIds[0]), [])

    expect(output.model).toBe(fixtures[0].stage_output._stage_meta.model)
    expect(output.tokensIn).toBe(fixtures[0].stage_output._stage_meta.tokens_in)
    expect(output.tokensOut).toBe(fixtures[0].stage_output._stage_meta.tokens_out)
  })
})
