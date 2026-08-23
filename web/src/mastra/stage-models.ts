/**
 * Per-stage model configuration, the `settings`-backed extension ledger item
 * 6.2 asks for.
 *
 * Until now each stage's model id was a constant in its agent module, so
 * changing the model that runs `write` meant a deploy. This module makes the
 * choice data: one `settings` row per user under the `stage_models` key, read
 * at call time the same way `api-keys.ts` reads credentials, with the verified
 * constants from ledger item 6.1 as the fallback when a stage is unset.
 *
 * Three rules the shape follows.
 *
 * **The allowlist is evidence, not taste.** Section 5 of the objective forbids
 * writing a model id that has not been proven to resolve, so the only ids
 * accepted here are the ones with a pasted live provider response in
 * `docs/mastra-port/evidence/phase-6.md` #6.1. Adding an id to this file
 * without adding a live call beside it is the failure mode the allowlist
 * exists to prevent.
 *
 * **Bare provider ids, not router ids.** A stored value is what the provider
 * reports back in its own response (`claude-opus-5`, `sonar-pro`,
 * `gemini-3-pro-image`), so a stored value is directly comparable to
 * `result.response.modelId` and to the monitor page's model filters. The
 * `anthropic/` and `perplexity/` prefixes Mastra's model router wants are a
 * per-agent concern, added where the agent is built.
 *
 * **Resolution is per field, not per stage.** Defaults, then the global row
 * (`user_id IS NULL`), then the user's row, each overriding only the fields it
 * carries. A user who overrides `write`'s effort keeps whatever model the
 * global row chose, which is the fallback behaviour Phase 6.0 required of
 * every settings key.
 */
import { RequestContext } from "@mastra/core/request-context"
import { and, eq, isNull, or } from "drizzle-orm"

import { getDb, posts, settings, websiteProfiles } from "../db"
import type { Provider } from "./api-keys"
import { STAGE_PROVIDER_MAP, STAGES, type Stage } from "./state"

/** The `settings.key` per-stage model configuration is stored under. */
export const STAGE_MODELS_SETTING_KEY = "stage_models"

/** One entry per stage, in `STAGES` order, without an `as` on every map. */
function byStage<T>(value: (stage: Stage) => T): Record<Stage, T> {
  return Object.fromEntries(STAGES.map((stage) => [stage, value(stage)])) as Record<Stage, T>
}

/**
 * `STAGE_PROVIDER_MAP` speaks Python's provider vocabulary (`claude`) while
 * credentials and this module speak the provider's own (`anthropic`). Derived
 * rather than written out again so a stage cannot end up on two providers.
 */
const CREDENTIAL_PROVIDER: Record<string, Provider> = {
  claude: "anthropic",
  perplexity: "perplexity",
  gemini: "gemini",
}

/**
 * Stage -> the provider whose model this setting selects.
 *
 * `images` is `gemini`, the generation half, because that is the model the
 * stage is judged on and the one the manifest names. The stage also makes one
 * Claude call to write the image prompts; that call is not separately
 * configurable and keeps the shared Claude defaults, which is recorded in the
 * ledger rather than hidden here.
 */
export const STAGE_MODEL_PROVIDER: Record<Stage, Provider> = byStage(
  (stage) => CREDENTIAL_PROVIDER[STAGE_PROVIDER_MAP[stage]],
)

/**
 * Anthropic's `effort` enum, read from the provider options schema bundled
 * with the installed `@mastra/core`
 * (`dist/_types/@ai-sdk_anthropic-v6/dist/index.d.ts`), not from memory.
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

/**
 * Model ids accepted per stage. Every entry returned HTTP 200 from a real
 * minimal call in item 6.1, sending the request shape its stage sends.
 */
export const STAGE_MODEL_ALLOWLIST: Record<Stage, readonly string[]> = {
  // Perplexity's only tier that pairs live grounding with the citations this
  // stage's link extraction reads. `sonar` is weaker and
  // `sonar-deep-research` is a report generator; neither has a live call
  // behind it here, so neither is offered.
  research: ["sonar-pro"],
  outline: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
  write: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
  edit: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
  images: ["gemini-3-pro-image", "gemini-3.1-flash-image-preview"],
  ready: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
}

