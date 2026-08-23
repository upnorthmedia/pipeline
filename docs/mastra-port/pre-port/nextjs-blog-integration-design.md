# Next.js Blog Integration — Design Spec

## Overview

A two-part integration between Jena AI and Next.js applications:

1. **`create-mdx-blog`** — an npm CLI package (`npx create-mdx-blog`) that either scaffolds a complete MDX blog system into an existing Next.js app, or connects Jena AI to an existing blog
2. **Jena AI webhook publishing** — server-side changes to the Jena AI platform that deliver completed articles to connected Next.js blogs via webhook

The blog is a standalone product (PLG top-of-funnel). Jena AI is an optional content source, not a runtime dependency.

## Actors

| Actor | Role |
|-------|------|
| `create-mdx-blog` CLI | Scaffolds blog or connects to existing one. Runs once during setup. |
| User's Next.js app | Hosts the blog. Optionally receives content via webhook. |
| Jena AI platform | Produces content. Pushes via webhook when a post completes. |

## Two Modes

### Scaffold Mode
For repos with no existing blog. Scaffolds routes, components, content layer, config, and optionally the Jena AI webhook route.

### Connect Mode
For repos with an existing blog (e.g., `apsr-pro-main`). Detects the existing blog structure, infers the frontmatter schema from existing posts, confirms with the user, and scaffolds only the Jena AI webhook route + config. Does not touch existing routes, components, or content processing.

---

## Part 1: CLI Package — `create-mdx-blog`

### Package Architecture

Single npm package with internal adapter pattern. Ships as one package, organized behind clean interfaces for future extensibility.

```
create-mdx-blog/
src/
  cli.ts                  # Entry point, argument parsing
  detect.ts               # Project detection
  init/
    scaffold.ts           # Scaffold mode orchestrator
    connect.ts            # Connect mode orchestrator
  prompts/
    setup.ts              # Interactive prompts
  adapters/
    types.ts              # Adapter interfaces
    images/
      local.ts            # Write to public/blog/images/
      jena-cdn.ts         # Jena AI CDN URLs (passthrough)
    delivery/
      webhook.ts          # Webhook handler template generation
    frontmatter/
      canonical.ts        # Default schema for scaffold mode
      detect.ts           # Auto-detect from existing posts
  templates/
    blog/                 # Scaffolded route files
    components/           # BlogLayout, PostCard, Pagination, etc.
    content-layer/        # getAllPosts(), getPostBySlug(), etc.
    config/               # jena.config.ts template
    webhook/              # API route handler template
```

### Adapter Interfaces

Three interfaces that define extension points. V1 implements the minimum; new adapters slot in without touching core code.

```typescript
/** Where images are stored and how URLs are resolved */
interface ImageStorageAdapter {
  name: string;                          // "local" | "jena-cdn"
  resolveUrl(filename: string, slug: string): string;
  setup?(prompts: SetupContext): Promise<EnvVars>;
}

/** How content arrives in the user's project */
interface ContentDeliveryAdapter {
  name: string;                          // "webhook"
  scaffold(ctx: ScaffoldContext): Promise<GeneratedFiles>;
  setup?(prompts: SetupContext): Promise<EnvVars>;
}

/** How Jena AI frontmatter maps to the user's schema */
interface FrontmatterMapper {
  name: string;                          // "canonical" | "detected"
  map(jenaFrontmatter: JenaFrontmatter): Record<string, unknown>;
  detect?(existingPost: string): FrontmatterSchema;
}
```

**V1 adapters:**

| Interface | Adapters |
|-----------|----------|
| ImageStorage | `local` (public/ dir), `jena-cdn` (passthrough URLs) |
| ContentDelivery | `webhook` (API route handler) |
| FrontmatterMapper | `canonical` (scaffold default), `detected` (connect mode) |

**Future adapters (not in scope, but interfaces support):**

| Interface | Future |
|-----------|--------|
| ImageStorage | `s3`, `r2`, `supabase`, `cloudinary` |
| ContentDelivery | `git-push`, `cli-sync`, `api-poll` |
| FrontmatterMapper | `custom` (user-defined transform functions) |

