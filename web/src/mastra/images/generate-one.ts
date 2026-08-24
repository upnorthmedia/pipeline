/**
 * Port of `_generate_one`, the per-image closure inside `images_node` in
 * `api/src/pipeline/stages/images.py`.
 *
 * One manifest entry in, one manifest entry out. Between them sit every
 * decision the stored `image_manifest` JSONB depends on that is not the
 * manifest parse (item 3.5a), the WebP encoder (3.5b) or the Gemini wire
 * format (3.5d): which aspect ratio and image size reach the provider, which
 * optimize width applies, what the file on disk is called, what URL the
 * dashboard is handed, and which keys the success and failure shapes carry.
 *
 * The oracle is `data/image-generation-parity.json`, captured by
 * `api/scripts/export_image_generation_parity.py` running the real Python
 * stage with both providers intercepted. One behaviour it recorded is
 * reproduced here deliberately even though it reads like a bug, because the
 * column it lands in is the product's data: a provider call that succeeded is
 * billed even when the optimizer then rejects the bytes, so usage is reported
 * separately from success.
 *
 * **Four deliberate divergences from Python**, each one a `todo.md` finding the
 * polish run closed. Python's behaviour is stated first in every case, and the
 * inverted parity assertions live in `generate-one.test.ts`:
 *
 * 1. *(P2.2)* Python's featured overrides key off `placement === "featured"`, a
 *    string, while the optimize width and the filename rewrite also accept
 *    `type === "featured"`. `rules/blog-images.md` asks the model for
 *    `type: "featured"` and an *object* `placement` of
 *    `{location: "featured_image", after_section: null}`, and both golden
 *    captures answer with exactly that, so on every real manifest Python's
 *    overrides never fired and its width and filename rules did. `isFeatured`
 *    below is the one predicate all four decisions now read, and it accepts the
 *    shape the rule file asks for as well as the string Python looked for.
 * 2. *(P2.11)* Python's overrides change what is *sent* without changing what
 *    is *stored*, so an entry could record `image_size: "1K"` for a call made
 *    at `2K`. The entry now records the request that was actually made, because
 *    the manifest is what the dashboard and the publish steps report from.
 * 3. *(P2.10)* Python drew one featured filename per *manifest* rather than per
 *    *image*, from the clock and a single `randint(10, 99)`, so two featured
 *    entries in one manifest overwrote each other's file and recorded the same
 *    url. `featuredFilename` takes the entry's index, which is unique within a
 *    manifest by construction.
 * 4. *(P2.12)* A `filename` of `""` produced `<media_dir>/<post_id>/.webp`, a
 *    dotfile hidden from directory listings and unservable by most static
 *    handlers. A stem that is empty or begins with a dot now falls back to the
 *    same `image-<index>` name a missing `filename` already got.
 *
 * *(P2.13)* Python reads `aspect_ratio`, `image_size` and `filename` with
 * `dict.get(key, default)`, which returns an explicit JSON `null` rather than
 * the default, and then either forwards `None` to the SDK or raises
 * `TypeError` out of `Path(None)`. This port treats a non-string as absent, and
 * that reading is now the intended behaviour rather than an unobserved
 * divergence: a null is the model failing to answer the key, and the key's
 * documented default is the answer to that.
 */
import { writeFile } from "node:fs/promises"
import path from "node:path"

import { generateImage } from "./gemini"
import { optimizeImage } from "./optimize"

/** `image_spec.get("aspect_ratio", "4:3")`. */
export const DEFAULT_ASPECT_RATIO = "4:3"

/** `image_spec.get("image_size", "1K")`. */
export const DEFAULT_IMAGE_SIZE = "1K"

/** The size forced onto a featured entry. */
export const FEATURED_IMAGE_SIZE = "2K"

/** The ratio forced onto a featured entry that declares none. */
export const FEATURED_ASPECT_RATIO = "16:9"

/** The `placement.location` `rules/blog-images.md` gives the featured entry. */
export const FEATURED_PLACEMENT_LOCATION = "featured_image"

/** `optimize_image`'s `max_width` for a featured image and for everything else. */
export const FEATURED_MAX_WIDTH = 1920
export const CONTENT_MAX_WIDTH = 1200

