/**
 * Port of `GET /api/settings/api-keys/{provider}/reveal` in
 * `api/src/api/settings.py`, the one endpoint in the app that returns a
 * plaintext provider key. The settings page calls it behind the eye toggle,
 * for a key already stored; a key the operator has just typed is shown by the
 * page itself and never comes back through here.
 *
 * Python gated it on `request.client.host in ("127.0.0.1", "::1",
 * "localhost")`, the raw TCP peer address the ASGI server saw. A Next.js
 * handler has no access to the socket (`NextRequest.ip` was removed in Next
 * 15), so the peer has to be read out of headers instead.
 *
 * This first refused any request carrying a forwarding header at all, on the
 * grounds that such a header means a proxy. It does not: Next fills those
 * headers in itself, from the socket, before a handler runs
 * (`base-server.js`: `req.headers['x-forwarded-for'] ??=
 * originalRequest.socket.remoteAddress`, and the same `??=` for host, port and
 * proto). Every request therefore carried one, the gate never opened, and the
 * eye toggle answered `403 Forbidden` on the developer's own machine.
 *
 * So the headers are read rather than counted. A request passes only when
 * every address in it names loopback:
 *
 *   - `host`, which on a deployed instance is the public domain;
 *   - `x-forwarded-host`, which Next copies from `host` locally and a proxy
 *     sets to the domain it terminated;
 *   - `x-real-ip`, if some proxy set one;
 *   - the *rightmost* entry of `x-forwarded-for`, which is the address written
 *     by the hop closest to this process. A client can prepend `127.0.0.1` to
 *     that header, and Next's `??=` preserves it, but a proxy appends the peer
 *     it actually saw after it, so the forged entry is never the one read.
 *   - `forwarded` is rejected outright: Next never writes it, so its presence
 *     means a proxy did.
 *
 * The residual exposure is an origin published straight to the internet with
 * no proxy in front, where nothing overwrites a forged `x-forwarded-for` and a
 * forged `Host`. Deployments front this with a proxy (Railway's edge), whose
 * appended peer address is the real client's and closes that path.
 */
import { withServerError } from "@/lib/route-error"
import { revealApiKey } from "@/mastra/api-keys"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

/** Hostnames that count as loopback, with the port stripped and IPv6 unbracketed. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

/** The header a proxy sets and Next never does: its presence alone is a proxy. */
const PROXY_ONLY_HEADER = "forwarded"

/** `[::1]:3000` -> `::1`, `localhost:3000` -> `localhost`, `::1` -> `::1`. */
function hostname(value: string): string {
  const host = value.trim().toLowerCase()
  const bracketed = host.match(/^\[(.+)\]/)
  if (bracketed) return bracketed[1]
  // A bare IPv6 address has several colons; only a `host:port` has exactly one.
  return host.split(":").length === 2 ? host.split(":")[0] : host
}

/** True for the addresses a connection from this machine can arrive as. */
function isLoopbackAddress(value: string): boolean {
  const address = hostname(value).replace(/^::ffff:/, "")
  return LOOPBACK_HOSTS.has(address) || /^127\./.test(address)
}

/** The address written by the hop nearest this process, or null if there is none. */
function nearestForwardedFor(header: string): string | null {
  const hops = header.split(",").map((hop) => hop.trim()).filter(Boolean)
  return hops.length > 0 ? hops[hops.length - 1] : null
}

function isLoopbackRequest(request: Request): boolean {
  if (request.headers.has(PROXY_ONLY_HEADER)) return false

  const host = request.headers.get("host")
  if (!host || !isLoopbackAddress(host)) return false

  for (const header of ["x-forwarded-host", "x-real-ip"]) {
    const value = request.headers.get(header)
    if (value !== null && !isLoopbackAddress(value)) return false
  }

  const forwardedFor = request.headers.get("x-forwarded-for")
  if (forwardedFor !== null) {
    const peer = nearestForwardedFor(forwardedFor)
    if (peer === null || !isLoopbackAddress(peer)) return false
  }

  return true
}

async function getHandler(
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

export const GET = withServerError(getHandler)