### Init Flow

```
npx create-mdx-blog

1. Detect project context (automatic, no user input):
   - Next.js version + router type (require App Router / Next.js 14+)
   - TypeScript vs JavaScript
   - Package manager (npm, pnpm, yarn)
   - Styling (Tailwind, CSS Modules)
   - UI library (shadcn detection)
   - Existing blog presence (glob for MDX files in app/ or content/)

2. If existing blog detected:
   "Found blog at app/blog/ with 4 MDX posts."
   "Connect Jena AI to this blog, or scaffold a new one?"
     - Connect: infer frontmatter schema, show mapping, user confirms
     - Scaffold: proceed as no blog

3. If scaffold mode:
   - Site name and description
   - Posts per page (default: 10)
   - Enable RSS? (default: yes)
   - Enable categories? (default: yes)

4. "Connect to Jena AI?" (optional):
   - If yes: prompt for API key, validate against Jena AI API
   - Generate webhook secret (32-byte random, base64)
   - Scaffold webhook route
   - Display webhook URL and secret for user to add to Jena AI profile

5. Write files:
   - jena.config.ts at project root
   - Append to .env.local (never overwrite)
   - Install deps if missing (gray-matter, @next/mdx)
   - Print summary of what was created and next steps
```

Fail fast with clear guidance if not Next.js 14+ App Router.

### TUI Design

The interactive setup must be a clean, polished terminal UI:
- Clear progress indicators showing current step / total steps
- Color-coded output (success green, error red, info blue, prompts yellow)
- Good spacing and visual hierarchy
- Formatted summary tables on completion
- Spinner animations for async operations (API key validation, project detection)
- Use `prompts` library (lightweight) not `inquirer`

### Scaffolded Blog System (Scaffold Mode)

**Routes:**

```
app/
  blog/
    page.tsx                    # Paginated post listing
    [slug]/
      page.tsx                  # Individual post (MDX, OG tags, structured data)
    category/
      [category]/
        page.tsx                # Category-filtered listing with pagination
    feed.xml/
      route.ts                  # RSS feed
  api/
    jena-webhook/
      route.ts                  # Webhook receiver (only if Jena AI connected)
```

**Content layer** (`lib/blog/`):

```
lib/blog/
  content.ts          # getAllPosts(), getPostBySlug(), getPostsByCategory(), getCategories()
  types.ts            # Post, PostMeta, FrontmatterSchema types
  mdx.ts              # MDX compilation + custom components registry
```

`content.ts` is ~60-80 lines. Reads MDX files from the configured content directory, parses frontmatter with `gray-matter`, sorts by date, handles pagination. All functions run at build time via `generateStaticParams`. This file is the content adapter boundary — swap it to change the content backend.

**Components** (`components/blog/`):

```
components/blog/
  post-card.tsx        # Card for listing pages
  post-layout.tsx      # Layout wrapper for individual posts
  pagination.tsx       # Page navigation
  category-nav.tsx     # Category filter links
  rss-link.tsx         # RSS icon/link
```

Minimal by default. If Tailwind detected, ships with Tailwind classes. If shadcn detected, uses existing UI primitives (Badge, Card, etc.).

**Config file** (`jena.config.ts`):

```typescript
export default {
  blog: {
    contentDir: "content/blog",
    postsPerPage: 10,
    rss: true,
    categories: true,
    siteName: "My Blog",
    siteDescription: "...",
    siteUrl: "https://example.com",
  },
  jena: {                          // only if connected
    apiKey: process.env.JENA_API_KEY,
    webhookSecret: process.env.JENA_WEBHOOK_SECRET,
  },
  frontmatter: {
    title: "title",
    description: "description",
    date: "date",
    category: "category",
    image: "image",
    author: "author",
  },
  images: {
    storage: "local",              // "local" | "jena-cdn"
    localDir: "public/blog/images",
    publicPath: "/blog/images",
  },
} satisfies JenaConfig;
```

