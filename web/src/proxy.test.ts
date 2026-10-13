// @vitest-environment node
/**
 * The file convention that stands between an anonymous request and every page.
 *
 * Next 16 renamed it: `middleware` is deprecated and `proxy` is the name the
 * bundler resolves, which the installed copy says on every dev boot and every
 * `pnpm build`. The rename is not cosmetic. `runDependingOnPageType` in
 * `next/dist/build/entries.js` sends a proxy file to `onServer()` only, so it
 * runs on the Node.js runtime instead of the edge one, and a `runtime` in the
 * route segment config is a build error there rather than a setting. Nothing
 * here declares one.
 *
 * The three facts below are read out of the installed Next rather than
 * restated, because all three are version-specific:
 *   - `PROXY_FILENAME` / `MIDDLEWARE_FILENAME` are the basenames it resolves.
 *   - `isProxyFile()` is the predicate that picks the Node.js runtime.
 *   - `build/templates/middleware.js` requires an export named `proxy` (or a
 *     default) and throws `ProxyMissingExportError` without one, which is a
 *     boot failure, not a type error, so tsc cannot catch it.
 *
 * The behaviour half is here because the redirect had no unit test at all: it
 * was covered only by the signed-out e2e case, which needs a dev server.
 */
import fs from "node:fs"
import path from "node:path"

import { isProxyFile } from "next/dist/build/utils"
import { MIDDLEWARE_FILENAME, PROXY_FILENAME } from "next/dist/lib/constants"
import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname)

describe("the request proxy", () => {
  it("ships under the name Next resolves, and only that name", () => {
    // Both files present is not a warning, it is error E900: "Both middleware
    // file ... and proxy file ... are detected."
    expect(fs.existsSync(path.join(SRC, `${PROXY_FILENAME}.ts`))).toBe(true)
    expect(fs.existsSync(path.join(SRC, `${MIDDLEWARE_FILENAME}.ts`))).toBe(false)

    expect(isProxyFile(`/src/${PROXY_FILENAME}`)).toBe(true)
  })

  it("exports the handler name the entry template reads", async () => {
    const mod = await import("@/proxy")

    expect(typeof mod.proxy).toBe("function")
  })

  it("sends a request carrying no session cookie to sign-in", async () => {
    const { proxy } = await import("@/proxy")

    const response = proxy(new NextRequest("http://localhost:3000/posts/new"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost:3000/auth/sign-in")
  })

  it("lets a request carrying a session cookie through", async () => {
    const { proxy } = await import("@/proxy")

    const request = new NextRequest("http://localhost:3000/posts/new")
    request.cookies.set("better-auth.session_token", "a-value")

    const response = proxy(request)

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("accepts the secure cookie name a production deployment sets", async () => {
    const { proxy } = await import("@/proxy")

    const request = new NextRequest("https://example.com/posts/new")
    request.cookies.set("__Secure-better-auth.session_token", "a-value")

    expect(proxy(request).headers.get("x-middleware-next")).toBe("1")
  })
})
