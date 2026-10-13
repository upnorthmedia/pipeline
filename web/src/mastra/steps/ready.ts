/** Deterministic assembly of edited Markdown and generated image placements. */
import { createStep } from "@mastra/core/workflows/evented"
import { eq } from "drizzle-orm"

import { getDb, posts } from "../../db"
import { loadPipelineState, saveStageOutput } from "../post-state"
import { validatePublishContent } from "../publish-safety"
import { STATUS_COMPLETE } from "../state"
import {
  announceStageComplete,
  announceStageStart,
  formatSeconds,
  gateResumeSchema,
  gateSuspendSchema,
  markRerunComplete,
  pauseGate,
  publishStageLog,
  recordStageRetry,
  reviewGate,
  shouldRunStage,
  skippedStageOutput,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

type ManifestEntry = Record<string, unknown>

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/
const NOTES_COMMENT_RE = /(?:\n---\s*)?\n?<!--(?:(?!-->)[\s\S])*(?:PUBLISHING|WRITING) NOTES(?:(?!-->)[\s\S])*-->\s*/gi

function manifestImages(manifest: Record<string, unknown>): ManifestEntry[] {
  const images = manifest.images
  if (images === undefined) return []
  if (!Array.isArray(images)) throw new TypeError("image manifest 'images' is not an array")
  return images.map((image, index) => {
    if (typeof image !== "object" || image === null || Array.isArray(image)) {
      throw new TypeError(`image manifest entry ${index} is not an object`)
    }
    return image as ManifestEntry
  })
}

export function applyImageReviewDecision(
  manifest: Record<string, unknown>,
  approved: boolean,
): Record<string, unknown> {
  return {
    ...manifest,
    images: manifestImages(manifest).map((image) =>
      image.generated
        ? {
            ...image,
            human_review_required: true,
            human_review_approved: approved,
          }
        : image,
    ),
  }
}

function isFeatured(image: ManifestEntry): boolean {
  const placement = image.placement
  return Boolean(
    image.type === "featured" ||
      placement === "featured" ||
      (typeof placement === "object" &&
        placement !== null &&
        !Array.isArray(placement) &&
        (placement as ManifestEntry).location === "featured_image"),
  )
}

function applyFeaturedFrontmatter(
  content: string,
  manifest: Record<string, unknown>,
): string {
  const featured = manifestImages(manifest).find((image) => image.generated && isFeatured(image))
  if (!featured) return content

  const match = FRONTMATTER_RE.exec(content)
  const metaLines = match?.[1] ? match[1].split("\n") : []
  const body = match ? content.slice(match[0].length) : content
  const updates: [string, string][] = [
    ["featuredImage", String(featured.url ?? "")],
    ["featuredImageAlt", String(featured.alt_text ?? "")],
  ]

  for (const [key, value] of updates) {
    const replacement = `${key}: ${JSON.stringify(value)}`
    const index = metaLines.findIndex((line) => line.startsWith(`${key}:`))
    if (index === -1) metaLines.push(replacement)
    else metaLines[index] = replacement
  }

  return `---\n${metaLines.join("\n")}\n---\n\n${body.trimStart()}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function insertImage(content: string, image: ManifestEntry): string {
  const url = String(image.url ?? "")
  if (!url || content.includes(url)) return content

  const placement = image.placement
  const section =
    typeof placement === "object" && placement !== null && !Array.isArray(placement)
      ? String((placement as ManifestEntry).after_section ?? "")
      : ""
  const id = String(image.id ?? url)
  if (!section) throw new Error(`image ${id} has no target section`)

  const heading = new RegExp(`^(#{2,6})\\s+${escapeRegExp(section)}[ \\t]*$`, "m")
  const match = heading.exec(content)
  if (!match) throw new Error(`image ${id} target heading not found: ${section}`)

  const imageMarkdown = `![${String(image.alt_text ?? "")}](${url})`
  const end = match.index + match[0].length
  return `${content.slice(0, end)}\n\n${imageMarkdown}\n\n${content.slice(end).trimStart()}`
}

export function assembleReadyContent(
  finalMd: string,
  manifest: Record<string, unknown>,
): string {
  let content = finalMd.replace(NOTES_COMMENT_RE, "\n").trim()
  content = applyFeaturedFrontmatter(content, manifest)

  for (const image of manifestImages(manifest)) {
    if (!image.generated || isFeatured(image)) continue
    content = insertImage(content, image)
  }

  content = `${content.trim()}\n`
  validatePublishContent(content)
  return content
}

export const readyStep = createStep({
  id: "ready",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, bail, retryCount, abortSignal }) => {
    try {
      const { postId } = inputData
      const state = await loadPipelineState(postId)
      const paused = await pauseGate(mastra, "ready", inputData, state)
      if (paused) return bail(paused)
      if (!shouldRunStage("ready", inputData, state.stageStatus)) {
        return skippedStageOutput(inputData, "ready")
      }

      const gate = await reviewGate(
        mastra,
        "ready",
        inputData,
        state.stageSettings,
        resumeData,
        retryCount,
      )
      if (gate) return suspend(gate)

      await announceStageStart(mastra, "ready", inputData)
      await publishStageLog(mastra, postId, "ready", "Assembling final Markdown...")
      const startedAt = Date.now()
      const reviewedManifest = applyImageReviewDecision(
        state.imageManifest,
        resumeData?.approved === true,
      )
      await getDb()
        .update(posts)
        .set({ imageManifest: reviewedManifest, updatedAt: new Date() })
        .where(eq(posts.id, postId))
      const content = assembleReadyContent(state.finalMd, reviewedManifest)
      const durationS = (Date.now() - startedAt) / 1000
      await publishStageLog(
        mastra,
        postId,
        "ready",
        `Assembly done (${formatSeconds(durationS)}s)`,
      )

      await saveStageOutput(postId, "ready", content, { ready: STATUS_COMPLETE })
      await markRerunComplete(inputData)

      const output = {
        postId,
        stages: inputData.stages,
        stage: "ready" as const,
        skipped: false,
        model: "deterministic",
        tokensIn: 0,
        tokensOut: 0,
        durationS,
      }
      await announceStageComplete(mastra, output)
      return output
    } catch (error) {
      await recordStageRetry("ready", inputData.postId, retryCount, error, abortSignal)
      throw error
    }
  },
})