**SEO (every post page):**
- `generateMetadata()` — title, description, image from frontmatter for OG/Twitter tags
- JSON-LD structured data (`BlogPosting` schema)
- Canonical URL
- `generateSitemapEntries()` helper for the user's `app/sitemap.ts`

**SSG by default** — all blog routes use `generateStaticParams`. No SSR, no client-side rendering. Pre-rendered HTML, served from CDN. This is the most SEO-friendly rendering strategy.

**What is NOT scaffolded:**
- No layout/nav changes to the user's existing app
- No global CSS (component-scoped or Tailwind utilities only)
- No database, CMS, or auth
- No analytics or tracking

### Content Directory Convention

**Scaffold mode:** `content/blog/*.mdx` with `public/blog/images/` for local images.

**Connect mode:** detects existing content location. `apsr-pro-main` stores posts colocated with routes (`app/blog/post-slug.mdx`). Other projects may use `content/`, `posts/`, etc. Detection handles this.

### Canonical Frontmatter Schema (Scaffold Mode Default)

```yaml
title: "Post Title"
description: "Meta description for SEO"
date: "2026-04-09"
category: "Category Name"
author: "Author Name"
image: "/blog/images/post-slug/featured.webp"
```

### Connect Mode Frontmatter Mapping

During init, CLI reads existing posts, infers the schema, and shows it for confirmation. Mapping is saved in `jena.config.ts` with optional transforms:

```typescript
frontmatter: {
  title: "title",
  description: "description",
  date: "date",
  category: { key: "category", transform: "array" },    // string -> string[]
  image: { key: "image", transform: "jena-cdn-url" },
  author: { key: "author", default: "Ship Restrict" },
}
```

Transforms handle type mismatches (e.g., Jena AI sends category as string, target expects array).

---

## Part 2: Webhook Integration — Jena AI to User's App

### Webhook Protocol

Single request for all delivery modes. Jena AI reads the profile config to determine how images are referenced.

**Unified payload:**

```json
{
  "event": "post.published",
  "post_id": "uuid",
  "delivery_id": "uuid",
  "slug": "my-blog-post-title",
  "content": "---\ntitle: ...\n---\n\nMarkdown with image references...",
  "images": [
    {
      "filename": "featured.webp",
      "url": "https://cdn.jena.ai/images/{post_id}/featured.webp",
      "download_url": "https://cdn.jena.ai/images/{post_id}/featured.webp?token=signed-temp-token",
      "alt": "Description",
      "placement": "featured"
    }
  ],
  "timestamp": "2026-04-09T12:00:00Z"
}
```

- `url` — permanent Jena AI CDN URL (used as-is in CDN mode)
- `download_url` — temporary signed URL for downloading (used in local mode, expires in 1 hour)

The payload itself is always small (~30KB) regardless of image count — images are URLs, not embedded data.

#### CDN Mode (`images.storage === "jena-cdn"`)

Handler writes MDX as-is. Image URLs in the content already point to Jena AI CDN. Nothing to download.

#### Local Mode (`images.storage === "local"`)

Handler downloads each image from `download_url`, writes to `public/blog/images/{slug}/`, rewrites image URLs in the content from CDN paths to local paths.

**Why single request instead of multi-request:** Serverless platforms (Vercel, Netlify) have ephemeral filesystems per invocation. Multi-request delivery with temp state between requests is unreliable — `publish_start` may hit instance A while `post.image` hits instance B. A single request with URL-based image delivery avoids this entirely while keeping the payload under 1KB per image reference.

### Webhook Handler Logic (~50 lines)

1. Validate HMAC-SHA256 signature (`X-Jena-Signature` header, constant-time comparison)
2. Check timestamp — reject if older than 5 minutes (replay prevention)
3. Sanitize slug — restrict to `[a-z0-9-]`, resolve final path, verify within `contentDir`
4. If local image storage:
   - Download each image from `download_url` (parallel, with timeout)
   - Write to configured image directory (`public/blog/images/{slug}/`)
   - Rewrite image URLs in content from CDN to local paths
