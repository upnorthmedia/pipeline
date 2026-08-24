/**
 * The post detail screen, against a real post owned by the e2e account.
 *
 * Every row here is created through the app's own API in `beforeAll` (see
 * `seed.ts`); nothing is stubbed with `page.route`, so a change to the post
 * serializer or to `computeAnalytics` fails these tests instead of passing
 * against a hand-written fixture.
 */
import { test, expect } from "@playwright/test"

import { BASE_URL, STORAGE_STATE } from "./e2e-user"
import { seedPost, seedProfile, type SeededPost } from "./seed"

const RESEARCH = "# Research Output\n\nKeyword analysis for the post editor spec.\n"
const OUTLINE = "# Outline\n\n## Introduction\n\nWhat the article opens with.\n\n## Conclusion\n"
const DRAFT = "# Draft\n\nThe first pass at the body copy.\n"
const FINAL_MD = "# Final Post\n\nThe edited body copy, which is what analytics measures.\n"
const READY = "# Ready Post\n\nThe assembled article, images and all.\n"

/** The post every test but the export kill check loads. */
let post: SeededPost
/** A post with no stage output, which is what makes the export assertion mean something. */
let emptyPost: SeededPost

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
  })

  const profile = await seedProfile(request, {
    name: "E2E Post Editor Site",
    website_url: "https://post-editor.jena.test",
  })

  post = await seedPost(
    request,
    {
      slug: "e2e-post-editor",
      topic: "E2E Post Editor Topic",
      profile_id: profile.id,
      related_keywords: ["post editor"],
      website_url: "https://post-editor.jena.test",
    },
    {
      research_content: RESEARCH,
      outline_content: OUTLINE,
      draft_content: DRAFT,
      final_md_content: FINAL_MD,
      final_html_content: "<h1>Final Post</h1>",
      ready_content: READY,
    },
  )

  emptyPost = await seedPost(request, {
    slug: "e2e-post-editor-empty",
    topic: "E2E Post Editor Empty Topic",
    profile_id: profile.id,
  })

  await request.dispose()
})

test.describe("Post Editor", () => {
  test("post detail page loads with the topic and one tab per stage", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)

    await expect(page.getByRole("heading", { name: post.topic })).toBeVisible()

    // STAGE_LABELS in src/app/posts/[id]/page.tsx, one per entry of STAGES.
    for (const label of ["Research", "Outline", "Draft", "Editing", "Images", "Ready"]) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible()
    }
  })

  test("editor pane renders CodeMirror holding the stage content", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)

    await expect(page.locator("[data-testid='markdown-editor']")).toBeVisible()
    await expect(page.locator(".cm-editor")).toBeVisible()
    await expect(page.locator(".cm-content")).toContainText(
      "Keyword analysis for the post editor spec.",
    )
  })

  test("the ready tab renders the preview pane", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)

    // `content-preview` is only mounted for the ready stage: every other tab
    // shows the editor alone.
    await expect(page.locator("[data-testid='content-preview']")).toHaveCount(0)

    await page.getByRole("tab", { name: "Ready" }).click()
    await expect(page.locator("[data-testid='content-preview']")).toBeVisible()
  })

  test("stage tabs switch content", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)

    // The card title, not the same words inside the markdown the editor holds.
    const cardTitle = page.locator("[data-slot='card-title']")
    await expect(cardTitle.filter({ hasText: "Research Output" })).toBeVisible()
    await expect(page.locator(".cm-content")).toContainText("Keyword analysis")

    await page.getByRole("tab", { name: "Outline" }).click()
    await expect(cardTitle.filter({ hasText: "Outline Output" })).toBeVisible()
    await expect(page.locator(".cm-content")).toContainText("What the article opens with.")
  })

  test("analytics bar displays the numbers the API computed", async ({ page }) => {
    const measured = await (await page.request.get(`/api/posts/${post.id}/analytics`)).json()

    await page.goto(`/posts/${post.id}`)

    const bar = page.locator("[data-testid='analytics-bar']")
    await expect(bar).toBeVisible()

    // Each Stat is a div holding a label paragraph then a value paragraph, so
    // the value is read per stat rather than as a substring of the whole bar:
    // "target: 2,000" and the other three stats would otherwise satisfy almost
    // any number.
    const statValue = (label: string) =>
      bar
        .locator("div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .last()
        .locator("p")
        .nth(1)

    // AnalyticsBar's own formatting: toLocaleString() and toFixed(1).
    await expect(statValue("Words")).toHaveText(measured.word_count.toLocaleString())
    await expect(statValue("Flesch Score")).toHaveText(
      measured.flesch_reading_ease.toFixed(1),
    )
  })

  test("export button is present only when there is content to export", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)
    await expect(page.locator("[data-testid='export-button']")).toBeVisible()

    // Same screen, no stage output: `POST /api/posts` starts a run, so this
    // post is not `neverRan`, it simply has nothing exportable in it yet.
    await page.goto(`/posts/${emptyPost.id}`)
    await expect(page.getByRole("heading", { name: emptyPost.topic })).toBeVisible()
    await expect(page.locator("[data-testid='export-button']")).toHaveCount(0)
  })

  test("back button navigates to posts list", async ({ page }) => {
    await page.goto(`/posts/${post.id}`)
    await expect(page.getByRole("heading", { name: post.topic })).toBeVisible()

    // Scoped to `main`, because the sidebar's Posts link is also href="/".
    await page.locator("main a[href='/']").first().click()
    await expect(page).toHaveURL("/")
  })
})