/** The message recorded for an entry the model gave no prompt. */
export const NO_PROMPT_ERROR = "no prompt"

/** One manifest entry, as parsed out of Claude's answer. Keys are the model's. */
export type ImageSpec = Record<string, unknown>

/**
 * What one image cost, reported whether or not the entry ends up generated.
 *
 * Python accumulates `gemini_tokens_in` / `gemini_tokens_out` / `gemini_model`
 * the moment `generate_image` returns, before the optimizer runs, so a failure
 * after that point still bills. Returning usage separately from the entry is
 * what lets the assembling step reproduce that sum without re-deriving it from
 * `generated`.
 */
export interface ImageUsage {
  tokensIn: number
  tokensOut: number
  model: string
}

/**
 * Which of Python's three branches produced the entry, stated rather than
 * inferred.
 *
 * `_generate_one` publishes a different line from each of its three exits: an
 * `image_generated` on the success path, an `image_failed` from the `except`,
 * and nothing at all from the no-prompt short circuit. The caller has to pick
 * one, and the returned entry does not say which branch it came from: a short
 * circuit and a provider failure both come back with `generated: false`, a
 * `usage` of `null` and an `error` string, so the only thing separating them is
 * the text, and a provider error whose message happened to read `no prompt`
 * would be published as if it were a short circuit. This is the branch itself,
 * carrying the two values each line interpolates so the caller re-derives
 * nothing.
 */
export type ImageOutcome =
  | { kind: "generated"; bytes: number; url: string }
  | { kind: "failed"; error: string }
  | { kind: "no-prompt" }

export interface GeneratedImage {
  /** The manifest entry to store, with the stage's bookkeeping keys applied. */
  spec: ImageSpec
  /** Non-null exactly when the provider returned, success or not. */
  usage: ImageUsage | null
  /** The branch taken, for the caller that publishes Python's per-image line. */
  outcome: ImageOutcome
}

export interface GenerateOneImageOptions {
  spec: ImageSpec
  index: number
  postId: string
  /** The already-created `<media_dir>/<post_id>` directory. */
  mediaDir: string
  apiKey: string
  /** The generation model, resolved from the stage's setting by the caller. */
  model?: string
}

/**
 * Whether one manifest entry is the post's featured image.
 *
 * The one predicate behind all four featured decisions: the 2K size, the 16:9
 * fallback ratio, the 1920px optimize width and the filename rewrite. Python
 * asked two different questions for those four and only one of them matched the
 * shape its own rule file asks the model for, which is the whole of P2.2.
 *
 * Three shapes count, in the order a manifest is likely to carry them:
 *
 * * `type: "featured"`, which is what `rules/blog-images.md` documents and what
 *   both golden captures answer with;
 * * `placement.location: "featured_image"`, the object the same rule file
 *   documents beside it, so an entry that carries the placement and drops the
 *   type is still recognised;
 * * `placement: "featured"`, the bare string. No rule asks for it and no real
 *   manifest has one, but it is the only shape Python's overrides ever fired
 *   on, so a hand-edited manifest written against the old behaviour keeps
 *   working.
 */
export function isFeatured(spec: ImageSpec): boolean {
  if (spec.type === "featured" || spec.placement === "featured") return true
  const placement = spec.placement
  return (
    typeof placement === "object" &&
    placement !== null &&
    !Array.isArray(placement) &&
    (placement as Record<string, unknown>).location === FEATURED_PLACEMENT_LOCATION
  )
}

/**
 * `pathlib.PurePosixPath(name).stem`.
 *
 * Reimplemented rather than approximated with a regex because two of its edges
 * are load-bearing here: a filename carrying a directory is flattened to its
 * last component (so a manifest entry cannot write outside the media
 * directory), and a leading dot is not a suffix, so `.hidden` keeps its name
 * while `..png` becomes `.`. POSIX semantics only: `\` is an ordinary
 * character, matching the Linux worker.
 */
export function pathStem(value: string): string {
  const components = value.split("/").filter((part) => part !== "" && part !== ".")
  const name = components.length > 0 ? components[components.length - 1] : ""
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name
}