5. Write MDX file to content directory
6. Return 200

### Edge Cases

| Edge Case | Handling |
|-----------|---------|
| Image download fails | Handler returns 500 with details of which images failed. Jena AI retries the entire delivery. Partial files cleaned up. |
| Image download timeout | 30-second timeout per image. Total function timeout respected (Vercel: 10s free / 60s Pro). If too many large images for the timeout, CDN mode is recommended. |
| Signed URL expired | URLs valid for 1 hour. If delivery is retried after expiry, Jena AI generates fresh signed URLs. |
| Same slug re-published | MDX file + images overwritten. User sees diff in git. |
| Duplicate delivery (retry) | `delivery_id` logged for idempotency. Same content written = same result. |
| Post with 0 images | No downloads, content written directly. |
| Serverless cold start | Single request = single invocation. No cross-request state needed. |
| Self-hosted (persistent server) | Same flow works — single request is compatible with both serverless and persistent servers. |

### Image Optimization

Images are already optimized during Jena AI's pipeline stage:
- Resized to max 1920px (featured) / 1200px (inline)
- Converted to WebP at quality 82
- No additional optimization at delivery time

### Content Delivery Flow (User Responsibility)

After the webhook writes files, the user commits and pushes to trigger a deploy:

```bash
git add content/blog/my-post.mdx public/blog/images/my-post/
git commit -m "Add blog post: My Post Title"
git push
```

Vercel/Netlify auto-deploys on push. No additional rebuild trigger needed.

Auto-commit via GitHub API is a future content delivery adapter — not in v1.

---

## Part 3: Jena AI Platform Changes

### Database — New Profile Fields

New Alembic migration following the existing `wp_*` field pattern in `api/src/models/profile.py`:

```
nextjs_webhook_url       Text, nullable
nextjs_webhook_secret    Text, nullable (Fernet encrypted, same pattern as wp_app_password)
nextjs_frontmatter_map   JSONB, nullable
```

### Database — New Post Fields

Same migration, following `wp_post_id` / `wp_post_url` / `wp_publish_status` pattern in `api/src/models/post.py`:

```
nextjs_publish_status    String(20), nullable  — "pending" | "publishing" | "published" | "failed"
nextjs_published_at      DateTime(tz), nullable
```

### New Service — `api/src/services/nextjs_publish.py`

Mirrors `api/src/pipeline/publish.py` for WordPress. Async function registered as ARQ job.

**`publish_to_nextjs(post_id)` flow:**
1. Load post + profile from DB
2. Read `ready_content` and `image_manifest`
3. Apply frontmatter mapping from `profile.nextjs_frontmatter_map`
4. Rewrite image URLs from `/media/{post_id}/...` to Jena AI CDN paths
5. Generate temporary signed download URLs for each image (1 hour expiry)
6. Build unified payload with content + image manifest (URLs, not data)
7. Sign payload with HMAC-SHA256 using decrypted `nextjs_webhook_secret`
8. POST to `profile.nextjs_webhook_url`
9. Update `post.nextjs_publish_status` and `nextjs_published_at`
10. Publish SSE event for real-time dashboard feedback
11. On failure: set status to `failed`, log error, allow retry

### Worker Integration

In `worker.py`, same pattern as WordPress auto-publish:

```python
if post.output_format == "nextjs" and profile.nextjs_webhook_url:
    await arq_pool.enqueue_job("publish_to_nextjs", post_id)
```

### API Endpoints — `api/src/api/nextjs.py`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/profiles/{id}/nextjs/test` | POST | Send test webhook to verify connection |
| `/api/posts/{id}/publish/nextjs` | POST | Manual publish trigger |

### Dashboard UI Changes

**Profile edit page** — new section when `output_format == "nextjs"`:
- Webhook URL input
- Webhook secret display (generated server-side, shown once, copy button)
- Frontmatter mapping editor (pre-filled, editable)
- "Test Connection" button

