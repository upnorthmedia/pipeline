/**
 * Real BetterAuth sessions for route-handler tests.
 *
 * The handlers ported in Phase 5 scope every row by the authenticated user, so
 * a test that stubs out authentication proves nothing about that scoping. These
 * helpers write the same `auth_users` and `auth_sessions` rows BetterAuth
 * writes and sign the cookie with the running instance's own secret, so
 * `auth.api.getSession()` validates it exactly as it would a browser's.
 *
 * Sign-up is deliberately not used to mint the session: the Stripe plugin's
 * `createCustomerOnSignUp` would make an outbound Stripe call on every test
 * user.
 *
 * Requires `docker compose up -d db` and `node --env-file=../.env
 * scripts/auth-migrate.mts --apply`.
 */
import { randomUUID } from "node:crypto"

import { makeSignature } from "better-auth/crypto"

import { getPool } from "@/db"
import { auth } from "@/lib/auth"

/** BetterAuth's default session cookie name, matching `COOKIE_NAME` in `api/src/api/auth.py`. */
export const SESSION_COOKIE = "better-auth.session_token"

export interface TestSession {
  userId: string
  email: string
  /** A ready-to-send `cookie` header value carrying the signed session token. */
  cookie: string
}

/** The `token.signature` cookie value BetterAuth would set for `token`. */
export async function signSessionCookie(token: string): Promise<string> {
  const { secret } = await auth.$context
  const value = `${token}.${await makeSignature(token, secret)}`
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}`
}

/**
 * A user plus a live session. `idPrefix` is both the user id prefix and the
 * cleanup handle, so give each test file its own.
 */
export async function createTestSession(
  idPrefix: string,
  options: { expiresAt?: Date } = {},
): Promise<TestSession> {
  const pool = getPool()
  const userId = `${idPrefix}${randomUUID()}`
  const email = `${userId}@example.test`
  const token = randomUUID()
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)

  await pool.query(
    `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [userId, "Route handler test", email],
  )
  await pool.query(
    `insert into auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())`,
    [randomUUID(), token, userId, expiresAt],
  )

  return { userId, email, cookie: await signSessionCookie(token) }
}

/** Removes every user created with `idPrefix`; sessions cascade. */
export async function deleteTestSessions(idPrefix: string): Promise<void> {
  await getPool().query(`delete from auth_users where id like $1`, [`${idPrefix}%`])
}

/** A `Request` for a handler under test, optionally carrying a session cookie. */
export function apiRequest(
  url: string,
  init: RequestInit & { cookie?: string } = {},
): Request {
  const { cookie, ...rest } = init
  const headers = new Headers(rest.headers)
  if (cookie) headers.set("cookie", cookie)
  if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  return new Request(url, { ...rest, headers })
}
