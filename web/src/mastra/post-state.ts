/**
 * The bridge between the `posts` table and a pipeline run, ported from
 * `state_from_post()` in `api/src/pipeline/state.py` and `save_stage_output()`
 * in `api/src/pipeline/helpers.py`.
 *
 * Every stage step reads its inputs through `stateFromPost` and writes its
 * output through `saveStageOutput`, which is what makes a crash resumable: the
 * stage's column is committed the moment the stage finishes, so a restarted run
 * rebuilds its state from the table rather than from anything held in memory.
 *
 * Kept out of `state.ts` so that module stays free of database imports: the
 * prompt assembly and the stage vocabulary are pure, this file is not.
 */
import { eq, getTableColumns } from "drizzle-orm"

import { getDb, internalLinks, posts } from "../db"
import { STAGE_CONTENT_MAP, STAGES, pipelineContextSchema } from "./state"
import type { InternalLink, Stage } from "./state"
import { z } from "zod"

/**
 * A run's full state: the prompt-visible context plus the identity and
 * run-control fields a step needs but a prompt never sees.
 *
 * This mirrors Python's `PipelineState` minus `api_keys`, which stays out
 * deliberately so a credential cannot reach a provider payload by being carried
 * in the same object as the prompt inputs.
 */
export const pipelineStateSchema = pipelineContextSchema.extend({
  postId: z.string(),
  slug: z.string(),
  profileId: z.string(),
  imageStyle: z.string(),
  imageBrandColors: z.array(z.string()),
  imageExclude: z.array(z.string()),
  finalHtml: z.string(),
  currentStage: z.string(),
  stageSettings: z.record(z.string(), z.string()),
  stageStatus: z.record(z.string(), z.string()),
})

export type PipelineState = z.infer<typeof pipelineStateSchema>

/** The shape `stateFromPost` reads: a row selected from `posts`. */
export type PostRow = typeof posts.$inferSelect

/**
 * Python's defaults for the three columns whose absence would otherwise change
 * the rendered prompt. Note `or`, not `??`: Python coalesces falsy values, so a
 * `word_count` of 0 becomes 2000 rather than staying 0, and `||` reproduces
 * that. The other columns coalesce to `""` / `[]` / `{}`.
 */
const DEFAULT_WORD_COUNT = 2000
const DEFAULT_TONE = "Conversational and friendly"
const DEFAULT_OUTPUT_FORMAT = "markdown"

/** `{research: "auto", ...}` for all six stages, Python's `stage_settings` fallback. */
function defaultStageSettings(): Record<string, string> {
  return Object.fromEntries(STAGES.map((stage) => [stage, "auto"]))
}

/**
 * Build a run's state from a post row and the internal links offered to `edit`.
 *
 * `internalLinks` is a parameter rather than a join because the links belong to
 * the post's profile and are crawled on their own schedule; the caller decides
 * whether to spend that query. Python's signature does the same.
 */
export function stateFromPost(post: PostRow, internalLinks: InternalLink[] = []): PipelineState {
  return {
    postId: String(post.id),
    slug: post.slug,
    profileId: post.profileId ? String(post.profileId) : "",
    topic: post.topic || "",
    targetAudience: post.targetAudience || "",
    niche: post.niche || "",
    intent: post.intent || "",
    wordCount: post.wordCount || DEFAULT_WORD_COUNT,
    tone: post.tone || DEFAULT_TONE,
    outputFormat: post.outputFormat || DEFAULT_OUTPUT_FORMAT,
    websiteUrl: post.websiteUrl || "",
    relatedKeywords: post.relatedKeywords || [],
    competitorUrls: post.competitorUrls || [],
    imageStyle: post.imageStyle || "",
    imageBrandColors: post.imageBrandColors || [],
    imageExclude: post.imageExclude || [],
    brandVoice: post.brandVoice || "",
    avoid: post.avoid || "",
    requiredMentions: post.requiredMentions || "",
    articleType: post.articleType || "",
    additionalInfo: post.additionalInfo || "",
    internalLinks,
    research: post.researchContent || "",
    outline: post.outlineContent || "",
    draft: post.draftContent || "",
    finalMd: post.finalMdContent || "",
    finalHtml: post.finalHtmlContent || "",
    imageManifest: post.imageManifest || {},
    ready: post.readyContent || "",
    currentStage: post.currentStage || "pending",
    stageSettings: post.stageSettings || defaultStageSettings(),
    stageStatus: post.stageStatus || {},
  }
}

