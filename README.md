# Content Pipeline

A blog content pipeline with a Next.js dashboard. Takes a topic and produces a publication-ready, SEO-optimized blog post through six sequential stages with configurable human review gates.

It is one TypeScript codebase. The pipeline is a single [Mastra](https://mastra.ai) workflow whose steps run in a separate worker process, so deploying the dashboard never kills an in-flight article.

## Architecture

```
                      ┌───────────────┐
      browser  ─────► │    Next.js    │ :3000
                      │     `web`     │  dashboard, route handlers, SSE
                      └───┬───────┬───┘
                          │       │ publishes workflow.* events
                          │       ▼
                          │  ┌──────────┐ :6379
                          │  │  redis   │  event bus and SSE fan-out
                          │  └────┬─────┘
                          │       │ consumes
                          │  ┌────▼─────┐
                          │  │  Mastra  │
                          │  │ `worker` │  executes the workflow steps
                          │  └────┬─────┘
                          ▼       ▼
                      ┌───────────────┐ :5433
                      │  PostgreSQL   │  posts and Mastra run state
                      └───────────────┘
```

Four Docker services: **web** (Next.js dashboard and API routes), **worker** (Mastra workflow
runner), **db** (PostgreSQL 17), **redis** (Redis 7).

`web` and `worker` are the same code: both import `web/src/mastra/index.ts`, which registers
the workflows, the agents, a Postgres storage adapter for run state and a Redis Streams
pub/sub for transport. `web` starts a run by publishing an event and returns immediately;
`worker` consumes it and executes the steps. State lives in Postgres, transport in Redis, so a
single database backup is internally consistent and a restarted `web` leaves a running
pipeline alone.

Each step writes its output to the post row as soon as it completes, so a killed worker
resumes from the last finished stage rather than re-running it.

## Pipeline Stages

One workflow, `pipeline`, of eight steps: `pipeline-start`, the six stages below, and
`pipeline-complete`.

| Stage | Provider | Default model | Description |
|-------|----------|---------------|-------------|
| **Research** | Perplexity | `sonar-pro` | Keyword research, competitor analysis, audience pain points, search intent |
| **Outline** | Anthropic | `claude-opus-5` | Title options, section structure, word count distribution, SEO checklist |
| **Write** | Anthropic | `claude-opus-5` | Full draft with conversational tone, bucket brigades, pattern interrupts |
| **Edit** | Anthropic | `claude-opus-5` | SEO optimization, editorial polish, automatic internal link insertion |
| **Images** | Google | `gemini-3-pro-image` | Featured image and content images, generated per prompt with `.foreach()` |
| **Ready** | Anthropic | `claude-opus-5` | Final assembly: publishable article with images inline, new frontmatter |

The prompt for each stage is assembled from `rules/blog-<stage>.md` plus the post and profile
fields. Those files are the product's prompt IP; they are inputs, not code.

Model and reasoning effort are configurable per stage and per user on the settings page,
validated against an allowlist of verified model IDs. Provider API keys are stored encrypted
in the database, not in environment variables.

Each stage has a configurable gate mode: **auto** (runs immediately), **review** (suspends the
workflow for human approval), or **approve_only**. A suspended run is parked in Mastra's
storage and resumed from the dashboard. Pipelines auto-start on post creation and auto-resume
after approval through the remaining auto stages.

## Features

- **Automatic pipeline execution** with durable, resumable runs
- **Website profiles** with automatic sitemap crawling and scheduled re-crawls
- **Internal link database** for automatic link insertion during editing
- **Configurable review gates** per stage: auto, review, or approve-only
- **Batch processing** for multiple posts
- **Real-time SSE updates** replayed from Redis, so a browser refresh mid-run keeps the trace
- **Persistent execution logs** stored in the database
- **Content analytics**: readability scores, SEO analysis, keyword density
- **Export**: Markdown, WordPress Gutenberg HTML, or ZIP
- **Publishing**: WordPress, or a Next.js blog scaffolded by `packages/create-mdx-blog`
- **Cost and token tracking** per post and per stage
- **Dead letter queue** for failed runs with retry support

## Quick Start

**Prerequisites:** Docker and Docker Compose.

```bash
git clone https://github.com/upnorthmedia/pipeline.git
cd pipeline

cp .env.example .env
# Fill in DATABASE_URL_SYNC, REDIS_URL, WP_ENCRYPTION_KEY and BETTER_AUTH_SECRET

docker compose up
```

The dashboard is at `http://localhost:3000`. There is no second origin: the route handlers
are part of the same Next.js app.

Postgres binds host port `5433` and Redis `6379` by default. If another project already owns
either port, set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` and update
`DATABASE_URL_SYNC` and `REDIS_URL` to match. The container-internal ports (`db:5432`,
`redis:6379`) never change.

## Development

Requires [pnpm](https://pnpm.io/) 10 (pinned by `packageManager` in `web/package.json`)
and Node 22 or newer; the runtime images are `node:22-alpine`. The database and Redis can
come from compose while the app runs on the host:

```bash
docker compose up -d db redis

pnpm -C web install
pnpm -C web dev                                  # dashboard on :3000
pnpm -C web worker:build && pnpm -C web worker    # workflow runner
```

`web/next.config.ts` loads the repo-root `.env` at import time, so `pnpm -C web dev` needs no
sourcing. The Mastra CLI has no such loader, which is why the `studio` script passes
`--env ../.env`.

### Database

Both migration runners target `DATABASE_URL_SYNC`, and neither runs automatically on deploy.

```bash
pnpm -C web db:migrate               # pipeline tables (drizzle-kit, web/drizzle/)
pnpm -C web auth:migrate --apply     # BetterAuth tables
```

`auth:migrate` prints the DDL and exits without `--apply`. Both are idempotent.

Mastra's `mastra_*` run-state tables are created by the storage adapter on first boot. See
`web/drizzle/README.md` for the full fresh-database procedure.

### Mastra Studio

```bash
pnpm -C web studio             # :4111, alongside `pnpm -C web dev`
```

Studio lists the workflows, their steps and recent runs, and can trigger runs, so it is never
publicly exposed. The script sets `MASTRA_WORKERS=false` so Studio observes rather than
competing with the real worker for steps. See [`docs/mastra-port/studio.md`](docs/mastra-port/studio.md).

### Running Tests

```bash
pnpm -C web test               # vitest, against the real database and Redis
pnpm -C web exec tsc --noEmit  # typecheck
pnpm -C web lint               # eslint
pnpm -C web build              # next build
```

Tests hit real boundaries: the `content_pipeline` database, the Redis event bus, and, where a
key is present in `.env`, the live provider APIs. Stop any locally running `worker` first: it
joins the same Redis Streams consumer group as the tests and each event is delivered to
exactly one consumer.

## Deployment

Two Railway services, `web` and `worker`, built from the same `web/Dockerfile` and separated
only by start command, plus managed Postgres and Redis. The whole project is declared in
[`.railway/railway.ts`](.railway/railway.ts); per-service environment variables, the one-time
setup and the known gaps are in [`docs/mastra-port/railway.md`](docs/mastra-port/railway.md).

`docker-compose.prod.yml` runs the same two images locally.

## Tech Stack

**Runtime:** TypeScript, Node 24, Next.js 16, React 19

**Pipeline:** Mastra (`@mastra/core`, `@mastra/pg`, `@mastra/redis-streams`), Zod

**Data:** PostgreSQL 17, Drizzle ORM, Redis 7, BetterAuth

**UI:** Tailwind CSS v4, shadcn/ui

**LLM Providers:** Anthropic Claude, Perplexity, Google Gemini

**Infrastructure:** Docker Compose, Railway, pnpm

## Environment Variables

`.env.example` is the reference: it lists every variable the app reads, which are required,
and which are only read by tests. Copy it to `.env`. Compose overrides the database and Redis
URLs internally to use service hostnames.

## Repository Layout

| Path | Contents |
|------|----------|
| `web/src/mastra/` | Mastra instance, workflows, steps, agents. All pipeline logic lives here. |
| `web/src/app/api/` | Route handlers. |
| `web/src/app/` | Dashboard pages. |
| `web/src/db/` | Drizzle schema and parity checks; `web/drizzle/` holds the migrations. |
| `rules/` | One prompt rule file per stage. |
| `packages/create-mdx-blog` | CLI that scaffolds a Next.js blog and connects it to this app's publishing webhook. |
| `docs/mastra-port/` | Port ledger, evidence, deployment and Studio docs. |

## License

MIT
