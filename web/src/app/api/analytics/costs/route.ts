/**
 * Port of `GET /api/analytics/costs` in `api/src/api/analytics.py`.
 *
 * One row per `(post, stage_logs key)` pair, aggregated in the handler into the
 * `CostAnalytics` shape `web/src/lib/api.ts` declares. The aggregation stays in
 * application code rather than moving into SQL because Python's is order and
 * type sensitive in ways `sum()` in Postgres is not: `total_tokens_in` is a
 * float sum truncated with `int()`, every cost is rounded with Python's
 * half-to-even `round()`, and `avg_cost_per_post` divides the *unrounded*
 * total. Doing it the same way in the same order is what makes the numbers
 * match rather than nearly match.
 *
 * **The Python endpoint this ports never ran.** Its SQL puts the
 * `website_profiles` join inside the second FROM item, where the `posts` alias
 * is not visible:
 *
 *     FROM posts p,
 *          jsonb_each(p.stage_logs) AS sl(key, value)
 *     JOIN website_profiles wp ON p.profile_id = wp.id
 *
 * `JOIN` binds tighter than the comma, so `p` is referenced from a part of the
 * query it cannot be referenced from and Postgres rejects the statement before
 * any parameter is bound. Every call answers 500, on every input, and has since
 * the file was added. The join is moved onto `posts` here so the endpoint does
 * what it was written to do. Recorded as a deviation in the ledger and as a
 * confirmed defect in `todo.md`, because the Python route is still serving
 * until Phase 7.
 *
 * The `sl.key NOT LIKE '\_%'` filter excludes keys beginning with a literal
 * underscore, which is how `_error` (written by the dead-letter path) stays out
 * of the cost totals. Postgres reads the backslash as `LIKE`'s default escape
 * character, so it is the underscore that is escaped, not a wildcard.
 */
import { inArray, sql } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { pythonRound } from "@/mastra/analytics/python-round"
import { MODEL_COSTS } from "@/mastra/model-costs"

import { unprocessableRequest, type ValidationErrorDetail } from "../../pydantic"
import { DAY_MS, parseDays } from "../days"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Totals {
  tokens_in: number
  tokens_out: number
  cost_usd: number
  calls: number
}

// A `type` rather than an `interface` because `execute<T>` constrains `T` to
// `Record<string, unknown>` and only a type alias gets the implicit index
// signature that satisfies it.
type CostRow = {
  stage_name: string
  model: string | null
  tokens_in: number
  tokens_out: number
  cost_usd: number
  post_id: string
  profile_id: string | null
  completed_date: string | null
}

