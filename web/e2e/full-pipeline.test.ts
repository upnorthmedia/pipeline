/**
 * The journey a first-time operator takes through the real UI: create a
 * profile, create a post against it, then read the surfaces that report what
 * the pipeline is doing.
 *
 * Everything here drives the shipped forms rather than the API, which is what
 * separates this file from `post-editor.test.ts` and `profile-flow.test.ts`:
 * those seed rows over HTTP and assert on the pages that render them, this one
 * asserts that the forms themselves reach the database.
 *
 * The rows it creates are deleted in `afterAll` over the same API. That is not
 * tidiness: `navigation.test.ts` asserts the posts list is empty, and Playwright
 * runs spec files in alphabetical order, so a post left behind by this file
 * would fail a different one.
 */
import { test, expect, request as apiRequest, type APIRequestContext } from "@playwright/test";

import { ABSENT_POST_ID } from "../src/test/absent-ids";
import { BASE_URL, STORAGE_STATE } from "./e2e-user";

/** Fixed strings so a leftover row from a killed run is identifiable. */
const PROFILE_NAME = "Full Pipeline Profile";
const PROFILE_URL = "https://full-pipeline.jena.test";
const POST_TOPIC = "Best AR-15 Optics for Every Budget";
const POST_SLUG = "best-ar-15-optics-for-every-budget";

/** The six stage dots `PipelineProgress` renders, in pipeline order. */
const STAGE_LABELS = ["Research", "Outline", "Write", "Edit", "Images", "Ready"];

/** The six tabs `/posts/[id]` renders, which name two stages differently. */
const TAB_LABELS = ["Research", "Outline", "Draft", "Editing", "Images", "Ready"];

let createdProfileId: string | null = null;
let createdPostId: string | null = null;

test.describe("Full pipeline journey", () => {
  // The post test needs the profile the first test creates: a post with no
  // profile is invisible to every read handler, because they all join through
  // `website_profiles` to reach `user_id`.
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    const context: APIRequestContext = await apiRequest.newContext({
      baseURL: BASE_URL,
      storageState: STORAGE_STATE,
    });
    // Posts first: `posts_profile_id_fkey` has no ON DELETE.
    if (createdPostId) await context.delete(`/api/posts/${createdPostId}`);
    if (createdProfileId) await context.delete(`/api/profiles/${createdProfileId}`);
    await context.dispose();
  });

  test("creates a profile from the dialog and lists it", async ({ page }) => {
    await page.goto("/profiles");
    await expect(page.getByRole("heading", { name: "Website Profiles" })).toBeVisible();

    await page.getByRole("button", { name: "New Profile" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.locator("#profile-name").fill(PROFILE_NAME);
    await page.locator("#profile-url").fill(PROFILE_URL);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // The dialog navigates to the new profile, so the id in the URL is proof
    // the row exists rather than proof the request was sent.
    await expect(page).toHaveURL(/\/profiles\/[0-9a-f-]{36}$/);
    createdProfileId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { name: PROFILE_NAME })).toBeVisible();

    await page.goto("/profiles");
    const row = page.getByRole("row").filter({ hasText: PROFILE_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText(PROFILE_URL);
  });

  test("creates a post from the new post form and opens its detail page", async ({
    page,
  }) => {
    await page.goto("/posts/new");
    await expect(page.getByRole("heading", { name: "New Post" })).toBeVisible();

    await page.getByLabel("Website profile").click();
    await page.getByRole("option", { name: PROFILE_NAME }).click();
    // Picking a profile prefills the form from its columns.
    await expect(page.locator("#websiteUrl")).toHaveValue(PROFILE_URL);

    await page.locator("#topic").fill(POST_TOPIC);
    await expect(page.locator("#slug")).toHaveValue(POST_SLUG);
    await page.getByRole("button", { name: "Create Post" }).click();

    await expect(page).toHaveURL(/\/posts\/[0-9a-f-]{36}$/);
    createdPostId = new URL(page.url()).pathname.split("/").pop()!;

    await expect(page.getByRole("heading", { name: POST_TOPIC })).toBeVisible();
    await expect(page.getByText(POST_SLUG, { exact: true })).toBeVisible();

    // `PipelineProgress` labels each dot "<stage>: <status>". The statuses are
    // not asserted because a worker may be running against the same Redis and
    // would move them; the six dots being on screen is what this test owns.
    for (const label of STAGE_LABELS) {
      await expect(page.getByLabel(new RegExp(`^${label}: `))).toBeVisible();
    }
    for (const label of TAB_LABELS) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible();
    }
  });

  test("the overview reports the queue counters", async ({ page }) => {
    await page.goto("/monitor");
    await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible();

    // Queue Controls is outside the has-posts branch, so it is the one part of
    // the overview an account with no posts still sees. Its four counters come
    // from `GET /api/queue`, which is the surface the deleted `/queue` page
    // test was reaching for.
    const queue = page.locator("[data-slot='card']").filter({ hasText: "Queue Controls" });
    await expect(queue).toBeVisible();
    for (const counter of ["Running:", "Pending:", "Paused:", "Failed:"]) {
      await expect(queue.getByText(counter, { exact: false }).first()).toBeVisible();
    }
    await expect(queue.getByRole("button", { name: "Pause All" })).toBeVisible();
    await expect(queue.getByRole("button", { name: "Resume All" })).toBeVisible();
  });

  test("the settings page shows one field per provider", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("API Keys", { exact: true })).toBeVisible();
    for (const provider of ["anthropic", "perplexity", "gemini"]) {
      await expect(page.locator(`#key-${provider}`)).toBeVisible();
    }
  });

  test("a post id that does not exist reads as a failure with a retry", async ({
    page,
  }) => {
    await page.goto(`/posts/${ABSENT_POST_ID}`);
    await expect(page.getByText("Could not load this post")).toBeVisible();
    // The reason is the handler's own `detail`, not a fallback string.
    await expect(page.getByText("Post not found")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("link", { name: "All posts" })).toBeVisible();
  });

  test("an unknown route renders the 404 page", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.getByText("Page not found")).toBeVisible();
    await page.getByRole("link", { name: "Back to Dashboard" }).click();
    await expect(page).toHaveURL("/");
  });
});
