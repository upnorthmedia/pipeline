// @vitest-environment node
/**
 * Parity for `generateOneImage` (item 3.5e), and the four places the polish run
 * deliberately stopped matching Python (ledger P2.2, P2.10, P2.11, P2.12).
 *
 * The divergences are held in the two tables below rather than baked into the
 * assertions, so the corpus stays the oracle for everything else and the exact
 * list of things this port answers differently is one thing to read. Each one is
 * also pinned on its own, further down, by a case that states what Python did
 * and asserts what this does instead.
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
import {
  NO_PROMPT_ERROR,
  featuredFilename,
  generateOneImage,
  isFeatured,
  pathStem,
} from "./generate-one"

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

/**
 * Python's rendering of the frozen clock and the frozen `randint(10, 99)`, read
 * off the one url the corpus recorded for it.
 *
 * Kept as the corpus' own string so a drift in either the date format or the
 * draw still fails here; only the trailing index is this port's addition.
 */
const FEATURED_PREFIX = String(corpus.images[0].url)
  .split("/")
  .pop()!
  .replace(/\.webp$/, "")

/** The name the featured rewrite gives the entry at `index` (P2.10). */
function featuredName(index: number): string {
  return `${FEATURED_PREFIX}-${index}.webp`
}

/**
 * The request each entry now records on itself, by corpus id (P2.11).
 *
 * Python stored whatever the model wrote and sent something else, so an entry
 * could claim `1K` for a call made at `2K` and an entry that declared nothing
 * claimed nothing while `4:3` / `1K` went over the wire. These are what the
 * provider was actually asked for, which is now what the entry says. The two
 * no-prompt entries are absent because they form no request at all.
 *
 * `hero-string-placement-with-ratio` is the one that reads oddly and is right:
 * its declared `1:1` survives, because the featured ratio is only a fallback,
 * while its declared `1K` does not, because the featured size is forced.
 */
const REQUESTED: Record<string, { aspect_ratio: string; image_size: string }> = {
  featured: { aspect_ratio: "16:9", image_size: "2K" },
  "hero-string-placement": { aspect_ratio: "16:9", image_size: "2K" },
  "hero-string-placement-with-ratio": { aspect_ratio: "1:1", image_size: "2K" },
  "wide-featured": { aspect_ratio: "16:9", image_size: "2K" },
  "content-defaults": { aspect_ratio: "4:3", image_size: "1K" },
  "no-filename": { aspect_ratio: "4:3", image_size: "1K" },
  "multi-dot": { aspect_ratio: "4:3", image_size: "1K" },
  "no-extension": { aspect_ratio: "4:3", image_size: "1K" },
  "nested-filename": { aspect_ratio: "4:3", image_size: "1K" },
  "empty-filename": { aspect_ratio: "4:3", image_size: "1K" },
  "provider-error": { aspect_ratio: "4:3", image_size: "1K" },
  "wide-content": { aspect_ratio: "4:3", image_size: "1K" },
  unoptimizable: { aspect_ratio: "4:3", image_size: "1K" },
  "stale-keys": { aspect_ratio: "4:3", image_size: "1K" },
}

/**
 * The url each entry now records where Python recorded another, by corpus id.
 *
 * Four of the five are the featured collision (P2.10): Python gave all four
 * featured entries `featured-030726-47.webp` and wrote one file. The fifth is
 * the dotfile (P2.12): `filename: ""` wrote `.webp`, which no static handler
 * serves.
 */
const RENAMED: Record<string, string> = {
  featured: featuredName(0),
  "hero-string-placement": featuredName(1),
  "hero-string-placement-with-ratio": featuredName(2),
  "wide-featured": featuredName(13),
  "empty-filename": "image-8.webp",
}