function bucket(into: Record<string, Totals>, key: string, row: CostRow): void {
  const totals = (into[key] ??= { tokens_in: 0, tokens_out: 0, cost_usd: 0, calls: 0 })
  totals.tokens_in += row.tokens_in
  totals.tokens_out += row.tokens_out
  totals.cost_usd += row.cost_usd
  totals.calls += 1
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const url = new URL(request.url)
  const days = parseDays(url)
  if (days instanceof Response) return days

  // `profile_id: str | None = Query(None)`, so pydantic let anything through
  // and the value reached the uuid column raw. Validated here instead, with the
  // same `uuid_parsing` 422 `GET /api/posts` answers, because the alternative
  // is a database error surfacing as a 500. An empty value is not a filter at
  // all: Python's guard is `if profile_id:`, not `is not None`.
  const profileId = url.searchParams.get("profile_id")
  if (profileId && !UUID_PATTERN.test(profileId)) {
    const issue: ValidationErrorDetail = {
      type: "uuid_parsing",
      loc: ["query", "profile_id"],
      msg: "Input should be a valid UUID",
      input: profileId,
    }
    return unprocessableRequest([issue])
  }
  const model = url.searchParams.get("model")

  const since = new Date(Date.now() - days * DAY_MS)
  const filters = [
    profileId ? sql` and p.profile_id = ${profileId}::uuid` : sql.empty(),
    model ? sql` and sl.value->>'model' = ${model}` : sql.empty(),
  ]

  // `completed_at` is a `timestamptz` and Python called `.date()` on the
  // UTC-aware datetime asyncpg returned, so the bucket key is the UTC date
  // whatever the session time zone is. Rendering it in SQL says that outright
  // and keeps the key a string rather than depending on which `pg` type parser
  // is installed for OID 1184.
  const result = await getDb().execute<CostRow>(sql`
    select
      sl.key as stage_name,
      (sl.value->>'model') as model,
      coalesce((sl.value->>'tokens_in')::float, 0) as tokens_in,
      coalesce((sl.value->>'tokens_out')::float, 0) as tokens_out,
      coalesce((sl.value->>'cost_usd')::float, 0) as cost_usd,
      p.id as post_id,
      p.profile_id as profile_id,
      to_char(p.completed_at at time zone 'UTC', 'YYYY-MM-DD') as completed_date
    from posts p
      join website_profiles wp on p.profile_id = wp.id,
      jsonb_each(p.stage_logs) as sl(key, value)
    where wp.user_id = ${user.id}
      and p.created_at >= ${since}
      and p.stage_logs != '{}'::jsonb
      and sl.key not like '\\_%'${filters[0]}${filters[1]}
  `)

  let totalTokensIn = 0
  let totalTokensOut = 0
  let totalCost = 0
  const byModel: Record<string, Totals> = {}
  const byStage: Record<string, Totals> = {}
  const postCosts = new Set<string>()
  const costByDate = new Map<string, number>()
  const byProfileMap = new Map<string, number>()

  for (const row of result.rows) {
    totalTokensIn += row.tokens_in
    totalTokensOut += row.tokens_out
    totalCost += row.cost_usd

    // A stage that recorded no model is counted in `by_stage` and in the
    // totals but has no `by_model` bucket, so the two breakdowns need not sum
    // to the same number.
    if (row.model) bucket(byModel, row.model, row)
    bucket(byStage, row.stage_name, row)

    // Python built a `post_id -> cost` dict here and only ever read its
    // length, so the costs themselves are dropped and the count of distinct
    // posts is what `avg_cost_per_post` divides by.
    postCosts.add(row.post_id)

    if (row.completed_date) {
      costByDate.set(row.completed_date, (costByDate.get(row.completed_date) ?? 0) + row.cost_usd)
    }
    if (row.profile_id) {
      byProfileMap.set(row.profile_id, (byProfileMap.get(row.profile_id) ?? 0) + row.cost_usd)
    }
  }

  // Divides the unrounded total, and reports the integer `0` rather than a
  // rounded float when the caller has no priced posts at all.
  const numPosts = postCosts.size
  const avgCostPerPost = numPosts > 0 ? pythonRound(totalCost / numPosts, 4) : 0
  for (const totals of Object.values(byModel)) totals.cost_usd = pythonRound(totals.cost_usd, 6)
  for (const totals of Object.values(byStage)) totals.cost_usd = pythonRound(totals.cost_usd, 6)

  const byProfile = await resolveProfileNames(byProfileMap)
  const costOverTime = [...costByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cost]) => ({ date, cost_usd: pythonRound(cost, 6) }))

  return Response.json({
    total_tokens_in: Math.trunc(totalTokensIn),
    total_tokens_out: Math.trunc(totalTokensOut),
    total_cost: pythonRound(totalCost, 6),
    avg_cost_per_post: avgCostPerPost,
    by_model: byModel,
    by_stage: byStage,
    by_profile: byProfile,
    cost_over_time: costOverTime,
    model_costs_reference: MODEL_COSTS,
  })
}

/**
 * Python resolved the names with an unscoped `WHERE id IN (...)`, which is safe
 * because the ids all came out of the user-scoped query above, and fell back to
 * "Unknown" for an id it could not resolve. The fallback is unreachable through
 * a foreign key that cannot dangle, and is kept because it is cheaper than
 * proving it stays unreachable.
 *
 * The sort is by cost descending and is stable in both languages, so profiles
 * that cost the same keep the order they were first seen in.
 */
async function resolveProfileNames(
  byProfileMap: Map<string, number>,
): Promise<{ name: string; cost_usd: number }[]> {
  if (byProfileMap.size === 0) return []
  const ids = [...byProfileMap.keys()]
  const rows = await getDb()
    .select({ id: websiteProfiles.id, name: websiteProfiles.name })
    .from(websiteProfiles)
    .where(inArray(websiteProfiles.id, ids))
  const names = new Map(rows.map((row) => [row.id, row.name]))
  return [...byProfileMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id, cost]) => ({ name: names.get(id) ?? "Unknown", cost_usd: pythonRound(cost, 6) }))
}
