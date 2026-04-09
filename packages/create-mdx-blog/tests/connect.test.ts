import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { connectToExistingBlog } from "../src/init/connect.js";

describe("connectToExistingBlog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-test-"));
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
