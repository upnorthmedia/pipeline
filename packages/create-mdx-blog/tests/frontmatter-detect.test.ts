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
    expect(schema.fields.author.required).toBe(false);
    expect(schema.fields.image.required).toBe(false);
  });

  it("detects mixed types for same field across posts", () => {
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
