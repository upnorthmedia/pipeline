# `create-mdx-blog` CLI Package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `create-mdx-blog`, an npm CLI package that scaffolds a complete MDX blog into a Next.js app or connects Jena AI to an existing blog.

**Architecture:** Single TypeScript package with adapter pattern. Core handles detection and orchestration. Adapters handle image storage, content delivery, and frontmatter mapping behind clean interfaces. Templates are plain `.ts`/`.tsx` files with token replacement. TUI uses `prompts` + `chalk` + `ora`.

**Tech Stack:** TypeScript, Node.js, `prompts`, `chalk`, `ora`, `gray-matter`, `glob`, `vitest`

**Spec:** `docs/superpowers/specs/2026-04-09-nextjs-blog-integration-design.md`

---

## File Map

```
packages/create-mdx-blog/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    cli.ts                          # Entry point, argument parsing
    types.ts                        # Shared types (JenaConfig, ProjectContext, etc.)
    detect.ts                       # Project detection engine
    ui.ts                           # TUI helpers (banner, step indicators, formatting)
    init/
      scaffold.ts                   # Scaffold mode orchestrator
      connect.ts                    # Connect mode orchestrator
    prompts/
      setup.ts                      # Interactive prompt sequences
    adapters/
      types.ts                      # Adapter interfaces
      images/
        local.ts                    # Local image storage (public/)
        jena-cdn.ts                 # Jena AI CDN passthrough
      delivery/
        webhook.ts                  # Webhook handler template generator
      frontmatter/
        canonical.ts                # Default frontmatter schema
        detect.ts                   # Auto-detect from existing posts
    templates/
      content-layer/
        content.ts.tmpl             # getAllPosts(), getPostBySlug(), etc.
        types.ts.tmpl               # Post, PostMeta types
        mdx.ts.tmpl                 # MDX compilation setup
      components/
        post-card.tsx.tmpl          # Blog listing card
        post-layout.tsx.tmpl        # Single post layout
        pagination.tsx.tmpl         # Page navigation
        category-nav.tsx.tmpl       # Category filter links
      routes/
        blog-page.tsx.tmpl          # /blog — paginated listing
        blog-slug-page.tsx.tmpl     # /blog/[slug] — individual post
        category-page.tsx.tmpl      # /blog/category/[category]
        feed-route.ts.tmpl          # /blog/feed.xml
      webhook/
        route.ts.tmpl               # /api/jena-webhook handler
      config/
        jena-config.ts.tmpl         # jena.config.ts
      example-post.mdx.tmpl        # Example blog post
  tests/
    fixtures/
      nextjs-minimal/               # Bare Next.js 15 + TS + Tailwind (no blog)
        package.json
        next.config.ts
        tsconfig.json
        app/layout.tsx
      nextjs-with-blog/             # Next.js with existing blog (apsr-pro-main-like)
        package.json
        next.config.ts
        tsconfig.json
        app/blog/
          page.tsx
          example-post.mdx
    detect.test.ts
    frontmatter-detect.test.ts
    scaffold.test.ts
    connect.test.ts
    webhook-template.test.ts
    security.test.ts
```

---

### Task 1: Project Setup

**Files:**
- Create: `packages/create-mdx-blog/package.json`
- Create: `packages/create-mdx-blog/tsconfig.json`
- Create: `packages/create-mdx-blog/vitest.config.ts`
- Create: `packages/create-mdx-blog/src/types.ts`

- [ ] **Step 1: Create package directory**

```bash
mkdir -p packages/create-mdx-blog/src
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "create-mdx-blog",
  "version": "0.1.0",
  "description": "Scaffold a production-ready MDX blog into your Next.js app",
  "type": "module",
  "bin": {
    "create-mdx-blog": "./dist/cli.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "chalk": "^5.4.0",
    "glob": "^11.0.0",
    "gray-matter": "^4.0.3",
    "ora": "^8.1.0",
    "prompts": "^2.4.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/prompts": "^2.4.9",
    "memfs": "^4.17.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=18"
  },
  "keywords": ["nextjs", "blog", "mdx", "scaffold", "cli"],
  "license": "MIT"
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write shared types**

Create `packages/create-mdx-blog/src/types.ts`:

```typescript
export interface ProjectContext {
  /** Absolute path to project root */
  rootDir: string;
  /** Next.js version string (e.g., "15.5.9") */
  nextVersion: string;
  /** Whether project uses TypeScript */
  typescript: boolean;
  /** Detected package manager */
  packageManager: "npm" | "pnpm" | "yarn";
  /** Whether Tailwind CSS is configured */
  tailwind: boolean;
  /** Whether shadcn/ui components are detected */
  shadcn: boolean;
  /** Existing blog info, null if no blog found */
  existingBlog: ExistingBlog | null;
}

export interface ExistingBlog {
  /** Relative path from project root to blog content directory */
  contentDir: string;
  /** Number of MDX/MD posts found */
  postCount: number;
  /** Paths to discovered post files (relative) */
  postPaths: string[];
  /** Inferred frontmatter schema from existing posts */
  frontmatterSchema: FrontmatterSchema | null;
}

export interface FrontmatterSchema {
  /** Map of field name to inferred type info */
  fields: Record<string, FrontmatterFieldInfo>;
}

export interface FrontmatterFieldInfo {
  type: "string" | "string[]" | "number" | "boolean" | "date";
  /** Example value from an existing post */
  example: unknown;
  /** Whether every post has this field */
  required: boolean;
}

export interface FrontmatterMapping {
  [jenaField: string]: string | FrontmatterTransform;
}

export interface FrontmatterTransform {
  key: string;
  transform?: "array" | "jena-cdn-url";
  default?: string;
}

export interface BlogConfig {
  contentDir: string;
  postsPerPage: number;
  rss: boolean;
  categories: boolean;
  siteName: string;
  siteDescription: string;
  siteUrl: string;
}

export interface JenaConfig {
  blog: BlogConfig;
  jena?: {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
  };
  frontmatter: FrontmatterMapping;
  images: {
    storage: "local" | "jena-cdn";
    localDir?: string;
    publicPath?: string;
  };
}

export interface GeneratedFile {
  /** Relative path from project root */
  path: string;
  /** File content */
  content: string;
}

export type EnvVars = Record<string, string>;
```

- [ ] **Step 6: Install dependencies**

```bash
cd packages/create-mdx-blog && pnpm install
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd packages/create-mdx-blog && pnpm lint
```
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/create-mdx-blog/package.json packages/create-mdx-blog/tsconfig.json packages/create-mdx-blog/vitest.config.ts packages/create-mdx-blog/src/types.ts packages/create-mdx-blog/pnpm-lock.yaml
git commit -m "feat(create-mdx-blog): project setup with types and build config"
```

---

### Task 2: Adapter Interfaces

**Files:**
- Create: `packages/create-mdx-blog/src/adapters/types.ts`
- Test: `packages/create-mdx-blog/tests/adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/create-mdx-blog/tests/adapters.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type {
  ImageStorageAdapter,
  ContentDeliveryAdapter,
  FrontmatterMapper,
} from "../src/adapters/types.js";

describe("ImageStorageAdapter", () => {
  it("resolves local image URL", () => {
    const adapter: ImageStorageAdapter = {
      name: "local",
      resolveUrl: (filename, slug) => `/blog/images/${slug}/${filename}`,
    };
    expect(adapter.resolveUrl("hero.webp", "my-post")).toBe(
      "/blog/images/my-post/hero.webp",
    );
  });

  it("resolves jena-cdn image URL", () => {
    const adapter: ImageStorageAdapter = {
      name: "jena-cdn",
      resolveUrl: (filename, slug) =>
        `https://cdn.jena.ai/images/${slug}/${filename}`,
    };
    expect(adapter.resolveUrl("hero.webp", "my-post")).toBe(
      "https://cdn.jena.ai/images/my-post/hero.webp",
    );
  });
});

