/**
 * The path and query parameters of the three link endpoints, as FastAPI
 * declared them.
 *
 * FastAPI validated path parameters, then query parameters, and reported all
 * of them in one 422 rather than stopping at the first. Probed against the
 * real router:
 *
 *   GET /api/profiles/not-a-uuid/links?page=0&per_page=999
 *     -> uuid_parsing ['path','profile_id'],
 *        greater_than_equal ['query','page'],
 *        less_than_equal ['query','per_page']
 *   DELETE /api/profiles/bad/links/nope
 *     -> uuid_parsing ['path','profile_id'], uuid_parsing ['path','link_id']
 *
 * so both are collected here rather than short-circuited on the first failure
 * the way the single-parameter post and profile handlers can afford to.
 */
import {
  parseInt422,
  pathUuidIssue,
  unprocessableRequest,
  type ValidationErrorDetail,
} from "../../../pydantic"
import { isUuid } from "../../params"

export interface ListLinksQuery {
  /** `q: str | None`. An empty string is falsy in Python, so it filters nothing. */
  q: string | null
  page: number
  perPage: number
}

/**
 * `GET /api/profiles/{profile_id}/links`. Returns the parsed query, or the 422
 * FastAPI would have answered with.
 *
 * A repeated `?page=` keeps the last value, because FastAPI read it through
 * Starlette's `QueryParams`, a multidict whose `get()` returns the last
 * occurrence where `URLSearchParams.get()` returns the first. That is the same
 * difference already recorded for `?stage=` on `POST /{post_id}/run`.
 */
export function parseListLinksRequest(
  profileId: string,
  url: URL,
): ListLinksQuery | Response {
  const issues: ValidationErrorDetail[] = []
  if (!isUuid(profileId)) issues.push(pathUuidIssue("profile_id", profileId))

  const params = url.searchParams
  const rawPage = params.getAll("page").at(-1)
  const page = rawPage === undefined ? 1 : parseInt422(rawPage, "page", 1, 1, null, issues)
  const rawPerPage = params.getAll("per_page").at(-1)
  const perPage =
    rawPerPage === undefined ? 50 : parseInt422(rawPerPage, "per_page", 50, 1, 200, issues)

  if (issues.length > 0) return unprocessableRequest(issues)

  return { q: params.getAll("q").at(-1) ?? null, page, perPage }
}

/**
 * The two path uuids of `DELETE /api/profiles/{profile_id}/links/{link_id}`,
 * both reported in one 422 when both are malformed.
 */
export function parseLinkPath(profileId: string, linkId: string): Response | null {
  const issues: ValidationErrorDetail[] = []
  if (!isUuid(profileId)) issues.push(pathUuidIssue("profile_id", profileId))
  if (!isUuid(linkId)) issues.push(pathUuidIssue("link_id", linkId))
  return issues.length > 0 ? unprocessableRequest(issues) : null
}

export function linkNotFound(): Response {
  return Response.json({ detail: "Link not found" }, { status: 404 })
}
