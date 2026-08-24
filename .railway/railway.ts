/**
 * Railway Infrastructure as Code for the two services this repo deploys.
 *
 * `web` serves the dashboard, the route handlers and SSE, and starts pipeline
 * runs by publishing onto Redis Streams. `worker` consumes those events and
 * executes the workflow steps. Both run the same image and both reach the same
 * `web/src/mastra/index.ts`: `web` through the Next standalone server's traced
 * modules, `worker` through the bundle `mastra worker build` produces. Only the
 * start command differs, which is what keeps a dashboard deploy from killing an
 * in-flight pipeline.
 *
 * Why this file and not `railway.json`: Railway's docs state that Config as
 * Code (`railway.json` / `railway.toml`) is deprecated with a hard cutoff on
 * 2026-12-01 and that "New services cannot opt into Config as Code", so the
 * only form a new project can use is `.railway/railway.ts`. The DSL is the
 * `railway` npm package (verified against railway@3.10.0, published
 * 2026-08-13); the CLI resolves it itself, so it is not a dependency of `web/`.
 *
 * Apply it with the Railway CLI, from the repo root:
 *
 *   railway login && railway link
 *   railway config plan     # preview, reads only
 *   railway config apply    # applies after confirmation
 *
 * See `docs/mastra-port/railway.md` for the environment variable tables, the
 * one-time setup steps this file cannot do, and the known gaps.
 */
import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  redis,
  service,
  volume,
} from "railway/iac"

export default defineRailway(() => {
  // Managed Postgres holds posts *and* Mastra run state, so one backup is
  // internally consistent. Managed Redis is transport only: the workflow event
  // bus and the SSE fan-out.
  const db = postgres("postgres")
  const cache = redis("redis")

  // Generated article images. Mounted on `worker`, which is the process that
  // writes them; see the shared-volume gap in docs/mastra-port/railway.md.
  const media = volume("media", { sizeMB: 5120 })

  /**
   * Both services build the same Dockerfile, and Railway builds Docker's
   * default target because neither this DSL's `BuildConfig` nor the deprecated
   * `railway.json` schema can select a stage. `web/Dockerfile`'s last stage is
   * `railway`, which carries both entry points for exactly that reason.
   */
  const build = {
    builder: "DOCKERFILE" as const,
    dockerfilePath: "web/Dockerfile",
    // `rules/` is baked into the image and is the source of every stage
    // prompt, so a change there has to rebuild both services.
    watchPatterns: ["web/**", "rules/**", ".railway/**"],
  }

  const source = github("upnorthmedia/pipeline", { branch: "master" })

  /**
   * The database migration hook, run by both services before either of them
   * takes traffic. `IntentServiceConfig.preDeployCommand` (railway@3.10.0) is
   * the documented place for it; Railway aborts the deployment if the command
   * exits non-zero, which is what makes a failed migration stop a release
   * rather than start one against the wrong schema.
   *
   * `scripts/predeploy.mjs` is a bundle `pnpm build` writes into the Next
   * standalone output, because the packages it reaches (`better-auth`,
   * `@better-auth/stripe`, `stripe`, `resend`, `@mastra/pg`) are compiled into
   * the server chunks and are not resolvable from a sibling script in the
   * image. It applies the pipeline schema, the BetterAuth tables and the
   * `mastra_*` run-state tables under one advisory lock.
   *
   * On both services, not just `web`: the `mastra_*` DDL is not concurrency
   * safe, so the point is that every process that opens a store finds the
   * tables already there. A hook on `web` alone leaves `worker` starting into
   * the same race it always had. See `docs/polish/evidence/p2.md#p277b-ii`.
   */
  const preDeployCommand = "node scripts/predeploy.mjs"

  /**
   * `preserve()` compiles to `{ type: "preserve" }` and is dropped from the
   * desired state rather than written, so a secret named here is documented
   * without its value ever entering git and without an apply overwriting what
   * is set in Railway. Set these once in the dashboard or with
   * `railway variables --set`.
   *
   * `WP_ENCRYPTION_KEY` is not a fresh secret: it is the Fernet key the
   * `api_settings` rows were encrypted with. A different value decrypts
   * nothing and every stage loses its provider credentials.
   */
  const shared = {
    DATABASE_URL_SYNC: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    WP_ENCRYPTION_KEY: preserve(),
  }

  const web = service("web", {
    source,
    build,
    start: "node server.js",
    preDeployCommand,
    // `/` redirects an unauthenticated request to `/auth/sign-in`, and Railway
    // waits for an HTTP 200 before switching traffic, so the probe needs a path
    // outside the middleware matcher.
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: 1,
    env: {
      ...shared,
      // Required, not optional: `src/lib/auth.ts` throws at import without
      // it, because BetterAuth's own fallback is a constant published in the
      // package. Nothing in the image supplies one.
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      // Read by `src/lib/auth-client.ts`, which means `next build` inlines it:
      // it reaches the image through the `NEXT_PUBLIC_APP_URL` build arg, not
      // through the runtime environment, so changing it needs a rebuild.
      NEXT_PUBLIC_APP_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      RESEND_API_KEY: preserve(),
      EMAIL_FROM: preserve(),
    },
  })

  const worker = service("worker", {
    source,
    build,
    start: "node .mastra/worker/index.mjs",
    preDeployCommand,
    // No healthcheck: the worker serves no HTTP. Its liveness question is
    // whether it is consuming the Mastra orchestration group, which
    // `scripts/worker-healthcheck.mjs` answers for compose and which Railway
    // has no equivalent hook for.
    //
    // One replica, not for throughput but because Railway does not allow
    // replicas on a service with a volume. Mastra's Redis Streams consumer
    // group would distribute steps across more of them if that changes.
    replicas: 1,
    volumeMounts: {
      "/app/media": media,
    },
    env: {
      ...shared,
      // Not for the worker itself, which never imports `src/lib/auth.ts`: for
      // `preDeployCommand`, which does, and which refuses to start without a
      // secret rather than signing anything with better-auth's published
      // fallback. Same value as `web`.
      BETTER_AUTH_SECRET: preserve(),
    },
  })

  return project("jena-ai", {
    resources: [db, cache, web, worker, media],
  })
})
