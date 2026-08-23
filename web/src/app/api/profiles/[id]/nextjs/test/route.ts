/**
 * Port of `POST /api/profiles/{profile_id}/nextjs/test` in
 * `api/src/api/nextjs.py`.
 *
 * Like the WordPress `/test` endpoint next to it, every failure below the
 * profile lookup is reported rather than raised: a missing URL or secret, a
 * secret that will not decrypt, a non-200 from the webhook and a transport
 * failure all come back as a 200 carrying `{connected: false, error}`, which is
 * what `profiles.nextjsTest()` in `web/src/lib/api.ts` renders. The profile
 * lookup itself is outside that net, so another user's profile is a 404.
 *
 * The bytes on the wire matter here in a way they do not for a JSON API: the
 * receiver in `packages/create-mdx-blog` verifies the signature over the raw
 * body before parsing it, so the payload is assembled to match Python's
 * `json.dumps` separators and `datetime.now(UTC).isoformat()` exactly rather
 * than left to `JSON.stringify` and `toISOString`.
 *
 * Two behaviours of `httpx.AsyncClient` have to be asked for explicitly here
 * because `fetch` defaults the other way: httpx does not follow redirects, so a
 * 302 is reported as a 302, and httpx was given a 10 second timeout.
 */
import { and, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { decrypt } from "@/lib/crypto"
import { signPayload } from "@/lib/hmac-signing"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, profileNotFound, unprocessableUuid } from "../../../params"
import { webhookDetail } from "../detail"

const TIMEOUT_MS = 10_000

/**
 * `datetime.now(UTC).isoformat()`: microsecond precision, a `+00:00` offset
 * rather than `Z`, and no fractional part at all when the microsecond is zero.
 * `Date` only carries milliseconds, so the last three digits are always zero;
 * the format matches, the resolution does not.
 */
function utcIsoformat(now: Date): string {
  const [seconds, millis] = now.toISOString().slice(0, -1).split(".")
  return millis === "000" ? `${seconds}+00:00` : `${seconds}.${millis}000+00:00`
}

/** `json.dumps({"event": ..., "timestamp": ...})`, separators included. */
function testPayload(now: Date): string {
  return `{"event": "test", "timestamp": ${JSON.stringify(utcIsoformat(now))}}`
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({
      url: websiteProfiles.nextjsWebhookUrl,
      secret: websiteProfiles.nextjsWebhookSecret,
    })
    .from(websiteProfiles)
    .where(and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  const profile = rows[0]
  if (!profile) return profileNotFound()

  // `if not profile.nextjs_webhook_url or ...`: an empty string is as missing
  // as a null, and one message covers both columns.
  if (!profile.url || !profile.secret) {
    return Response.json({ connected: false, error: "Webhook URL or secret not configured" })
  }

  let secret: string
  try {
    secret = decrypt(profile.secret)
  } catch {
    // Python's `except Exception` covers both an invalid token and the
    // `ValueError` a missing `WP_ENCRYPTION_KEY` raises.
    return Response.json({ connected: false, error: "Failed to decrypt webhook secret" })
  }

  const payload = testPayload(new Date())

  let response: Response
  let text: string
  try {
    response = await fetch(profile.url, {
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/json",
        "X-Jena-Signature": signPayload(payload, secret),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    text = await response.text()
  } catch (error) {
    // `except httpx.RequestError`: every transport failure, connect, read,
    // write and timeout alike. The wording of the message is Node's, not
    // httpx's.
    return Response.json({
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (response.status === 200) return Response.json({ connected: true })
  return Response.json({
    connected: false,
    error: `Webhook returned ${response.status}: ${webhookDetail(text)}`,
  })
}
