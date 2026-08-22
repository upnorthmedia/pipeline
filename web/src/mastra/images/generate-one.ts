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
 * stage with both providers intercepted. Three behaviours it recorded are
 * reproduced here deliberately even though they read like bugs, because the
 * column they land in is the product's data:
 *
 * 1. the featured overrides key off `placement === "featured"` (a string),
 *    while `is_featured`, which picks the optimize width and the filename
 *    rewrite, also accepts `type === "featured"`. Real manifests write
 *    `placement` as an object, so the overrides never fire on them and the
 *    width and filename rules do;
 * 2. the overrides change what is *sent* without changing what is *stored*, so
 *    an entry can record `image_size: "1K"` for a call made at `2K`;
 * 3. a provider call that succeeded is billed even when the optimizer then
 *    rejects the bytes, so usage is reported separately from success.
 *
 * **Known divergence.** Python reads `aspect_ratio`, `image_size` and
 * `filename` with `dict.get(key, default)`, which returns an explicit JSON
 * `null` rather than the default, and then either forwards `None` to the SDK or
 * raises `TypeError` out of `Path(None)`. This port treats a non-string as
 * absent instead. No rule in `rules/blog-images.md` asks the model for a null
 * there and the corpus has no such case, so the exact `None` behaviour would
 * have to be invented rather than observed; see `todo.md`.
 */
import { writeFile } from "node:fs/promises"
import path from "node:path"

import { generateImage } from "./gemini"
import { optimizeImage } from "./optimize"

/** `image_spec.get("aspect_ratio", "4:3")`. */
export const DEFAULT_ASPECT_RATIO = "4:3"

/** `image_spec.get("image_size", "1K")`. */
export const DEFAULT_IMAGE_SIZE = "1K"

/** The size forced onto an entry whose `placement` is the string `"featured"`. */
export const FEATURED_IMAGE_SIZE = "2K"

/** The ratio forced onto such an entry when it declares none. */
export const FEATURED_ASPECT_RATIO = "16:9"

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

export interface GeneratedImage {
  /** The manifest entry to store, with the stage's bookkeeping keys applied. */
  spec: ImageSpec
  /** Non-null exactly when the provider returned, success or not. */
  usage: ImageUsage | null
}

export interface GenerateOneImageOptions {
  spec: ImageSpec
  index: number
  postId: string
  /** The already-created `<media_dir>/<post_id>` directory. */
  mediaDir: string
  apiKey: string
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
 * `f"featured-{datetime.now(UTC):%m%d%y}-{random.randint(10, 99)}{ext}"`.
 *
 * Both sources are read at call time rather than injected: the clock and
 * `Math.random` are what a test fakes, and threading a clock through the step
 * for the sake of one filename would put a seam in production code that only
 * the test uses.
 */
export function featuredFilename(extension: string): string {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  const year = String(now.getUTCFullYear() % 100).padStart(2, "0")
  // `random.randint(10, 99)` is inclusive at both ends.
  const digits = Math.floor(Math.random() * 90) + 10
  return `featured-${month}${day}${year}-${digits}${extension}`
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
  const { spec, index, postId, mediaDir, apiKey } = options

  const prompt = spec.prompt
  // Python's `if not image_prompt`, so a missing key, an empty string and a
  // non-string falsy value all take this branch without calling the provider.
  if (typeof prompt !== "string" || prompt === "") {
    return {
      spec: { ...spec, generated: false, error: NO_PROMPT_ERROR, index },
      usage: null,
    }
  }

  let aspectRatio =
    typeof spec.aspect_ratio === "string" ? spec.aspect_ratio : DEFAULT_ASPECT_RATIO
  let imageSize = typeof spec.image_size === "string" ? spec.image_size : DEFAULT_IMAGE_SIZE

  if (spec.placement === "featured") {
    imageSize = FEATURED_IMAGE_SIZE
    if (!("aspect_ratio" in spec)) aspectRatio = FEATURED_ASPECT_RATIO
  }

  let usage: ImageUsage | null = null
  try {
    const response = await generateImage({ prompt, apiKey, aspectRatio, imageSize })
    usage = {
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    }

    const isFeatured = spec.placement === "featured" || spec.type === "featured"
    const { bytes, ext } = await optimizeImage(
      response.imageBytes,
      isFeatured ? FEATURED_MAX_WIDTH : CONTENT_MAX_WIDTH,
    )

    const declared = typeof spec.filename === "string" ? spec.filename : `image-${index}.png`
    const filename = isFeatured ? featuredFilename(ext) : pathStem(declared) + ext

    await writeFile(path.join(mediaDir, filename), bytes)

    return {
      spec: {
        ...spec,
        generated: true,
        size_bytes: bytes.length,
        url: `/media/${postId}/${filename}`,
        index,
      },
      usage,
    }
  } catch (error) {
    return {
      spec: { ...spec, generated: false, error: errorText(error), index },
      usage,
    }
  }
}
