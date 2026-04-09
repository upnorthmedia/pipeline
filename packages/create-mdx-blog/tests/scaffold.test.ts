import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scaffoldBlog } from "../src/init/scaffold.js";

describe("scaffoldBlog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
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
