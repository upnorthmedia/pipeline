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
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-minimal"));
    expect(["npm", "pnpm", "yarn"]).toContain(ctx.packageManager);
  });

  it("detects shadcn from components/ui directory", async () => {
    const ctx = await detectProject(path.join(FIXTURES, "nextjs-minimal"));
    expect(ctx.shadcn).toBe(false);
  });
});