**Post detail page:**
- Next.js publish status badge
- Manual publish / retry button
- Real-time status via existing SSE infrastructure

### Schema Changes

`ProfileCreate` / `ProfileUpdate` / `ProfileRead` gain:
- `nextjs_webhook_url`
- `nextjs_webhook_secret` (write-only in create/update, never returned in read)
- `nextjs_frontmatter_map`

`PostRead` gains:
- `nextjs_publish_status`
- `nextjs_published_at`

---

## Part 4: Security Model

### Webhook Security

| Protection | Implementation |
|------------|---------------|
| Authentication | HMAC-SHA256 signature in `X-Jena-Signature` header. Constant-time comparison. |
| Replay prevention | `timestamp` field in payload. Reject requests older than 5 minutes. |
| Path traversal | Slug sanitized to `[a-z0-9-]` only. Final write path resolved and verified to start with configured `contentDir`. |
| Directory confinement | Absolute path resolution + prefix check. Belt and suspenders with slug sanitization. |
| Payload size | 10MB hard limit enforced in handler. Payloads are ~30KB (URLs, not image data). |
| Rate limiting | In-memory rate limiter in webhook handler (10 requests/minute/IP). |
| Request method | POST only. All other methods return 405. |

### Credential Security

| Protection | Implementation |
|------------|---------------|
| Webhook secret encryption | Fernet symmetric encryption at rest (same pattern as `wp_app_password`). |
| No user cloud credentials | Jena AI hosts images on its own R2. Never stores user S3/R2/Supabase keys. |
| Signed download URLs | Image download URLs expire after 1 hour. Non-guessable tokens. Fresh URLs generated on retry. |
| Secrets in `.env.local` only | CLI writes `JENA_API_KEY` and `JENA_WEBHOOK_SECRET` to `.env.local`, never to committed files. |
| `.gitignore` verification | CLI checks `.env.local` is gitignored during init. Warns and offers to fix if not. |
| No secrets in CLI output | Webhook secret displayed once with copy instructions. Not logged to any file. |
| API key validation | `JENA_API_KEY` validated during init. Revoked keys stop webhook delivery. |

### Content Security

| Protection | Implementation |
|------------|---------------|
| No runtime code execution | MDX compiled at build time (SSG). Malicious MDX can't execute at runtime. |
| Component allowlist | Only explicitly registered MDX components are available. No `dangerouslySetInnerHTML`. |
| Image URL validation | Webhook handler validates image URLs against expected patterns (Jena AI CDN domain or configured local paths). |

### Threat Summary

| Threat | Mitigation |
|--------|-----------|
| Forged webhook | HMAC-SHA256 signature |
| Replay attack | 5-minute timestamp window |
| Path traversal | Slug sanitization + directory confinement |
| DoS (payload size) | 10MB limit, payloads are URLs not image data |
| DoS (volume) | Rate limiting |
| Secret leakage | `.env.local` only + gitignore check |
| Credential exposure | No user cloud creds stored on Jena AI |
| Malicious MDX | Build-time compilation + component allowlist |
| Malicious image URLs | Domain allowlist validation |

---

## Part 5: `apsr-pro-main` Compatibility (Day-One Validation)

Running `npx create-mdx-blog` in the `apsr-pro-main` repo triggers connect mode.

### Detection Results

```
Framework:        Next.js 15.5.9 (App Router)
Language:         TypeScript
Styling:          Tailwind 3.4 + @tailwindcss/typography
Package Manager:  pnpm
UI Library:       shadcn/ui (Radix primitives)
Existing Blog:    Yes — app/blog/ with 4 MDX posts
Content Dir:      app/blog/ (posts colocated with routes)
Image Storage:    AWS S3 + CloudFront (external, not managed by CLI)
MDX Setup:        @next/mdx + gray-matter + remark/rehype plugins
```

### Inferred Frontmatter Schema

```yaml
title:       string
description: string
date:        string (YYYY-MM-DD)
author:      string
category:    string[] (array)
image:       string (CloudFront CDN URL)
```

