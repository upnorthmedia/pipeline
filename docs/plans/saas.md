# SaaS Conversion Plan — Content Crew

## Overview

Converting Content Crew from a single-tenant content pipeline dashboard into a multi-tenant SaaS. Users sign up, get isolated workspaces, and subscribe to paid plans that include a set number of articles per month.

**Stack decisions:**
- **Auth:** BetterAuth (TypeScript) in Next.js, FastAPI validates sessions via shared DB
- **Email:** Resend for transactional emails (verification, password reset)
- **Billing:** Stripe subscriptions via BetterAuth's Stripe plugin
- **Hosting:** Railway (PostgreSQL, Redis, API, Worker, Web as separate services)
- **Media:** Cloudflare R2 (S3-compatible, replaces local filesystem)
- **Tenancy:** Single user per account, no orgs/teams
- **API Keys:** Platform-owned — users never see or manage LLM keys. Plans include X articles/month.

**Domain:** `contentcrewai.com`
- App: `app.contentcrewai.com`
- API: `api.contentcrewai.com`
- Media: `media.contentcrewai.com`

## Architecture

```
Browser
  |
  v
Next.js (BetterAuth + better-auth-ui)
  |  auth routes: /api/auth/[...all] (runtime: nodejs)
  |  session cookie: better-auth.session_token (format: token.signature)
  |  middleware: lightweight cookie existence check → redirect to /auth/sign-in
  |
  v (cookie forwarded via credentials: "include")
FastAPI (validates session via DB query on auth_sessions table)
  |  get_current_user dependency reads session cookie → splits token.signature → queries DB
  |  all queries scoped by user_id
  |
  v
PostgreSQL (shared)
  ├── BetterAuth tables: auth_users, auth_sessions, auth_accounts, auth_verifications, auth_subscriptions
  │   └── Created via direct SQL (BetterAuth CLI doesn't work with pnpm + pg adapter)
  ├── BetterAuth Stripe: auth_subscriptions table (managed by plugin)
  └── App tables: posts, website_profiles, internal_links, settings
      └── website_profiles.user_id FK → auth_users.id (tenant isolation root)
      └── settings.user_id FK → auth_users.id (per-user config)

Redis (ARQ jobs + SSE pub/sub)
Cloudflare R2 (generated images)
Stripe (subscription management)
Resend (email delivery)
```

**Key pattern:** Posts and links inherit tenant isolation through `profile_id` FK → `website_profiles.user_id`. No `user_id` needed directly on posts.

**Billing model:** Users pay for a plan (Free, Pro, etc.) that grants X articles/month. All LLM API keys are platform-owned and managed — users never interact with API keys. The settings page no longer exposes API key management to end users. API keys are set as environment variables on the platform side.

---

## Completed Work

### Phase 1: Auth Layer (Next.js) ✅

BetterAuth installed and configured in the Next.js app with pre-built shadcn/ui auth pages.

