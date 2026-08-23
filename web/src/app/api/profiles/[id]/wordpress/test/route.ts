/**
 * Port of `GET /api/profiles/{profile_id}/wordpress/test` in
 * `api/src/api/wordpress.py`.
 *
 * This is the one endpoint of the three that reports failure rather than
 * raising it: both of `_get_wp_client`'s 400s and every `WordPressError` come
 * back as a 200 carrying `{connected: false, error}`, which is what
 * `profiles.wpTest()` in `web/src/lib/api.ts` renders. The profile lookup is
 * outside that net, so another user's profile is still a 404.
 *
 * `info.get("name", "")` is not a safe read: Python raised `AttributeError`
 * for a `/wp-json` root that answered with anything but a JSON object, and
 * nothing caught it, so the request became a 500. `siteName` reproduces that
 * rather than quietly reporting `connected: true` with an empty site name.
 */
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { WordPressError } from "@/mastra/wordpress"

import { isUuid, profileNotFound, unprocessableUuid } from "../../../params"
import { resolveWpClient } from "../client"

class WordPressRootError extends Error {
  constructor() {
    super("WordPress site root did not answer with a JSON object")
    this.name = "WordPressRootError"
  }
}

function siteName(info: unknown): unknown {
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    throw new WordPressRootError()
  }
  const record = info as Record<string, unknown>
  return "name" in record ? record.name : ""
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const resolved = await resolveWpClient(id, user.id)
  if (resolved.kind === "not-found") return profileNotFound()
  if (resolved.kind === "bad-request") {
    return Response.json({ connected: false, error: resolved.detail })
  }

  try {
    const info = await resolved.client.testConnection()
    return Response.json({ connected: true, site_name: siteName(info) })
  } catch (error) {
    // `except WordPressError` only: anything else escapes, as it did in Python.
    if (error instanceof WordPressError) {
      return Response.json({ connected: false, error: error.message })
    }
    throw error
  }
}
