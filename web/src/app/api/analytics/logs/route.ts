/**
 * Port of `GET /api/analytics/logs` in `api/src/api/analytics.py`.
 *
 * A cross-post log explorer: `execution_logs` is unrolled with
 * `jsonb_array_elements`, filtered by up to six predicates plus the caller's
 * `user_id`, counted, then fetched a page at a time. The two statements share
 * one `WHERE` clause in Python and share one here for the same reason: a
 * `total` computed under different predicates than the `items` is a wrong
 * `total`, not a slightly different one.
 *
 * The `FROM` clause is the working shape, the same one `/models` uses:
 * `posts JOIN website_profiles` is the first item and
 * `jsonb_array_elements(p.execution_logs)` is an implicitly `LATERAL` second
 * one. (`/costs` put its join inside the second item, where the `posts` alias
 * is out of scope, and answered 500 on every call.) Verified against the live
 * database, not inferred.
 *
 * Both bounds are compared as *text* against `log_entry->>'ts'`, which is
 * itself `datetime.now(UTC).isoformat()`, so they have to be run through
 * `fromIsoFormat()` first. The dashboard sends `toISOString()`, which ends in
 * `Z`; `Z` (0x5A) sorts above `+` (0x2B), so a bound that kept its `Z` would
 * silently mis-filter the whole boundary second. See ledger item 5.8d-i.
 */
import { sql, type SQL } from "drizzle-orm"

import { getDb } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { parseInt422, unprocessableRequest, type ValidationErrorDetail } from "../../pydantic"
import { fromIsoFormat, toPythonUtcIsoFormat } from "../from-isoformat"
import { DAY_MS } from "../days"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_WINDOW_DAYS = 90

// A `type` rather than an `interface` because `execute<T>` constrains `T` to
// `Record<string, unknown>` and only a type alias gets the implicit index
// signature that satisfies it.
type LogRow = {
  post_id: string
  slug: string
  topic: string
  timestamp: string
  stage: string | null
  level: string | null
  event: string | null
  message: string | null
  data: Record<string, unknown> | null
}

/**
 * Starlette's `QueryParams.get()` returns the *last* value of a repeated key
 * where `URLSearchParams.get()` returns the first.
 */
function lastValue(url: URL, name: string): string | undefined {
  return url.searchParams.getAll(name).at(-1)
}

/**
 * `since` and `until` are declared `str | None`, so pydantic never looked at
 * them and `datetime.fromisoformat()` raised out of the handler: every value it
 * rejects is a 500 in Python, on a parameter the caller controls. Recorded as a
 * confirmed defect in `todo.md` and answered here with pydantic's own
 * `datetime_from_date_parsing`, the error a `datetime` query parameter would
 * have produced.
 *
 * The message drops pydantic's `ctx.error` tail, which names the specific
 * failure ("input is too short", "month value is outside expected range of
 * 1-12") and comes from speedate, a different parser than `fromisoformat` with
 * different failure modes. `pathUuidIssue` already drops the same kind of tail
 * for the same reason.
 */
function boundIssue(name: string, input: string): ValidationErrorDetail {
  return {
    type: "datetime_from_date_parsing",
    loc: ["query", name],
    msg: "Input should be a valid datetime or date",
    input,
  }
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const url = new URL(request.url)
  const issues: ValidationErrorDetail[] = []

  // FastAPI validated every declared parameter before the endpoint body ran, so
  // a bad `page` is reported even when `since` is also unparseable. Probed
  // against the real router rather than assumed.
  const pageRaw = lastValue(url, "page")
  const page = pageRaw === undefined ? 1 : parseInt422(pageRaw, "page", 1, 1, null, issues)
  const perPageRaw = lastValue(url, "per_page")
  const perPage =
    perPageRaw === undefined ? 50 : parseInt422(perPageRaw, "per_page", 50, 1, 200, issues)
  if (issues.length > 0) return unprocessableRequest(issues)

  // Every optional filter is guarded with `if <value>:` in Python, not
  // `is not None`, so an empty value is not a filter at all.
  const level = lastValue(url, "level")
  const stage = lastValue(url, "stage")
  const profileId = lastValue(url, "profile_id")
  const q = lastValue(url, "q")

  // `profile_id: str | None`, so pydantic let anything through and the value
  // reached the uuid column raw. Validated here instead, with the same
  // `uuid_parsing` 422 `GET /api/posts` answers, because the alternative is a
  // database error surfacing as a 500. Same deviation as `/costs`.
  if (profileId && !UUID_PATTERN.test(profileId)) {
    issues.push({
      type: "uuid_parsing",
      loc: ["query", "profile_id"],
      msg: "Input should be a valid UUID",
      input: profileId,
    })
  }

  const sinceRaw = lastValue(url, "since")
  const since = sinceRaw
    ? fromIsoFormat(sinceRaw)
    : toPythonUtcIsoFormat(new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS))
  if (since === null) issues.push(boundIssue("since", sinceRaw as string))

  const untilRaw = lastValue(url, "until")
  const until = untilRaw ? fromIsoFormat(untilRaw) : null
  if (untilRaw && until === null) issues.push(boundIssue("until", untilRaw))

  if (issues.length > 0) return unprocessableRequest(issues)

  const where: SQL[] = [
    sql`p.execution_logs != '[]'::jsonb`,
    sql`wp.user_id = ${user.id}`,
    sql`log_entry->>'ts' >= ${since}`,
  ]
  if (level) {
    // `= ANY(:levels)` over the comma-split list. drizzle's `sql` template
    // expands a JS array into one placeholder per element, which parses as a
    // record rather than an array, so the array is built in SQL instead.
    const levels = level.split(",").map((value) => value.trim())
    const values = sql.join(
      levels.map((value) => sql`${value}`),
      sql`, `,
    )
    where.push(sql`log_entry->>'level' = any(array[${values}]::text[])`)
  }
  if (stage) where.push(sql`log_entry->>'stage' = ${stage}`)
  if (profileId) where.push(sql`p.profile_id = ${profileId}::uuid`)
  // Python interpolates `q` into `%{q}%` without escaping, so a `%` or `_` a
  // caller types is a wildcard. Preserved rather than fixed: the monitor's
  // search box is the only caller and this is a search, not a lookup.
  if (q) where.push(sql`log_entry->>'message' ilike ${`%${q}%`}`)
  if (until !== null) where.push(sql`log_entry->>'ts' <= ${until}`)

  const whereSql = sql.join(where, sql` and `)
  const from = sql`
    from posts p
      join website_profiles wp on p.profile_id = wp.id,
      jsonb_array_elements(p.execution_logs) as log_entry
    where ${whereSql}
  `

  const db = getDb()

  // `count(*)` is `bigint` and `pg` hands OID 20 back as a string rather than
  // risk a lossy `Number`, where asyncpg decoded it to an `int`.
  const counted = await db.execute<{ count: string }>(sql`select count(*) as count ${from}`)
  const total = Number(counted.rows[0].count)

  const result = await db.execute<LogRow>(sql`
    select
      p.id as post_id,
      p.slug,
      p.topic,
      log_entry->>'ts' as timestamp,
      log_entry->>'stage' as stage,
      log_entry->>'level' as level,
      log_entry->>'event' as event,
      log_entry->>'message' as message,
      log_entry->'data' as data
    ${from}
    order by log_entry->>'ts' desc
    limit ${perPage} offset ${(page - 1) * perPage}
  `)

  return Response.json({
    items: result.rows,
    total,
    page,
    per_page: perPage,
    pages: total > 0 ? Math.floor((total + perPage - 1) / perPage) : 0,
  })
}