/**
 * Drizzle property name for each stage's content column, resolved from the
 * table definition by the database column name in `STAGE_CONTENT_MAP`.
 *
 * Resolving it rather than writing a second hand-maintained map means the two
 * cannot drift: rename a column in `schema.ts` and this throws at import time
 * instead of silently writing to the wrong place.
 */
const contentColumnByStage: Record<Stage, string> = (() => {
  const propByDbName = new Map(
    Object.entries(getTableColumns(posts)).map(([prop, column]) => [column.name, prop]),
  )
  return Object.fromEntries(
    STAGES.map((stage) => {
      const prop = propByDbName.get(STAGE_CONTENT_MAP[stage])
      if (!prop) {
        throw new Error(
          `posts has no column '${STAGE_CONTENT_MAP[stage]}' for stage '${stage}'`,
        )
      }
      return [stage, prop]
    }),
  ) as Record<Stage, string>
})()

/**
 * Commit a stage's output to its column, advance `current_stage`, and (when the
 * caller has one) replace the whole `stage_status` map so the dashboard's
 * progress view stays in step.
 *
 * `updatedAt` is stamped explicitly because SQLAlchemy's `onupdate` stamped it
 * on every Python write; leaving it to the database's default would freeze it at
 * insert time and make the posts list sort wrongly.
 */
export async function saveStageOutput(
  postId: string,
  stage: Stage,
  content: string | Record<string, unknown>,
  stageStatus?: Record<string, string>,
): Promise<void> {
  const values: Record<string, unknown> = {
    // Strings land in text columns, objects in the `image_manifest` JSONB
    // column, exactly as Python passed content through untouched.
    [contentColumnByStage[stage]]: content,
    currentStage: stage,
    updatedAt: new Date(),
  }
  if (stageStatus !== undefined) values.stageStatus = stageStatus

  await getDb().update(posts).set(values).where(eq(posts.id, postId))
}

/**
 * The internal links offered to the `edit` stage, ported from
 * `_fetch_internal_links()` in `api/src/worker.py`: every link crawled for the
 * post's profile, or none when the post has no profile.
 *
 * Python also carries each link's `slug`, which no prompt reads; only `url` and
 * `title` reach `buildStagePrompt`, so only those are selected here.
 */
export async function loadInternalLinks(profileId: string | null): Promise<InternalLink[]> {
  if (!profileId) return []
  const rows = await getDb()
    .select({ url: internalLinks.url, title: internalLinks.title })
    .from(internalLinks)
    .where(eq(internalLinks.profileId, profileId))
  return rows.map((row) => ({ url: row.url, title: row.title ?? undefined }))
}

/**
 * Read a run's state straight from the database, which is what makes a stage
 * resumable: a step never trusts what an earlier step held in memory, it reads
 * the columns those steps committed.
 *
 * Throws on a missing post rather than returning a default state, because every
 * caller is a step that would otherwise render a prompt full of empty strings
 * and bill a provider for it.
 */
export async function loadPipelineState(postId: string): Promise<PipelineState> {
  const rows = await getDb().select().from(posts).where(eq(posts.id, postId)).limit(1)
  const post = rows[0]
  if (!post) throw new Error(`post ${postId} not found`)
  return stateFromPost(post, await loadInternalLinks(post.profileId))
}
