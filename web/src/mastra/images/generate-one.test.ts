// @vitest-environment node
/**
 * Parity for `generateOneImage` (item 3.5e).
 *
 * The oracle is `data/image-generation-parity.json`, produced by
 * `api/scripts/export_image_generation_parity.py` driving the real
 * `images_node` with `ClaudeClient` and `GeminiClient` intercepted and a
 * frozen clock and `randint`. Everything between the provider and the disk ran
 * for real over there, so the corpus records what Python actually stored, wrote
 * and billed rather than a description of it.
 *
 * The Gemini client is the one boundary stubbed here, and it is stubbed to the
 * same schedule the exporter used: the same PNG, the same per-call token
 * counts, the same prompt that raises and the same prompt that returns bytes
 * the optimizer will reject. Its own wire behaviour is item 3.5d's corpus. The
 * optimizer is *not* stubbed: sharp encodes the corpus PNG for real, and the
 * committed sha256 of each written file is Pillow's, so a byte of drift in the
 * encoder fails this file too.
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import sharp from "sharp"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import corpus from "./data/image-generation-parity.json"
import type { GeneratedImage, ImageSpec } from "./generate-one"
import { featuredFilename, generateOneImage, pathStem } from "./generate-one"

vi.mock("./gemini", () => ({
  generateImage: vi.fn(),
}))

const { generateImage } = await import("./gemini")
const generateImageMock = vi.mocked(generateImage)

const PNG = Buffer.from(corpus.png_base64, "base64")
const WIDE_PNG = Buffer.from(corpus.wide_png_base64, "base64")

/**
 * The two entries whose image was wider than its optimize width.
 *
 * They are the only cases that resize, which is exactly why they exist (no
 * other input can tell the 1920 branch from the 1200 one) and exactly why their
 * byte counts are not comparable: Pillow resamples with its own Lanczos
 * convolution and sharp with libvips' reduce, so the WebP that comes out
 * differs in size while the dimensions agree (item 3.5b).
 */
const RESIZED_IDS = new Set(["wide-content", "wide-featured"])

/** Every field of a manifest entry except the one the resampler decides. */
function withoutSizeBytes(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([key]) => key !== "size_bytes"))
}

/** `Math.random()` values that land on the corpus' frozen `randint(10, 99)`. */
const FROZEN_RANDOM = (corpus.frozen_randint - 10) / 90

/** The exporter's stub, restated so the token schedule is the same one. */
function installGeminiStub() {
  let calls = 0
  const seen: { prompt: string; aspectRatio: string; imageSize: string }[] = []
  generateImageMock.mockImplementation(async ({ prompt, aspectRatio, imageSize }) => {
    seen.push({ prompt, aspectRatio: aspectRatio!, imageSize: imageSize! })
    calls += 1
    if (prompt === "RAISE") throw new Error("429 RESOURCE_EXHAUSTED. quota exceeded")
    return {
      imageBytes:
        prompt === "BADBYTES"
          ? Buffer.from("not an image")
          : prompt === "WIDE"
            ? WIDE_PNG
            : PNG,
      model: "gemini-3.1-flash-image-preview",
      tokensIn: 10 + calls,
      tokensOut: 100 + calls,
    }
  })
  return seen
}

let mediaDir: string
const created: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "images-parity-"))
  created.push(root)
  mediaDir = path.join(root, corpus.post_id)
  await import("node:fs/promises").then((fs) => fs.mkdir(mediaDir, { recursive: true }))

  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })
  vi.setSystemTime(new Date(corpus.frozen_now))
  vi.spyOn(Math, "random").mockReturnValue(FROZEN_RANDOM)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  generateImageMock.mockReset()
})

afterAll(async () => {
  for (const root of created) await rm(root, { recursive: true, force: true })
})

/**
 * The whole manifest, one image at a time in manifest order.
 *
 * Sequential on purpose: the stub's token counts are numbered by call order,
 * exactly as the exporter's were, and the fan-out's concurrency is item 3.5f.
 */
