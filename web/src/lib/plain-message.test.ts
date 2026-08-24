import { describe, expect, it } from "vitest"

import { plainMessage } from "./plain-message"

/**
 * The strings below are what a real WordPress 6.x install answered, copied
 * from the responses recorded while ledger item P1.3a made these failures
 * visible at all. They are the reason this module exists: the dashboard has
 * nothing better than the install's own sentence, and React escapes it.
 */
describe("plainMessage", () => {
  it("drops the markup WordPress puts in an authentication failure", () => {
    expect(
      plainMessage(
        "WordPress API error: <strong>Error:</strong> Unknown username. " +
          "Check again or try your email address.",
      ),
    ).toBe(
      "WordPress API error: Error: Unknown username. " +
        "Check again or try your email address.",
    )
  })

  it("keeps the text of a link and drops the anchor", () => {
    expect(
      plainMessage('Go to <a href="https://wp.example/wp-login.php">Log in</a>.'),
    ).toBe("Go to Log in.")
  })

  it("decodes the numeric entity WordPress uses for an apostrophe", () => {
    expect(plainMessage("You don&#8217;t have permission.")).toBe(
      "You don’t have permission.",
    )
  })

  it("decodes the named entities a translated string carries", () => {
    expect(plainMessage("Sorry &amp; goodbye&hellip;")).toBe(
      "Sorry & goodbye…",
    )
  })

  it("decodes a hexadecimal character reference", () => {
    expect(plainMessage("caf&#xe9;")).toBe("café")
  })

  it("collapses the whitespace stripping a block tag leaves behind", () => {
    expect(plainMessage("<p>First line.</p>\n<p>Second line.</p>")).toBe(
      "First line. Second line.",
    )
  })

  it("leaves a message with no markup exactly as it was", () => {
    const message = "Connection refused: is the site reachable from here?"
    expect(plainMessage(message)).toBe(message)
  })

  it("leaves a lone angle bracket alone", () => {
    // No closing bracket, so there is no tag to strip and nothing to guess at.
    expect(plainMessage("Expected count < 10")).toBe("Expected count < 10")
  })

  it("leaves an entity it does not know written as it was", () => {
    expect(plainMessage("100 &deg; and &#xzz;")).toBe("100 &deg; and &#xzz;")
  })
})
