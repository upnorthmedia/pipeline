// @vitest-environment node
/**
 * The shared authentication step of every ported route handler, exercised
 * against real `auth_users` and `auth_sessions` rows and the real BetterAuth
 * instance. The cases mirror the ones `get_current_user()` in
 * `api/src/api/auth.py` distinguishes: no cookie, a cookie that does not match
 * a live session, and a valid one.
 */
import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import {
  apiRequest,
  createTestSession,
  deleteTestSessions,
  signSessionCookie,
} from "@/test/session"

const PREFIX = "req-auth-test-"

beforeAll(async () => {
  await deleteTestSessions(PREFIX)
})

afterAll(async () => {
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("getRequestUser", () => {
  it("resolves the user behind a valid session cookie", async () => {
    const session = await createTestSession(PREFIX)
    const user = await getRequestUser(apiRequest("http://test/api/settings", { cookie: session.cookie }))

    expect(user).toEqual({ id: session.userId, email: session.email })
  })

  it("returns null when the request carries no cookie", async () => {
    expect(await getRequestUser(apiRequest("http://test/api/settings"))).toBeNull()
  })

  it("returns null for a token that matches no session row", async () => {
    const cookie = await signSessionCookie(randomUUID())

    expect(await getRequestUser(apiRequest("http://test/api/settings", { cookie }))).toBeNull()
  })

  it("returns null when the signature does not match the token", async () => {
    const session = await createTestSession(PREFIX)
    const tampered = session.cookie.replace(/\.[^.]*$/, ".not-a-real-signature")

    expect(await getRequestUser(apiRequest("http://test/api/settings", { cookie: tampered }))).toBeNull()
  })

  it("returns null once the session has expired", async () => {
    const session = await createTestSession(PREFIX, { expiresAt: new Date(Date.now() - 60_000) })

    expect(
      await getRequestUser(apiRequest("http://test/api/settings", { cookie: session.cookie })),
    ).toBeNull()
  })
})

describe("unauthorized", () => {
  it("renders FastAPI's 401 body so ApiError keeps its message", async () => {
    const response = unauthorized()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })
})
