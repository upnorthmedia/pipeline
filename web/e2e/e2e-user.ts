/**
 * The one account every e2e test runs as.
 *
 * It is a real BetterAuth row in the real database, not a stubbed session:
 * `auth.setup.ts` signs it up over `/api/auth/sign-up/email` and stores the
 * session cookie it returns. The credentials are fixed rather than generated so
 * a second run reuses the account instead of leaving a new one behind on every
 * invocation.
 *
 * `.test` is a reserved TLD (RFC 2606), so this address can never reach a real
 * mailbox even if the app is ever pointed at a live mail provider.
 */
export const E2E_USER = {
  name: "E2E Runner",
  email: "e2e-runner@jena.test",
  password: "e2e-runner-password-1",
} as const

/** Where `auth.setup.ts` writes the signed-in cookie jar. Gitignored. */
export const STORAGE_STATE = "e2e/.auth/user.json"
