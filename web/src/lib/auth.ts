import { betterAuth } from "better-auth"
import { stripe } from "@better-auth/stripe"
import Stripe from "stripe"
import { Resend } from "resend"
import { Pool } from "pg"

const resend = new Resend(process.env.RESEND_API_KEY || "re_mock_dev_key")

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock_dev_key")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_SYNC!,
})

export const auth = betterAuth({
  database: pool,
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
      createCustomerOnSignUp: true,
    }),
  ],
})
