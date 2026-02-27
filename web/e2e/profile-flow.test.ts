import { test, expect } from "@playwright/test";

const mockProfile = {
  id: "test-prof-1",
  name: "Test Website",
  website_url: "https://test-website.com",
  niche: "Technology",
  target_audience: "Developers",
  tone: "Professional",
  brand_voice: null,
  word_count: 2000,
  output_format: "both",
  image_style: null,
  image_brand_colors: [],
  image_exclude: [],
  avoid: null,
  required_mentions: null,
  related_keywords: ["react", "typescript"],
  default_stage_settings: {
    research: "review",
    outline: "review",
    write: "review",
    edit: "review",
    images: "review",
  },
  sitemap_urls: [],
  last_crawled_at: null,
  crawl_status: "idle",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const mockLinks = [
  {
    id: "link-1",
    profile_id: "test-prof-1",
    url: "https://test-website.com/page-1",
    title: "Page One",
    slug: "page-1",
    source: "sitemap",
    post_id: null,
    keywords: [],
    created_at: "2025-01-01T00:00:00Z",
  },
];

test.describe("Profile Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/profiles", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([mockProfile]),
        });
      } else if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(mockProfile),
        });
      } else {
        await route.continue();
      }
    });

    await page.route("**/api/profiles/test-prof-1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockProfile),
      });
    });

    await page.route("**/api/profiles/test-prof-1/links**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockLinks),
      });
    });

    await page.route("**/api/profiles/test-prof-1/crawl", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "crawling" }),
      });
    });

    await page.route("**/api/events/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    });

    await page.route("**/api/events", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    });
  });

  test("profiles page loads and shows profiles", async ({ page }) => {
    await page.goto("/profiles");

    await expect(
      page.getByRole("heading", { name: "Website Profiles" })
    ).toBeVisible();

    await expect(page.getByText("Test Website")).toBeVisible({
      timeout: 10000,
    });
  });

  test("profile detail page loads", async ({ page }) => {
    await page.goto("/profiles/test-prof-1");

    await expect(
      page.getByRole("heading", { name: "Test Website" })
    ).toBeVisible({ timeout: 15000 });

    await expect(
      page.getByText("https://test-website.com").first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("profile detail shows internal links", async ({ page }) => {
    await page.goto("/profiles/test-prof-1");
    // Wait for profile to load first
    await expect(page.getByText("Test Website").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("Internal Links").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByText("https://test-website.com/page-1").first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("profile detail shows settings form", async ({ page }) => {
    await page.goto("/profiles/test-prof-1");
    // Wait for profile to load first
    await expect(page.getByText("Test Website").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("Profile Settings").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#name")).toHaveValue("Test Website", {
      timeout: 10000,
    });
  });

  test("navigate from profiles list to detail", async ({ page }) => {
    await page.goto("/profiles");

    await page.getByText("Test Website").click();

    await expect(page).toHaveURL("/profiles/test-prof-1");
  });
});
