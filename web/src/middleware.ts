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

export const config = {
  matcher: ["/((?!auth|api/auth|_next|favicon|manifest|icons).*)"],
}
