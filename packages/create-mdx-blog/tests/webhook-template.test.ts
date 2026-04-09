import { describe, it, expect } from "vitest";
import { generateWebhookHandler } from "../src/adapters/delivery/webhook.js";

describe("generateWebhookHandler", () => {
  it("generates a webhook handler that commits via GitHub API", () => {
    const result = generateWebhookHandler({
      typescript: true,
      contentDir: "content/blog",
      imageStorage: "jena-cdn",
      localImageDir: "public/blog/images",
      localImagePublicPath: "/blog/images",
    });

    // HMAC validation
    expect(result).toContain("X-Jena-Signature");
    expect(result).toContain("createHmac");
    expect(result).toContain("timingSafeEqual");

    // Timestamp validation
    expect(result).toContain("5 * 60 * 1000");

    // Slug sanitization
    expect(result).toContain("/[^a-z0-9-]/g");

    // GitHub API commit (not filesystem)
    expect(result).toContain("GITHUB_TOKEN");
    expect(result).toContain("GITHUB_REPO");
    expect(result).toContain("commitToGitHub");
    expect(result).toContain("api.github.com");
    expect(result).not.toContain("fs.writeFile");

    // Test event handling
    expect(result).toContain('payload.event === "test"');

    // POST handler export
    expect(result).toContain("export async function POST");
  });

  it("uses configured content directory", () => {
    const result = generateWebhookHandler({
      typescript: true,
      contentDir: "app/blog",
      imageStorage: "jena-cdn",
      localImageDir: "public/blog/images",
      localImagePublicPath: "/blog/images",
    });

    expect(result).toContain("app/blog");
  });
});
