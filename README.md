# Content Pipeline

A blog content pipeline with a Next.js dashboard. Takes a topic and produces a publication-ready, SEO-optimized blog post through six sequential stages with configurable human review gates.

## Architecture

```
                     ┌───────────┐
                     │  Next.js  │ :3000
                     │ Dashboard │
                     └─────┬─────┘
                           │ SSE
                     ┌─────▼─────┐
                     │  FastAPI   │ :8000
                     │    API     │
                     └──┬─────┬──┘
                        │     │
                 ┌──────▼┐   ┌▼──────┐
                 │  ARQ   │  │Postgres│ :5433
                 │ Worker │  │  (DB)  │
                 └───┬────┘  └────────┘
                     │
                 ┌───▼────┐
                 │ Redis  │ :6379
                 └────────┘
```

Five Docker services: **web** (Next.js dashboard), **api** (FastAPI), **worker** (ARQ background jobs), **db** (PostgreSQL 17), **redis** (Redis 7).

The worker runs a sequential pipeline — each stage executes a direct function call, saves output to the database immediately (crash-safe), and publishes real-time progress via Redis pub/sub to SSE clients.

## Pipeline Stages

| Stage | LLM | Description |
|-------|-----|-------------|
| **Research** | Perplexity | Keyword research, competitor analysis, audience pain points, search intent |
| **Outline** | Claude | Title options, section structure, word count distribution, SEO checklist |
| **Write** | Claude | Full draft with conversational tone, bucket brigades, pattern interrupts |
| **Edit** | Claude | SEO optimization, editorial polish, automatic internal link insertion |
| **Images** | Gemini | Featured image and content images generated from crafted prompts (parallel, max 3 concurrent) |
| **Ready** | Claude | Final assembly — publishable article with images inline, new frontmatter |

Each stage has a configurable gate mode: **auto** (runs immediately), **review** (pauses for human approval), or **approve_only**. Pipeline auto-starts on post creation and auto-resumes after approval through remaining auto stages.

## Features

- **Automatic pipeline execution** — posts start processing on creation, no manual trigger needed
- **Website profiles** with automatic sitemap crawling and scheduled re-crawls
- **Internal link database** for automatic link insertion during editing
- **Configurable review gates** per stage: auto, review, or approve-only
- **Batch processing** for multiple posts
- **Real-time SSE updates** during pipeline execution
- **Persistent execution logs** — full pipeline timeline stored in DB, survives browser disconnects
- **Content analytics**: readability scores, SEO analysis, keyword density
- **Export**: Markdown, WordPress Gutenberg HTML, or ZIP
- **Cost tracking** per post and per stage
- **Dead letter queue** for failed jobs with retry support (transient vs permanent error discrimination)
- **Worker health monitoring** endpoint

## Quick Start

**Prerequisites:** Docker and Docker Compose.

```bash
git clone https://github.com/your-org/content-pipeline.git
cd content-pipeline

cp .env.example .env
# Fill in your API keys in .env

docker compose up
```

The dashboard is available at `http://localhost:3000` and the API at `http://localhost:8000`.

## Development

### Backend (Python)

Requires [uv](https://docs.astral.sh/uv/).

```bash
cd api
uv sync
uv run uvicorn src.main:app --reload
```

### Frontend (Next.js)

Requires [pnpm](https://pnpm.io/).

```bash
cd web
pnpm install
pnpm dev
```

### Running Tests

```bash
# Backend tests
cd api
uv run pytest

# Frontend unit tests (vitest)
cd web
pnpm test

# Frontend E2E tests (playwright, requires dev server running)
cd web
pnpm test:e2e
```

## Tech Stack

**Backend:** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, ARQ, PostgreSQL 17, Redis 7

**Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui

**LLM Providers:** Anthropic Claude, Perplexity, Google Gemini

**Infrastructure:** Docker Compose, uv, pnpm

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Async PostgreSQL connection string |
| `DATABASE_URL_SYNC` | Sync PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `PERPLEXITY_API_KEY` | Perplexity API key (research stage) |
| `ANTHROPIC_API_KEY` | Anthropic API key (outline, write, edit, ready stages) |
| `GEMINI_API_KEY` | Google Gemini API key (image generation) |
| `WORKER_MAX_JOBS` | Maximum concurrent worker jobs (default: 3) |

Copy `.env.example` to `.env` and fill in your values. Docker Compose overrides database and Redis URLs internally to use service hostnames.

## License

MIT