async function runManifest(): Promise<{
  results: GeneratedImage[]
  sent: { prompt: string; aspectRatio: string; imageSize: string }[]
}> {
  const sent = installGeminiStub()
  const results: GeneratedImage[] = []
  for (const [index, spec] of (corpus.input_manifest.images as ImageSpec[]).entries()) {
    results.push(
      await generateOneImage({
        spec,
        index,
        postId: corpus.post_id,
        mediaDir,
        apiKey: "test-key-not-a-real-credential",
      }),
    )
  }
  return { results, sent }
}

/**
 * Pillow renders the failing buffer's address into its message and sharp writes
 * its own, so this one entry's `error` text cannot be matched across stacks.
 * The exporter masks the address; the assertion below drops the text.
 */
const IMPLEMENTATION_SPECIFIC_ERROR = "unoptimizable"

describe("pathStem", () => {
  for (const oracle of corpus.path_stem_cases) {
    it(`matches Path(${JSON.stringify(oracle.input)}).stem`, () => {
      expect(pathStem(oracle.input)).toBe(oracle.stem)
    })
  }
})

describe("generateOneImage manifest entries", () => {
  it("stores the entry Python stored, for every image in the corpus", async () => {
    const { results } = await runManifest()

    expect(results).toHaveLength(corpus.images.length)
    for (const [index, expected] of corpus.images.entries()) {
      const actual = results[index].spec
      if (expected.id === IMPLEMENTATION_SPECIFIC_ERROR) {
        expect(actual.generated).toBe(false)
        expect(actual.index).toBe(index)
        expect(typeof actual.error).toBe("string")
        expect(actual.error).not.toBe("")
        continue
      }
      if (RESIZED_IDS.has(String(expected.id))) {
        expect(withoutSizeBytes(actual)).toEqual(withoutSizeBytes(expected))
        expect(actual.size_bytes).toBeGreaterThan(0)
        continue
      }
      expect(actual).toEqual(expected)
    }
  })

  it("sends the aspect ratio and image size Python sent, for every call", async () => {
    const { sent } = await runManifest()

    expect(sent).toEqual(
      corpus.gemini_calls.map((call) => ({
        prompt: call.prompt,
        aspectRatio: call.aspect_ratio,
        imageSize: call.image_size,
      })),
    )
  })

  it("skips the provider entirely for an entry with no usable prompt", async () => {
    const { results } = await runManifest()

    const skipped = corpus.images.filter((image) => image.error === "no prompt")
    expect(skipped).toHaveLength(2)
    for (const image of skipped) {
      expect(results[image.index as number].usage).toBeNull()
    }
    // Two of the fourteen entries never reach Gemini.
    expect(generateImageMock).toHaveBeenCalledTimes(corpus.gemini_calls.length)
  })
})

describe("generateOneImage usage accounting", () => {
  it("sums to the `_stage_meta_gemini` totals Python reported", async () => {
    const { results } = await runManifest()

    const billed = results.map((r) => r.usage).filter((u) => u !== null)
    const tokensIn = billed.reduce((total, u) => total + u.tokensIn, 0)
    const tokensOut = billed.reduce((total, u) => total + u.tokensOut, 0)

    expect(tokensIn).toBe(corpus.stage_meta_gemini.tokens_in)
    expect(tokensOut).toBe(corpus.stage_meta_gemini.tokens_out)
    expect(billed.at(-1)!.model).toBe(corpus.stage_meta_gemini.model)
  })

  it("bills a call whose bytes the optimizer then rejected", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex(
      (image) => image.id === IMPLEMENTATION_SPECIFIC_ERROR,
    )
    const entry = results[index]
    // The provider answered and charged for it, so the totals above include
    // this call even though the entry is stored as a failure. Reporting usage
    // only for successes would silently under-report spend.
    expect(entry.spec.generated).toBe(false)
    expect(entry.usage).not.toBeNull()
    expect(entry.usage!.tokensOut).toBeGreaterThan(0)
  })

  it("bills nothing for the call that raised", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex((image) => image.id === "provider-error")
    expect(results[index].usage).toBeNull()
    expect(results[index].spec.error).toBe(corpus.images[index].error)
  })
})

