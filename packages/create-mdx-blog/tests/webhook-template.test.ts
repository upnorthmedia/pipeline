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

    expect(result).toContain("X-Jena-Signature");
    expect(result).toContain("createHmac");
    expect(result).toContain("timingSafeEqual");
    expect(result).toContain("timestamp");
    expect(result).toContain("5 * 60 * 1000");
    expect(result).toContain("/[^a-z0-9-]/g");
    expect(result).toContain("startsWith");
    expect(result).toContain("POST");
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

    expect(result).not.toContain("download_url");
  });
});