/**
 * Effort values accepted per stage, empty where the provider has no such
 * parameter. Only Anthropic documents one and only Anthropic's request shape
 * carries it, so an `effort` sent to `research` or `images` is a client bug
 * and is rejected rather than stored and ignored.
 */
export const STAGE_EFFORT_ALLOWLIST: Record<Stage, readonly string[]> = byStage((stage) =>
  STAGE_MODEL_PROVIDER[stage] === "anthropic" ? CLAUDE_EFFORTS : [],
)

/** One stage's resolved configuration. `effort` is null where unsupported. */
export interface StageModelConfig {
  model: string
  effort: ClaudeEffort | null
}

/**
 * The values a stage runs at when nothing is stored: item 6.1's verified
 * choices.
 *
 * Item 6.2b moved every stage onto this resolver, so these are the values the
 * pipeline actually runs when nothing is stored. Two constants outlive that
 * move and `stage-models.test.ts` asserts both agree with the table here:
 * `GEMINI_IMAGE_MODEL_ID`, which stays `generate_image`'s own default so the
 * low-level client keeps working without a database, and `IMAGES_MODEL_ID`,
 * the manifest call this setting deliberately does not configure.
 */
export const STAGE_MODEL_DEFAULTS: Record<Stage, StageModelConfig> = {
  research: { model: "sonar-pro", effort: null },
  outline: { model: "claude-opus-5", effort: "high" },
  write: { model: "claude-opus-5", effort: "high" },
  edit: { model: "claude-opus-5", effort: "high" },
  images: { model: "gemini-3-pro-image", effort: null },
  ready: { model: "claude-opus-5", effort: "high" },
}

/** One stage's stored overrides. An absent field means "use the fallback". */
export interface StageModelOverride {
  model?: string
  effort?: ClaudeEffort
}

/** The whole `stage_models` row value: overrides for zero or more stages. */
export type StageModelSettings = Partial<Record<Stage, StageModelOverride>>

/** Where a resolved field came from, for the settings page's override badge. */
export type StageModelSource = "default" | "global" | "user"

export interface ResolvedStageModel extends StageModelConfig {
  stage: Stage
  provider: Provider
  modelSource: StageModelSource
  effortSource: StageModelSource
}

/**
 * Validate a candidate `stage_models` value against the allowlist.
 *
 * Returns the parsed settings or a single human-readable reason, which the
 * route hands back as `{"detail": ...}` the way every other ported handler
 * reports a 422. Errors name the offending stage and the accepted values,
 * because a rejected model id is otherwise indistinguishable from a typo.
 */
export function parseStageModelSettings(
  value: unknown,
): { ok: true; data: StageModelSettings } | { ok: false; detail: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: `'${STAGE_MODELS_SETTING_KEY}' must be an object keyed by stage` }
  }

  const parsed: StageModelSettings = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(STAGES as readonly string[]).includes(key)) {
      return { ok: false, detail: `Unknown stage '${key}'. Stages are ${STAGES.join(", ")}` }
    }
    const stage = key as Stage

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, detail: `Stage '${stage}' must be an object with 'model' and 'effort'` }
    }

    const override: StageModelOverride = {}
    for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      if (field !== "model" && field !== "effort") {
        return { ok: false, detail: `Stage '${stage}' has no setting '${field}'` }
      }
      // An explicit null is how a client clears one field back to the
      // fallback, so it is dropped rather than stored as a value.
      if (fieldValue === null || fieldValue === undefined) continue

      const allowed = field === "model" ? STAGE_MODEL_ALLOWLIST[stage] : STAGE_EFFORT_ALLOWLIST[stage]
      if (allowed.length === 0) {
        return {
          ok: false,
          detail: `Stage '${stage}' runs on ${STAGE_MODEL_PROVIDER[stage]}, which has no '${field}' setting`,
        }
      }
      if (typeof fieldValue !== "string" || !allowed.includes(fieldValue)) {
        return {
          ok: false,
          detail: `Invalid ${field} '${String(fieldValue)}' for stage '${stage}'. Verified values are ${allowed.join(", ")}`,
        }
      }
      if (field === "model") override.model = fieldValue
      else override.effort = fieldValue as ClaudeEffort
    }

    parsed[stage] = override
  }

  return { ok: true, data: parsed }
}

