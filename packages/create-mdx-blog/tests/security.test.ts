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
