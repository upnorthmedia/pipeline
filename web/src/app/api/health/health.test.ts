// @vitest-environment node
/**
 * The healthcheck the Railway `web` service and both compose files probe.
 * These assertions are the deployment contract: a 200 and a JSON body, with no
 * connection opened to anything.
 */
import { describe, expect, it, vi } from "vitest"

import { config as middlewareConfig } from "@/middleware"

import { GET } from "./route"

describe("GET /api/health", () => {
  it("answers 200, which is the only status Railway accepts", async () => {
    const response = GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("opens no database pool", async () => {
    const db = await import("@/db")
    const getPool = vi.spyOn(db, "getPool")

    GET()

    expect(getPool).not.toHaveBeenCalled()
    getPool.mockRestore()
  })

  it("is outside the middleware matcher, so an unauthenticated probe reaches it", () => {
    const [matcher] = middlewareConfig.matcher
    const pattern = new RegExp(`^${matcher}$`)

    expect(pattern.test("/api/health")).toBe(false)
    expect(pattern.test("/")).toBe(true)
  })
})