describe("FrontmatterMapper", () => {
  it("maps canonical frontmatter", () => {
    const mapper: FrontmatterMapper = {
      name: "canonical",
      map: (jena) => ({ ...jena }),
    };
    const result = mapper.map({
      title: "Test Post",
      description: "A test",
      date: "2026-04-09",
      category: "Testing",
      image: "/img/test.webp",
    });
    expect(result.title).toBe("Test Post");
    expect(result.category).toBe("Testing");
  });

  it("detects frontmatter schema from raw content", () => {
    const content = `---
title: "My Post"
description: "A description"
date: "2026-01-15"
category:
  - Tech
  - AI
author: "Cody"
image: "https://cdn.example.com/img.webp"
---

Content here.`;

    const mapper: FrontmatterMapper = {
      name: "detected",
      map: (jena) => jena,
      detect: (raw: string) => {
        // This is the implementation we'll build in Task 4
        return {
          fields: {
            title: { type: "string", example: "My Post", required: true },
            category: {
              type: "string[]",
              example: ["Tech", "AI"],
              required: true,
            },
          },
        };
      },
    };
    const schema = mapper.detect!(content);
    expect(schema.fields.title.type).toBe("string");
    expect(schema.fields.category.type).toBe("string[]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/adapters.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write adapter interfaces**

Create `packages/create-mdx-blog/src/adapters/types.ts`:

```typescript
import type {
  ProjectContext,
  FrontmatterSchema,
  GeneratedFile,
  EnvVars,
  JenaConfig,
} from "../types.js";

export interface SetupContext {
  projectContext: ProjectContext;
  config: Partial<JenaConfig>;
}

export interface ScaffoldContext extends SetupContext {
  /** Whether the project uses TypeScript */
  typescript: boolean;
  /** Whether Tailwind is available */
  tailwind: boolean;
}

/** Where images are stored and how URLs are resolved */
export interface ImageStorageAdapter {
  name: string;
  /** Returns the public URL for an image given filename and post slug */
  resolveUrl(filename: string, slug: string): string;
  /** Optional: interactive setup during init, returns env vars to write */
  setup?(ctx: SetupContext): Promise<EnvVars>;
}

/** How content arrives in the user's project */
export interface ContentDeliveryAdapter {
  name: string;
  /** Generate files to add to the project (e.g., webhook route) */
  scaffold(ctx: ScaffoldContext): Promise<GeneratedFile[]>;
  /** Optional: interactive setup during init, returns env vars to write */
  setup?(ctx: SetupContext): Promise<EnvVars>;
}

/** How Jena AI frontmatter maps to the user's schema */
export interface FrontmatterMapper {
  name: string;
  /** Transform Jena AI frontmatter to the target schema */
  map(jenaFrontmatter: Record<string, unknown>): Record<string, unknown>;
  /** Optional: detect schema from existing post content */
  detect?(rawContent: string): FrontmatterSchema;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/adapters.test.ts
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/create-mdx-blog/src/adapters/types.ts packages/create-mdx-blog/tests/adapters.test.ts
git commit -m "feat(create-mdx-blog): adapter interfaces for image storage, content delivery, frontmatter"
```

---

### Task 3: Project Detection Engine

**Files:**
- Create: `packages/create-mdx-blog/src/detect.ts`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/package.json`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/next.config.ts`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/tsconfig.json`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/package.json`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/next.config.ts`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/tsconfig.json`
- Create: `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/app/blog/example-post.mdx`
- Test: `packages/create-mdx-blog/tests/detect.test.ts`

- [ ] **Step 1: Create test fixtures**

Create `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/package.json`:
```json
{
  "name": "test-app",
  "dependencies": {
    "next": "15.5.9",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "typescript": "5.5.3",
    "tailwindcss": "3.4.11"
  }
}
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/next.config.ts`:
```typescript
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-minimal/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "module": "esnext",
    "jsx": "preserve",
    "strict": true
  }
}
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/package.json`:
```json
{
  "name": "test-app-blog",
  "dependencies": {
    "next": "15.5.9",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "gray-matter": "4.0.3"
  },
  "devDependencies": {
    "typescript": "5.5.3",
    "tailwindcss": "3.4.11"
  }
}
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/next.config.ts`:
```typescript
import type { NextConfig } from "next";
const nextConfig: NextConfig = { pageExtensions: ["tsx", "ts", "mdx"] };
export default nextConfig;
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/tsconfig.json`:
```json
{
  "compilerOptions": { "target": "ES2017", "module": "esnext", "jsx": "preserve", "strict": true }
}
```

Create `packages/create-mdx-blog/tests/fixtures/nextjs-with-blog/app/blog/example-post.mdx`:
```markdown
---
title: "Shipping Firearms Across State Lines"
description: "Learn the rules for interstate firearm shipping"
date: "2025-01-15"
author: "Ship Restrict"
category:
  - Compliance
  - Firearms
image: "https://d2mpkaxyc7dort.cloudfront.net/blog/firearms.webp"
---

Content goes here.
```

- [ ] **Step 2: Write the failing test**

Create `packages/create-mdx-blog/tests/detect.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { detectProject } from "../src/detect.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

describe("detectProject", () => {
  it("detects a minimal Next.js project", async () => {
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-minimal"));

    expect(ctx.nextVersion).toBe("15.5.9");
    expect(ctx.typescript).toBe(true);
    expect(ctx.tailwind).toBe(true);
    expect(ctx.packageManager).toBe("pnpm");
    expect(ctx.existingBlog).toBeNull();
  });

  it("detects an existing blog with posts", async () => {
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-with-blog"));

    expect(ctx.existingBlog).not.toBeNull();
    expect(ctx.existingBlog!.postCount).toBe(1);
    expect(ctx.existingBlog!.contentDir).toBe("app/blog");
  });

  it("throws if no Next.js found", async () => {
    await expect(detectProject("/tmp")).rejects.toThrow(/Next\.js/);
  });

  it("detects package manager from lock files", async () => {
    // nextjs-minimal has no lock file — should default to npm
    // But we test the detection logic via the fixture
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-minimal"));
    // pnpm if pnpm-lock.yaml exists, npm if package-lock.json, yarn if yarn.lock
    expect(["npm", "pnpm", "yarn"]).toContain(ctx.packageManager);
  });

  it("detects shadcn from components/ui directory", async () => {
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-minimal"));
    // Minimal fixture has no components/ui
    expect(ctx.shadcn).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/detect.test.ts
```
Expected: FAIL — `detectProject` not found

- [ ] **Step 4: Write the detection engine**

Create `packages/create-mdx-blog/src/detect.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";
import type { ProjectContext, ExistingBlog } from "./types.js";

export async function detectProject(rootDir: string): Promise<ProjectContext> {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      "No package.json found. Run this command from a Next.js project root.",
    );
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Detect Next.js
  const nextVersion = allDeps.next?.replace(/[\^~]/, "");
  if (!nextVersion) {
    throw new Error(
      "Next.js not found in dependencies. This tool requires a Next.js 14+ project.",
    );
  }

  const majorVersion = parseInt(nextVersion.split(".")[0], 10);
  if (majorVersion < 14) {
    throw new Error(
      `Next.js ${nextVersion} detected. This tool requires Next.js 14+ with App Router.`,
    );
  }

  // Detect TypeScript
  const typescript =
    !!allDeps.typescript || fs.existsSync(path.join(rootDir, "tsconfig.json"));

  // Detect package manager
  const packageManager = detectPackageManager(rootDir);

  // Detect Tailwind
  const tailwind = !!allDeps.tailwindcss || !!allDeps["@tailwindcss/postcss"];

  // Detect shadcn
  const shadcn =
    fs.existsSync(path.join(rootDir, "components", "ui")) ||
    fs.existsSync(path.join(rootDir, "src", "components", "ui"));

  // Detect existing blog
  const existingBlog = await detectExistingBlog(rootDir);

  return {
    rootDir,
    nextVersion,
    typescript,
    packageManager,
    tailwind,
    shadcn,
    existingBlog,
  };
}

function detectPackageManager(
  rootDir: string,
): "npm" | "pnpm" | "yarn" {
  if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootDir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function detectExistingBlog(
  rootDir: string,
): Promise<ExistingBlog | null> {
  // Search common blog content locations
  const patterns = [
    "app/blog/**/*.{mdx,md}",
    "content/blog/**/*.{mdx,md}",
    "content/posts/**/*.{mdx,md}",
    "posts/**/*.{mdx,md}",
    "src/content/blog/**/*.{mdx,md}",
  ];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      ignore: ["**/node_modules/**"],
    });

    if (matches.length > 0) {
      // Determine content directory from the first match
      const firstMatch = matches[0];
      const contentDir = path.dirname(firstMatch).split("/").slice(0, 2).join("/");

      return {
        contentDir,
        postCount: matches.length,
        postPaths: matches,
        frontmatterSchema: null, // Populated later by frontmatter detection
      };
    }
  }

  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/detect.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/create-mdx-blog/src/detect.ts packages/create-mdx-blog/tests/detect.test.ts packages/create-mdx-blog/tests/fixtures/
git commit -m "feat(create-mdx-blog): project detection engine with test fixtures"
```

---

### Task 4: Frontmatter Detection and Canonical Schema

**Files:**
- Create: `packages/create-mdx-blog/src/adapters/frontmatter/detect.ts`
- Create: `packages/create-mdx-blog/src/adapters/frontmatter/canonical.ts`
- Test: `packages/create-mdx-blog/tests/frontmatter-detect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/create-mdx-blog/tests/frontmatter-detect.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectFrontmatter } from "../src/adapters/frontmatter/detect.js";
import { canonicalMapper } from "../src/adapters/frontmatter/canonical.js";

const APSR_POST = `---
title: "Shipping Firearms Across State Lines"
description: "Learn the rules"
date: "2025-01-15"
author: "Ship Restrict"
category:
  - Compliance
  - Firearms
image: "https://d2mpkaxyc7dort.cloudfront.net/blog/firearms.webp"
---

Content here.`;

const SIMPLE_POST = `---
title: "My First Post"
description: "Hello world"
date: "2026-04-09"
category: "General"
---

Hello world.`;

describe("detectFrontmatter", () => {
  it("detects string fields", () => {
    const schema = detectFrontmatter([SIMPLE_POST]);
    expect(schema.fields.title.type).toBe("string");
    expect(schema.fields.description.type).toBe("string");
    expect(schema.fields.date.type).toBe("string");
    expect(schema.fields.category.type).toBe("string");
  });

  it("detects array fields", () => {
    const schema = detectFrontmatter([APSR_POST]);
    expect(schema.fields.category.type).toBe("string[]");
    expect(schema.fields.category.example).toEqual(["Compliance", "Firearms"]);
  });

  it("marks fields present in all posts as required", () => {
    const schema = detectFrontmatter([APSR_POST, SIMPLE_POST]);
    expect(schema.fields.title.required).toBe(true);
    expect(schema.fields.description.required).toBe(true);
    // author only in APSR_POST
    expect(schema.fields.author.required).toBe(false);
    // image only in APSR_POST
    expect(schema.fields.image.required).toBe(false);
  });

  it("detects mixed types for same field across posts", () => {
    // category is string in SIMPLE_POST but string[] in APSR_POST
    // Should resolve to string[] since that's the richer type
    const schema = detectFrontmatter([APSR_POST, SIMPLE_POST]);
    expect(schema.fields.category.type).toBe("string[]");
  });

  it("returns empty schema for empty input", () => {
    const schema = detectFrontmatter([]);
    expect(Object.keys(schema.fields)).toHaveLength(0);
  });
});

describe("canonicalMapper", () => {
  it("passes through canonical frontmatter unchanged", () => {
    const input = {
      title: "Test",
      description: "Desc",
      date: "2026-04-09",
      category: "Tech",
      author: "Bot",
      image: "/blog/images/test/hero.webp",
    };
    const result = canonicalMapper.map(input);
    expect(result).toEqual(input);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/frontmatter-detect.test.ts
```
Expected: FAIL — modules not found

- [ ] **Step 3: Write frontmatter detection**

Create `packages/create-mdx-blog/src/adapters/frontmatter/detect.ts`:

```typescript
import matter from "gray-matter";
import type { FrontmatterSchema, FrontmatterFieldInfo } from "../../types.js";
import type { FrontmatterMapper } from "../types.js";

function inferType(value: unknown): FrontmatterFieldInfo["type"] {
  if (Array.isArray(value)) {
    return "string[]";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

export function detectFrontmatter(postContents: string[]): FrontmatterSchema {
  if (postContents.length === 0) {
    return { fields: {} };
  }

  // Parse all posts
  const allFields = new Map<string, { types: Set<string>; examples: unknown[]; count: number }>();

  for (const content of postContents) {
    const { data } = matter(content);
    for (const [key, value] of Object.entries(data)) {
      if (!allFields.has(key)) {
        allFields.set(key, { types: new Set(), examples: [], count: 0 });
      }
      const field = allFields.get(key)!;
      field.types.add(inferType(value));
      if (field.examples.length < 2) {
        field.examples.push(value);
      }
      field.count++;
    }
  }

  // Build schema
  const fields: Record<string, FrontmatterFieldInfo> = {};
  for (const [key, info] of allFields) {
    // If both string and string[] seen, prefer string[] (richer type)
    let type: FrontmatterFieldInfo["type"] = "string";
    if (info.types.has("string[]")) {
      type = "string[]";
    } else if (info.types.has("number")) {
      type = "number";
    } else if (info.types.has("boolean")) {
      type = "boolean";
    }

    fields[key] = {
      type,
      example: info.examples[0],
      required: info.count === postContents.length,
    };
  }

  return { fields };
}

export const detectedMapper: FrontmatterMapper = {
  name: "detected",
  map: (jena) => jena,
  detect: (rawContent: string) => detectFrontmatter([rawContent]),
};
```

- [ ] **Step 4: Write canonical frontmatter mapper**

Create `packages/create-mdx-blog/src/adapters/frontmatter/canonical.ts`:

```typescript
import type { FrontmatterMapper } from "../types.js";

/**
 * Canonical frontmatter schema for scaffold mode.
 * Passes through Jena AI's default output unchanged.
 */
export const canonicalMapper: FrontmatterMapper = {
  name: "canonical",
  map: (jena) => ({
    title: jena.title,
    description: jena.description,
    date: jena.date,
    category: jena.category,
    author: jena.author,
    image: jena.image,
  }),
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/frontmatter-detect.test.ts
```
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/create-mdx-blog/src/adapters/frontmatter/ packages/create-mdx-blog/tests/frontmatter-detect.test.ts
git commit -m "feat(create-mdx-blog): frontmatter detection and canonical schema mapper"
```

---

### Task 5: Image Storage Adapters

**Files:**
- Create: `packages/create-mdx-blog/src/adapters/images/local.ts`
- Create: `packages/create-mdx-blog/src/adapters/images/jena-cdn.ts`

- [ ] **Step 1: Write local image adapter**

Create `packages/create-mdx-blog/src/adapters/images/local.ts`:

```typescript
import type { ImageStorageAdapter } from "../types.js";

export const localImageAdapter: ImageStorageAdapter = {
  name: "local",
  resolveUrl(filename: string, slug: string): string {
    return `/blog/images/${slug}/${filename}`;
  },
};
```

- [ ] **Step 2: Write Jena CDN image adapter**

Create `packages/create-mdx-blog/src/adapters/images/jena-cdn.ts`:

```typescript
import type { ImageStorageAdapter } from "../types.js";

export const jenaCdnImageAdapter: ImageStorageAdapter = {
  name: "jena-cdn",
  resolveUrl(filename: string, slug: string): string {
    // CDN URLs are passed through from the webhook payload as-is.
    // This adapter is a no-op placeholder — the actual URL comes from
    // the Jena AI webhook payload, not from this function.
    return `https://cdn.jena.ai/images/${slug}/${filename}`;
  },
};
```

- [ ] **Step 3: Verify existing adapter tests still pass**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/adapters.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/create-mdx-blog/src/adapters/images/
git commit -m "feat(create-mdx-blog): local and jena-cdn image storage adapters"
```

---

### Task 6: Webhook Handler Template with Security

**Files:**
- Create: `packages/create-mdx-blog/src/adapters/delivery/webhook.ts`
- Create: `packages/create-mdx-blog/src/templates/webhook/route.ts.tmpl`
- Test: `packages/create-mdx-blog/tests/webhook-template.test.ts`

This is the most security-critical template. The generated webhook handler must validate HMAC signatures, prevent replay attacks, sanitize slugs, and confine writes to the content directory.

- [ ] **Step 1: Write the failing test**

Create `packages/create-mdx-blog/tests/webhook-template.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateWebhookHandler } from "../src/adapters/delivery/webhook.js";

describe("generateWebhookHandler", () => {
  it("generates a TypeScript webhook route handler", () => {
    const result = generateWebhookHandler({
      typescript: true,
      contentDir: "content/blog",
      imageStorage: "jena-cdn",
      localImageDir: "public/blog/images",
      localImagePublicPath: "/blog/images",
    });

    // Must contain HMAC validation
    expect(result).toContain("X-Jena-Signature");
    expect(result).toContain("createHmac");
    expect(result).toContain("timingSafeEqual");

    // Must contain timestamp validation
    expect(result).toContain("timestamp");
    expect(result).toContain("5 * 60 * 1000");

    // Must contain slug sanitization
    expect(result).toContain("/[^a-z0-9-]/g");

    // Must contain directory confinement check
    expect(result).toContain("startsWith");

    // Must contain POST method check
    expect(result).toContain("POST");

    // Must export a POST handler (Next.js App Router convention)
    expect(result).toContain("export async function POST");
  });

  it("includes image download logic for local storage", () => {
    const result = generateWebhookHandler({
      typescript: true,
      contentDir: "content/blog",
      imageStorage: "local",
      localImageDir: "public/blog/images",
      localImagePublicPath: "/blog/images",
    });

    expect(result).toContain("download_url");
    expect(result).toContain("mkdir");
  });

  it("skips image download for jena-cdn storage", () => {
    const result = generateWebhookHandler({
      typescript: true,
      contentDir: "content/blog",
      imageStorage: "jena-cdn",
      localImageDir: "public/blog/images",
      localImagePublicPath: "/blog/images",
    });

    // CDN mode should not download images
    expect(result).not.toContain("download_url");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/webhook-template.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the webhook template generator**

Create `packages/create-mdx-blog/src/adapters/delivery/webhook.ts`:

```typescript
import type { ContentDeliveryAdapter, ScaffoldContext } from "../types.js";
import type { GeneratedFile } from "../../types.js";

interface WebhookOptions {
  typescript: boolean;
  contentDir: string;
  imageStorage: "local" | "jena-cdn";
  localImageDir: string;
  localImagePublicPath: string;
}

export function generateWebhookHandler(options: WebhookOptions): string {
  const { contentDir, imageStorage, localImageDir, localImagePublicPath } = options;

  const imageDownloadBlock =
    imageStorage === "local"
      ? `
  // Download images locally
  const imageDir = path.join(process.cwd(), "${localImageDir}", slug);
  await fs.mkdir(imageDir, { recursive: true });

  for (const img of images) {
    if (!img.download_url) continue;
    const resp = await fetch(img.download_url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      // Clean up partial downloads on failure
      await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json(
        { error: \`Failed to download image: \${img.filename}\` },
        { status: 500 },
      );
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    await fs.writeFile(path.join(imageDir, img.filename), buffer);
  }

  // Rewrite image URLs from CDN to local paths
  for (const img of images) {
    if (img.url) {
      content = content.replaceAll(img.url, \`${localImagePublicPath}/\${slug}/\${img.filename}\`);
    }
  }`
      : "";

  return `import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const WEBHOOK_SECRET = process.env.JENA_WEBHOOK_SECRET!;
const CONTENT_DIR = path.resolve(process.cwd(), "${contentDir}");
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function verifySignature(body: string, signature: string): boolean {
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9-]/g, "").slice(0, 200);
}

export async function POST(request: Request) {
  // Method is guaranteed POST by Next.js route handler, but verify content length
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Validate HMAC signature
  const signature = request.headers.get("X-Jena-Signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const rawBody = await request.text();

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Validate timestamp (reject replays older than 5 minutes)
  const timestamp = new Date(payload.timestamp).getTime();
  if (Date.now() - timestamp > 5 * 60 * 1000) {
    return NextResponse.json({ error: "Request expired" }, { status: 401 });
  }

  // Sanitize and validate slug
  const slug = sanitizeSlug(payload.slug || "");
  if (!slug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  // Directory confinement check
  const filePath = path.resolve(CONTENT_DIR, \`\${slug}.mdx\`);
  if (!filePath.startsWith(CONTENT_DIR)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  let content: string = payload.content;
  const images: Array<{
    filename: string;
    url: string;
    download_url?: string;
    alt: string;
    placement: string;
  }> = payload.images || [];
${imageDownloadBlock}

  // Write MDX file
  await fs.mkdir(CONTENT_DIR, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");

  return NextResponse.json({
    received: true,
    path: path.relative(process.cwd(), filePath),
  });
}
`;
}

export const webhookDeliveryAdapter: ContentDeliveryAdapter = {
  name: "webhook",

  async scaffold(ctx: ScaffoldContext): Promise<GeneratedFile[]> {
    const config = ctx.config;
    const imageStorage = config.images?.storage ?? "local";
    const handler = generateWebhookHandler({
      typescript: ctx.typescript,
      contentDir: config.blog?.contentDir ?? "content/blog",
      imageStorage,
      localImageDir: config.images?.localDir ?? "public/blog/images",
      localImagePublicPath: config.images?.publicPath ?? "/blog/images",
    });

    return [
      {
        path: "app/api/jena-webhook/route.ts",
        content: handler,
      },
    ];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/webhook-template.test.ts
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/create-mdx-blog/src/adapters/delivery/ packages/create-mdx-blog/tests/webhook-template.test.ts
git commit -m "feat(create-mdx-blog): webhook handler template with HMAC, replay prevention, path traversal protection"
```

---

### Task 7: TUI Helpers

**Files:**
- Create: `packages/create-mdx-blog/src/ui.ts`

This provides the polished terminal UI primitives used by the prompt system.

- [ ] **Step 1: Write TUI helpers**

Create `packages/create-mdx-blog/src/ui.ts`:

```typescript
import chalk from "chalk";

const BRAND = chalk.hex("#6366f1"); // Indigo to match Jena AI palette

export function banner(): void {
  console.log();
  console.log(BRAND.bold("  create-mdx-blog"));
  console.log(chalk.dim("  Scaffold a production-ready MDX blog for Next.js"));
  console.log();
}

export function step(current: number, total: number, message: string): void {
  const progress = chalk.dim(`[${current}/${total}]`);
  console.log(`  ${progress} ${message}`);
}

export function success(message: string): void {
  console.log(`  ${chalk.green("+")} ${message}`);
}

export function info(message: string): void {
  console.log(`  ${chalk.blue("i")} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${chalk.yellow("!")} ${message}`);
}

export function error(message: string): void {
  console.log(`  ${chalk.red("x")} ${message}`);
}

export function created(filePath: string): void {
  console.log(`  ${chalk.green("+")} ${chalk.dim("created")} ${filePath}`);
}

export function skipped(filePath: string, reason: string): void {
  console.log(`  ${chalk.yellow("-")} ${chalk.dim("skipped")} ${filePath} ${chalk.dim(`(${reason})`)}`);
}

export function divider(): void {
  console.log();
  console.log(chalk.dim("  " + "─".repeat(50)));
  console.log();
}

export function summary(files: string[], envVars: string[]): void {
  divider();
  console.log(BRAND.bold("  Done!"));
  console.log();

  if (files.length > 0) {
    console.log(chalk.bold("  Files created:"));
    for (const f of files) {
      console.log(`    ${chalk.green("+")} ${f}`);
    }
    console.log();
  }

  if (envVars.length > 0) {
    console.log(chalk.bold("  Environment variables added to .env.local:"));
    for (const v of envVars) {
      console.log(`    ${chalk.blue("+")} ${v}`);
    }
    console.log();
  }

  console.log(chalk.bold("  Next steps:"));
  console.log(`    1. Review the generated files`);
  console.log(`    2. ${chalk.cyan("git add . && git commit -m 'Add blog'")}`);
  console.log(`    3. ${chalk.cyan("git push")} to deploy`);
  console.log();
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/create-mdx-blog/src/ui.ts
git commit -m "feat(create-mdx-blog): TUI helpers with color-coded output and progress indicators"
```

---

### Task 8: Interactive Prompts

**Files:**
- Create: `packages/create-mdx-blog/src/prompts/setup.ts`

- [ ] **Step 1: Write prompt sequences**

Create `packages/create-mdx-blog/src/prompts/setup.ts`:

```typescript
import prompts from "prompts";
import type { ProjectContext, BlogConfig, FrontmatterMapping, FrontmatterSchema } from "../types.js";
import * as ui from "../ui.js";

/** Prompt: existing blog found — connect or scaffold? */
export async function promptExistingBlogAction(
  blog: NonNullable<ProjectContext["existingBlog"]>,
): Promise<"connect" | "scaffold"> {
  ui.info(
    `Found an existing blog at ${blog.contentDir}/ with ${blog.postCount} post${blog.postCount === 1 ? "" : "s"}.`,
  );
  console.log();

  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "What would you like to do?",
    choices: [
      {
        title: "Connect Jena AI to this blog",
        value: "connect",
        description: "Add webhook integration without changing your blog",
      },
      {
        title: "Scaffold a new blog",
        value: "scaffold",
        description: "Create a fresh blog system alongside your existing one",
      },
    ],
  });

  return action || "connect";
}

/** Prompt: blog configuration for scaffold mode */
export async function promptBlogConfig(): Promise<BlogConfig> {
  const responses = await prompts([
    {
      type: "text",
      name: "siteName",
      message: "Blog name",
      initial: "My Blog",
    },
    {
      type: "text",
      name: "siteDescription",
      message: "Blog description",
      initial: "A blog about things that matter",
    },
    {
      type: "text",
      name: "siteUrl",
      message: "Site URL (for RSS and metadata)",
      initial: "https://example.com",
    },
    {
      type: "number",
      name: "postsPerPage",
      message: "Posts per page",
      initial: 10,
      min: 1,
      max: 100,
    },
    {
      type: "confirm",
      name: "rss",
      message: "Enable RSS feed?",
      initial: true,
    },
    {
      type: "confirm",
      name: "categories",
      message: "Enable category pages?",
      initial: true,
    },
  ]);

  return {
    contentDir: "content/blog",
    postsPerPage: responses.postsPerPage ?? 10,
    rss: responses.rss ?? true,
    categories: responses.categories ?? true,
    siteName: responses.siteName ?? "My Blog",
    siteDescription: responses.siteDescription ?? "",
    siteUrl: responses.siteUrl ?? "https://example.com",
  };
}

/** Prompt: connect to Jena AI? */
export async function promptJenaConnection(): Promise<{
  connect: boolean;
  apiKey?: string;
}> {
  const { connect } = await prompts({
    type: "confirm",
    name: "connect",
    message: "Connect to Jena AI for automated content delivery?",
    initial: false,
  });

  if (!connect) return { connect: false };

  const { apiKey } = await prompts({
    type: "password",
    name: "apiKey",
    message: "Jena AI API key",
  });

  return { connect: true, apiKey };
}

/** Prompt: confirm detected frontmatter schema */
export async function promptFrontmatterConfirmation(
  schema: FrontmatterSchema,
): Promise<boolean> {
  console.log();
  ui.info("Detected frontmatter schema:");
  console.log();
  for (const [key, field] of Object.entries(schema.fields)) {
    const req = field.required ? "" : " (optional)";
    const example =
      typeof field.example === "string"
        ? `"${field.example}"`
        : JSON.stringify(field.example);
    console.log(`    ${key}: ${field.type}${req} — e.g. ${example}`);
  }
  console.log();

  const { confirmed } = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Does this look right?",
    initial: true,
  });

  return confirmed ?? true;
}

/** Build frontmatter mapping from detected schema */
export function buildFrontmatterMapping(
  schema: FrontmatterSchema,
): FrontmatterMapping {
  const mapping: FrontmatterMapping = {};
  const jenaFields = ["title", "description", "date", "category", "author", "image"];

  for (const jenaField of jenaFields) {
    // Try exact match first
    if (schema.fields[jenaField]) {
      const field = schema.fields[jenaField];
      if (jenaField === "category" && field.type === "string[]") {
        mapping[jenaField] = { key: "category", transform: "array" };
      } else if (jenaField === "image") {
        mapping[jenaField] = { key: "image", transform: "jena-cdn-url" };
      } else {
        mapping[jenaField] = jenaField;
      }
    }
  }

  return mapping;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/create-mdx-blog/src/prompts/
git commit -m "feat(create-mdx-blog): interactive prompt sequences for setup flow"
```

---

### Task 9: Content Layer Templates

**Files:**
- Create: `packages/create-mdx-blog/src/templates/content-layer/types.ts.tmpl`
- Create: `packages/create-mdx-blog/src/templates/content-layer/content.ts.tmpl`
- Create: `packages/create-mdx-blog/src/templates/content-layer/mdx.ts.tmpl`

These are the template files that get copied into the user's project. They use `{{TOKEN}}` placeholders replaced at scaffold time.

- [ ] **Step 1: Write types template**

Create `packages/create-mdx-blog/src/templates/content-layer/types.ts.tmpl`:

```typescript
export interface PostMeta {
  title: string;
  description: string;
  date: string;
  category: string;
  author?: string;
  image?: string;
  slug: string;
}

export interface Post extends PostMeta {
  content: string;
}
```

- [ ] **Step 2: Write content layer template**

Create `packages/create-mdx-blog/src/templates/content-layer/content.ts.tmpl`:

```typescript
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { PostMeta, Post } from "./types";

const CONTENT_DIR = path.join(process.cwd(), "{{CONTENT_DIR}}");
const POSTS_PER_PAGE = {{POSTS_PER_PAGE}};

function getPostFiles(): string[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".mdx") || f.endsWith(".md"));
}

function parsePost(filename: string): Post {
  const filePath = path.join(CONTENT_DIR, filename);
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const slug = filename.replace(/\.(mdx|md)$/, "");

  return {
    title: data.title ?? "",
    description: data.description ?? "",
    date: data.date ?? "",
    category: data.category ?? "",
    author: data.author,
    image: data.image,
    slug,
    content,
  };
}

export function getAllPosts(): PostMeta[] {
  return getPostFiles()
    .map((f) => {
      const post = parsePost(f);
      const { content: _, ...meta } = post;
      return meta;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getPostBySlug(slug: string): Post | null {
  const files = getPostFiles();
  const match = files.find(
    (f) => f.replace(/\.(mdx|md)$/, "") === slug,
  );
  if (!match) return null;
  return parsePost(match);
}

export function getPostsByCategory(category: string): PostMeta[] {
  return getAllPosts().filter(
    (p) => p.category.toLowerCase() === category.toLowerCase(),
  );
}

export function getCategories(): string[] {
  const cats = new Set(getAllPosts().map((p) => p.category));
  return [...cats].sort();
}

export function getPaginatedPosts(
  page: number,
  posts?: PostMeta[],
): { posts: PostMeta[]; totalPages: number } {
  const all = posts ?? getAllPosts();
  const totalPages = Math.ceil(all.length / POSTS_PER_PAGE);
  const start = (page - 1) * POSTS_PER_PAGE;
  return {
    posts: all.slice(start, start + POSTS_PER_PAGE),
    totalPages,
  };
}
```

- [ ] **Step 3: Write MDX compilation template**

Create `packages/create-mdx-blog/src/templates/content-layer/mdx.ts.tmpl`:

```typescript
import { compileMDX } from "next-mdx-remote/rsc";
import type { ReactElement } from "react";

const components: Record<string, React.ComponentType<Record<string, unknown>>> = {
  // Register custom MDX components here
  // Example: Callout: (props) => <div className="callout" {...props} />,
};

export async function renderMDX(source: string): Promise<ReactElement> {
  const { content } = await compileMDX({
    source,
    components,
  });
  return content;
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/create-mdx-blog/src/templates/content-layer/
git commit -m "feat(create-mdx-blog): content layer templates (types, content API, MDX renderer)"
```

---

### Task 10: Blog Component Templates

**Files:**
- Create: `packages/create-mdx-blog/src/templates/components/post-card.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/components/post-layout.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/components/pagination.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/components/category-nav.tsx.tmpl`

These are Tailwind-styled by default. The scaffold orchestrator will strip Tailwind classes if the project doesn't use Tailwind.

- [ ] **Step 1: Write PostCard template**

Create `packages/create-mdx-blog/src/templates/components/post-card.tsx.tmpl`:

```tsx
import Link from "next/link";
import type { PostMeta } from "{{LIB_PATH}}/blog/types";

export function PostCard({ post }: { post: PostMeta }) {
  return (
    <article className="group">
      {post.image && (
        <Link href={`/blog/${post.slug}`}>
          <img
            src={post.image}
            alt={post.title}
            className="aspect-video w-full rounded-lg object-cover"
          />
        </Link>
      )}
      <div className="mt-4">
        {post.category && (
          <Link
            href={`/blog/category/${encodeURIComponent(post.category.toLowerCase())}`}
            className="text-sm font-medium text-indigo-600"
          >
            {post.category}
          </Link>
        )}
        <h2 className="mt-1 text-xl font-semibold">
          <Link href={`/blog/${post.slug}`} className="hover:underline">
            {post.title}
          </Link>
        </h2>
        <p className="mt-2 text-gray-600 line-clamp-2">{post.description}</p>
        <time className="mt-3 block text-sm text-gray-400">{post.date}</time>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Write PostLayout template**

Create `packages/create-mdx-blog/src/templates/components/post-layout.tsx.tmpl`:

```tsx
import Link from "next/link";
import type { PostMeta } from "{{LIB_PATH}}/blog/types";

export function PostLayout({
  meta,
  children,
}: {
  meta: PostMeta;
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8">
        <Link
          href="/blog"
          className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back to blog
        </Link>
        {meta.category && (
          <Link
            href={`/blog/category/${encodeURIComponent(meta.category.toLowerCase())}`}
            className="mb-2 block text-sm font-medium text-indigo-600"
          >
            {meta.category}
          </Link>
        )}
        <h1 className="text-4xl font-bold tracking-tight">{meta.title}</h1>
        <p className="mt-2 text-lg text-gray-600">{meta.description}</p>
        <div className="mt-4 flex items-center gap-4 text-sm text-gray-400">
          <time>{meta.date}</time>
          {meta.author && <span>by {meta.author}</span>}
        </div>
      </header>
      {meta.image && (
        <img
          src={meta.image}
          alt={meta.title}
          className="mb-8 w-full rounded-lg"
        />
      )}
      <div className="prose prose-lg max-w-none">{children}</div>
    </article>
  );
}
```

- [ ] **Step 3: Write Pagination template**

Create `packages/create-mdx-blog/src/templates/components/pagination.tsx.tmpl`:

```tsx
import Link from "next/link";

export function Pagination({
  currentPage,
  totalPages,
  basePath = "/blog",
}: {
  currentPage: number;
  totalPages: number;
  basePath?: string;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav className="mt-12 flex items-center justify-center gap-2">
      {currentPage > 1 && (
        <Link
          href={currentPage === 2 ? basePath : `${basePath}?page=${currentPage - 1}`}
          className="rounded-md px-4 py-2 text-sm font-medium hover:bg-gray-100"
        >
          Previous
        </Link>
      )}
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
        <Link
          key={page}
          href={page === 1 ? basePath : `${basePath}?page=${page}`}
          className={`rounded-md px-3 py-2 text-sm font-medium ${
            page === currentPage
              ? "bg-indigo-600 text-white"
              : "hover:bg-gray-100"
          }`}
        >
          {page}
        </Link>
      ))}
      {currentPage < totalPages && (
        <Link
          href={`${basePath}?page=${currentPage + 1}`}
          className="rounded-md px-4 py-2 text-sm font-medium hover:bg-gray-100"
        >
          Next
        </Link>
      )}
    </nav>
  );
}
```

- [ ] **Step 4: Write CategoryNav template**

Create `packages/create-mdx-blog/src/templates/components/category-nav.tsx.tmpl`:

```tsx
import Link from "next/link";

export function CategoryNav({
  categories,
  activeCategory,
}: {
  categories: string[];
  activeCategory?: string;
}) {
  return (
    <nav className="mb-8 flex flex-wrap gap-2">
      <Link
        href="/blog"
        className={`rounded-full px-4 py-1.5 text-sm font-medium ${
          !activeCategory
            ? "bg-indigo-600 text-white"
            : "bg-gray-100 text-gray-700 hover:bg-gray-200"
        }`}
      >
        All
      </Link>
      {categories.map((cat) => (
        <Link
          key={cat}
          href={`/blog/category/${encodeURIComponent(cat.toLowerCase())}`}
          className={`rounded-full px-4 py-1.5 text-sm font-medium ${
            activeCategory?.toLowerCase() === cat.toLowerCase()
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          {cat}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/create-mdx-blog/src/templates/components/
git commit -m "feat(create-mdx-blog): blog component templates (PostCard, PostLayout, Pagination, CategoryNav)"
```

---

### Task 11: Blog Route Templates

**Files:**
- Create: `packages/create-mdx-blog/src/templates/routes/blog-page.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/routes/blog-slug-page.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/routes/category-page.tsx.tmpl`
- Create: `packages/create-mdx-blog/src/templates/routes/feed-route.ts.tmpl`
- Create: `packages/create-mdx-blog/src/templates/example-post.mdx.tmpl`

- [ ] **Step 1: Write blog listing page template**

Create `packages/create-mdx-blog/src/templates/routes/blog-page.tsx.tmpl`:

```tsx
import type { Metadata } from "next";
import { getAllPosts, getCategories, getPaginatedPosts } from "{{LIB_PATH}}/blog/content";
import { PostCard } from "{{COMPONENTS_PATH}}/blog/post-card";
import { Pagination } from "{{COMPONENTS_PATH}}/blog/pagination";
import { CategoryNav } from "{{COMPONENTS_PATH}}/blog/category-nav";

export const metadata: Metadata = {
  title: "Blog | {{SITE_NAME}}",
  description: "{{SITE_DESCRIPTION}}",
};

export default async function BlogPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10));
  const { posts, totalPages } = getPaginatedPosts(page);
  const categories = getCategories();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="mb-8 text-4xl font-bold">Blog</h1>
      <CategoryNav categories={categories} />
      <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        {posts.map((post) => (
          <PostCard key={post.slug} post={post} />
        ))}
      </div>
      {posts.length === 0 && (
        <p className="text-center text-gray-500">No posts yet.</p>
      )}
      <Pagination currentPage={page} totalPages={totalPages} />
    </div>
  );
}
```

- [ ] **Step 2: Write individual post page template**

Create `packages/create-mdx-blog/src/templates/routes/blog-slug-page.tsx.tmpl`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllPosts, getPostBySlug } from "{{LIB_PATH}}/blog/content";
import { renderMDX } from "{{LIB_PATH}}/blog/mdx";
import { PostLayout } from "{{COMPONENTS_PATH}}/blog/post-layout";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  return {
    title: `${post.title} | {{SITE_NAME}}`,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      publishedTime: post.date,
      ...(post.image && { images: [{ url: post.image }] }),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const content = await renderMDX(post.content);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    ...(post.author && { author: { "@type": "Person", name: post.author } }),
    ...(post.image && { image: post.image }),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PostLayout meta={post}>
        {content}
      </PostLayout>
    </>
  );
}
```

- [ ] **Step 3: Write category page template**

Create `packages/create-mdx-blog/src/templates/routes/category-page.tsx.tmpl`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCategories, getPostsByCategory, getPaginatedPosts } from "{{LIB_PATH}}/blog/content";
import { PostCard } from "{{COMPONENTS_PATH}}/blog/post-card";
import { Pagination } from "{{COMPONENTS_PATH}}/blog/pagination";
import { CategoryNav } from "{{COMPONENTS_PATH}}/blog/category-nav";

interface Props {
  params: Promise<{ category: string }>;
  searchParams: Promise<{ page?: string }>;
}

export async function generateStaticParams() {
  return getCategories().map((cat) => ({
    category: encodeURIComponent(cat.toLowerCase()),
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category: rawCategory } = await params;
  const category = decodeURIComponent(rawCategory);
  return {
    title: `${category} | Blog | {{SITE_NAME}}`,
  };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { category: rawCategory } = await params;
  const { page: pageParam } = await searchParams;
  const category = decodeURIComponent(rawCategory);
  const allCategories = getCategories();

  const matchedCategory = allCategories.find(
    (c) => c.toLowerCase() === category.toLowerCase(),
  );
  if (!matchedCategory) notFound();

  const categoryPosts = getPostsByCategory(matchedCategory);
  const page = Math.max(1, parseInt(pageParam ?? "1", 10));
  const { posts, totalPages } = getPaginatedPosts(page, categoryPosts);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="mb-8 text-4xl font-bold">{matchedCategory}</h1>
      <CategoryNav categories={allCategories} activeCategory={matchedCategory} />
      <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        {posts.map((post) => (
          <PostCard key={post.slug} post={post} />
        ))}
      </div>
      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath={`/blog/category/${encodeURIComponent(matchedCategory.toLowerCase())}`}
      />
    </div>
  );
}
```

- [ ] **Step 4: Write RSS feed route template**

Create `packages/create-mdx-blog/src/templates/routes/feed-route.ts.tmpl`:

```typescript
import { getAllPosts } from "{{LIB_PATH}}/blog/content";

export async function GET() {
  const posts = getAllPosts();
  const siteUrl = "{{SITE_URL}}";

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{{SITE_NAME}}</title>
    <link>${siteUrl}/blog</link>
    <description>{{SITE_DESCRIPTION}}</description>
    <atom:link href="${siteUrl}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    ${posts
      .map(
        (post) => `<item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}</link>
      <guid isPermaLink="true">${siteUrl}/blog/${post.slug}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
    </item>`,
      )
      .join("\n    ")}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
```

- [ ] **Step 5: Write example post template**

Create `packages/create-mdx-blog/src/templates/example-post.mdx.tmpl`:

```markdown
---
title: "Welcome to Your New Blog"
description: "This is your first blog post. Edit or delete this file to get started."
date: "{{TODAY_DATE}}"
category: "Getting Started"
author: "{{SITE_NAME}}"
image: ""
---

Welcome to your new blog! This post was scaffolded by `create-mdx-blog`.

## Getting Started

Your blog posts live in `{{CONTENT_DIR}}/`. Each `.mdx` file becomes a blog post.

### Frontmatter

Every post needs frontmatter at the top:

```yaml
---
title: "Your Post Title"
description: "A brief description for SEO"
date: "2026-04-09"
category: "Category Name"
author: "Your Name"
image: "/blog/images/your-post/hero.webp"
---
```

### Adding Images

Place images in `public/blog/images/your-post-slug/` and reference them in your post:

```markdown
![Alt text](/blog/images/your-post-slug/image.webp)
```

### Categories

Posts are grouped by the `category` field. Category pages are generated automatically.

## What's Next?

- Edit this post or delete it
- Create a new `.mdx` file in `{{CONTENT_DIR}}/`
- Run `git push` to deploy
```

- [ ] **Step 6: Commit**

```bash
git add packages/create-mdx-blog/src/templates/routes/ packages/create-mdx-blog/src/templates/example-post.mdx.tmpl
git commit -m "feat(create-mdx-blog): blog route templates (listing, post, category, RSS) and example post"
```

---

### Task 12: Config Template

**Files:**
- Create: `packages/create-mdx-blog/src/templates/config/jena-config.ts.tmpl`

- [ ] **Step 1: Write config template**

Create `packages/create-mdx-blog/src/templates/config/jena-config.ts.tmpl`:

```typescript
/**
 * Blog configuration for create-mdx-blog.
 * Edit this file to customize your blog settings.
 */

interface JenaConfig {
  blog: {
    contentDir: string;
    postsPerPage: number;
    rss: boolean;
    categories: boolean;
    siteName: string;
    siteDescription: string;
    siteUrl: string;
  };
  jena?: {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
  };
  frontmatter: Record<
    string,
    string | { key: string; transform?: string; default?: string }
  >;
  images: {
    storage: "local" | "jena-cdn";
    localDir?: string;
    publicPath?: string;
  };
}

const config: JenaConfig = {{CONFIG_JSON}};

export default config;
```

- [ ] **Step 2: Commit**

```bash
git add packages/create-mdx-blog/src/templates/config/
git commit -m "feat(create-mdx-blog): jena.config.ts template"
```

---

### Task 13: Scaffold Mode Orchestrator

**Files:**
- Create: `packages/create-mdx-blog/src/init/scaffold.ts`
- Test: `packages/create-mdx-blog/tests/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/create-mdx-blog/tests/scaffold.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scaffoldBlog } from "../src/init/scaffold.js";

describe("scaffoldBlog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
    // Create minimal Next.js project structure
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test",
        dependencies: { next: "15.5.9", react: "18.3.1" },
        devDependencies: { typescript: "5.5.3", tailwindcss: "3.4.11" },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates blog route files", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: true,
          categories: true,
          siteName: "Test Blog",
          siteDescription: "A test blog",
          siteUrl: "https://test.com",
        },
        frontmatter: {
          title: "title",
          description: "description",
          date: "date",
          category: "category",
          image: "image",
          author: "author",
        },
        images: { storage: "local", localDir: "public/blog/images", publicPath: "/blog/images" },
      },
      typescript: true,
      tailwind: true,
      includeJena: false,
    });

    expect(result.files.length).toBeGreaterThan(0);

    // Check key files exist
    const filePaths = result.files.map((f) => f.path);
    expect(filePaths).toContain("app/blog/page.tsx");
    expect(filePaths).toContain("app/blog/[slug]/page.tsx");
    expect(filePaths).toContain("lib/blog/content.ts");
    expect(filePaths).toContain("lib/blog/types.ts");
    expect(filePaths).toContain("components/blog/post-card.tsx");
    expect(filePaths).toContain("content/blog/welcome.mdx");
    expect(filePaths).toContain("jena.config.ts");
  });

  it("includes category route when categories enabled", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: true,
          categories: true,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        frontmatter: { title: "title" },
        images: { storage: "local" },
      },
      typescript: true,
      tailwind: true,
      includeJena: false,
    });

    const filePaths = result.files.map((f) => f.path);
    expect(filePaths).toContain("app/blog/category/[category]/page.tsx");
  });

  it("includes RSS route when rss enabled", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: true,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        frontmatter: { title: "title" },
        images: { storage: "local" },
      },
      typescript: true,
      tailwind: true,
      includeJena: false,
    });

    const filePaths = result.files.map((f) => f.path);
    expect(filePaths).toContain("app/blog/feed.xml/route.ts");
  });

  it("includes webhook route when jena connected", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: true,
          categories: true,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        jena: {
          apiKey: process.env.JENA_API_KEY,
          webhookSecret: process.env.JENA_WEBHOOK_SECRET,
        },
        frontmatter: { title: "title" },
        images: { storage: "jena-cdn" },
      },
      typescript: true,
      tailwind: true,
      includeJena: true,
    });

    const filePaths = result.files.map((f) => f.path);
    expect(filePaths).toContain("app/api/jena-webhook/route.ts");
  });

  it("writes files to disk", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: false,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        frontmatter: { title: "title" },
        images: { storage: "local" },
      },
      typescript: true,
      tailwind: true,
      includeJena: false,
    });

    // Write files (the orchestrator does this)
    for (const file of result.files) {
      const fullPath = path.join(tmpDir, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content);
    }

    expect(fs.existsSync(path.join(tmpDir, "app/blog/page.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "lib/blog/content.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "jena.config.ts"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/scaffold.test.ts
```
Expected: FAIL — `scaffoldBlog` not found

- [ ] **Step 3: Write scaffold orchestrator**

Create `packages/create-mdx-blog/src/init/scaffold.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { JenaConfig, GeneratedFile } from "../types.js";
import { generateWebhookHandler } from "../adapters/delivery/webhook.js";

interface ScaffoldOptions {
  rootDir: string;
  config: Partial<JenaConfig>;
  typescript: boolean;
  tailwind: boolean;
  includeJena: boolean;
}

interface ScaffoldResult {
  files: GeneratedFile[];
  envVars: Record<string, string>;
}

export async function scaffoldBlog(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { config, includeJena } = options;
  const blog = config.blog!;
  const files: GeneratedFile[] = [];
  const envVars: Record<string, string> = {};

  // Determine paths based on project structure
  const libPath = "lib";
  const componentsPath = "components";

  // Content layer
  files.push({
    path: `${libPath}/blog/types.ts`,
    content: readTemplate("content-layer/types.ts.tmpl"),
  });

  files.push({
    path: `${libPath}/blog/content.ts`,
    content: applyTokens(readTemplate("content-layer/content.ts.tmpl"), {
      CONTENT_DIR: blog.contentDir,
      POSTS_PER_PAGE: String(blog.postsPerPage),
    }),
  });

  files.push({
    path: `${libPath}/blog/mdx.ts`,
    content: readTemplate("content-layer/mdx.ts.tmpl"),
  });

  // Components
  const componentTokens = { LIB_PATH: libPath };
  files.push({
    path: `${componentsPath}/blog/post-card.tsx`,
    content: applyTokens(readTemplate("components/post-card.tsx.tmpl"), componentTokens),
  });
  files.push({
    path: `${componentsPath}/blog/post-layout.tsx`,
    content: applyTokens(readTemplate("components/post-layout.tsx.tmpl"), componentTokens),
  });
  files.push({
    path: `${componentsPath}/blog/pagination.tsx`,
    content: readTemplate("components/pagination.tsx.tmpl"),
  });
  files.push({
    path: `${componentsPath}/blog/category-nav.tsx`,
    content: readTemplate("components/category-nav.tsx.tmpl"),
  });

  // Routes
  const routeTokens = {
    LIB_PATH: libPath,
    COMPONENTS_PATH: componentsPath,
    SITE_NAME: blog.siteName,
    SITE_DESCRIPTION: blog.siteDescription,
    SITE_URL: blog.siteUrl,
  };

  files.push({
    path: "app/blog/page.tsx",
    content: applyTokens(readTemplate("routes/blog-page.tsx.tmpl"), routeTokens),
  });

  files.push({
    path: "app/blog/[slug]/page.tsx",
    content: applyTokens(readTemplate("routes/blog-slug-page.tsx.tmpl"), routeTokens),
  });

  if (blog.categories) {
    files.push({
      path: "app/blog/category/[category]/page.tsx",
      content: applyTokens(readTemplate("routes/category-page.tsx.tmpl"), routeTokens),
    });
  }

  if (blog.rss) {
    files.push({
      path: "app/blog/feed.xml/route.ts",
      content: applyTokens(readTemplate("routes/feed-route.ts.tmpl"), routeTokens),
    });
  }

  // Example post
  files.push({
    path: `${blog.contentDir}/welcome.mdx`,
    content: applyTokens(readTemplate("example-post.mdx.tmpl"), {
      TODAY_DATE: new Date().toISOString().split("T")[0],
      SITE_NAME: blog.siteName,
      CONTENT_DIR: blog.contentDir,
    }),
  });

  // Config file
  const configContent = generateConfigFile(config);
  files.push({ path: "jena.config.ts", content: configContent });

  // Webhook route (if Jena AI connected)
  if (includeJena) {
    const webhookHandler = generateWebhookHandler({
      typescript: true,
      contentDir: blog.contentDir,
      imageStorage: config.images?.storage ?? "local",
      localImageDir: config.images?.localDir ?? "public/blog/images",
      localImagePublicPath: config.images?.publicPath ?? "/blog/images",
    });
    files.push({ path: "app/api/jena-webhook/route.ts", content: webhookHandler });
  }

  return { files, envVars };
}

function readTemplate(templatePath: string): string {
  const fullPath = path.join(
    import.meta.dirname,
    "..",
    "templates",
    templatePath,
  );
  // In development, read from source. In production (dist/), adjust path.
  if (fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath, "utf-8");
  }
  // Fallback: try relative to current file
  const altPath = path.join(__dirname, "..", "templates", templatePath);
  return fs.readFileSync(altPath, "utf-8");
}

function applyTokens(
  template: string,
  tokens: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function generateConfigFile(config: Partial<JenaConfig>): string {
  const tmpl = readTemplate("config/jena-config.ts.tmpl");
  const configObj = {
    blog: config.blog,
    ...(config.jena && {
      jena: {
        apiKey: "process.env.JENA_API_KEY",
        webhookSecret: "process.env.JENA_WEBHOOK_SECRET",
      },
    }),
    frontmatter: config.frontmatter ?? {},
    images: config.images ?? { storage: "local" },
  };

  // Serialize config with process.env references unquoted
  let json = JSON.stringify(configObj, null, 2);
  json = json.replace(/"process\.env\.(\w+)"/g, "process.env.$1");

  return tmpl.replace("{{CONFIG_JSON}}", json);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/scaffold.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/create-mdx-blog/src/init/scaffold.ts packages/create-mdx-blog/tests/scaffold.test.ts
git commit -m "feat(create-mdx-blog): scaffold mode orchestrator with template rendering"
```

---

### Task 14: Connect Mode Orchestrator

**Files:**
- Create: `packages/create-mdx-blog/src/init/connect.ts`
- Test: `packages/create-mdx-blog/tests/connect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/create-mdx-blog/tests/connect.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { connectToExistingBlog } from "../src/init/connect.js";

describe("connectToExistingBlog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-test-"));
    // Create a project with an existing blog
    fs.mkdirSync(path.join(tmpDir, "app/blog"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "app/blog/test-post.mdx"),
      `---
title: "Test Post"
description: "A test"
date: "2025-01-15"
author: "Tester"
category:
  - Tech
image: "https://cdn.example.com/img.webp"
---

Content.`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates only webhook route and config", async () => {
    const result = await connectToExistingBlog({
      rootDir: tmpDir,
      contentDir: "app/blog",
      frontmatterMapping: {
        title: "title",
        description: "description",
        date: "date",
        category: { key: "category", transform: "array" },
        image: { key: "image", transform: "jena-cdn-url" },
        author: { key: "author", default: "Tester" },
      },
      imageStorage: "jena-cdn",
    });

    const filePaths = result.files.map((f) => f.path);

    // Should create ONLY webhook + config
    expect(filePaths).toContain("app/api/jena-webhook/route.ts");
    expect(filePaths).toContain("jena.config.ts");

    // Should NOT create blog routes or components
    expect(filePaths).not.toContain("app/blog/page.tsx");
    expect(filePaths).not.toContain("lib/blog/content.ts");
    expect(filePaths).not.toContain("components/blog/post-card.tsx");
  });

  it("generates config with detected frontmatter mapping", async () => {
    const result = await connectToExistingBlog({
      rootDir: tmpDir,
      contentDir: "app/blog",
      frontmatterMapping: {
        title: "title",
        category: { key: "category", transform: "array" },
      },
      imageStorage: "jena-cdn",
    });

    const configFile = result.files.find((f) => f.path === "jena.config.ts");
    expect(configFile).toBeDefined();
    expect(configFile!.content).toContain("category");
    expect(configFile!.content).toContain("array");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/connect.test.ts
```
Expected: FAIL — `connectToExistingBlog` not found

- [ ] **Step 3: Write connect mode orchestrator**

Create `packages/create-mdx-blog/src/init/connect.ts`:

```typescript
import path from "node:path";
import type { GeneratedFile, FrontmatterMapping, JenaConfig } from "../types.js";
import { generateWebhookHandler } from "../adapters/delivery/webhook.js";

interface ConnectOptions {
  rootDir: string;
  contentDir: string;
  frontmatterMapping: FrontmatterMapping;
  imageStorage: "local" | "jena-cdn";
  siteName?: string;
  siteUrl?: string;
}

interface ConnectResult {
  files: GeneratedFile[];
  envVars: Record<string, string>;
}

export async function connectToExistingBlog(
  options: ConnectOptions,
): Promise<ConnectResult> {
  const {
    contentDir,
    frontmatterMapping,
    imageStorage,
    siteName = "",
    siteUrl = "",
  } = options;
  const files: GeneratedFile[] = [];

  // Generate webhook handler
  const webhookHandler = generateWebhookHandler({
    typescript: true,
    contentDir,
    imageStorage,
    localImageDir: "public/blog/images",
    localImagePublicPath: "/blog/images",
  });
  files.push({ path: "app/api/jena-webhook/route.ts", content: webhookHandler });

  // Generate config file
  const config: Partial<JenaConfig> = {
    blog: {
      contentDir,
      postsPerPage: 10,
      rss: false,
      categories: false,
      siteName,
      siteDescription: "",
      siteUrl,
    },
    jena: {
      apiKey: undefined,
      webhookSecret: undefined,
    },
    frontmatter: frontmatterMapping,
    images: { storage: imageStorage },
  };

  const configContent = generateConnectConfigFile(config);
  files.push({ path: "jena.config.ts", content: configContent });

  return { files, envVars: {} };
}

function generateConnectConfigFile(config: Partial<JenaConfig>): string {
  const configObj = {
    blog: config.blog,
    jena: {
      apiKey: "process.env.JENA_API_KEY",
      webhookSecret: "process.env.JENA_WEBHOOK_SECRET",
    },
    frontmatter: config.frontmatter ?? {},
    images: config.images ?? { storage: "jena-cdn" },
  };

  let json = JSON.stringify(configObj, null, 2);
  json = json.replace(/"process\.env\.(\w+)"/g, "process.env.$1");

  return `/**
 * Jena AI blog integration config.
 * Generated by create-mdx-blog (connect mode).
 */

interface JenaConfig {
  blog: {
    contentDir: string;
    postsPerPage: number;
    rss: boolean;
    categories: boolean;
    siteName: string;
    siteDescription: string;
    siteUrl: string;
  };
  jena?: {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
  };
  frontmatter: Record<
    string,
    string | { key: string; transform?: string; default?: string }
  >;
  images: {
    storage: "local" | "jena-cdn";
    localDir?: string;
    publicPath?: string;
  };
}

const config: JenaConfig = ${json};

export default config;
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/create-mdx-blog && pnpm test -- tests/connect.test.ts
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/create-mdx-blog/src/init/connect.ts packages/create-mdx-blog/tests/connect.test.ts
git commit -m "feat(create-mdx-blog): connect mode orchestrator for existing blogs"
```

---

### Task 15: CLI Entry Point

**Files:**
- Create: `packages/create-mdx-blog/src/cli.ts`

This wires together detection, prompts, and orchestrators into the `npx create-mdx-blog` command.

- [ ] **Step 1: Write CLI entry point**

Create `packages/create-mdx-blog/src/cli.ts`:

```typescript
#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import ora from "ora";
import * as ui from "./ui.js";
import { detectProject } from "./detect.js";
import { detectFrontmatter } from "./adapters/frontmatter/detect.js";
import {
  promptExistingBlogAction,
  promptBlogConfig,
  promptJenaConnection,
  promptFrontmatterConfirmation,
  buildFrontmatterMapping,
} from "./prompts/setup.js";
import { scaffoldBlog } from "./init/scaffold.js";
import { connectToExistingBlog } from "./init/connect.js";
import type { JenaConfig, FrontmatterMapping } from "./types.js";

async function main() {
  ui.banner();

  const rootDir = process.cwd();

  // Step 1: Detect project
  const spinner = ora("Detecting project...").start();
  let context;
  try {
    context = await detectProject(rootDir);
    spinner.succeed(
      `Next.js ${context.nextVersion} · ${context.typescript ? "TypeScript" : "JavaScript"} · ${context.tailwind ? "Tailwind" : "CSS"} · ${context.packageManager}`,
    );
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }

  // Step 2: Determine mode
  let mode: "scaffold" | "connect" = "scaffold";
  if (context.existingBlog) {
    mode = await promptExistingBlogAction(context.existingBlog);
  }

  if (mode === "connect") {
    await runConnectMode(rootDir, context);
  } else {
    await runScaffoldMode(rootDir, context);
  }
}

async function runScaffoldMode(
  rootDir: string,
  context: Awaited<ReturnType<typeof detectProject>>,
) {
  // Prompt for blog config
  const blogConfig = await promptBlogConfig();

  // Prompt for Jena AI connection
  const jena = await promptJenaConnection();

  const config: Partial<JenaConfig> = {
    blog: blogConfig,
    frontmatter: {
      title: "title",
      description: "description",
      date: "date",
      category: "category",
      image: "image",
      author: "author",
    },
    images: {
      storage: jena.connect ? "jena-cdn" : "local",
      localDir: "public/blog/images",
      publicPath: "/blog/images",
    },
  };

  if (jena.connect) {
    config.jena = {
      apiKey: undefined,
      webhookSecret: undefined,
    };
  }

  // Scaffold
  const spinner = ora("Scaffolding blog...").start();
  const result = await scaffoldBlog({
    rootDir,
    config,
    typescript: context.typescript,
    tailwind: context.tailwind,
    includeJena: jena.connect,
  });
  spinner.stop();

  // Write files
  const writtenFiles: string[] = [];
  for (const file of result.files) {
    const fullPath = path.join(rootDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    ui.created(file.path);
    writtenFiles.push(file.path);
  }

  // Write env vars
  const envEntries: string[] = [];
  if (jena.connect) {
    const webhookSecret = randomBytes(32).toString("base64");
    const envLines = [
      `JENA_API_KEY=${jena.apiKey ?? ""}`,
      `JENA_WEBHOOK_SECRET=${webhookSecret}`,
    ];

    appendEnvLocal(rootDir, envLines);
    envEntries.push("JENA_API_KEY", "JENA_WEBHOOK_SECRET");
    verifyGitignore(rootDir);
  }

  // Install dependencies if needed
  await installDepsIfNeeded(rootDir, context.packageManager);

  ui.summary(writtenFiles, envEntries);
}

async function runConnectMode(
  rootDir: string,
  context: Awaited<ReturnType<typeof detectProject>>,
) {
  const blog = context.existingBlog!;

  // Read existing posts and detect frontmatter
  const postContents = blog.postPaths.map((p) =>
    fs.readFileSync(path.join(rootDir, p), "utf-8"),
  );
  const schema = detectFrontmatter(postContents);
  blog.frontmatterSchema = schema;

  // Confirm frontmatter
  const confirmed = await promptFrontmatterConfirmation(schema);
  if (!confirmed) {
    ui.warn("Frontmatter mapping not confirmed. Please edit jena.config.ts manually after setup.");
  }

  const mapping = buildFrontmatterMapping(schema);

  // Connect
  const spinner = ora("Setting up Jena AI connection...").start();
  const result = await connectToExistingBlog({
    rootDir,
    contentDir: blog.contentDir,
    frontmatterMapping: mapping,
    imageStorage: "jena-cdn",
  });
  spinner.stop();

  // Write files
  const writtenFiles: string[] = [];
  for (const file of result.files) {
    const fullPath = path.join(rootDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    ui.created(file.path);
    writtenFiles.push(file.path);
  }

  // Write env vars
  const webhookSecret = randomBytes(32).toString("base64");
  appendEnvLocal(rootDir, [
    "JENA_API_KEY=",
    `JENA_WEBHOOK_SECRET=${webhookSecret}`,
  ]);
  verifyGitignore(rootDir);

  ui.summary(writtenFiles, ["JENA_API_KEY", "JENA_WEBHOOK_SECRET"]);
}

function appendEnvLocal(rootDir: string, lines: string[]): void {
  const envPath = path.join(rootDir, ".env.local");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";

  const newLines = lines.filter((line) => {
    const key = line.split("=")[0];
    return !existing.includes(`${key}=`);
  });

  if (newLines.length > 0) {
    const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
    const content = `${separator}# Jena AI Blog Integration\n${newLines.join("\n")}\n`;
    fs.appendFileSync(envPath, content);
  }
}

function verifyGitignore(rootDir: string): void {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, "utf-8");
  if (!content.includes(".env.local")) {
    ui.warn(
      ".env.local is not in .gitignore. Next.js ignores it by default, but double-check your .gitignore.",
    );
  }
}

async function installDepsIfNeeded(
  rootDir: string,
  packageManager: "npm" | "pnpm" | "yarn",
): Promise<void> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"),
  );
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const needed: string[] = [];
  if (!allDeps["gray-matter"]) needed.push("gray-matter");
  if (!allDeps["next-mdx-remote"]) needed.push("next-mdx-remote");

  if (needed.length === 0) return;

  ui.info(`Installing: ${needed.join(", ")}`);
  const { execSync } = await import("node:child_process");
  const cmd =
    packageManager === "pnpm"
      ? `pnpm add ${needed.join(" ")}`
      : packageManager === "yarn"
        ? `yarn add ${needed.join(" ")}`
        : `npm install ${needed.join(" ")}`;

  execSync(cmd, { cwd: rootDir, stdio: "pipe" });
}

