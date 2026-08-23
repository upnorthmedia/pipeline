/**
 * Port of `GET /api/analytics/models` in `api/src/api/analytics.py`.
 *
 * Three independent queries, assembled into the `ModelAnalytics` shape
 * `web/src/lib/api.ts` declares:
 *
 * 1. `models`, one row per distinct `stage_logs` model, with averaged tokens
 *    and duration and a summed cost.
 * 2. `stage_performance`, the same unroll grouped by stage key instead.
 * 3. `stage_success_rates`, a `stage_status` unroll pivoted in the handler and
 *    then projected over `STAGES` so every stage appears whether or not it has
 *    ever run.
 *
 * Unlike `/costs`, the arithmetic here is almost entirely Postgres's: `AVG` and
 * `SUM` run in SQL and Python only rounded what came back. So the queries stay
 * queries and the handler only rounds, which is why `pythonRound` still has to
 * be the rounding function: `round(20.25, 1)` is `20.2` in Python and `20.3`
 * through `toFixed`.
 *
 * The `FROM` clause here is the working one. `/costs` had the
 * `website_profiles` join sitting inside the second `FROM` item, where the
 * `posts` alias is out of scope, and answered 500 on every call; this endpoint
 * puts the join ahead of the comma, so `posts JOIN website_profiles` is the
 * first item and `jsonb_each(p.stage_logs)` is an implicitly `LATERAL` second
 * one. Verified against the live database rather than assumed, because the two
 * endpoints look alike at a glance.
 *
 * The `sl.key NOT LIKE '\_%'` filter excludes keys beginning with a literal
 * underscore, which is how `_error` (written by the dead-letter path) stays out
 * of the model and stage rollups. Postgres reads the backslash as `LIKE`'s
 * default escape character, so it is the underscore that is escaped, not a
 * wildcard. `stage_status` has no such filter in Python and gets none here.
 */
import { sql } from "drizzle-orm"

import { getDb } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { pythonRound } from "@/mastra/analytics/python-round"
import { STAGES } from "@/mastra/state"

// `type` rather than `interface`, because `execute<T>` constrains `T` to
// `Record<string, unknown>` and only a type alias gets the implicit index
// signature that satisfies it.
type ModelRow = {
  model: string
  // `count(*)` is `bigint`, and `pg` hands OID 20 back as a string rather than
  // risk a lossy `Number`. Python's asyncpg decoded it to an `int`, so every
  // count on this endpoint has to be converted or it goes out quoted.
  call_count: string
  avg_tokens_in: number
  avg_tokens_out: number
  avg_duration_s: number
  total_cost: number
}

type StageRow = {
  stage: string
  runs: string
  avg_duration_s: number
  total_cost: number
}

type StatusRow = {
  stage: string
  status: string
  count: string
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const url = new URL(request.url)
  // Starlette's `QueryParams.get()` returns the *last* value of a repeated key
  // where `URLSearchParams.get()` returns the first. Python's guard is
  // `if model:`, not `is not None`, so `?model=` is not a filter at all.
  const model = url.searchParams.getAll("model").at(-1)
  const modelFilter = model ? sql` and sl.value->>'model' = ${model}` : sql.empty()

  const db = getDb()

  const modelRows = await db.execute<ModelRow>(sql`
    select
      (sl.value->>'model') as model,
      count(*) as call_count,
      avg(coalesce((sl.value->>'tokens_in')::float, 0)) as avg_tokens_in,
      avg(coalesce((sl.value->>'tokens_out')::float, 0)) as avg_tokens_out,
      avg(coalesce((sl.value->>'duration_s')::float, 0)) as avg_duration_s,
      sum(coalesce((sl.value->>'cost_usd')::float, 0)) as total_cost
    from posts p
      join website_profiles wp on p.profile_id = wp.id,
      jsonb_each(p.stage_logs) as sl(key, value)
    where wp.user_id = ${user.id}
      and p.stage_logs != '{}'::jsonb
      and sl.key not like '\\_%'
      and sl.value->>'model' is not null${modelFilter}
    group by model
    order by call_count desc
  `)

  const stageRows = await db.execute<StageRow>(sql`
    select
      sl.key as stage,
      count(*) as runs,
      avg(coalesce((sl.value->>'duration_s')::float, 0)) as avg_duration_s,
      sum(coalesce((sl.value->>'cost_usd')::float, 0)) as total_cost
    from posts p
      join website_profiles wp on p.profile_id = wp.id,
      jsonb_each(p.stage_logs) as sl(key, value)
    where wp.user_id = ${user.id}
      and p.stage_logs != '{}'::jsonb
      and sl.key not like '\\_%'${modelFilter}
    group by sl.key
    order by sl.key
  `)

  // The success-rate query takes no `model` filter in Python: `stage_status`
  // records no model, so there would be nothing to filter on.
  const statusRows = await db.execute<StatusRow>(sql`
    select
      ss.key as stage,
      ss.value::text as status,
      count(*) as count
    from posts p
      join website_profiles wp on p.profile_id = wp.id,
      jsonb_each(p.stage_status) as ss(key, value)
    where wp.user_id = ${user.id}
      and p.stage_status != '{}'::jsonb
    group by ss.key, ss.value
    order by ss.key
  `)

  const statusCounts = new Map<string, Map<string, number>>()
  for (const row of statusRows.rows) {
    const counts = statusCounts.get(row.stage) ?? new Map<string, number>()
    statusCounts.set(row.stage, counts)
    // `ss.value::text` renders a jsonb string with its quotes, so `"complete"`
    // arrives as six characters plus two. Python stripped them with
    // `str.strip('"')`, which removes *every* leading and trailing quote rather
    // than one from each end, and assigns rather than accumulates, so two
    // distinct jsonb values that strip to the same key keep only the last.
    counts.set(row.status.replace(/^"+|"+$/g, ""), Number(row.count))
  }

  const stageSuccessRates = STAGES.map((stage) => {
    const counts = statusCounts.get(stage) ?? new Map<string, number>()
    let totalRuns = 0
    for (const count of counts.values()) totalRuns += count
    const complete = counts.get("complete") ?? 0
    const failed = counts.get("failed") ?? 0
    return {
      stage,
      total: totalRuns,
      complete,
      failed,
      success_rate: totalRuns > 0 ? pythonRound((complete / totalRuns) * 100, 1) : 0,
    }
  })

  return Response.json({
    models: modelRows.rows.map((row) => ({
      model: row.model,
      call_count: Number(row.call_count),
      avg_tokens_in: pythonRound(row.avg_tokens_in, 0),
      avg_tokens_out: pythonRound(row.avg_tokens_out, 0),
      avg_duration_s: pythonRound(row.avg_duration_s, 1),
      total_cost: pythonRound(row.total_cost, 6),
    })),
    stage_performance: stageRows.rows.map((row) => ({
      stage: row.stage,
      runs: Number(row.runs),
      avg_duration_s: pythonRound(row.avg_duration_s, 1),
      total_cost: pythonRound(row.total_cost, 6),
    })),
    stage_success_rates: stageSuccessRates,
  })
}
