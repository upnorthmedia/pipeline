/**
 * Port of `GET /api/settings/api-keys/{provider}/reveal` in
 * `api/src/api/settings.py`, the one endpoint in the app that returns a
 * plaintext provider key. The settings page calls it behind the eye toggle.
 *
 * Python gated it on `request.client.host in ("127.0.0.1", "::1",
 * "localhost")`, the raw TCP peer address the ASGI server saw. A Next.js handler
 * has no access to the socket (`NextRequest.ip` was removed in Next 15), so
 * the peer address is not recoverable and the check has to be rebuilt from
 * headers. Deriving it from `x-forwarded-for` would be strictly weaker than
 * what it replaces, because that header is attacker-controlled, so this fails
 * closed instead: the request must both name a loopback host and carry no
 * forwarding header at all.
 *
 * Behind any proxy, including Railway's edge, a forwarding header is present
 * and the reveal 403s. Against `next dev` or `next start` on the developer's
 * own machine the browser sends `Host: localhost:3000` and no forwarding
 * header, which is exactly the case Python allowed. An attacker cannot strip a
 * header the trusted proxy adds, so there is no way to talk a deployed
 * instance into the allowed branch.
 */
import { revealApiKey } from "@/mastra/api-keys"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

/** Hostnames that count as loopback, with the port stripped and IPv6 unbracketed. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

/**
 * Headers a proxy inserts. Any one of them means the connection reaching this
 * process did not originate on this machine.
 */
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
]

function isLoopbackRequest(request: Request): boolean {
  if (FORWARDING_HEADERS.some((header) => request.headers.has(header))) return false

  const host = request.headers.get("host")
  if (!host) return false

  const bracketed = host.match(/^\[(.+)\]/)
  const hostname = bracketed ? bracketed[1] : host.split(":")[0]
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  if (!isLoopbackRequest(request)) {
    return Response.json({ detail: "Forbidden" }, { status: 403 })
  }

  const { provider } = await params
  const key = await revealApiKey(provider)
  if (key === null) {
    return Response.json({ detail: "Key not configured" }, { status: 404 })
  }

  return Response.json({ provider, key })
}
