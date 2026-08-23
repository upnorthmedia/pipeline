/**
 * Port of the two collection endpoints in `api/src/api/settings.py`:
 * `GET /api/settings` and `PATCH /api/settings`.
 *
 * The response is `SettingRead` from `api/src/models/schemas.py`, which is the
 * `Setting` interface in `web/src/lib/api.ts`: `key`, `value`, `updated_at`.
 * The one representational difference is that FastAPI serialised the timestamp
 * as `+00:00` and `Date.toISOString()` writes `Z`; both are the same instant in
 * RFC 3339 and no caller parses the field.
 *
 * Rows are scoped to the authenticated user by `settings.user_id`, matching
 * Alembic 010. Note that the `api_keys` row is written with a null `user_id`
 * (see `save_api_keys()` in `api/src/services/api_keys.py`), so it is invisible
 * to these endpoints in both stacks.
 *
 * Since Alembic 012 the natural key is `(key, user_id)`, so the lookup-then-
 * write below inserts one row per user for a shared key instead of colliding
 * on `settings_pkey`. Before that revision the second user to write a key got
 * a unique violation, which is what made per-user stage configuration
 * impossible.
 *
 * One key is not stored verbatim: `stage_models` is validated against the
 * allowlist in `mastra/stage-models.ts` before any row is written, per ledger
 * item 6.2.
 */
import { and, asc, eq } from "drizzle-orm"

import { getDb, settings } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { parseStageModelSettings, STAGE_MODELS_SETTING_KEY } from "@/mastra/stage-models"

/** The wire shape of one row, matching `SettingRead`. */
interface SettingResponse {
  key: string
  value: unknown
  updated_at: string | null
}

async function listForUser(userId: string): Promise<SettingResponse[]> {
  const rows = await getDb()
    .select()
    .from(settings)
    .where(eq(settings.userId, userId))
    .orderBy(asc(settings.key))

  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    updated_at: row.updatedAt?.toISOString() ?? null,
  }))
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  return Response.json(await listForUser(user.id))
}

/**
 * Body shape is `{"<key>": <value>, ...}`, and the value is stored verbatim.
 * Python did the same, which is why `settings.update()` in `api.ts` sending
 * `{"<key>": {"value": {...}}}` persists the wrapper object as the row value.
 * Preserving that keeps existing rows readable rather than silently changing
 * the meaning of stored settings.
 */
export async function PATCH(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  let updates: unknown
  try {
    updates = await request.json()
  } catch {
    return Response.json({ detail: "Invalid JSON body" }, { status: 422 })
  }
  if (updates === null || typeof updates !== "object" || Array.isArray(updates)) {
    return Response.json({ detail: "Body must be an object of key to value" }, { status: 422 })
  }

  const entries = Object.entries(updates as Record<string, unknown>)

  // Item 6.2's write validation. Every other key is stored verbatim, as
  // Python stored it, but `stage_models` chooses which model a paid provider
  // call runs on, so an id nobody has proven resolves must not reach a
  // pipeline run. Checked for the whole body before anything is written, so a
  // rejected batch leaves no half-applied rows behind.
  for (const [key, value] of entries) {
    if (key !== STAGE_MODELS_SETTING_KEY) continue
    const parsed = parseStageModelSettings(value)
    if (!parsed.ok) return Response.json({ detail: parsed.detail }, { status: 422 })
  }

  const db = getDb()
  for (const [key, value] of entries) {
    const existing = await db
      .select({ key: settings.key })
      .from(settings)
      .where(and(eq(settings.key, key), eq(settings.userId, user.id)))
      .limit(1)

    if (existing.length > 0) {
      await db
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(and(eq(settings.key, key), eq(settings.userId, user.id)))
    } else {
      await db.insert(settings).values({ key, userId: user.id, value })
    }
  }

  return Response.json(await listForUser(user.id))
}
