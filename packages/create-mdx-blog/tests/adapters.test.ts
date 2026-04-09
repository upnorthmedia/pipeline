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
