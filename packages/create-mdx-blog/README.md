# create-mdx-blog

Scaffold a production-ready MDX blog into your Next.js app in under a minute. Optionally connect to [Jena AI](https://jena.ai) for automated content delivery.

## Quick Start

```bash
npx create-mdx-blog
```

The CLI detects your project and walks you through setup.

## What You Get

**Blog routes** (App Router, SSG):
- `/blog` — paginated post listing
- `/blog/[slug]` — individual post with SEO metadata and structured data
- `/blog/category/[category]` — filtered by category
- `/blog/feed.xml` — RSS feed

**Content layer**:
- File-based MDX posts in `content/blog/`
- Frontmatter-driven metadata (title, description, date, category, author, image)
- `getAllPosts()`, `getPostBySlug()`, `getPostsByCategory()` — clean API for your routes

**Components**:
- `PostCard`, `PostLayout`, `Pagination`, `CategoryNav`
- Tailwind classes if your project uses Tailwind, minimal otherwise

**SEO out of the box**:
- `generateMetadata()` with Open Graph and Twitter cards
- JSON-LD structured data (`BlogPosting` schema)
- RSS feed with proper XML escaping
- `generateStaticParams()` for static generation

## Two Modes

### Scaffold Mode

For projects without an existing blog. Creates everything: routes, components, content layer, config, and an example post.

```
npx create-mdx-blog

  create-mdx-blog
  Scaffold a production-ready MDX blog for Next.js

  [+] Next.js 15.5.9 · TypeScript · Tailwind · pnpm

  ? Blog name: My Blog
  ? Posts per page: 10
  ? Enable RSS feed? Yes
  ? Enable category pages? Yes
  ? Connect to Jena AI? No

  + app/blog/page.tsx
  + app/blog/[slug]/page.tsx
  + app/blog/category/[category]/page.tsx
  + app/blog/feed.xml/route.ts
  + lib/blog/content.ts
  + lib/blog/types.ts
  + lib/blog/mdx.ts
  + components/blog/post-card.tsx
  + components/blog/post-layout.tsx
  + components/blog/pagination.tsx
  + components/blog/category-nav.tsx
  + content/blog/welcome.mdx
  + jena.config.ts

  Done!
```

### Connect Mode

For projects that already have a blog. Detects your existing blog structure, infers the frontmatter schema, and adds only the Jena AI webhook integration.

```
npx create-mdx-blog

  [+] Next.js 15.5.9 · TypeScript · Tailwind · pnpm
  [i] Found an existing blog at app/blog/ with 4 posts.

  ? What would you like to do? Connect Jena AI to this blog

  Detected frontmatter schema:
    title: string — e.g. "Shipping Firearms Across State Lines"
    description: string — e.g. "Learn the rules"
    date: string — e.g. "2025-01-15"
    author: string — e.g. "Ship Restrict"
    category: string[] — e.g. ["Compliance", "Firearms"]
    image: string (optional) — e.g. "https://cdn.example.com/img.webp"

  ? Does this look right? Yes

  + app/api/jena-webhook/route.ts
  + jena.config.ts

  Done!
```

## Jena AI Integration (Optional)

[Jena AI](https://jena.ai) generates SEO-optimized blog articles through an AI-powered content pipeline. When connected, completed articles are automatically delivered to your blog via a secure webhook.

**How it works:**
1. Run `npx create-mdx-blog` and choose "Connect to Jena AI"
2. Enter your Jena AI API key
3. A webhook route and secret are generated automatically
4. Add the webhook URL and secret to your Jena AI profile
5. When an article completes, it arrives as an MDX file — commit and push to deploy

**Security:** The webhook handler uses HMAC-SHA256 signature verification, replay prevention (5-minute window), slug sanitization, and directory confinement. Secrets are stored in `.env.local`, never committed.

The blog works fully standalone without Jena AI. Just add `.mdx` files to your content directory.

## Writing Posts

Create `.mdx` files in your content directory (default: `content/blog/`):

```mdx
---
title: "Your Post Title"
description: "A brief description for SEO"
date: "2026-04-09"
category: "Category Name"
author: "Your Name"
image: "/blog/images/your-post/hero.webp"
---

Your markdown content here. MDX lets you use React components too.
```

Commit and push to deploy. Your hosting platform (Vercel, Netlify, etc.) auto-builds on push.

## Configuration

All settings live in `jena.config.ts`:

```typescript
export default {
  blog: {
    contentDir: "content/blog",
    postsPerPage: 10,
    rss: true,
    categories: true,
    siteName: "My Blog",
    siteDescription: "A blog about things that matter",
    siteUrl: "https://example.com",
  },
  images: {
    storage: "local",           // "local" or "jena-cdn"
    localDir: "public/blog/images",
    publicPath: "/blog/images",
  },
};
```

## Requirements

- Next.js 14+ with App Router
- Node.js 18+

## License

MIT
