/**
 * `GET /api/settings/stage-models`, the read side of the settings UI ledger
 * item 6.3 asks for.
 *
 * This endpoint has no FastAPI ancestor: per-stage model configuration only
 * became possible with the `(key, user_id)` key from item 6.0 and the resolver
 * from 6.2a. It exists because the settings page cannot build the table from
 * `GET /api/settings` alone. That endpoint returns the caller's own rows
 * verbatim, so the page would see the user's overrides but neither the global
 * operator row underneath them, nor the verified defaults underneath that, nor
 * the allowlist a selector has to be populated from. Resolving in the browser
 * would be a second implementation of `resolveStageModels()` that could
 * disagree with the one the pipeline runs on.
 *
 * Writes still go through `PATCH /api/settings` under the `stage_models` key,
 * which already validates against the allowlist (item 6.2a). Adding a write
 * path here would mean two places that decide what a legal model id is.
 *
 * Two resolutions are returned per stage. `model`/`effort` are what the
 * caller's runs use right now. `fallback_model`/`fallback_effort` are what the
 * same fields resolve to with the caller's own row removed, which is exactly
 * what "revert to default" produces and is not always the hardcoded default:
 * an operator's global row sits in between.
 */
import { and, eq } from "drizzle-orm"

import { getDb, settings } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import {
  resolveStageModels,
  parseStageModelSettings,
  STAGE_EFFORT_ALLOWLIST,
  STAGE_MODEL_ALLOWLIST,
  STAGE_MODELS_SETTING_KEY,
  type StageModelSettings,
} from "@/mastra/stage-models"
import { STAGES } from "@/mastra/state"

/** One row of the settings page's stage table. */
interface StageModelResponse {
  stage: string
  provider: string
  model: string
  effort: string | null
  model_source: string
  effort_source: string
  models: readonly string[]
  efforts: readonly string[]
  fallback_model: string
  fallback_effort: string | null
}

/** The caller's own `stage_models` row, or `{}` when they have none. */
async function ownOverrides(userId: string): Promise<StageModelSettings> {
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), eq(settings.userId, userId)))
    .limit(1)

  if (rows.length === 0) return {}
  const parsed = parseStageModelSettings(rows[0].value)
  // Matches the resolver: a row that no longer validates is ignored rather
  // than surfaced, so the page shows the configuration the pipeline will
  // actually run instead of one the resolver has already discarded.
  return parsed.ok ? parsed.data : {}
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const [effective, withoutUser, overrides] = await Promise.all([
    resolveStageModels(user.id),
    resolveStageModels(null),
    ownOverrides(user.id),
  ])

  const stages: StageModelResponse[] = STAGES.map((stage) => ({
    stage,
    provider: effective[stage].provider,
    model: effective[stage].model,
    effort: effective[stage].effort,
    model_source: effective[stage].modelSource,
    effort_source: effective[stage].effortSource,
    models: STAGE_MODEL_ALLOWLIST[stage],
    efforts: STAGE_EFFORT_ALLOWLIST[stage],
    fallback_model: withoutUser[stage].model,
    fallback_effort: withoutUser[stage].effort,
  }))

  return Response.json({ stages, overrides })
}
