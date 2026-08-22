/**
 * The pipeline's stage vocabulary, ported from `api/src/pipeline/state.py`.
 *
 * These maps are the contract between the six stages and the `posts` table:
 * which rule file a stage renders, which column its output lands in, and which
 * provider runs it. They are data, not logic, so they live beside the steps
 * rather than inside any one of them.
 */
import { z } from "zod"

/** Ordered list of pipeline stages. Order drives previous-stage chaining. */
export const STAGES = ["research", "outline", "write", "edit", "images", "ready"] as const

export type Stage = (typeof STAGES)[number]

/** Stage -> `posts` column its output is written to. */
export const STAGE_CONTENT_MAP: Record<Stage, string> = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
}

/** Stage -> LLM provider. */
export const STAGE_PROVIDER_MAP: Record<Stage, string> = {
  research: "perplexity",
  outline: "claude",
  write: "claude",
  edit: "claude",
  images: "gemini",
  ready: "claude",
}

/** Stage -> rule file under `rules/`. */
export const STAGE_RULES_MAP: Record<Stage, string> = {
  research: "blog-research.md",
  outline: "blog-outline.md",
  write: "blog-write.md",
  edit: "blog-edit.md",
  images: "blog-images.md",
  ready: "blog-ready.md",
}

/** Stage -> the key its output occupies in the pipeline context. */
export const STAGE_OUTPUT_KEY: Record<Stage, keyof PipelineContext> = {
  research: "research",
  outline: "outline",
  write: "draft",
  edit: "finalMd",
  images: "imageManifest",
  ready: "ready",
}

/**
 * The value `current_stage` carries once every stage is complete.
 *
 * Spelled the same as `STATUS_COMPLETE` but it belongs to a different column's
 * vocabulary: `current_stage` otherwise holds a stage name, so a rename of one
 * must not silently rename the other.
 */
export const CURRENT_STAGE_COMPLETE = "complete"

/**
 * The value `stage_status[stage]` carries while a run is parked at that
 * stage's review gate.
 *
 * Python spelled it inline in `_run_pipeline()` rather than beside the other
 * four status constants, which is why `state.py` has no counterpart to this.
 */
export const STATUS_REVIEW = "review"

export const STATUS_PENDING = "pending"
export const STATUS_RUNNING = "running"
export const STATUS_COMPLETE = "complete"
export const STATUS_FAILED = "failed"

/**
 * One internal link offered to the `edit` stage. `link_validator` and the
 * sitemap crawler both produce this shape.
 */
export const internalLinkSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
})

export type InternalLink = z.infer<typeof internalLinkSchema>

/**
 * Everything a stage prompt can read: the post/profile configuration plus the
 * outputs of the stages that ran before it.
 *
 * This is the prompt-visible subset of Python's `PipelineState`. API keys,
 * run control fields and status maps are deliberately absent: they never reach
 * a prompt, and keeping them out means a step cannot leak a credential into a
 * provider payload by accident.
 *
 * Every field is required so a caller cannot silently omit one and change the
 * rendered prompt. `state_from_post()` in Python coalesces each column to `""`
 * / `[]` / `{}`, so the TypeScript callers do the same.
 */
export const pipelineContextSchema = z.object({
  topic: z.string(),
  targetAudience: z.string(),
  niche: z.string(),
  intent: z.string(),
  articleType: z.string(),
  additionalInfo: z.string(),
  wordCount: z.number().int(),
  tone: z.string(),
  outputFormat: z.string(),
  websiteUrl: z.string(),
  brandVoice: z.string(),
  avoid: z.string(),
  requiredMentions: z.string(),
  relatedKeywords: z.array(z.string()),
  competitorUrls: z.array(z.string()),
  internalLinks: z.array(internalLinkSchema),
  research: z.string(),
  outline: z.string(),
  draft: z.string(),
  finalMd: z.string(),
  // Loose only until item 3.5 defines the manifest's real shape; the prompt
  // assembly needs nothing from it beyond serializing it.
  imageManifest: z.record(z.string(), z.unknown()),
  ready: z.string(),
})

export type PipelineContext = z.infer<typeof pipelineContextSchema>
