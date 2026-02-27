import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("homepage loads with sidebar and posts table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1:has-text('Posts')")).toBeVisible();
    await expect(page.locator("aside").locator("text=Pipeline").first()).toBeVisible();
    await expect(page.locator("th:has-text('Topic')")).toBeVisible();
    await expect(page.locator("th:has-text('Stage')")).toBeVisible();
    await expect(page.locator("th:has-text('Progress')")).toBeVisible();
  });

  test("sidebar navigation items are visible", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside");
    await expect(sidebar.getByText("Posts", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Profiles", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Queue", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Monitor", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Settings", { exact: true })).toBeVisible();
  });

  test("navigates to profiles page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Profiles", { exact: true }).click();
    await expect(page).toHaveURL("/profiles");
    await expect(page.getByRole("heading", { name: "Website Profiles" })).toBeVisible();
  });

  test("navigates to queue page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Queue", { exact: true }).click();
    await expect(page).toHaveURL("/queue");
    await expect(page.getByRole("heading", { name: "Review Queue" })).toBeVisible();
  });

  test("navigates to monitor page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Monitor", { exact: true }).click();
    await expect(page).toHaveURL("/monitor");
    await expect(page.getByRole("heading", { name: "Queue Monitor" })).toBeVisible();
  });

  test("navigates to settings page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Settings", { exact: true }).click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("navigates to new post page via button", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "New Post" }).click();
    await expect(page).toHaveURL("/posts/new");
    await expect(page.getByRole("heading", { name: "New Post" })).toBeVisible();
  });

  test("new post form renders all sections", async ({ page }) => {
    await page.goto("/posts/new");
    await expect(page.getByText("Website Profile", { exact: true }).first()).toBeVisible();
    await expect(page.locator("[data-slot='card-title']:has-text('Content')")).toBeVisible();
    await expect(page.getByText("Writing Config", { exact: true })).toBeVisible();
    await expect(page.getByText("SEO & Research", { exact: true })).toBeVisible();
    await expect(page.getByText("Pipeline Settings", { exact: true })).toBeVisible();
  });

  test("new post form has required inputs", async ({ page }) => {
    await page.goto("/posts/new");
    await expect(page.locator("#topic")).toBeVisible();
    await expect(page.locator("#slug")).toBeVisible();
  });

  test("auto-generates slug from topic input", async ({ page }) => {
    await page.goto("/posts/new");
    await page.locator("#topic").fill("Best AR-15 Optics for Every Budget");
    await expect(page.locator("#slug")).toHaveValue(
      "best-ar-15-optics-for-every-budget"
    );
  });

  test("back button on new post navigates home", async ({ page }) => {
    await page.goto("/posts/new");
    await page.locator("a[href='/']").first().click();
    await expect(page).toHaveURL("/");
  });

  test("empty state shows when no posts", async ({ page }) => {
    await page.goto("/");
    // Without API, the table should show empty state
    await expect(page.getByText("No posts found")).toBeVisible({ timeout: 5000 });
  });

  test("search input is functional", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.locator("input[placeholder='Search posts...']");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("test search");
    await expect(searchInput).toHaveValue("test search");
  });

  test("all pages load without errors", async ({ page }) => {
    const routes = ["/", "/profiles", "/queue", "/monitor", "/settings", "/posts/new"];
    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(400);
    }
  });
});
