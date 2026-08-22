/**
 * Port of `optimize_image` from `api/src/pipeline/stages/images.py`.
 *
 * The images stage runs every Gemini-generated PNG through this before writing
 * it to disk, and the byte length of the result is what lands in the
 * `image_manifest` JSONB column as `size_bytes`, so the port has to agree with
 * Pillow on the output dimensions exactly and on the encoded content closely.
 *
 * Pillow and sharp both encode through libwebp 1.6.0, but they reach it through
 * different resamplers (Pillow's own Lanczos convolution vs libvips' reduce),
 * so identical bytes are not achievable. `optimize.test.ts` pins the achievable
 * guarantee against a corpus of Pillow output: exact dimensions, and decoded
 * pixels within a measured tolerance.
 */

import sharp from "sharp";

/** Pillow's default quality for this call site; the stage never overrides it. */
export const OPTIMIZE_QUALITY = 82;

/** Pillow's `Image.save(format="WEBP")` default `method`, pinned explicitly. */
const WEBP_EFFORT = 4;

/** Pillow's `alpha_quality` default, pinned explicitly. */
const WEBP_ALPHA_QUALITY = 100;

export interface OptimizedImage {
  bytes: Buffer;
  /** Always `.webp`; kept as a return value to mirror the Python tuple. */
  ext: ".webp";
}

/**
 * Resize to at most `maxWidth` and re-encode as WebP.
 *
 * Mirrors Python exactly on the two decisions that are observable downstream:
 * an image at or under `maxWidth` is never touched or upscaled, and the resized
 * height is `int(height * maxWidth / width)`, truncated rather than rounded.
 */
export async function optimizeImage(
  imageBytes: Buffer | Uint8Array,
  maxWidth = 1200,
  quality = OPTIMIZE_QUALITY,
): Promise<OptimizedImage> {
  const image = sharp(imageBytes);
  const { width, height } = await image.metadata();
  if (!width || !height) {
    throw new Error("optimizeImage: input has no readable dimensions");
  }

  if (width > maxWidth) {
    const ratio = maxWidth / width;
    image.resize({
      width: maxWidth,
      height: Math.trunc(height * ratio),
      fit: "fill",
      kernel: "lanczos3",
    });
  }

  const bytes = await image
    .webp({
      quality,
      effort: WEBP_EFFORT,
      alphaQuality: WEBP_ALPHA_QUALITY,
      lossless: false,
      nearLossless: false,
      smartSubsample: false,
    })
    .toBuffer();

  return { bytes, ext: ".webp" };
}
