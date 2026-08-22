/**
 * Session resolution for the ported route handlers, replacing
 * `get_current_user()` in `api/src/api/auth.py`.
 *
 * The Python dependency read the `better-auth.session_token` cookie, split the
 * signature off, and looked the token up in `auth_sessions` itself. This port
 * hands the request to BetterAuth instead, because BetterAuth owns the session
 * format here: it also verifies the cookie signature, understands the
 * `__Secure-` prefix, and honours the cookie cache. Reimplementing the lookup
 * would leave two definitions of "logged in" to drift apart.
 *
 * Handlers stay on the Web `Request`/`Response` types rather than
 * `next/server`, so they are callable from a test without a Next.js server.
 */
import { auth } from "./auth"

/** The subset of the BetterAuth user every ported handler scopes its rows by. */
export interface RequestUser {
  id: string
  email: string
}

/**
 * The authenticated user, or `null` when the request carries no usable
 * session. Returning `null` rather than throwing keeps the 401 body in the
 * handler, where the rest of that handler's responses are built.
 */
export async function getRequestUser(request: Request): Promise<RequestUser | null> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email }
}

/**
 * FastAPI rendered `HTTPException(401, "Not authenticated")` as
 * `{"detail": "Not authenticated"}`, and `web/src/lib/api.ts` surfaces the raw
 * body on `ApiError`, so keep the shape byte for byte.
 */
export function unauthorized(): Response {
  return Response.json({ detail: "Not authenticated" }, { status: 401 })
}
