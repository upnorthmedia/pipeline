/**
 * Sign-up is the first thing a user ever does, and with no Stripe account
 * configured it must not reach Stripe.
 *
 * `src/lib/auth.ts` mounts `@better-auth/stripe` unconditionally, giving the
 * Stripe SDK a placeholder key when `STRIPE_SECRET_KEY` is unset. The plugin's
 * `createCustomerOnSignUp` hook then runs on every account creation: it calls
 * `customers.search`, falls back to `customers.list`, and logs its failure
 * through BetterAuth's logger. Two outbound HTTPS attempts to api.stripe.com
 * sit in front of the sign-up response, and the account is created either way,
 * so the whole exchange is latency and log noise on the happy path.
 *
 * The oracle is the outbound request, not the log line: the log wording belongs
 * to the plugin, while "no socket was opened to Stripe" is the property that
 * matters and stays true whatever the plugin decides to print. `https.request`
 * is the boundary the Stripe SDK uses (`node_modules/stripe/cjs/net/
 * NodeHttpClient.js` reads it off the module object at call time, deliberately,
 * so that test doubles can intercept it), and the stub throws rather than
 * calling through, so the suite never touches the network in either state.
 *
 * Requires `docker compose up -d db` and `node --env-file=../.env
 * scripts/auth-migrate.mts --apply`.
 */
import https from "node:https"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { getPool } from "@/db"
import { auth } from "@/lib/auth"

const ID_PREFIX = "stripe-signup-test-"

/** Hosts every `https.request` made during the sign-up under test was aimed at. */
const requestedHosts: string[] = []
/** Everything BetterAuth's logger printed during that sign-up, level and all. */
const consoleLines: string[] = []

/**
 * A real key means this file's premise (no Stripe account configured) does not
 * hold, so it measures nothing. Nobody in this repo has one, and CI has none.
 */
const configured = Boolean(process.env.STRIPE_SECRET_KEY)

describe.skipIf(configured)("sign-up with no Stripe key configured", () => {
  let email: string

  beforeAll(async () => {
    email = `${ID_PREFIX}${Date.now()}@example.test`

    const requestSpy = vi
      .spyOn(https, "request")
      .mockImplementation((...args: unknown[]) => {
        const target = args[0]
        const host =
          typeof target === "string"
            ? new URL(target).host
            : String((target as { host?: string; hostname?: string })?.host ?? "")
        requestedHosts.push(host)
        throw new Error(`outbound https.request to ${host} is blocked in this test`)
      }) as unknown as ReturnType<typeof vi.spyOn>

    const consoleSpies = (["error", "warn", "info", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(`${level}: ${args.map(String).join(" ")}`)
      }),
    )

    try {
      await auth.api.signUpEmail({
        body: { name: "Stripe hook probe", email, password: "probe-password-1234" },
      })
    } finally {
      requestSpy.mockRestore()
      consoleSpies.forEach((spy) => spy.mockRestore())
    }
  })

  afterAll(async () => {
    await getPool().query(`delete from auth_users where email like $1`, [`${ID_PREFIX}%`])
  })

  it("opens no connection to Stripe", () => {
    expect(requestedHosts.filter((host) => host.includes("stripe.com"))).toEqual([])
  })

  it("prints no Stripe failure on the happy path", () => {
    expect(consoleLines.filter((line) => /stripe/i.test(line))).toEqual([])
  })

  it("still creates the account", async () => {
    const { rows } = await getPool().query(
      `select "stripeCustomerId" from auth_users where email = $1`,
      [email],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].stripeCustomerId).toBeNull()
  })
})
