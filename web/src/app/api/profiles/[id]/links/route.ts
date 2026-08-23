/**
 * Port of `GET` and `POST /api/profiles/{profile_id}/links` in
 * `api/src/api/links.py`.
 *
 * Both endpoints resolved the profile through `_get_profile_or_404()`, which
 * matched the id and `website_profiles.user_id` together, so another user's
 * profile is indistinguishable from one that does not exist. That check runs
 * before anything else the handler does, exactly as it did in Python.
 */
import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm"

import { getDb, internalLinks, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import {
  bodyDetails,
  invalidJsonBody,
  pathUuidIssue,
  unprocessableRequest,
  type ValidationErrorDetail,
} from "../../../pydantic"
import { isUuid, profileNotFound } from "../../params"
import { parseListLinksRequest } from "./params"
import { serializeLink, type LinkResponse } from "./serialize"
import { linkCreateSchema } from "./validation"

export interface PaginatedLinksResponse {
  items: LinkResponse[]
  total: number
  page: number
  per_page: number
  pages: number
}

/** `_get_profile_or_404()`: the profile id, only if this caller owns it. */
async function ownedProfile(profileId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: websiteProfiles.id })
    .from(websiteProfiles)
    .where(and(eq(websiteProfiles.id, profileId), eq(websiteProfiles.userId, userId)))
    .limit(1)
  return rows.length > 0
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  const query = parseListLinksRequest(id, new URL(request.url))
  if (query instanceof Response) return query

  if (!(await ownedProfile(id, user.id))) return profileNotFound()

  const conditions: SQL[] = [eq(internalLinks.profileId, id)]
  if (query.q) {
    // `f"%{q}%"` was not escaped in Python either, so a `%` or `_` in the
    // search term is still a wildcard rather than a literal.
    const pattern = `%${query.q}%`
    conditions.push(
      or(ilike(internalLinks.url, pattern), ilike(internalLinks.title, pattern)) as SQL,
    )
  }
  const where = and(...conditions)

  const db = getDb()
  const [{ total }] = await db.select({ total: count() }).from(internalLinks).where(where)

  const rows = await db
    .select()
    .from(internalLinks)
    .where(where)
    .orderBy(desc(internalLinks.createdAt))
    .offset((query.page - 1) * query.perPage)
    .limit(query.perPage)

  const body: PaginatedLinksResponse = {
    items: rows.map(serializeLink),
    total,
    page: query.page,
    per_page: query.perPage,
    pages: total > 0 ? Math.ceil(total / query.perPage) : 0,
  }
  return Response.json(body)
}

/**
 * `create_link()`. The duplicate check is a read before the insert, as Python
 * wrote it, so the ordinary duplicate is a 409 rather than the 500 the
 * `uq_internal_links_profile_url` constraint would have produced. A concurrent
 * insert that slips between the two still hits the constraint and surfaces as
 * a 500, which is what happened in Python too.
 *
 * `source` is always `"manual"` here: the sitemap crawl writes `"sitemap"`,
 * and `LinkCreate` has no field a client could use to claim otherwise.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params

  // A body FastAPI could not decode was reported on its own, without the path
  // error beside it, because the decode failed before the parameters were
  // solved. Probed: POST /api/profiles/bad/links with `{nope` answers a single
  // `json_invalid` entry.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const issues: ValidationErrorDetail[] = []
  if (!isUuid(id)) issues.push(pathUuidIssue("profile_id", id))
  const parsed = linkCreateSchema.safeParse(body)
  if (issues.length > 0 || !parsed.success) {
    return unprocessableRequest([...issues, ...bodyDetails(parsed.error?.issues ?? [], body)])
  }

  if (!(await ownedProfile(id, user.id))) return profileNotFound()

  const db = getDb()
  const existing = await db
    .select({ id: internalLinks.id })
    .from(internalLinks)
    .where(and(eq(internalLinks.profileId, id), eq(internalLinks.url, parsed.data.url)))
    .limit(1)
  if (existing.length > 0) {
    return Response.json(
      { detail: "Link with this URL already exists for this profile" },
      { status: 409 },
    )
  }

  const [row] = await db
    .insert(internalLinks)
    .values({
      profileId: id,
      source: "manual",
      url: parsed.data.url,
      title: parsed.data.title,
      slug: parsed.data.slug,
      keywords: parsed.data.keywords,
    })
    .returning()

  return Response.json(serializeLink(row), { status: 201 })
}
