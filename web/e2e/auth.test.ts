import { test, expect } from "@playwright/test"

/**
 * The precondition every other spec rests on.
 *
 * If the `setup` project's storage state stops being applied, the suite does
 * not error: `src/middleware.ts` quietly serves the sign-in page for every
 * route, and each spec fails on whatever dashboard element it happened to name
 * first. These two tests fail with the actual reason instead.
 */
test.describe("Authenticated session", () => {
  test("the stored session reaches the dashboard without a redirect", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL("/")
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible()
  })

  // The kill check for the test above: without the stored cookie the same
  // navigation lands on the sign-in page, so passing it means something.
  test("a request with no session is redirected to sign-in", async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await anonymous.newPage()

    await page.goto("/")
    await expect(page).toHaveURL(/\/auth\/sign-in/)

    await anonymous.close()
  })
})
