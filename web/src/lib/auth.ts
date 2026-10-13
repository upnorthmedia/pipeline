import { betterAuth } from "better-auth"
import { stripe } from "@better-auth/stripe"
import Stripe from "stripe"
import { Resend } from "resend"
import { Pool } from "pg"

// Relative and extensioned, not the `@/` alias: `scripts/auth-migrate.mts`
// loads this module under bare node to read `auth.options`, and node resolves
// neither a tsconfig path nor an extensionless specifier. That is the same
// reason `tsconfig.json` sets `allowImportingTsExtensions`.
// `src/db/migration-scripts.test.ts` runs the script, so an alias reappearing
// anywhere in this graph fails a test rather than the fresh-database procedure.
import { resolveAuthSecret } from "./auth-secret.ts"

const resend = new Resend(process.env.RESEND_API_KEY || "re_mock_dev_key")

/**
 * Whether this deployment has a Stripe account behind it at all. The placeholder
 * below keeps the SDK constructible without one, but it is not a key: every call
 * made with it reaches api.stripe.com and comes back rejected.
 */
const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY)

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock_dev_key")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_SYNC!,
})

export const auth = betterAuth({
  database: pool,
  // Passed rather than left to BetterAuth's own `BETTER_AUTH_SECRET` lookup,
  // which falls back to a constant published in the package. See
  // `src/lib/auth-secret.ts`.
  secret: resolveAuthSecret(),
  user: {
    modelName: "auth_users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "auth_sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    modelName: "auth_accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "auth_verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env.NODE_ENV === "production",
  },
  emailVerification: {
    sendOnSignUp: process.env.NODE_ENV === "production",
    sendVerificationEmail: async ({ user, url }) => {
      if (process.env.NODE_ENV !== "production") {
        console.log(`[Auth] Verification email for ${user.email}: ${url}`)
        return
      }
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Content Crew <noreply@contentcrewai.com>",
        to: user.email,
        subject: "Verify your email",
        html: `<a href="${url}">Click here to verify your email</a>`,
      })
    },
  },
  plugins: [
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "whsec_mock_dev_key",
      // Only where there is an account to create the customer in. With the
      // placeholder key this hook put two rejected round trips to
      // api.stripe.com in front of every sign-up response and logged a WARN and
      // an ERROR for them, on the happy path of the first thing a user does.
      // The plugin's table schema does not depend on this flag (it turns on
      // with `subscription.enabled`, which nothing here sets), so a database
      // migrated with a key and one migrated without are the same database.
      // `src/lib/stripe-signup.test.ts` is the guard.
      createCustomerOnSignUp: stripeConfigured,
    }),
  ],
})
