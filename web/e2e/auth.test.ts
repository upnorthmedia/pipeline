import { test, expect } from "@playwright/test"

/**
 * The precondition every other spec rests on.
 *
 * If the `setup` project's storage state stops being applied, the suite does
 * not error: `src/proxy.ts` quietly serves the sign-in page for every
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

/**
 * What a visitor sees before they have an account. Every route redirects here,
 * so this page is the whole product until it is answered.
 */
test.describe("Signed-out pages", () => {
  test("the sign-in page offers no navigation that bounces back to itself", async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await anonymous.newPage()

    await page.goto("/auth/sign-in")
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible()

    // The four app destinations, none of which a visitor can reach.
    for (const name of ["Posts", "Profiles", "Observability", "Account"]) {
      await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0)
    }
    await expect(page.locator("aside")).toHaveCount(0)

    // What is left has to name the product: the sidebar was the only thing on
    // this page that did.
    await expect(page.getByText("Content Crew", { exact: true })).toBeVisible()

    await anonymous.close()
  })

  // The sign-up card is 466px tall. The signed-out frame used to be
  // `fixed inset-0`, which cannot scroll, so on a short viewport the last
  // control was off the bottom of a page that would not move.
  test("the sign-up form is reachable on a short viewport", async ({ browser }) => {
    const anonymous = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 900, height: 420 },
    })
    const page = await anonymous.newPage()

    await page.goto("/auth/sign-up")
    const signIn = page.getByRole("link", { name: "Sign In" })
    await expect(signIn).toHaveCount(1)

    await signIn.scrollIntoViewIfNeeded()
    await expect(signIn).toBeInViewport()

    await anonymous.close()
  })
})