/** A stored row value, reduced to the overrides that survive validation. */
function storedSettings(value: unknown): StageModelSettings {
  const parsed = parseStageModelSettings(value)
  // A row that no longer validates (a model id retired from the allowlist, a
  // hand-edited row) falls back rather than failing a pipeline run: the stage
  // still has a verified default, and refusing to start would be a worse
  // outcome than quietly running the model that is known to work.
  return parsed.ok ? parsed.data : {}
}

/**
 * Every stage's effective configuration for one user, with the origin of each
 * field.
 *
 * One query reads both the user's row and the global row; the global row is
 * the fallback layer Phase 6.0 required so an unset user still follows an
 * operator-wide choice.
 */
export async function resolveStageModels(
  userId: string | null,
): Promise<Record<Stage, ResolvedStageModel>> {
  const rows = await getDb()
    .select({ userId: settings.userId, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, STAGE_MODELS_SETTING_KEY),
        userId === null
          ? isNull(settings.userId)
          : or(isNull(settings.userId), eq(settings.userId, userId)),
      ),
    )

  const globalSettings = storedSettings(rows.find((row) => row.userId === null)?.value)
  const userSettings =
    userId === null ? {} : storedSettings(rows.find((row) => row.userId === userId)?.value)

  const resolved = {} as Record<Stage, ResolvedStageModel>
  for (const stage of STAGES) {
    const layers: Array<[StageModelSource, StageModelOverride]> = [
      ["global", globalSettings[stage] ?? {}],
      ["user", userSettings[stage] ?? {}],
    ]

    let model = STAGE_MODEL_DEFAULTS[stage].model
    let modelSource: StageModelSource = "default"
    let effort = STAGE_MODEL_DEFAULTS[stage].effort
    let effortSource: StageModelSource = "default"

    for (const [source, override] of layers) {
      if (override.model !== undefined) {
        model = override.model
        modelSource = source
      }
      if (override.effort !== undefined) {
        effort = override.effort
        effortSource = source
      }
    }

    resolved[stage] = {
      stage,
      provider: STAGE_MODEL_PROVIDER[stage],
      model,
      effort,
      modelSource,
      effortSource,
    }
  }

  return resolved
}

/** One stage's effective configuration, for the agent that runs it. */
export async function resolveStageModel(
  stage: Stage,
  userId: string | null,
): Promise<StageModelConfig> {
  const { model, effort } = (await resolveStageModels(userId))[stage]
  return { model, effort }
}

/**
 * The `requestContext` key carrying the settings user into an agent's dynamic
 * `model` and `defaultOptions` resolvers.
 *
 * Mastra resolves both with `{ requestContext }` and nothing else, so this is
 * the only channel a step has for telling an agent whose overrides apply. The
 * value is the user id or `null` for an unowned post, which is exactly
 * `resolveStageModel`'s parameter.
 */
export const STAGE_USER_CONTEXT_KEY = "settingsUserId"

/** The context a step hands `agent.generate()` so its overrides are read. */
export function stageRequestContext(userId: string | null): RequestContext {
  return new RequestContext([[STAGE_USER_CONTEXT_KEY, userId]])
}

/**
 * The settings user carried by a request context, or `null`.
 *
 * `null` is also what an agent called without a context resolves to (Studio, a
 * live smoke test, `getModel()`), and that resolves to the global row then the
 * defaults, which is the right answer for a call that belongs to no user.
 */
export function stageRequestContextUserId(requestContext: RequestContext): string | null {
  const value = requestContext.getRaw(STAGE_USER_CONTEXT_KEY)
  return typeof value === "string" ? value : null
}

/**
 * The user whose settings apply to a pipeline run, for a post id.
 *
 * `posts` has no `user_id`: Alembic 010 put multi-tenancy on
 * `website_profiles`, and every route handler scopes a post by joining through
 * its profile. A post with no profile, or a profile with no owner, has no
 * settings user and runs on the global row.
 */
export async function settingsUserIdForPost(postId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ userId: websiteProfiles.userId })
    .from(posts)
    .leftJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(eq(posts.id, postId))
    .limit(1)
  return rows[0]?.userId ?? null
}

/** One stage's effective configuration for the user who owns a post. */
export async function resolveStageModelForPost(
  stage: Stage,
  postId: string,
): Promise<StageModelConfig> {
  return resolveStageModel(stage, await settingsUserIdForPost(postId))
}