### Generated Config

```typescript
export default {
  blog: {
    contentDir: "app/blog",
    postsPerPage: 9,
    siteName: "Ship Restrict",
    siteUrl: "https://shiprestrict.com",
  },
  jena: {
    apiKey: process.env.JENA_API_KEY,
    webhookSecret: process.env.JENA_WEBHOOK_SECRET,
  },
  frontmatter: {
    title: "title",
    description: "description",
    date: "date",
    category: { key: "category", transform: "array" },
    image: { key: "image", transform: "jena-cdn-url" },
    author: { key: "author", default: "Ship Restrict" },
  },
  images: {
    storage: "jena-cdn",
  },
} satisfies JenaConfig;
```

### Files Created (Connect Mode Only)

```
app/api/jena-webhook/route.ts    # Webhook handler
jena.config.ts                   # Configuration
.env.local                       # JENA_API_KEY, JENA_WEBHOOK_SECRET (appended)
```

### Not Touched

- No changes to existing blog routes, components, layouts
- No changes to MDX processing pipeline (remark/rehype plugins)
- No changes to S3/CloudFront config
- No changes to admin dashboard or existing webhooks
- No new dependencies (everything needed already present)

---

## Part 6: Testing Strategy

### CLI Tests (`create-mdx-blog`)

- **Detection** — fixture projects with different configs, verify correct identification of framework, router, TS/JS, styling, blog presence
- **Scaffold** — run against minimal Next.js fixture, verify all files created correctly, no existing files modified
- **Connect** — run against `apsr-pro-main`-like fixture, verify only webhook + config created, frontmatter correctly inferred
- **Frontmatter detection** — various MDX shapes, verify inferred schema accuracy
- **Security** — `.env.local` gitignored, secrets never in committed files, slug sanitization rejects traversal

### Webhook Handler Tests (example tests scaffolded with the handler)

- Valid HMAC signature: 200, file written
- Invalid/missing signature: 401, no file written
- Expired timestamp: 401
- Path traversal slug: 400
- Oversized payload: 413
- Duplicate delivery (same slug): overwrites, 200
- CDN mode: content written, no image downloads
- Local mode: images downloaded, URLs rewritten, content written
- Image download failure: 500 with details, partial files cleaned up
- Post with 0 images: content written directly

### Jena AI Platform Tests

- `publish_to_nextjs` unit tests (following `publish_to_wordpress` patterns)
- HMAC signature generation + handler validation roundtrip
- Signed download URL generation and expiry
- Frontmatter mapping transforms
- Delivery retries with fresh signed URLs
- Status tracking lifecycle
- Webhook secret Fernet encryption roundtrip

### Integration Test (E2E)

- Jena AI completes post -> webhook fires -> handler writes MDX -> content valid and renderable

---

## Not In Scope (V1)

- Auto-commit via GitHub API (future content delivery adapter)
- Cloud image storage setup in CLI (S3, R2, Supabase adapters)
- Responsive image variants (multiple sizes)
- Bulk re-publish
- Image migration tooling
- Pages Router support
- Non-GitHub git hosts (GitLab, Bitbucket)
- ISR / on-demand revalidation (SSG + manual deploy for v1)
- `output_format == "nextjs"` auto-selection from CLI (user sets in dashboard)

---

## Dependencies

### `create-mdx-blog` Package

- `prompts` — interactive CLI prompts
- `chalk` — terminal colors and formatting
- `ora` — spinners for async operations
- `gray-matter` — frontmatter parsing (for detection)
- `glob` — file pattern matching (for blog detection)

### Scaffolded Into User's Project (if not already present)

- `gray-matter` — frontmatter parsing at build time
- `@next/mdx` + `@mdx-js/loader` — MDX compilation

### Jena AI Platform (existing dependencies, no new ones)

- `cryptography` (Fernet) — already used for `wp_app_password`
- `httpx` — already available for HTTP requests
- ARQ — already used for job queue