main().catch((err) => {
  ui.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify**

```bash
cd packages/create-mdx-blog && pnpm build
```
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add packages/create-mdx-blog/src/cli.ts
git commit -m "feat(create-mdx-blog): CLI entry point wiring detection, prompts, and orchestrators"
```

---

### Task 16: Integration Tests

**Files:**
- Test: `packages/create-mdx-blog/tests/security.test.ts`

- [ ] **Step 1: Write security tests for generated webhook handler**

Create `packages/create-mdx-blog/tests/security.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scaffoldBlog } from "../src/init/scaffold.js";

describe("security", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("webhook handler contains HMAC validation", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: false,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        jena: { apiKey: undefined, webhookSecret: undefined },
        frontmatter: {},
        images: { storage: "jena-cdn" },
      },
      typescript: true,
      tailwind: true,
      includeJena: true,
    });

    const webhook = result.files.find((f) =>
      f.path.includes("jena-webhook"),
    );
    expect(webhook).toBeDefined();
    expect(webhook!.content).toContain("createHmac");
    expect(webhook!.content).toContain("timingSafeEqual");
    expect(webhook!.content).toContain("X-Jena-Signature");
  });

  it("webhook handler contains replay prevention", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: false,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        jena: { apiKey: undefined, webhookSecret: undefined },
        frontmatter: {},
        images: { storage: "jena-cdn" },
      },
      typescript: true,
      tailwind: true,
      includeJena: true,
    });

    const webhook = result.files.find((f) =>
      f.path.includes("jena-webhook"),
    );
    expect(webhook!.content).toContain("5 * 60 * 1000");
  });

  it("webhook handler contains slug sanitization", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: false,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        jena: { apiKey: undefined, webhookSecret: undefined },
        frontmatter: {},
        images: { storage: "jena-cdn" },
      },
      typescript: true,
      tailwind: true,
      includeJena: true,
    });

    const webhook = result.files.find((f) =>
      f.path.includes("jena-webhook"),
    );
    // Must strip non-alphanumeric characters
    expect(webhook!.content).toContain("[^a-z0-9-]");
    // Must check directory confinement
    expect(webhook!.content).toContain("startsWith");
  });

  it("config file does not contain raw secrets", async () => {
    const result = await scaffoldBlog({
      rootDir: tmpDir,
      config: {
        blog: {
          contentDir: "content/blog",
          postsPerPage: 10,
          rss: false,
          categories: false,
          siteName: "Test",
          siteDescription: "",
          siteUrl: "https://test.com",
        },
        jena: { apiKey: undefined, webhookSecret: undefined },
        frontmatter: {},
        images: { storage: "jena-cdn" },
      },
      typescript: true,
      tailwind: true,
      includeJena: true,
    });

    const configFile = result.files.find((f) => f.path === "jena.config.ts");
    expect(configFile).toBeDefined();
    // Secrets must reference env vars, not contain raw values
    expect(configFile!.content).toContain("process.env.JENA_API_KEY");
    expect(configFile!.content).toContain("process.env.JENA_WEBHOOK_SECRET");
    expect(configFile!.content).not.toMatch(/sk-[a-zA-Z0-9]/);
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
cd packages/create-mdx-blog && pnpm test
```
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/create-mdx-blog/tests/security.test.ts
git commit -m "test(create-mdx-blog): security tests for webhook handler and config generation"
```

---

### Task 17: Package Publishing Prep

**Files:**
- Modify: `packages/create-mdx-blog/package.json`

- [ ] **Step 1: Verify build produces correct output**

```bash
cd packages/create-mdx-blog && pnpm build && ls -la dist/
```
Expected: `cli.js` and other compiled files present

- [ ] **Step 2: Verify the bin entry runs**

```bash
cd packages/create-mdx-blog && node dist/cli.js --help 2>&1 || true
```
Expected: either help output or an error about not being in a Next.js project (both acceptable — it means the CLI loaded)

- [ ] **Step 3: Run full test suite one final time**

```bash
cd packages/create-mdx-blog && pnpm test
```
Expected: ALL PASS

- [ ] **Step 4: Commit final state**

```bash
git add packages/create-mdx-blog/
git commit -m "feat(create-mdx-blog): package ready for publishing"
```
