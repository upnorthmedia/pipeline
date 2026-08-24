import { NextRequest, NextResponse } from "next/server"

export function middleware(request: NextRequest) {
  // Lightweight cookie check — full session validation happens server-side
  const sessionCookie =
    request.cookies.get("better-auth.session_token") ||
    request.cookies.get("__Secure-better-auth.session_token")

  if (!sessionCookie?.value) {
    return NextResponse.redirect(new URL("/auth/sign-in", request.url))
  }

  return NextResponse.next()
}

/**
 * `api` is excluded as a whole, not just `api/auth`: an API client that lost
 * its session needs the 401 its handler returns, and `request()` in
 * `src/lib/api.ts` parses the body as JSON. Redirecting it to the sign-in page
 * turns an expected `ApiError(401)` into a JSON parse failure on an HTML page.
 * Route handlers authenticate themselves with `getRequestUser()`; this
 * middleware only checks that a cookie is present, so it was never the thing
 * protecting them.
 *
 * The brand assets are excluded because the sign-in page renders the sidebar
 * logo and the browser asks for the favicon before anyone has a session, and a
 * PWA installer reads the manifest icons with no cookies at all. A redirect
 * there is a broken image on the first page a user sees. `icon` covers
 * `icon.svg`, `icon0.svg` and `icon1.png`; it replaces `icons`, which matched
 * no path this app serves. `src/app/brand-mark.test.ts` pins the list.
 */
export const config = {
  matcher: ["/((?!auth|api|_next|favicon|manifest|icon|apple-icon|web-app-manifest).*)"],
}
