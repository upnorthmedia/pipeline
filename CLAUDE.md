# CLAUDE.md

Orientation for agents working in this repo. `README.md` is the user-facing document; this
one records the conventions and the traps.

## What this is

One TypeScript codebase (`web/`) that runs as two processes against one Postgres and one
Redis:

| Process | Deployed start command | Responsibility |
| --- | --- | --- |
| `web` | `node server.js` (Next standalone) | Dashboard, route handlers, SSE. Starts runs, never executes a step. |
| `worker` | `node .mastra/worker/index.mjs` | Consumes `workflow.*` events off Redis Streams and executes the steps. |

Locally those are `pnpm -C web dev` and `pnpm -C web worker:build && pnpm -C web worker`.

Both import `web/src/mastra/index.ts`, which registers the workflows and agents, a
`PostgresStore` for run state and a `RedisStreamsPubSub` for transport. Run state and posts
share the `content_pipeline` database; Redis carries only transport and SSE fan-out.

The pipeline is one Mastra workflow, `pipeline`: `pipeline-start`, then `research`, `outline`,
`write`, `edit`, `images`, `ready`, then `pipeline-complete`. Six more workflows are
registered alongside it (`images`, `sitemap-crawl`, `recrawl-check`, `wordpress-publish`,
`nextjs-publish`, `scaffold-check`).

## Where things live

| Path | Contents |
| --- | --- |
| `web/src/mastra/` | Mastra instance, workflows, steps, agents, and the services they call. |
| `web/src/mastra/steps/` | One file per step. Zod `inputSchema`/`outputSchema` on every one. |
| `web/src/app/api/` | Route handlers. `web/src/lib/api.ts` is the client and the shared type home. |
| `web/src/db/` | Drizzle schema plus the parity checks; migrations in `web/drizzle/`. |
| `web/src/lib/auth.ts` | BetterAuth. Owns `/api/auth/*`. Leave it alone unless the task is auth. |
| `rules/` | One prompt rule file per stage. |
| `packages/create-mdx-blog` | Blog scaffolder with a fixed webhook contract against this app. |
| `.railway/railway.ts` | The whole Railway project as code. |
| `docs/mastra-port/` | Port ledger, evidence, and the Studio and Railway docs. |

## Commands

Run from the repo root. `web/next.config.ts` loads the repo-root `.env` at import time, so
nothing here needs sourcing except the Mastra CLI, which has no loader of its own.

```bash
docker compose up -d db redis          # dependencies only
docker compose up                      # the whole stack

pnpm -C web dev                        # dashboard on :3000
pnpm -C web worker:build               # bundle the worker
pnpm -C web worker                     # run it
pnpm -C web studio                     # Mastra Studio on :4111

pnpm -C web db:migrate                 # pipeline tables
pnpm -C web auth:migrate --apply       # BetterAuth tables (prints the DDL without --apply)
```

Gates:

```bash
pnpm -C web exec tsc --noEmit
pnpm -C web lint
pnpm -C web test
pnpm -C web build
pnpm -C web test:e2e                   # needs a dev server on :3000
```

`pnpm -C web tsc --noEmit` does **not** work on pnpm 10: `tsc` is not a script in
`web/package.json`, so pnpm treats `web` as a filter and exits 254. Use the `exec` form.

Known red, both tracked in `todo.md` and by ledger item 9.1, neither caused by the port's
runtime:

- `pnpm -C web test`: 9 failing tests in 2 files (`image-preview.test.tsx`,
  `PostDetail.test.tsx`), all expectation drift against the current UI.
- `pnpm -C web test:e2e`: broadly failing on the same kind of drift, with no recorded baseline.

## Traps

- **Stop the worker and Studio before running the test suite.** Mastra's orchestration topic
  is a Redis Streams consumer group, so each event goes to exactly one consumer. A worker or a
  stray `mastra dev` running next to `pnpm -C web test` takes events the tests are waiting for,
  and the event-driven suites fail with no useful message.
- **No `next/*` imports under `web/src/mastra/`.** The worker and Studio load that graph
  outside Next.js, so one such specifier stops both booting. `no-next-imports.test.ts`
  enforces it.
- **All pipeline logic lives in Mastra primitives** (`createStep`, `Agent`, tools) registered
  on the instance. Studio renders only what is registered, so logic in a route handler or a
  bare helper is invisible there.
- **`rules/*.md` are inputs, not code.** They are the product's prompt IP. Do not rewrite them.
- **Provider API keys are not environment variables.** They live encrypted in the `settings`
  table under key `api_keys` and are decrypted with `WP_ENCRYPTION_KEY`. A different key value
  decrypts nothing.
- **Do not add a second job queue.** A run suspended at a review gate has no representation in
  a job queue, and whole-job retries would re-run and re-bill stages Mastra already memoized.
- **Every route handler scopes by the authenticated user.** Reading another user's post is a
  defect, not a follow-up.
- **The worker bundle runs with its own output directory as the cwd**, so `RULES_DIR`,
  `MEDIA_DIR` and `TEXTSTAT_DATA_DIR` must all be set for it explicitly. Both compose files do.
- **`/media` is one directory shared by both processes locally** (a compose volume). On
  Railway it is not shared; see the gap list in `docs/mastra-port/railway.md`.

## Mastra Studio

```bash
pnpm -C web studio     # MASTRA_WORKERS=false mastra dev --env ../.env, on :4111
```

`MASTRA_WORKERS=false` is what makes Studio an observer: a bare `mastra dev` starts Mastra's
execution workers, joins the orchestration consumer group and steals steps from the real
worker. Studio can trigger runs and read run state, so it is never publicly exposed: no
compose file publishes 4111 and neither Railway service starts it. Full workflow, including
`server.studioBase` for a custom mount path, in
[`docs/mastra-port/studio.md`](docs/mastra-port/studio.md).

## Deployment

Two Railway services from `web/Dockerfile`, differing only by start command, declared in
`.railway/railway.ts`. Per-service environment variables, the one-time setup and the known
gaps are in [`docs/mastra-port/railway.md`](docs/mastra-port/railway.md).

## Conventions

- Conventional Commits. No AI attribution or co-author trailers anywhere.
- No em dashes in code, comments, commit messages or docs.
- Tests hit real boundaries: the real database, the real Redis, and real provider calls behind
  a key check. Do not write tests that only assert on mocks.
- Out-of-scope defects go in `todo.md` tagged `[confirmed]`, `[investigate]` or
  `[optimization]` with the date, not chased inline.
