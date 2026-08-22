/**
 * Port of `GET /api/posts/{post_id}/logs` in `api/src/api/posts.py`.
 *
 * `get_execution_logs` reads the `execution_logs` jsonb column and applies up
 * to three in-memory filters. Three details of the Python are load-bearing and
 * reproduced here rather than tidied:
 *
 * * `level` is a repeated query parameter (`list[str]`), so every occurrence
 *   counts, where `stage` and `since` are scalars and Starlette's
 *   `QueryParams.get()` keeps the last occurrence of each.
 * * an empty `level` list, an empty `stage` and an empty `since` are all falsy
 *   in Python, so each of those skips its filter entirely rather than matching
 *   nothing. `?level=` is the exception: it parses to `[""]`, a non-empty list
 *   holding the empty string, which filters and matches nothing.
 * * `since` is compared with `>` against `entry.get("ts", "")`, a plain string
 *   comparison rather than a date one, so an entry with no `ts` loses to any
 *   `since` that sorts above the empty string, and a `since` of `"2026-08"`
 *   filters just as well as a full timestamp.
 *
 * The response is the filtered array itself, in the column's stored order.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, postNotFound, unprocessableUuid } from "../../params"

type LogEntry = Record<string, unknown>

/**
 * Python compares strings by code point; JavaScript's `>` compares by UTF-16
 * code unit, and the two disagree once an astral character meets one in
 * `U+E000`-`U+FFFF`. Only `ts` values reach this, and `append_execution_log`
 * writes an ISO timestamp, but `since` is client-supplied.
 */
function pythonGreater(left: string, right: string): boolean {
  const a = Array.from(left)
  const b = Array.from(right)
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const x = a[i].codePointAt(0) as number
    const y = b[i].codePointAt(0) as number
    if (x !== y) return x > y
  }
  return a.length > b.length
}

/**
 * `entry.get(key)` on anything that is not a dict raised `AttributeError` and
 * surfaced as a 500. Treating a non-object entry as one with no keys removes
 * that error path; nothing writes such an entry, since the column is only ever
 * appended to by `append_execution_log`.
 */
function field(entry: unknown, key: string): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
  return (entry as LogEntry)[key]
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({ executionLogs: posts.executionLogs })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()

  const query = new URL(request.url).searchParams
  const level = query.getAll("level")
  const stage = query.getAll("stage").at(-1) ?? null
  const since = query.getAll("since").at(-1) ?? null

  const stored: unknown = rows[0].executionLogs
  let logs: unknown[] = Array.isArray(stored) ? [...stored] : []

  if (level.length > 0) {
    logs = logs.filter((entry) => {
      const value = field(entry, "level")
      return typeof value === "string" && level.includes(value)
    })
  }
  if (stage) {
    logs = logs.filter((entry) => field(entry, "stage") === stage)
  }
  if (since) {
    logs = logs.filter((entry) => {
      const ts = field(entry, "ts")
      return pythonGreater(typeof ts === "string" ? ts : "", since)
    })
  }

  return Response.json(logs)
}
