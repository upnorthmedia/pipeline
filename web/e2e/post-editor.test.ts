import { test, expect } from "@playwright/test";

const mockPost = {
  id: "test-post-1",
  slug: "test-post",
  topic: "Test Blog Post Topic",
  profile_id: null,
  target_audience: "developers",
  niche: "technology",
  intent: "informational",
  word_count: 2000,
  tone: "Conversational",
  output_format: "both",
  website_url: null,
  related_keywords: ["test keyword"],
  competitor_urls: [],
  image_style: null,
  image_brand_colors: [],
  image_exclude: [],
  brand_voice: null,
  avoid: null,
  required_mentions: null,
  stage_settings: {
    research: "review",
    outline: "review",
    write: "review",
    edit: "review",
    images: "review",
  },
  current_stage: "edit",
  stage_status: {
    research: "complete",
    outline: "complete",
    write: "complete",
    edit: "review",
  },
  stage_logs: {},
  thread_id: null,
  priority: 5,
  research_content: "# Research Output\n\nKeyword analysis here.",
  outline_content:
    "# Outline\n\n## Introduction\n## Section 1\n## Conclusion",
  draft_content:
    "# Test Blog Post\n\nThis is the draft content.\n\n## Section One\n\nBody text.",
  final_md_content: "# Final Post\n\nFinal markdown content here.",
  final_html_content: "<h1>Final Post</h1><p>Final HTML content</p>",
  image_manifest: null,
  created_at: "2025-01-15T10:00:00Z",
  updated_at: "2025-01-15T12:00:00Z",
  completed_at: null,
};

const mockAnalytics = {
  word_count: 1250,
  sentence_count: 58,
  paragraph_count: 12,
  avg_sentence_length: 18.5,
  flesch_reading_ease: 65.2,
  keyword_density: { "test keyword": 1.4 },
  seo_checklist: {
    title_contains_keyword: true,
    meta_description: false,
    h1_keyword: true,
  },
};

test.describe("Post Editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/posts/test-post-1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockPost),
      });
    });

    await page.route("**/api/posts/test-post-1/analytics", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockAnalytics),
      });
    });

    await page.route("**/api/events/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    });
  });

  test("post detail page loads with editor and stage tabs", async ({
    page,
  }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.getByText("Test Blog Post Topic")).toBeVisible({
      timeout: 10000,
    });

    // Stage tabs use STAGE_LABELS: Research, Outline, Draft, Final, Images
    await expect(page.getByRole("tab", { name: "Research" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Outline" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Draft" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Final" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Images" })).toBeVisible();
  });

  test("editor pane renders CodeMirror", async ({ page }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.locator("[data-testid='markdown-editor']")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".cm-editor")).toBeVisible();
  });

  test("preview pane renders", async ({ page }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.locator("[data-testid='content-preview']")).toBeVisible({
      timeout: 10000,
    });
  });

  test("stage tabs switch content", async ({ page }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.locator("[data-testid='markdown-editor']")).toBeVisible({
      timeout: 10000,
    });

    // Switch to Research tab
    await page.getByRole("tab", { name: "Research" }).click();
    await expect(
      page.getByRole("heading", { name: "Research Output" })
    ).toBeVisible();

    // Switch to Outline tab
    await page.getByRole("tab", { name: "Outline" }).click();
    await expect(
      page.getByRole("heading", { name: "Introduction" })
    ).toBeVisible();
  });

  test("analytics bar displays metrics", async ({ page }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.getByText("1,250")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("65.2")).toBeVisible();
    await expect(page.getByText("Words", { exact: true })).toBeVisible();
    await expect(page.getByText("Flesch Score")).toBeVisible();
  });

  test("export button is present when final content exists", async ({
    page,
  }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.locator("[data-testid='export-button']")).toBeVisible({
      timeout: 10000,
    });
  });

  test("back button navigates to posts list", async ({ page }) => {
    await page.goto("/posts/test-post-1");

    await expect(page.getByText("Test Blog Post Topic")).toBeVisible({
      timeout: 10000,
    });

    await page.locator("a[href='/']").first().click();
    await expect(page).toHaveURL("/");
  });
});
