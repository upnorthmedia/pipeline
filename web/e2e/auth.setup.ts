import { test as setup, expect, type APIRequestContext } from "@playwright/test"

import { E2E_USER, STORAGE_STATE } from "./e2e-user"

/**
 * Every page under `/` is behind `src/middleware.ts`, which redirects any
 * request without a `better-auth.session_token` cookie to `/auth/sign-in`.
 * Before this project existed the whole Playwright suite ran unauthenticated
 * and so asserted against the sign-in page, which is why 31 of 35 tests failed
 * on assertions that named the dashboard.
 *
 * This is the real sign-up endpoint against the real database: BetterAuth
 * writes `auth_users`, `auth_accounts` and `auth_sessions` rows and answers
 * with the session cookie. Nothing here is stubbed.
 */

/** BetterAuth answers a duplicate sign-up with 422 `USER_ALREADY_EXISTS`. */
const signUpOrSignIn = async (request: APIRequestContext) => {
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { name: E2E_USER.name, email: E2E_USER.email, password: E2E_USER.password },
    failOnStatusCode: false,
  })
  if (signUp.ok()) return

  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: E2E_USER.email, password: E2E_USER.password },
    failOnStatusCode: false,
  })
  expect(
    signIn.ok(),
    `sign-up said ${signUp.status()} ${await signUp.text()} and sign-in then said ` +
      `${signIn.status()} ${await signIn.text()}`,
  ).toBeTruthy()
}

/**
 * The account is reused across runs, so the rows a previous run created are
 * still there. Tests that assert on an empty dashboard need them gone, and the
 * account's own API is the only thing that knows which rows are its.
 *
 * Posts go before profiles: `posts_profile_id_fkey` has no `ON DELETE`, so a
 * profile with posts still attached cannot be deleted.
 */
const clearAccountData = async (request: APIRequestContext) => {
  const listed = await request.get("/api/posts?per_page=100")
  expect(listed.ok(), `GET /api/posts answered ${listed.status()}`).toBeTruthy()
  for (const post of (await listed.json()) as { id: string }[]) {
    const deleted = await request.delete(`/api/posts/${post.id}`)
    expect(deleted.ok(), `DELETE /api/posts/${post.id} answered ${deleted.status()}`).toBeTruthy()
  }

  const profiles = await request.get("/api/profiles")
  expect(profiles.ok(), `GET /api/profiles answered ${profiles.status()}`).toBeTruthy()
  for (const profile of (await profiles.json()) as { id: string }[]) {
    const deleted = await request.delete(`/api/profiles/${profile.id}`)
    expect(
      deleted.ok(),
      `DELETE /api/profiles/${profile.id} answered ${deleted.status()}`,
    ).toBeTruthy()
  }
}

setup("sign in and save the session", async ({ request }) => {
  await signUpOrSignIn(request)

  // Proves the cookie authenticates a route handler, not just that a 200 came
  // back: `getRequestUser()` is what every handler scopes its query by.
  const me = await request.get("/api/profiles")
  expect(me.status(), "the saved session must reach a scoped route handler").toBe(200)

  await clearAccountData(request)

  await request.storageState({ path: STORAGE_STATE })
})
