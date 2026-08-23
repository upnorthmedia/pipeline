# Deploying to Railway

Two services, one image, one repo. `web` serves the dashboard, the route
handlers and SSE and starts pipeline runs; `worker` consumes the workflow
events off Redis Streams and executes the steps. Both import the same
`web/src/mastra/index.ts`, so a dashboard deploy never kills an in-flight
pipeline.

Everything Railway needs is declared in [`.railway/railway.ts`](../../.railway/railway.ts).

## Why `.railway/railway.ts` and not `railway.json`

Railway's docs state that Config as Code (`railway.json` / `railway.toml`) is
deprecated, that "New services cannot opt into Config as Code", and that
existing files stop being read on **2026-12-01**. Infrastructure as Code
(`.railway/railway.ts`) is the replacement and is the only form a new project
can use. It is also the better fit here: one file describes both services, both
managed databases and the volume, where Config as Code described a single
service and would have needed two files plus a per-service path setting.

The DSL comes from the `railway` npm package (`railway/iac`, verified against
railway@3.10.0). It is not a dependency of `web/`; the Railway CLI evaluates
the file.

## Applying it

```sh
railway login
railway link                 # choose the project and environment
railway config plan          # preview, reads only
railway config apply         # applies after confirmation
```

`railway config plan` redacts variable values by default. `--detailed-exit-code`
makes it exit 2 when changes are pending, which is what a drift check in CI
would use.

## The image

Both services build `web/Dockerfile` with `builder: "DOCKERFILE"`. Railway has
no way to pick a build stage: the `BuildConfig` in this DSL is `builder`,
`watchPatterns`, `buildCommand`, `buildEnvironment`, `dockerfilePath`,
`nixpacks*` and `railpackVersion`, and the deprecated `railway.json` schema had
the same set. A Railway build therefore gets Docker's default target, the last
stage in the file.

That is why `web/Dockerfile`'s last stage is `railway`, which carries both
entry points:

| Service | Start command | Reaches `src/mastra/index.ts` through |
| --- | --- | --- |
| `web` | `node server.js` | the Next standalone server's traced modules |
| `worker` | `node .mastra/worker/index.mjs` | the `mastra worker build` bundle |

`docker-compose.yml` keeps building the narrower `runner` and `worker` targets,
so a local stack does not carry the other service's payload.

Baked into the image, so no deployment needs to set them: `NODE_ENV`,
`NEXT_TELEMETRY_DISABLED`, `HOSTNAME`, `RULES_DIR=/app/rules`,
`MEDIA_DIR=/app/media`, `TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data`.
Railway injects `PORT`; the Next standalone server reads it.

## Environment variables

`preserve()` in `.railway/railway.ts` names a variable without carrying a
value: the compiler drops preserved variables from the desired state, so an
apply never overwrites what is set in Railway and no secret enters git. Set
those once in the dashboard or with `railway variables --set`.

### `web`

| Variable | Value | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL_SYNC` | `${{postgres.DATABASE_URL}}` | yes | Posts and Mastra run state. `src/lib/auth.ts` reads this name directly, so `DATABASE_URL` alone is not enough. |
| `REDIS_URL` | `${{redis.REDIS_URL}}` | yes | Event bus and SSE fan-out. `src/mastra/index.ts` throws at import without it. |
| `WP_ENCRYPTION_KEY` | `preserve()` | yes | The Fernet key the `api_settings` rows were encrypted with, not a fresh secret. A different value decrypts nothing and every stage loses its provider credentials. |
| `BETTER_AUTH_SECRET` | `preserve()` | yes | BetterAuth warns in dev but **throws** under `NODE_ENV=production`, which the image sets, surfacing as an unhandled rejection on the first request. |
| `BETTER_AUTH_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | yes | Callback and verification links are built against it. |
| `NEXT_PUBLIC_APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | yes | Read by `src/lib/auth-client.ts`, so `next build` inlines it. It reaches the image through the `NEXT_PUBLIC_APP_URL` build arg, not the runtime environment: changing it needs a rebuild, and an unset value leaves the browser client pointing at `http://localhost:3000`. |
| `STRIPE_SECRET_KEY` | `preserve()` | for billing | Falls back to a mock key, so the app boots without it. |
| `STRIPE_WEBHOOK_SECRET` | `preserve()` | for billing | Same fallback. |
| `RESEND_API_KEY` | `preserve()` | for email | Same fallback. Verification email is only sent under `NODE_ENV=production`. |
| `EMAIL_FROM` | `preserve()` | no | Defaults to `Content Crew <noreply@contentcrewai.com>` in code. |

### `worker`

| Variable | Value | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL_SYNC` | `${{postgres.DATABASE_URL}}` | yes | Same database as `web`. |
| `REDIS_URL` | `${{redis.REDIS_URL}}` | yes | Same instance as `web`, or the two never meet. |
| `WP_ENCRYPTION_KEY` | `preserve()` | yes | Every stage decrypts its provider key from `api_settings` with it. |

The worker needs no auth, Stripe or email variables: nothing in the bundle
imports `src/lib/auth.ts`.

Provider API keys (Anthropic, Perplexity, Gemini) are **not** environment
variables. They live encrypted in the `api_settings` table and are reached
through the settings UI.

## One-time setup this file cannot do

1. **Generate the `web` service's domain first.** `NEXT_PUBLIC_APP_URL` is
   inlined at build time, so a build that runs before a domain exists produces
   a client pointing at localhost. Generate the domain, then redeploy.
2. **Set the preserved secrets** before the first deploy of `web`.
3. **Create the schema.** Nothing in the deployment runs migrations. Against
   the Postgres service's `DATABASE_PUBLIC_URL`, from a checkout:
   `pnpm -C web db:migrate` (pipeline tables) then `pnpm -C web auth:migrate`
   (BetterAuth tables). The `mastra_*` run-state tables are created by the
   `@mastra/pg` adapter on first boot. See `web/drizzle/README.md`.
4. **Carry the data over.** `WP_ENCRYPTION_KEY` only means something with the
   `api_settings` rows it encrypted.

## Known gaps

- **`/media` is not shared between the services.** The volume is mounted on
  `worker`, which is the process that writes generated images, so the bytes
  survive. `web` serves `/media/<post_id>/<file>` off its own disk and will
  answer 404 for them. Railway's caveat list says "Each service can only have a
  single volume", and the IaC reference says "A volume can be attached to one
  service", so there is no configuration that closes this. The fix is object
  storage: Railway's `bucket()` resource exists in the same DSL, but pointing
  the images stage and the `/media` route at it is a code change, logged in
  `todo.md`. Until then a Railway deployment shows broken images in the
  dashboard even though the pipeline completed.
- **No automated migrations.** `deploy.preDeployCommand` is the documented hook,
  but neither runtime image carries `drizzle-kit` or the `drizzle/` folder, so
  there is nothing to run there yet. Step 3 above is manual.
- **Railway IaC is experimental** by Railway's own documentation, and the
  generated file formatting may change while the DSL is unstable.
- **The worker has no Railway healthcheck.** It serves no HTTP.
  `scripts/worker-healthcheck.mjs` answers the real liveness question (is a
  process consuming the Mastra orchestration group) for compose, and Railway
  has no equivalent hook for a non-HTTP service.
- **Studio is not deployed.** Mastra Studio can trigger runs and read run
  state, so it is never publicly exposed; ledger item 7.3 documents running it
  locally against the same Postgres.