**Packages installed** (`web/package.json`):
- `better-auth` — core auth
- `@better-auth/stripe` — Stripe subscription plugin
- `@daveyplate/better-auth-ui` — pre-built sign-in/sign-up/forgot-password shadcn/ui components
- `resend` — transactional email SDK
- `stripe` — Stripe SDK
- `pg` — PostgreSQL driver (required by BetterAuth's kysely adapter)

**Files created:**

| File | Purpose |
|------|---------|
| `web/src/lib/auth.ts` | BetterAuth server config. Uses `pg.Pool` directly (not `{ url, type }` — the kysely adapter requires a Pool instance). Email/password auth, Resend integration (disabled in dev), Stripe plugin with mock fallback keys. All table/column names mapped to snake_case. |
| `web/src/lib/auth-client.ts` | Client-side `createAuthClient()` pointing at `NEXT_PUBLIC_APP_URL`. |
| `web/src/app/api/auth/[...all]/route.ts` | Catch-all route handler with `export const runtime = "nodejs"` (required — BetterAuth uses `pg` which can't run in Edge). |
| `web/src/app/auth/[path]/page.tsx` | Dynamic auth pages using `AuthView` from `@daveyplate/better-auth-ui`. Generates static params for all auth paths. |
| `web/src/app/auth/layout.tsx` | Full-screen overlay layout (`fixed inset-0 z-50`) so auth pages hide the dashboard sidebar. |
| `web/src/middleware.ts` | Lightweight cookie existence check only — redirects to `/auth/sign-in` if no `better-auth.session_token` cookie. Does NOT import `auth.ts` or `pg` (middleware can't use Node.js modules even with deprecated status in Next.js 16). |
| `web/.npmrc` | Added `public-hoist-pattern` for `react` and `react-dom` to fix pnpm hoisting issues with `better-auth/react`. |
| `web/.env` | Symlink → `../../.env` (root). Next.js only loads `.env` from its working directory, not the monorepo root. |

**Files modified:**

| File | Change |
|------|--------|
| `web/next.config.ts` | Added `serverExternalPackages: ['better-auth', 'pg']` |
| `web/src/components/providers.tsx` | `AuthUIProvider` loaded via `dynamic()` with `ssr: false` to fix React hooks error during SSR (better-auth/react's `useSession` calls `useRef` which fails during server render). |
| `web/src/lib/api.ts` | Added `credentials: "include"` to the `fetch()` wrapper so the session cookie is forwarded to FastAPI |

**Dev environment notes:**
- Email verification disabled in dev (`requireEmailVerification: process.env.NODE_ENV === "production"`)
- Verification emails logged to console in dev instead of sent via Resend
- Stripe/Resend use mock fallback keys when env vars aren't set
- `BETTER_AUTH_SECRET` generated and stored in root `.env`
- `BETTER_AUTH_URL=http://localhost:3000` and `NEXT_PUBLIC_APP_URL=http://localhost:3000` in `.env`

**Gotchas discovered:**
- BetterAuth's `{ url, type }` database config does NOT work — the kysely adapter only recognizes Pool/dialect instances, not URL strings. Must pass `new Pool({ connectionString })` directly.
- `@better-auth/cli migrate` fails with pnpm + pg adapter (can't resolve config). Auth tables must be created via direct SQL instead (see Database Setup below).
- Next.js 16 deprecated `middleware.ts` in favor of `proxy.ts` (warning only — middleware still runs but may be removed in future versions).
- The auth API route MUST have `export const runtime = "nodejs"` — without it, Next.js tries to run it in Edge where `pg` is unavailable.

### Phase 2: FastAPI Session Validation ✅

FastAPI validates BetterAuth sessions by querying the shared PostgreSQL database directly — no HTTP calls to Next.js, no JWT verification library needed.

**How it works:**
1. Browser sends `better-auth.session_token` cookie (or `__Secure-better-auth.session_token` in production)
2. FastAPI reads cookie from request
3. Splits cookie value on `.` to extract token (cookie format is `token.signature`)
4. Queries `auth_sessions` table: find session where `token` matches AND `expires_at > now()`
5. Joins to `auth_users` to get user info
6. Returns `AuthUser` object or raises 401

**Files created:**

| File | Purpose |
|------|---------|
| `api/src/models/auth.py` | Read-only SQLAlchemy models for `auth_users` and `auth_sessions` tables. These tables are managed by BetterAuth (via SQL), NOT by Alembic. |
| `api/src/api/auth.py` | `get_current_user()` FastAPI dependency. Reads session cookie, extracts token from `token.signature` format, queries DB, returns `AuthUser` or 401. |

**Files modified:**

| File | Change |
|------|--------|
| `api/src/models/__init__.py` | Added `AuthUser`, `AuthSession` exports |
| `api/alembic/env.py` | Added `include_object` filter to exclude BetterAuth tables (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`) from Alembic autogenerate |

**Gotcha:** BetterAuth session cookie format is `token.signature` (URL-encoded). The FastAPI auth dependency must split on `.` and use only the first part to match against the `auth_sessions.token` column. Without this, every session lookup fails.

### Phase 3: Multi-Tenancy ✅

All API routes now require authentication and scope data by user.

**Model changes:**

| File | Change |
|------|--------|
| `api/src/models/profile.py` | Added `user_id: Mapped[str]` with FK to `auth_users.id` and index |
| `api/src/models/setting.py` | Added `user_id: Mapped[str \| None]` with FK to `auth_users.id` and index |

**Migration:**

| File | Purpose |
|------|---------|
| `api/alembic/versions/010_add_user_id_multi_tenancy.py` | Adds `user_id` column (nullable) + index to `website_profiles` and `settings`. FK constraints are NOT added in migration because BetterAuth tables may not exist yet — enforced at application level. |

**API route changes (all files in `api/src/api/`):**

Every endpoint now includes `user: AuthUser = Depends(get_current_user)` and scopes queries by user ownership.

| File | Scoping approach |
|------|-----------------|
| `profiles.py` | Direct `WHERE user_id = user.id`. Added `_get_user_profile()` helper. Create sets `user_id=user.id`. |
| `posts.py` | JOIN through `WebsiteProfile` to verify ownership. Added `_get_user_post()` helper. Create verifies profile ownership. |
| `links.py` | Profile ownership check via `_get_profile_or_404(profile_id, user, session)`. |
| `settings.py` | `WHERE user_id = user.id` on all queries. Create sets `user_id=user.id`. |
| `queue.py` | JOIN through `WebsiteProfile` on all post queries. |
| `wordpress.py` | Profile ownership check via `_get_user_profile()`. |
| `analytics.py` | All ORM queries add `.where(WebsiteProfile.user_id == user.id)`. All raw SQL queries add `JOIN website_profiles wp ON p.profile_id = wp.id WHERE wp.user_id = :user_id`. |

**Not yet auth-protected:**
- `api/src/api/events.py` — SSE endpoints (see remaining work)
- `api/src/api/rules.py` — Global rule templates (intentionally shared across all users)

### Database Setup ✅

BetterAuth tables created via direct SQL (the CLI `npx @better-auth/cli migrate` doesn't work with pnpm + pg adapter).

**Tables created:**

| Table | Key Columns |
|-------|-------------|
| `auth_users` | `id TEXT PK`, `name`, `email UNIQUE`, `email_verified BOOLEAN`, `image`, `created_at`, `updated_at`, `stripe_customer_id` |
| `auth_sessions` | `id TEXT PK`, `expires_at`, `token UNIQUE`, `ip_address`, `user_agent`, `user_id FK → auth_users` |
| `auth_accounts` | `id TEXT PK`, `account_id`, `provider_id`, `user_id FK → auth_users`, `access_token`, `refresh_token`, `id_token`, `scope`, `password` |
| `auth_verifications` | `id TEXT PK`, `identifier`, `value`, `expires_at` |
| `auth_subscriptions` | `id TEXT PK`, `plan`, `reference_id`, `stripe_customer_id`, `stripe_subscription_id`, `status`, `period_start`, `period_end`, etc. |

All `id` columns are `TEXT` (BetterAuth generates string IDs, not UUIDs). All timestamps use `TIMESTAMP` (no timezone — matches BetterAuth's default). Indexes on `user_id` columns and `auth_verifications.identifier`.

**Data migration:** Existing profiles and settings assigned to the first user via `UPDATE website_profiles SET user_id = '<user_id>'`.

### Dev Environment Setup ✅

**Local development** runs Next.js outside Docker (`pnpm dev` from `web/`), while DB and Redis run in Docker.

**Why:** The Docker web container bakes `node_modules` and config files into the image at build time. Local changes to `next.config.ts`, `package.json`, or new packages (like `pg`) aren't reflected without rebuilding. For active development, running the Next.js dev server locally is faster and more reliable.

**Setup steps:**
1. Ensure DB and Redis are running: `docker-compose up db redis`
2. Stop the Docker web container: `docker-compose stop web`
3. Root `.env` is symlinked to `web/.env` (Next.js only loads env from its own directory)
4. Run `pnpm dev` from `web/`

**Required `.env` additions for auth:**
```env
BETTER_AUTH_SECRET=<random 32-byte base64 string>
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Remaining Work

### Phase 4: Remove Per-User API Key Management

**Context:** The old single-tenant app let the user configure their own LLM API keys (Anthropic, Perplexity, Gemini) via the settings page. In the SaaS model, all LLM keys are platform-owned — set as environment variables, never exposed to users. Users pay for a plan that includes X articles/month.

**What to change:**

1. **Remove API key UI from settings page:**
   - File: `web/src/app/settings/page.tsx`
   - Remove the API keys section entirely. Users should only see general settings (rules editor, etc.)

2. **Remove API key endpoints from the API:**
   - File: `api/src/api/settings.py`
   - Remove or gate behind admin: `GET /api/settings/api-keys`, `GET /api/settings/api-keys/{provider}/reveal`, `PUT /api/settings/api-keys`
   - These were for users to manage their own keys — no longer needed

3. **Simplify worker API key loading:**
   - File: `api/src/worker.py`
   - Stop loading keys from the `settings` table per-user
   - Load keys from environment variables only (platform-managed)
   - Look for the function that loads API keys (currently reads from DB with env fallback) and simplify to env-only

4. **Remove API key client code:**
   - File: `web/src/lib/api.ts`
   - Remove the `apiKeys` object (the `get`, `reveal`, `update` functions)
   - File: `web/src/app/settings/SettingsPage.test.tsx` — update tests

5. **Clean up related services:**
   - Files: `api/src/services/api_keys.py`, `api/src/services/api_key_validator.py`
   - These can be deleted or simplified to just read env vars

### Phase 5: SSE Authentication

**Context:** `api/src/api/events.py` has two SSE endpoints that stream pipeline updates via Redis pub/sub. They currently have no auth.

**Challenge:** SSE uses `EventSource` in the browser, which doesn't support custom headers. The session cookie must be read from the request.

**File:** `api/src/api/events.py`

**Steps:**
1. Add `get_current_user` dependency to both `post_events()` and `global_events()` endpoints
2. For `post_events`, verify the user owns the post (join through profile)
3. For `global_events`, filter published events to only include the user's posts (requires checking `post_id` in each event against user's posts, or use user-specific Redis channels like `pipeline:user:{user_id}`)

**Recommended approach:** Use user-specific Redis channels. When the worker publishes events, also publish to `pipeline:user:{user_id}`. The global SSE endpoint subscribes to the user-specific channel instead of the global one.

### Phase 6: Billing & Plan Limits

**Context:** BetterAuth's Stripe plugin auto-creates a Stripe customer on signup and manages subscriptions via webhooks. Users pay for a plan that includes a set number of articles per month. No API key management needed — all LLM costs are absorbed by the platform.

**Steps:**

1. **Stripe dashboard setup:**
   - Create Product: "Starter" (price: $X/month, includes Y articles/month, Z profiles)
   - Create Product: "Pro" (price: $X/month, more articles, more profiles)
   - Create Product: "Business" (price: $X/month, unlimited or high cap)
   - Configure webhook endpoint: `https://app.contentcrewai.com/api/auth/stripe/webhook` (handled by BetterAuth's catch-all route)
   - Store article limits as Stripe product metadata: `{"article_limit": 10, "profile_limit": 3}`

2. **Create `api/src/api/limits.py`:**
   - Add read-only SQLAlchemy model for BetterAuth's `auth_subscriptions` table
   - Create `check_plan_limits(user, db)` dependency
   - Read the user's subscription → get Stripe product metadata → check article count this month vs limit
   - No subscription or expired = no access (or very limited free tier, e.g., 1 article)
   - Call this dependency in `create_post()`, `batch_create_posts()`, and `create_profile()` endpoints
   - Return clear error message: "Your plan allows X articles/month. You've used Y. Upgrade to create more."

3. **Track article generation count:**
   - Option A: Count posts created this month per user (simple query, already possible)
   - Option B: Dedicated `usage_logs` table for more granular tracking
   - Start with Option A — it's a simple `SELECT COUNT(*) FROM posts JOIN profiles WHERE user_id = ? AND created_at >= start_of_month`

4. **Frontend billing page:**
   - `web/src/app/settings/billing/page.tsx`
   - Show current plan name, articles used this month vs limit, next billing date
   - Upgrade/downgrade buttons using `authClient.stripe.createCheckoutSession()`
   - If no active subscription, show pricing cards with CTA to subscribe

### Phase 7: Cloudflare R2 Media Storage

**Context:** Generated images are currently written to local filesystem (`media/{post_id}/`) and served via FastAPI's `StaticFiles`. This won't work on Railway (ephemeral filesystem) and can't be shared between API and worker services.

**Steps:**

1. **Install boto3:**
   ```bash
   cd api && uv add boto3
   ```

2. **Add R2 config to `api/src/config.py`:**
   ```python
   r2_account_id: str = ""
   r2_access_key: str = ""
   r2_secret_key: str = ""
   r2_bucket: str = "contentcrew-media"
   r2_public_url: str = ""  # https://media.contentcrewai.com
   ```

3. **Create `api/src/services/storage.py`:**
   - `R2Storage` class with `upload(key, data, content_type) -> url` method
   - Uses boto3 S3 client with R2 endpoint
   - Key format: `{user_id}/{post_id}/{filename}`

4. **Modify `api/src/pipeline/stages/images.py`:**
   - Replace `Path(media_dir) / post_id` filesystem writes with `R2Storage.upload()`
   - Store full R2 URLs in `image_manifest` instead of relative paths
   - Current code: look for `_save_image()` or direct file writes around lines 114-177

5. **Modify `api/src/main.py`:**
   - Remove the `StaticFiles` mount (lines 58-60)

6. **Update export endpoint** in `api/src/api/posts.py`:
   - `export_all()` currently reads images from local filesystem
   - Change to download from R2 URLs and zip them

### Phase 8: CORS & Cookie Configuration

**Context:** For production deployment, the API and web app will be on different subdomains (`api.contentcrewai.com` and `app.contentcrewai.com`). The session cookie must be sent cross-subdomain.

**Steps:**

1. **`api/src/config.py`:**
   - Change `cors_origin: str` to `cors_origins: list[str]` to support multiple origins (dev + prod)

2. **`api/src/main.py`:**
   - Update CORS middleware to use `cors_origins` list
   - Ensure `allow_credentials=True` is set (already is)

3. **`web/src/lib/auth.ts`:**
   - Add cookie config to BetterAuth:
     ```ts
     advanced: {
       cookiePrefix: "contentcrew",
       crossSubDomainCookies: {
         enabled: true,
         domain: ".contentcrewai.com",
       },
     },
     ```

4. **`api/src/api/auth.py`:**
   - Update cookie names to match the configured prefix (e.g., `contentcrew.session_token` instead of `better-auth.session_token`)

### Phase 9: Railway Deployment

**Context:** Railway organizes services in a project. Each service runs its own container. PostgreSQL and Redis are managed plugins.

**Infrastructure layout:**
```
Railway Project: "content-crew"
├── PostgreSQL (plugin)          # Shared by all services
├── Redis (plugin)               # Shared by API + Worker
├── api (service)                # Root: /api, port 8000
│   ├── Public domain: api.contentcrewai.com
│   ├── Deploy command: alembic upgrade head
│   └── Start: uvicorn src.main:app --host 0.0.0.0 --port 8000
├── worker (service)             # Root: /api, no public domain
│   └── Start: python -m src.worker
└── web (service)                # Root: /web, port 3000
    └── Public domain: app.contentcrewai.com
```

**Steps:**

1. **DATABASE_URL transform** — add to `api/src/config.py`:
   ```python
   @property
   def database_url_async(self) -> str:
       # Railway provides postgresql://, we need postgresql+asyncpg://
       return self.database_url.replace("postgresql://", "postgresql+asyncpg://")
   ```

2. **Dockerfiles** — ensure `api/Dockerfile` copies `rules/` directory into the image

3. **Railway setup:**
   - Create project, add PostgreSQL + Redis plugins
   - Create 3 services pointing at the GitHub repo
   - Set root directories: `api/` for api+worker, `web/` for web
   - Configure start commands per service (in dashboard, not in code)
   - Set deploy command for api: `alembic upgrade head`

4. **Environment variables** — set in Railway dashboard:
   - Shared: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `WP_ENCRYPTION_KEY`
   - api+worker: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`
   - web: `DATABASE_URL_SYNC=${{Postgres.DATABASE_URL}}`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`
   - api: `CORS_ORIGINS=https://app.contentcrewai.com`
   - api+worker: `R2_*` credentials

5. **BetterAuth tables** — create via direct SQL after PostgreSQL is available (CLI doesn't work, see gotchas above)

6. **Cloudflare R2 setup:**
   - Create R2 bucket in Cloudflare dashboard
   - Enable public access or set up custom domain (`media.contentcrewai.com`)
   - Generate API tokens for boto3

### Phase 10: Test Updates

**Context:** Existing tests don't mock the auth dependency. Every API test will fail with 401 after these changes.

**Steps:**

1. **Create test auth helper** in `api/tests/conftest.py`:
   ```python
   from src.api.auth import get_current_user
   from src.models.auth import AuthUser

   @pytest.fixture
   def test_user():
       return AuthUser(
           id="test-user-id",
           name="Test User",
           email="test@example.com",
           email_verified=True,
           created_at=datetime.now(UTC),
           updated_at=datetime.now(UTC),
       )

   @pytest.fixture
   def auth_app(app, test_user):
       app.dependency_overrides[get_current_user] = lambda: test_user
       yield app
       app.dependency_overrides.clear()
   ```

2. **Update all test files** to use `auth_app` fixture instead of `app`

3. **Update test data** — ensure test profiles have `user_id="test-user-id"` set

4. **Frontend tests** — mock the `AuthUIProvider` in `web/src/test/render.tsx`

### Phase 11: Middleware Migration (Next.js 16)

**Context:** Next.js 16 deprecated `middleware.ts` in favor of `proxy.ts`. Currently middleware still runs but logs a deprecation warning. It may be removed in a future Next.js release.

**Current state:** `middleware.ts` does a lightweight cookie existence check (no DB call). This works for now.

**When to migrate:** When Next.js removes middleware support entirely, or when upgrading to a version that breaks it. Convert to either:
- `proxy.ts` (Next.js 16 replacement)
- Server-side auth checks in layouts/pages using `auth.api.getSession()` with `cookies()` from `next/headers`

---

## Estimated Cost (Railway)

| Service | vCPU | RAM | Est. Cost/mo |
|---------|------|-----|-------------|
| API | 0.5 | 512MB | ~$15 |
| Worker | 0.5 | 512MB | ~$15 |
| Web | 0.25 | 256MB | ~$8 |
| PostgreSQL | 0.25 | 256MB + 1GB | ~$8 |
| Redis | 0.25 | 128MB | ~$4 |
| **Total** | | | **~$50/mo** |

Railway Pro plan includes $20/mo credits, bringing actual cost to ~$30/mo.

## Key Environment Variables Reference

```env
# Database (Railway provides this)
DATABASE_URL=postgresql+asyncpg://...
DATABASE_URL_SYNC=postgresql://...    # Required by BetterAuth (no asyncpg prefix)

# Auth
BETTER_AUTH_SECRET=<random 32+ char string>
BETTER_AUTH_URL=https://app.contentcrewai.com

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Email
RESEND_API_KEY=re_...
EMAIL_FROM=Content Crew <noreply@contentcrewai.com>

# R2 Storage
R2_ACCOUNT_ID=...
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=contentcrew-media
R2_PUBLIC_URL=https://media.contentcrewai.com

# LLM Keys (platform-owned, NOT exposed to users)
ANTHROPIC_API_KEY=sk-ant-...
PERPLEXITY_API_KEY=pplx-...
GEMINI_API_KEY=...

# App
NEXT_PUBLIC_APP_URL=https://app.contentcrewai.com
NEXT_PUBLIC_API_URL=https://api.contentcrewai.com
CORS_ORIGINS=https://app.contentcrewai.com
```
