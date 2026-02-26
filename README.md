# Content Pipeline

A LangGraph-powered blog content pipeline with a Next.js dashboard. Takes a topic and produces a publication-ready, SEO-optimized blog post through five automated stages with optional human review gates between each stage.

## Architecture

```
                     ┌───────────┐
                     │  Next.js  │ :3000
                     │ Dashboard │
                     └─────┬─────┘
                           │
                     ┌─────▼─────┐
                     │  FastAPI   │ :8000
                     │    API     │
                     └──┬─────┬──┘
                        │     │
                 ┌──────▼┐   ┌▼──────┐
                 │  ARQ   │  │ Postgres│ :5433
                 │ Worker │  │  (DB)   │
                 └───┬────┘  └────────┘
                     │
                 ┌───▼────┐
                 │ Redis  │ :6379
                 └────────┘
```

Five Docker services: **web** (Next.js dashboard), **api** (FastAPI), **worker** (ARQ background jobs), **db** (PostgreSQL 17), **redis** (Redis 7).

## Pipeline Stages

| Stage | LLM | Description |
|-------|-----|-------------|
| **Research** | Perplexity | Keyword research, competitor analysis, audience pain points, search intent |
| **Outline** | Claude | Title options, section structure, word count distribution, SEO checklist |
| **Write** | Claude | Full draft with conversational tone, bucket brigades, pattern interrupts |
| **Edit** | Claude | SEO optimization, editorial polish, automatic link insertion |
| **Images** | Gemini | Featured image and content images from crafted prompts |

Each stage produces a checkpoint file. Stages can run automatically or pause for human review depending on configuration.

## Features

- **Website profiles** with automatic sitemap crawling
- **Internal link database** for automatic link insertion during editing
- **Configurable autonomy** per stage: auto, review, or approve-only
- **Batch processing** for multiple posts
- **Real-time SSE updates** during pipeline execution
- **Content analytics**: readability scores, SEO analysis, keyword density
- **Export**: Markdown, WordPress Gutenberg HTML, or ZIP
- **Cost tracking** per post and per stage
- **Dead letter queue** for failed jobs with retry support

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

**Backend:** Python 3.12, FastAPI, LangGraph, SQLAlchemy, Alembic, ARQ, PostgreSQL 17, Redis 7

**Frontend:** Next.js, React 19, TypeScript, Tailwind CSS v4, shadcn/ui

**LLM Providers:** Anthropic Claude, Perplexity, Google Gemini

**Infrastructure:** Docker Compose, uv, pnpm

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Async PostgreSQL connection string |
| `DATABASE_URL_SYNC` | Sync PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `PERPLEXITY_API_KEY` | Perplexity API key (research stage) |
| `ANTHROPIC_API_KEY` | Anthropic API key (outline, write, edit stages) |
| `GEMINI_API_KEY` | Google Gemini API key (image generation) |
| `WORKER_MAX_JOBS` | Maximum concurrent worker jobs (default: 3) |

Copy `.env.example` to `.env` and fill in your values. Docker Compose overrides database and Redis URLs internally to use service hostnames.

## License

MIT
