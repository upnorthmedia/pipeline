/**
 * The one resolver for BetterAuth's signing secret.
 *
 * Left to itself, `betterAuth()` falls back to a constant compiled into the
 * published package (`DEFAULT_SECRET` in `better-auth/dist/utils/constants.mjs`)
 * whenever `BETTER_AUTH_SECRET` is unset. It throws for that fallback under
 * `NODE_ENV=production` and says nothing at all otherwise, so a development or
 * preview deployment signs every session cookie and every verification token
 * with a value anyone can read off npm, and nothing in the output says so.
 *
 * This makes the miss fatal wherever it happens, at import rather than on the
 * first request, and names the variable. `web/vitest.config.ts` supplies a
 * fixed secret for the suite, `.github/workflows/ci.yml` generates one per run,
 * and `web/Dockerfile`'s builder stage carries a build-only placeholder for the
 * same reason it carries placeholder database and Redis URLs: `next build`
 * imports every route module, including `/api/auth/[...all]`.
 */

/** `DEFAULT_SECRET` in `better-auth/dist/utils/constants.mjs`, at 1.5.4. */
export const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890"

/** The generator `.env.example` names, quoted in the failure so it can be pasted. */
const GENERATE =
  'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"'

/**
 * Returns the configured signing secret, or throws naming what to set.
 *
 * Rejecting the published fallback explicitly matters as much as rejecting an
 * empty value: it is a legal 38-character string, so every length and entropy
 * check BetterAuth runs on it passes.
 */
export function resolveAuthSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.BETTER_AUTH_SECRET?.trim()
  if (!secret) {
    throw new Error(
      `BETTER_AUTH_SECRET is not set. Without it BetterAuth signs session cookies with a ` +
        `publicly known constant. Add it to the repo-root .env (see .env.example) or to the ` +
        `deployment's environment. Generate one with: ${GENERATE}`,
    )
  }
  if (secret === BETTER_AUTH_DEFAULT_SECRET) {
    throw new Error(
      `BETTER_AUTH_SECRET is set to better-auth's own fallback, which is publicly known and ` +
        `signs nothing securely. Generate a real one with: ${GENERATE}`,
    )
  }
  return secret
}
