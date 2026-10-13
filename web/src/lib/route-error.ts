/**
 * The answer for a throw no route handler anticipated.
 *
 * Every ported handler answers a failure it knows about with FastAPI's
 * `{"detail": "..."}`, and `apiErrorMessage()` in `src/lib/api.ts` reads that
 * key to decide what the user is told. A throw nobody caught skipped all of
 * that: Next.js answers 500 with an empty body, so the client had nothing of
 * the server's to show and no log line carried the request it came from.
 *
 * The status and the wording are Starlette's own. `ServerErrorMiddleware`
 * answered an unhandled exception with `Internal Server Error`, so the port
 * says the same thing; only the envelope changes, from Starlette's plain text
 * to the JSON shape the rest of this API already uses.
 *
 * The cause is deliberately not in the body. A database error names tables and
 * columns, and an upstream client error can carry a URL with a credential in
 * it, neither of which belongs in a response to a browser. It goes to the
 * server log instead, with the method and path that produced it.
 */

/** Starlette's wording for an unhandled exception, in this API's envelope. */
export const INTERNAL_SERVER_ERROR_DETAIL = "Internal Server Error"

/**
 * Wraps a route handler so it always resolves with a `Response`.
 *
 * The handler's own arguments are passed through untouched, so a wrapped
 * handler is still callable from a test exactly as the unwrapped one was, and
 * Next.js still receives `(request, context)`.
 */
export function withServerError<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args)
    } catch (error) {
      console.error(`Unhandled error in ${describeRequest(args[0])}`, error)
      return Response.json({ detail: INTERNAL_SERVER_ERROR_DETAIL }, { status: 500 })
    }
  }
}

/** `POST /api/posts`, or a placeholder when the first argument is not one. */
function describeRequest(candidate: unknown): string {
  if (!(candidate instanceof Request)) return "route handler"
  try {
    return `${candidate.method} ${new URL(candidate.url).pathname}`
  } catch {
    return `${candidate.method} ${candidate.url}`
  }
}
