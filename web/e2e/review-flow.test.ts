import { test, expect } from "@playwright/test";

const mockReviewPost = {
  id: "review-post-1",
  slug: "review-test",
  topic: "Post Awaiting Review",
  profile_id: null,
  target_audience: "General",
  niche: "Tech",
  intent: "informational",
  word_count: 2000,
  tone: "Conversational",
  output_format: "both",
  website_url: null,
  related_keywords: [],
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
  current_stage: "outline",
  stage_status: {
    research: "complete",
    outline: "review",
  },
  stage_logs: {},
  thread_id: null,
  priority: 5,
  research_content: "Research output here",
  outline_content: "Outline content ready for review. This is a test outline with sections.",
  draft_content: null,
  final_md_content: null,
  final_html_content: null,
  image_manifest: null,
  created_at: "2025-01-15T10:00:00Z",
  updated_at: "2025-01-15T12:00:00Z",
  completed_at: null,
};

const mockQueueStatus = {
  running: 0,
  pending: 1,
  review: 1,
  complete: 5,
  failed: 0,
  paused: 0,
  total: 7,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/queue/review", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([mockReviewPost]),
    });
  });

  await page.route("**/api/queue", async (route) => {
    if (route.request().url().endsWith("/api/queue")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockQueueStatus),
      });
    } else {
      await route.continue();
    }
  });

  await page.route("**/api/posts/review-post-1/approve", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
  });

  await page.route("**/api/posts/review-post-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockReviewPost),
    });
  });

  await page.route("**/api/posts/review-post-1/analytics", async (route) => {
    await route.fulfill({ status: 404 });
  });

  await page.route("**/api/events/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
  });

  await page.route("**/api/events", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
  });
});

test("review queue page loads", async ({ page }) => {
  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Review Queue" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("1 post awaiting review")).toBeVisible({ timeout: 10000 });
});

test("review queue shows post topic", async ({ page }) => {
  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Review Queue" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Post Awaiting Review").first()).toBeVisible({ timeout: 10000 });
});

test("review queue shows approve button", async ({ page }) => {
  await page.goto("/queue");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 10000 });
});

test("monitor page loads with stats", async ({ page }) => {
  await page.goto("/monitor");
  await expect(page.getByRole("heading", { name: "Queue Monitor" })).toBeVisible({ timeout: 10000 });
  // Mock queue status: running=0, pending=1, review=1, complete=5
  await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("5").first()).toBeVisible({ timeout: 10000 });
});

test("monitor shows queue controls", async ({ page }) => {
  await page.goto("/monitor");
  await expect(page.getByRole("button", { name: "Pause All" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: "Resume All" })).toBeVisible({ timeout: 10000 });
});
