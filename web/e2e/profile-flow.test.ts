/**
 * The profiles list and the profile detail screen, against a real profile owned
 * by the e2e account.
 *
 * As with `post-editor.test.ts`, the rows are seeded through the app's own API
 * rather than faked with `page.route`, so the assertions run against the
 * profile serializer and the links handler rather than against a fixture.
 */
import { test, expect } from "@playwright/test"

import { BASE_URL, STORAGE_STATE } from "./e2e-user"
import { seedLink, seedProfile, type SeededProfile } from "./seed"

const PROFILE_NAME = "E2E Profile Flow Site"
const PROFILE_URL = "https://profile-flow.jena.test"
const LINK_URL = `${PROFILE_URL}/page-one`

let profile: SeededProfile

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
  })

  profile = await seedProfile(request, {
    name: PROFILE_NAME,
    website_url: PROFILE_URL,
    niche: "Technology",
    target_audience: "Developers",
    related_keywords: ["react", "typescript"],
  })

  await seedLink(request, profile.id, { url: LINK_URL, title: "Page One", slug: "page-one" })

  await request.dispose()
})

test.describe("Profile Flow", () => {
  test("profiles page loads and shows profiles", async ({ page }) => {
    await page.goto("/profiles")

    await expect(page.getByRole("heading", { name: "Website Profiles" })).toBeVisible()
    await expect(page.getByText(PROFILE_NAME)).toBeVisible()
  })

  test("profile detail page loads", async ({ page }) => {
    await page.goto(`/profiles/${profile.id}`)

    await expect(page.getByRole("heading", { name: PROFILE_NAME })).toBeVisible()
    await expect(page.getByText(PROFILE_URL).first()).toBeVisible()
  })

  test("profile detail shows internal links", async ({ page }) => {
    await page.goto(`/profiles/${profile.id}`)

    await expect(page.getByText("Internal Links").first()).toBeVisible()
    await expect(page.getByRole("link", { name: LINK_URL })).toBeVisible()
    await expect(page.getByText("Page One")).toBeVisible()
  })

  test("profile detail shows settings form", async ({ page }) => {
    await page.goto(`/profiles/${profile.id}`)

    await expect(page.getByText("Profile Settings").first()).toBeVisible()
    await expect(page.locator("#name")).toHaveValue(PROFILE_NAME)
    await expect(page.locator("#websiteUrl")).toHaveValue(PROFILE_URL)
  })

  test("navigate from profiles list to detail", async ({ page }) => {
    await page.goto("/profiles")

    await page.getByText(PROFILE_NAME).click()

    await expect(page).toHaveURL(`/profiles/${profile.id}`)
  })
})
