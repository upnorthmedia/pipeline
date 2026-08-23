/**
 * Liveness probe for the `web` service.
 *
 * Railway switches traffic to a new deployment only once the configured
 * healthcheck path answers HTTP 200 (docs.railway.com/guides/healthchecks:
 * "Railway will query the endpoint until it receives an HTTP 200 response"),
 * and `railway.web.json` points at this path. `/` cannot be used: the
 * middleware redirects an unauthenticated request to `/auth/sign-in`, so a
 * probe there gets a 307.
 *
 * Deliberately liveness, not readiness: it opens no database or Redis
 * connection. A probe that touched Postgres would make an unauthenticated
 * endpoint a way to spend the connection budget, and Railway polls this during
 * every deploy. The process answering at all is what the probe is asking about;
 * whether Postgres is reachable is what the dashboard's own error states are
 * for.
 *
 * `/api/*` is outside the middleware matcher, so no session is required here.
 */
export const dynamic = "force-dynamic"

export function GET() {
  return Response.json({ status: "ok" })
}