/** A corpus entry rewritten to what this port stores instead. */
function expected(entry: Record<string, unknown>): Record<string, unknown> {
  const id = String(entry.id)
  const rewritten: Record<string, unknown> = { ...entry, ...(REQUESTED[id] ?? {}) }
  if (id in RENAMED && entry.generated) {
    rewritten.url = `/media/${corpus.post_id}/${RENAMED[id]}`
  }
  return rewritten
}

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
  it("stores the entry Python stored, except where this port diverges", async () => {
    const { results } = await runManifest()

    expect(results).toHaveLength(corpus.images.length)
    for (const [index, entry] of corpus.images.entries()) {
      const actual = results[index].spec
      const want = expected(entry)
      if (entry.id === IMPLEMENTATION_SPECIFIC_ERROR) {
        expect(actual.generated).toBe(false)
        expect(actual.index).toBe(index)
        expect(typeof actual.error).toBe("string")
        expect(actual.error).not.toBe("")
        continue
      }
      if (RESIZED_IDS.has(String(entry.id))) {
        expect(withoutSizeBytes(actual)).toEqual(withoutSizeBytes(want))
        expect(actual.size_bytes).toBeGreaterThan(0)
        continue
      }
      expect(actual).toEqual(want)
    }
  })

  it("asks the provider for what the entry now claims, for every call", async () => {
    const { sent } = await runManifest()

    // The same table the stored entries are checked against, so the manifest
    // and the wire cannot drift apart without failing here (P2.11).
    expect(sent).toEqual(
      (corpus.input_manifest.images as Record<string, unknown>[])
        .filter((spec) => typeof spec.prompt === "string" && spec.prompt !== "")
        .map((spec) => ({
          prompt: spec.prompt,
          aspectRatio: REQUESTED[String(spec.id)].aspect_ratio,
          imageSize: REQUESTED[String(spec.id)].image_size,
        })),
    )
  })

  it("sends what Python sent for every call but the one P2.2 changes", async () => {
    const { sent } = await runManifest()

    const pythonSent = corpus.gemini_calls.map((call) => ({
      prompt: call.prompt,
      aspectRatio: call.aspect_ratio,
      imageSize: call.image_size,
    }))
    const differing = sent
      .map((call, index) => ({ index, call, python: pythonSent[index] }))
      .filter(({ call, python }) => JSON.stringify(call) !== JSON.stringify(python))

    // Exactly one: `wide-featured`, which carries `type: "featured"` and no
    // `placement`. Python treated it as featured for the optimize width and the
    // filename and as ordinary for the ratio and the size, so it asked Gemini
    // for a 4:3 1K image and then upscaled the answer to 1920px.
    expect(differing).toHaveLength(1)
    expect(differing[0].python).toEqual({ prompt: "WIDE", aspectRatio: "4:3", imageSize: "1K" })
    expect(differing[0].call).toEqual({ prompt: "WIDE", aspectRatio: "16:9", imageSize: "2K" })
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

/**
 * Item 5.5c-iv-d-2. The two lines Python published from inside `_generate_one`
 * pick themselves by which branch produced the entry, and the branch is not
 * recoverable from the entry: a no-prompt short circuit and a provider failure
 * both come back with `generated: false`, a `usage` of `null` and an `error`
 * string, and only the branch decides whether anything is published at all.
 * `outcome` is that branch, stated by the function that took it.
 */
describe("generateOneImage outcome", () => {
  it("names the branch every corpus entry took", async () => {
    const { results } = await runManifest()

    const kinds = results.map((result) => result.outcome.kind)
    expect(kinds).toEqual(
      corpus.images.map((image) => {
        if (image.generated) return "generated"
        return image.error === NO_PROMPT_ERROR ? "no-prompt" : "failed"
      }),
    )
  })

  it("carries the two values the `image_generated` line interpolates", async () => {
    const { results } = await runManifest()

    for (const [index, image] of corpus.images.entries()) {
      if (!image.generated) continue
      const { outcome, spec } = results[index]
      expect(outcome).toEqual({
        kind: "generated",
        // The byte count and the url the entry itself claims, so the line a
        // browser is shown and the manifest the dashboard renders cannot
        // disagree. Read off the result rather than the corpus because sharp
        // and Pillow do not encode to the same size (see `withoutSizeBytes`).
        bytes: spec.size_bytes,
        url: spec.url,
      })
    }
  })

  it("carries the message the `image_failed` line interpolates", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex((image) => image.id === "provider-error")
    expect(results[index].outcome).toEqual({
      kind: "failed",
      error: corpus.images[index].error,
    })
  })

  it("distinguishes a provider error that says `no prompt` from the short circuit", async () => {
    // The inference the discriminant exists to prevent. Both entries below end
    // up stored with `error: "no prompt"`, and Python published a line for one
    // of them and nothing for the other.
    installGeminiStub()
    generateImageMock.mockRejectedValue(new Error(NO_PROMPT_ERROR))

    const failed = await generateOneImage({
      spec: { id: "misleading", filename: "x.png", prompt: "a prompt the provider rejects" },
      index: 0,
      postId: corpus.post_id,
      mediaDir,
      apiKey: "test-key-not-a-real-credential",
    })
    const shortCircuited = await generateOneImage({
      spec: { id: "empty", filename: "y.png" },
      index: 1,
      postId: corpus.post_id,
      mediaDir,
      apiKey: "test-key-not-a-real-credential",
    })

    expect(failed.spec.error).toBe(NO_PROMPT_ERROR)
    expect(shortCircuited.spec.error).toBe(NO_PROMPT_ERROR)
    expect(failed.outcome).toEqual({ kind: "failed", error: NO_PROMPT_ERROR })
    expect(shortCircuited.outcome).toEqual({ kind: "no-prompt" })
  })
})

describe("generateOneImage disk output", () => {
  it("writes one file per generated entry, with Python's bytes", async () => {
    const { results } = await runManifest()

    const names = (await readdir(mediaDir)).sort()
    // Python wrote nine files for twelve generated entries, because its four
    // featured entries collided on one name (P2.10) and its empty filename
    // wrote a dotfile (P2.12). Every generated entry now owns a file, and the
    // manifest urls are exactly the directory listing.
    expect(names).toHaveLength(corpus.total_generated)
    expect(names).toEqual(
      results
        .filter((result) => result.spec.generated)
        .map((result) => path.basename(String(result.spec.url)))
        .sort(),
    )
    expect(names.some((name) => name.startsWith("."))).toBe(false)

    // The bytes are still Python's. Every renamed file is the same content
    // under a new name, so the oracle is looked up by the name Python used.
    const pythonName = new Map(
      Object.entries(RENAMED).map(([id, name]) => [
        name,
        id === "empty-filename" ? ".webp" : `${FEATURED_PREFIX}.webp`,
      ]),
    )
    for (const name of names) {
      const oracleName = pythonName.get(name) ?? name
      const oracle = corpus.written_files[oracleName as keyof typeof corpus.written_files] as {
        width: number
        height: number
        bytes?: number
        sha256?: string
        resized?: boolean
      }
      const bytes = await readFile(path.join(mediaDir, name))
      const { width, height } = await sharp(bytes).metadata()
      // Python's one featured file was whichever featured entry wrote last,
      // and that was the wide one, so the three narrow featured entries have no
      // oracle of their own: they are the same source PNG as every other narrow
      // entry, checked against that.
      const narrowFeatured =
        oracleName === `${FEATURED_PREFIX}.webp` && !String(name).includes("-13.")
      const want = narrowFeatured ? corpus.written_files["diagram-1.webp"] : oracle
      // The dimensions are exact either way: they come from
      // `int(height * max_width / width)`, not from the resampler.
      expect({ name, width, height }).toEqual({
        name,
        width: want.width,
        height: want.height,
      })
      // A resized entry carries no hash, because its bytes are the
      // resampler's rather than the encoder's.
      if (!("sha256" in want)) {
        expect(want.resized).toBe(true)
        continue
      }
      expect(bytes.length).toBe(want.bytes)
      // Pillow's sha256. Equal because these cases are narrower than their
      // optimize width, so no resize happens and both stacks drive libwebp
      // with the same settings (item 3.5b).
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(want.sha256)
    }
  })

  it("flattens a filename carrying a directory instead of writing outside the media dir", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex((image) => image.id === "nested-filename")
    expect(corpus.input_manifest.images[index].filename).toBe("sub/dir/nested.png")
    expect(results[index].spec.url).toBe(`/media/${corpus.post_id}/nested.webp`)
    expect(await readdir(mediaDir)).not.toContain("sub")
  })

  it("gives each featured entry its own filename (P2.10)", async () => {
    const { results } = await runManifest()

    // Python's name came from the clock and one `randint(10, 99)` and nothing
    // else, so the corpus' four featured entries all computed
    // `featured-030726-47.webp`: the last write won and all four entries
    // recorded a url pointing at it. Nine files for twelve generated entries.
    expect(Object.keys(corpus.written_files)).toHaveLength(corpus.total_generated - 3)

    const featured = results.filter((r) => String(r.spec.url ?? "").includes("featured-"))
    expect(featured).toHaveLength(4)
    expect(new Set(featured.map((r) => r.spec.url)).size).toBe(4)
    for (const result of featured) {
      const bytes = await readFile(path.join(mediaDir, path.basename(String(result.spec.url))))
      expect(bytes.length).toBe(result.spec.size_bytes)
    }
  })

  it("names an entry whose filename is empty rather than writing a dotfile (P2.12)", async () => {
    const { results } = await runManifest()

    const index = corpus.images.findIndex((image) => image.id === "empty-filename")
    expect(corpus.input_manifest.images[index].filename).toBe("")
    // Python wrote `<media_dir>/<post_id>/.webp` and recorded `/media/<id>/.webp`.
    expect(corpus.written_files).toHaveProperty(".webp")
    expect(corpus.images[index].url).toBe(`/media/${corpus.post_id}/.webp`)

    expect(results[index].spec.url).toBe(`/media/${corpus.post_id}/image-${index}.webp`)
  })

  it("names an entry whose filename is only a suffix rather than hiding it (P2.12)", async () => {
    // Not in the corpus: `pathStem` keeps a leading dot, so `.webp` and
    // `.hidden.png` both produced a hidden file the same way the empty name
    // did. Same fallback, because the failure is the same one.
    installGeminiStub()
    for (const [offset, filename] of [".webp", ".hidden.png", "..png"].entries()) {
      const index = 20 + offset
      const result = await generateOneImage({
        spec: { id: `dotfile-${offset}`, filename, prompt: "a hidden filename" },
        index,
        postId: corpus.post_id,
        mediaDir,
        apiKey: "test-key-not-a-real-credential",
      })
      expect(result.spec.url).toBe(`/media/${corpus.post_id}/image-${index}.webp`)
    }
  })
})