/**
 * `f"featured-{datetime.now(UTC):%m%d%y}-{random.randint(10, 99)}{ext}"`, plus
 * the entry's index.
 *
 * Python's name was drawn from the clock and one random draw and nothing else,
 * so every featured entry in a manifest computed the same one: the later write
 * overwrote the earlier file and both entries recorded the same url (P2.10).
 * The index is the only value in scope that is unique within a manifest by
 * construction, so appending it makes the collision impossible rather than
 * unlikely. The date and the draw stay because they are what makes a
 * regenerated featured image a new url rather than a cached old one.
 *
 * The clock and `Math.random` are read at call time rather than injected: they
 * are what a test fakes, and threading a clock through the step for the sake of
 * one filename would put a seam in production code that only the test uses.
 */
export function featuredFilename(extension: string, index: number): string {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  const year = String(now.getUTCFullYear() % 100).padStart(2, "0")
  // `random.randint(10, 99)` is inclusive at both ends.
  const digits = Math.floor(Math.random() * 90) + 10
  return `featured-${month}${day}${year}-${digits}-${index}${extension}`
}

/** Python's `str(e)` for the exceptions this path can raise. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Generate, optimize and store one image from its manifest entry.
 *
 * Never throws: every failure is recorded on the returned entry, because
 * Python catches everything here so that one bad image cannot take down a
 * stage that has already paid for the rest.
 */
export async function generateOneImage(
  options: GenerateOneImageOptions,
): Promise<GeneratedImage> {
  const { spec, index, postId, mediaDir, apiKey, model } = options

  const prompt = spec.prompt
  // Python's `if not image_prompt`, so a missing key, an empty string and a
  // non-string falsy value all take this branch without calling the provider.
  if (typeof prompt !== "string" || prompt === "") {
    return {
      spec: { ...spec, generated: false, error: NO_PROMPT_ERROR, index },
      usage: null,
      outcome: { kind: "no-prompt" },
    }
  }

  const featured = isFeatured(spec)

  let aspectRatio =
    typeof spec.aspect_ratio === "string" ? spec.aspect_ratio : DEFAULT_ASPECT_RATIO
  let imageSize = typeof spec.image_size === "string" ? spec.image_size : DEFAULT_IMAGE_SIZE

  if (featured) {
    imageSize = FEATURED_IMAGE_SIZE
    if (typeof spec.aspect_ratio !== "string") aspectRatio = FEATURED_ASPECT_RATIO
  }

  // The entry records the request that was actually made rather than the one
  // the model wrote down (P2.11): the dashboard, the retry action and both
  // publish steps read `image_manifest` to report what was generated, and an
  // entry saying `1K` for a call made at `2K` is a lie told in the one place
  // anybody looks. Applied to the failure path too, because a failed entry's
  // settings are exactly what a retry needs.
  const requested = { ...spec, aspect_ratio: aspectRatio, image_size: imageSize }

  let usage: ImageUsage | null = null
  try {
    const response = await generateImage({ prompt, apiKey, model, aspectRatio, imageSize })
    usage = {
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    }

    const { bytes, ext } = await optimizeImage(
      response.imageBytes,
      featured ? FEATURED_MAX_WIDTH : CONTENT_MAX_WIDTH,
    )

    const stem = pathStem(typeof spec.filename === "string" ? spec.filename : "")
    // An empty stem wrote `<media_dir>/<post_id>/.webp` and a leading dot wrote
    // `.<name>.webp` (P2.12): both are hidden from a directory listing and both
    // are refused by most static handlers, so the file existed and the url the
    // manifest recorded served nothing. The fallback is the one a missing
    // `filename` already used.
    const named = stem === "" || stem.startsWith(".") ? `image-${index}` : stem
    const filename = featured ? featuredFilename(ext, index) : named + ext

    await writeFile(path.join(mediaDir, filename), bytes)
    const url = `/media/${postId}/${filename}`

    return {
      spec: { ...requested, generated: true, size_bytes: bytes.length, url, index },
      usage,
      outcome: { kind: "generated", bytes: bytes.length, url },
    }
  } catch (error) {
    const message = errorText(error)
    return {
      spec: { ...requested, generated: false, error: message, index },
      usage,
      outcome: { kind: "failed", error: message },
    }
  }
}
