// @vitest-environment node
/**
 * Two things are pinned here: what `withServerError` does to a handler, and
 * the fact that every route handler in the app goes through it. The second is
 * the one that matters over time, because the defect this fixes is a handler
 * nobody remembered to wrap, not a wrapper that stopped working.
 */
import fs from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { INTERNAL_SERVER_ERROR_DETAIL, withServerError } from "./route-error"

const APP = path.resolve(__dirname, "../app")

/**
 * `src/app/api/auth/[...all]/route.ts` is BetterAuth's own handler, mounted
 * through `toNextJsHandler()`. It owns its error responses and this app does
 * not build them, so it is not wrapped.
 */
const UNWRAPPED = ["api/auth/[...all]/route.ts"]

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name === "route.ts" ? [full] : []
  })
}

describe("withServerError", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the handler's own response untouched", async () => {
    const wrapped = withServerError(async () =>
      Response.json({ detail: "Not found" }, { status: 404 }),
    )

    const response = await wrapped()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ detail: "Not found" })
  })

  it("passes every argument through, so a context param still reaches the handler", async () => {
    const wrapped = withServerError(
      async (request: Request, context: { params: Promise<{ id: string }> }) =>
        Response.json({ url: request.url, id: (await context.params).id }),
    )

    const response = await wrapped(new Request("http://test/api/posts/7"), {
      params: Promise.resolve({ id: "7" }),
    })

    await expect(response.json()).resolves.toEqual({ url: "http://test/api/posts/7", id: "7" })
  })

  it("accepts a handler that is not async, which the healthcheck is", async () => {
    const wrapped = withServerError(() => Response.json({ status: "ok" }))

    await expect((await wrapped()).json()).resolves.toEqual({ status: "ok" })
  })

  it("answers a throw with the envelope every other failure in this API uses", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const wrapped = withServerError<[Request]>(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432")
    })

    const response = await wrapped(new Request("http://test/api/posts?q=x"))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ detail: INTERNAL_SERVER_ERROR_DETAIL })
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it("keeps the cause out of the body and puts it in the log with the request", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const cause = new Error('password authentication failed for user "pipeline"')
    const wrapped = withServerError<[Request]>(async () => {
      throw cause
    })

    const response = await wrapped(
      new Request("http://test/api/profiles/7", { method: "PATCH" }),
    )

    expect(await response.text()).not.toContain("password")
    expect(logged).toHaveBeenCalledWith("Unhandled error in PATCH /api/profiles/7", cause)
  })

  it("names the handler generically when the first argument is not a Request", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const wrapped = withServerError(() => {
      throw new Error("boom")
    })

    await wrapped()

    expect(logged.mock.calls[0][0]).toBe("Unhandled error in route handler")
  })

  it("catches a rejection as well as a synchronous throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const wrapped = withServerError(() => Promise.reject(new Error("boom")))

    expect((await wrapped()).status).toBe(500)
  })
})

describe("every route handler", () => {
  const files = routeFiles(APP)

  it("finds the app's route files, so an empty scan cannot pass", () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it.each(files.map((file) => path.relative(APP, file)))("%s is wrapped", (relative) => {
    const source = fs.readFileSync(path.join(APP, relative), "utf8")
    const verbs = [...source.matchAll(/^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/gm)]

    if (UNWRAPPED.includes(relative)) {
      expect(source).not.toContain("withServerError")
      return
    }

    expect(verbs.length).toBeGreaterThan(0)
    for (const [, verb] of verbs) {
      expect(source).toMatch(new RegExp(`^export const ${verb} = withServerError\\(`, "m"))
    }
  })
})