describe("generateOneImage disk output", () => {
  it("writes the files Python wrote, byte for byte", async () => {
    await runManifest()

    const names = (await readdir(mediaDir)).sort()
    expect(names).toEqual(Object.keys(corpus.written_files).sort())

    for (const [name, expected] of Object.entries(corpus.written_files)) {
      const bytes = await readFile(path.join(mediaDir, name))
      const { width, height } = await sharp(bytes).metadata()
      // The dimensions are exact either way: they come from
      // `int(height * max_width / width)`, not from the resampler.
      expect({ width, height }).toEqual({ width: expected.width, height: expected.height })
      // A resized entry carries no hash, because its bytes are the
      // resampler's rather than the encoder's.
      if (!("sha256" in expected)) {
        expect(expected.resized).toBe(true)
        continue
      }
      expect(bytes.length).toBe(expected.bytes)
      // Pillow's sha256. Equal because these cases are narrower than their
      // optimize width, so no resize happens and both stacks drive libwebp
      // with the same settings (item 3.5b).
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256)
    }
  })

  it("flattens a filename carrying a directory instead of writing outside the media dir", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex((image) => image.id === "nested-filename")
    expect(corpus.input_manifest.images[index].filename).toBe("sub/dir/nested.png")
    expect(results[index].spec.url).toBe(`/media/${corpus.post_id}/nested.webp`)
    expect(await readdir(mediaDir)).not.toContain("sub")
  })

  it("collapses every featured entry onto one filename, overwriting the others", async () => {
    const { results } = await runManifest()

    // Four entries are featured (two by `type`, two by a string `placement`),
    // and the featured rewrite depends only on the clock and one random draw,
    // so all three land on the same name and only one file survives. Real
    // manifests carry a single featured image, which is why the pipeline has
    // never hit this. Logged in todo.md.
    const featured = results.filter((r) => String(r.spec.url ?? "").includes("featured-"))
    expect(featured.length).toBeGreaterThan(1)
    expect(new Set(featured.map((r) => r.spec.url)).size).toBe(1)
    expect(Object.keys(corpus.written_files)).toHaveLength(
      corpus.total_generated - featured.length + 1,
    )
  })
})

describe("the featured branches Python's own manifests never reach", () => {
  it("does not apply the aspect-ratio and size overrides when placement is an object", async () => {
    const { sent } = await runManifest()

    // The real manifest shape: `placement` is `{location, after_section}`, so
    // `placement == "featured"` is false and the 16:9 / 2K forcing never fires.
    // The entry is still treated as featured for the optimize width and the
    // filename, because that test also accepts `type`.
    const spec = corpus.input_manifest.images[0]
    expect(spec.type).toBe("featured")
    expect(typeof spec.placement).toBe("object")
    expect(sent[0]).toEqual({
      prompt: spec.prompt,
      aspectRatio: spec.aspect_ratio,
      imageSize: spec.image_size,
    })
  })

  it("sends 2K while storing the 1K the model declared", async () => {
    const { results, sent } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "hero-string-placement-with-ratio",
    )
    // The override rewrites the local variable, never the entry, so the stored
    // manifest disagrees with the request that was actually made.
    expect(sent[index].imageSize).toBe("2K")
    expect(results[index].spec.image_size).toBe("1K")
  })

  it("leaves aspect_ratio absent from an entry it defaulted to 16:9", async () => {
    const { results, sent } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "hero-string-placement",
    )
    expect(sent[index].aspectRatio).toBe("16:9")
    expect(results[index].spec).not.toHaveProperty("aspect_ratio")
  })

  it("overwrites bookkeeping keys a previous run left on the entry", async () => {
    const { results } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "stale-keys",
    )
    expect(corpus.input_manifest.images[index]).toMatchObject({ index: 99, generated: true })
    expect(results[index].spec).toMatchObject({
      index,
      generated: true,
      url: `/media/${corpus.post_id}/stale.webp`,
    })
  })
})

describe("featuredFilename", () => {
  it("renders the frozen clock and draw the corpus recorded", () => {
    expect(featuredFilename(".webp")).toBe(
      String(corpus.images[0].url).split("/").pop(),
    )
  })

  it("draws from the inclusive 10-99 range randint used", () => {
    const random = vi.spyOn(Math, "random")

    random.mockReturnValue(0)
    expect(featuredFilename(".webp")).toMatch(/-10\.webp$/)
    // The largest value `Math.random()` can return is just under 1.
    random.mockReturnValue(1 - Number.EPSILON / 2)
    expect(featuredFilename(".webp")).toMatch(/-99\.webp$/)
  })
})