describe("the featured branches (P2.2, P2.11)", () => {
  it("recognises every featured shape the rule file documents", () => {
    // `rules/blog-images.md` asks for both keys on the featured entry, and both
    // golden captures answer with both, so either one alone is a model that
    // half-complied rather than a content image.
    expect(isFeatured({ type: "featured" })).toBe(true)
    expect(
      isFeatured({ placement: { location: "featured_image", after_section: null } }),
    ).toBe(true)
    // The only shape Python's overrides ever fired on. No rule asks for it.
    expect(isFeatured({ placement: "featured" })).toBe(true)

    expect(isFeatured({ type: "content" })).toBe(false)
    expect(
      isFeatured({ placement: { location: "after_heading", after_section: "Pricing" } }),
    ).toBe(false)
    expect(isFeatured({})).toBe(false)
    // A `placement` that is neither a string nor an object must not throw.
    expect(isFeatured({ placement: null })).toBe(false)
    expect(isFeatured({ placement: ["featured_image"] })).toBe(false)
  })

  it("applies the size override when placement is the object real manifests carry", async () => {
    const { sent, results } = await runManifest()

    // Python asked `placement == "featured"`, a string, so on the shape the
    // rule file documents its 16:9 / 2K forcing never fired while the 1920px
    // optimize width and the filename rewrite did, because those also accepted
    // `type`. This entry happens to declare 16:9 / 2K itself, so the corpus
    // records the same request either way; what it proves is that the entry is
    // seen as featured by the one predicate.
    const spec = corpus.input_manifest.images[0]
    expect(spec.type).toBe("featured")
    expect(typeof spec.placement).toBe("object")
    expect(sent[0]).toEqual({ prompt: spec.prompt, aspectRatio: "16:9", imageSize: "2K" })
    expect(results[0].spec.url).toBe(`/media/${corpus.post_id}/${featuredName(0)}`)
  })

  it("forces 2K on a featured entry declaring a plain placement object", async () => {
    installGeminiStub()
    const result = await generateOneImage({
      // Python sent 4:3 / 1K here and optimized the answer to 1200px: neither
      // key names the featured image in a way its `placement == "featured"`
      // could see.
      spec: {
        id: "featured",
        filename: "hero.png",
        prompt: "a hero",
        placement: { location: "featured_image", after_section: null },
      },
      index: 0,
      postId: corpus.post_id,
      mediaDir,
      apiKey: "test-key-not-a-real-credential",
    })

    expect(generateImageMock.mock.calls[0][0]).toMatchObject({
      aspectRatio: "16:9",
      imageSize: "2K",
    })
    expect(result.spec).toMatchObject({ aspect_ratio: "16:9", image_size: "2K" })
    expect(result.spec.url).toBe(`/media/${corpus.post_id}/${featuredName(0)}`)
  })

  it("stores the 2K it sent rather than the 1K the model declared", async () => {
    const { results, sent } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "hero-string-placement-with-ratio",
    )
    // Python's override rewrote a local variable and never the entry, so the
    // stored manifest claimed `1K` for a call made at `2K`.
    expect(corpus.images[index].image_size).toBe("1K")

    expect(sent[index].imageSize).toBe("2K")
    expect(results[index].spec.image_size).toBe("2K")
    // The declared ratio still wins: the featured ratio is a fallback, not an
    // override, in Python and here.
    expect(sent[index].aspectRatio).toBe("1:1")
    expect(results[index].spec.aspect_ratio).toBe("1:1")
  })

  it("records the 16:9 it defaulted to instead of leaving the key absent", async () => {
    const { results, sent } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "hero-string-placement",
    )
    expect(corpus.images[index]).not.toHaveProperty("aspect_ratio")

    expect(sent[index].aspectRatio).toBe("16:9")
    expect(results[index].spec.aspect_ratio).toBe("16:9")
  })

  it("records the content defaults an entry declared nothing for", async () => {
    const { results, sent } = await runManifest()

    const index = corpus.input_manifest.images.findIndex(
      (image) => image.id === "content-defaults",
    )
    expect(corpus.images[index]).not.toHaveProperty("image_size")

    expect(sent[index]).toMatchObject({ aspectRatio: "4:3", imageSize: "1K" })
    expect(results[index].spec).toMatchObject({ aspect_ratio: "4:3", image_size: "1K" })
  })

  it("treats an explicit null as the key being unanswered (P2.13)", async () => {
    // Python's `dict.get(key, default)` returns the null rather than the
    // default, so `None` reached the Gemini SDK and `Path(None)` raised
    // `TypeError` out of the filename. No rule asks the model for a null there
    // and no capture contains one, so this is the port deciding rather than
    // reproducing: a null is the key unanswered, and its default is the answer.
    installGeminiStub()
    const result = await generateOneImage({
      spec: {
        id: "nulls",
        prompt: "a null-carrying entry",
        aspect_ratio: null,
        image_size: null,
        filename: null,
      },
      index: 7,
      postId: corpus.post_id,
      mediaDir,
      apiKey: "test-key-not-a-real-credential",
    })

    expect(generateImageMock.mock.calls[0][0]).toMatchObject({
      aspectRatio: "4:3",
      imageSize: "1K",
    })
    expect(result.spec).toMatchObject({
      generated: true,
      aspect_ratio: "4:3",
      image_size: "1K",
      url: `/media/${corpus.post_id}/image-7.webp`,
    })
  })

  it("defaults a featured entry's null aspect ratio to 16:9 (P2.13)", async () => {
    installGeminiStub()
    const result = await generateOneImage({
      // Python asked `"aspect_ratio" in spec`, which a null satisfies, so this
      // entry got 4:3 from the `.get` default and never reached the fallback.
      spec: { id: "nulls", type: "featured", prompt: "a hero", aspect_ratio: null },
      index: 0,
      postId: corpus.post_id,
      mediaDir,
      apiKey: "test-key-not-a-real-credential",
    })

    expect(generateImageMock.mock.calls[0][0]).toMatchObject({ aspectRatio: "16:9" })
    expect(result.spec.aspect_ratio).toBe("16:9")
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
  it("renders the frozen clock and draw the corpus recorded, plus the index", () => {
    // Python's whole name, which every featured entry in a manifest shared.
    expect(String(corpus.images[0].url).split("/").pop()).toBe(`${FEATURED_PREFIX}.webp`)

    expect(featuredFilename(".webp", 0)).toBe(`${FEATURED_PREFIX}-0.webp`)
    expect(featuredFilename(".webp", 3)).toBe(`${FEATURED_PREFIX}-3.webp`)
  })

  it("cannot collide across a manifest even on the same clock and draw", () => {
    const names = [0, 1, 2, 3].map((index) => featuredFilename(".webp", index))
    expect(new Set(names).size).toBe(4)
  })

  it("draws from the inclusive 10-99 range randint used", () => {
    const random = vi.spyOn(Math, "random")

    random.mockReturnValue(0)
    expect(featuredFilename(".webp", 0)).toMatch(/-10-0\.webp$/)
    // The largest value `Math.random()` can return is just under 1.
    random.mockReturnValue(1 - Number.EPSILON / 2)
    expect(featuredFilename(".webp", 0)).toMatch(/-99-0\.webp$/)
  })
})
