import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("homepage loads with sidebar and posts table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1:has-text('Posts')")).toBeVisible();
    await expect(page.locator("aside").getByText("Content Crew")).toBeVisible();
    await expect(page.locator("th:has-text('Topic')")).toBeVisible();
    await expect(page.locator("th:has-text('Stage')")).toBeVisible();
    await expect(page.locator("th:has-text('Progress')")).toBeVisible();
  });

  test("sidebar navigation items are visible", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside");
    await expect(sidebar.getByText("Posts", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Profiles", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Observability", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Account", { exact: true })).toBeVisible();
  });

  test("navigates to profiles page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Profiles", { exact: true }).click();
    await expect(page).toHaveURL("/profiles");
    await expect(page.getByRole("heading", { name: "Website Profiles" })).toBeVisible();
  });

  test("navigates to monitor page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Observability", { exact: true }).click();
    await expect(page).toHaveURL("/monitor");
    await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible();
  });

  test("navigates to the account page", async ({ page }) => {
    await page.goto("/");
    await page.locator("aside").getByText("Account", { exact: true }).click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    // The boundary the page states, checked in a real browser: the account
    // page names where per-site settings live and links straight to them.
    await page.getByRole("link", { name: "Website profiles" }).click();
    await expect(page).toHaveURL("/profiles");
    // Scoped to `main`, because the sidebar's own Account link is also
    // href="/settings".
    await expect(
      page.locator("main").getByRole("link", { name: "Account" })
    ).toBeVisible();
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
    await expect(page.locator("[data-slot='card-title']:has-text('Pipeline')")).toBeVisible();
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
    // auth.setup.ts deletes the e2e account's posts, so the list starts empty.
    await expect(page.getByText("No posts yet")).toBeVisible({ timeout: 5000 });
  });

  test("search input is functional", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.locator("input[placeholder='Search posts...']");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("test search");
    await expect(searchInput).toHaveValue("test search");
  });

  test("the waiting for review filter reaches the server", async ({ page }) => {
    // The gate queue is the one filter that does not go out as `status`, so
    // this is the case that proves the whole path: the option, the
    // `awaiting_review` parameter and the jsonb predicate behind it. A filter
    // the route handler choked on would render the "Could not load posts"
    // panel instead. auth.setup.ts leaves the e2e account with no posts.
    await page.goto("/");
    await page.getByRole("combobox", { name: "Filter posts by state" }).click();
    await page.getByRole("option", { name: "Waiting for review" }).click();
    await expect(page.getByText("Nothing is waiting for your review")).toBeVisible();
    await expect(page.getByText("0 posts waiting for your review")).toBeVisible();
  });

  test("all pages load without errors", async ({ page }) => {
    const routes = ["/", "/profiles", "/monitor", "/settings", "/posts/new"];
    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(400);
    }
  });
});
