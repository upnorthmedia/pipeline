import { describe, expect, it } from "vitest"

import { hasUrlCredentials, stripUrlCredentials } from "./url-credentials"

describe("hasUrlCredentials", () => {
  it("finds a username and password in front of the host", () => {
    expect(hasUrlCredentials("https://admin:hunter2@example.com/blog")).toBe(true)
  })

  it("finds a username on its own", () => {
    expect(hasUrlCredentials("https://admin@example.com")).toBe(true)
  })

  it("reads a bare @ as no credential, the way the WHATWG parser does", () => {
    expect(new URL("https://@example.com").username).toBe("")
    expect(hasUrlCredentials("https://@example.com")).toBe(false)
  })

  it("answers false for a plain URL, an unparseable one, and nothing", () => {
    expect(hasUrlCredentials("https://example.com/blog?a=1#b")).toBe(false)
    expect(hasUrlCredentials("example.com")).toBe(false)
    expect(hasUrlCredentials("")).toBe(false)
    expect(hasUrlCredentials(null)).toBe(false)
    expect(hasUrlCredentials(undefined)).toBe(false)
  })

  it("is not fooled by an @ that sits after the authority", () => {
    expect(hasUrlCredentials("https://example.com/mail@host")).toBe(false)
  })
})

describe("stripUrlCredentials", () => {
  it("removes the userinfo and leaves the rest of the URL byte for byte", () => {
    expect(stripUrlCredentials("https://admin:hunter2@example.com")).toBe("https://example.com")
    expect(stripUrlCredentials("https://admin:hunter2@example.com/blog/")).toBe(
      "https://example.com/blog/",
    )
    expect(stripUrlCredentials("http://u:p@example.com:8080/a?b=1#c")).toBe(
      "http://example.com:8080/a?b=1#c",
    )
  })

  it("does not normalise a URL it has nothing to strip from", () => {
    expect(stripUrlCredentials("https://example.com")).toBe("https://example.com")
    expect(stripUrlCredentials("https://example.com/mail@host")).toBe(
      "https://example.com/mail@host",
    )
    expect(stripUrlCredentials("example.com")).toBe("example.com")
    expect(stripUrlCredentials("")).toBe("")
  })

  it("keeps the last @ of an escaped password as the boundary", () => {
    // `%40` is how the parser carries an @ inside the password itself, so the
    // authority's own @ is the last one before the path.
    expect(stripUrlCredentials("https://admin:p%40ss@example.com/x")).toBe("https://example.com/x")
  })

  it("produces a value the write endpoints accept", () => {
    const cleaned = stripUrlCredentials("https://admin:hunter2@example.com/blog")
    expect(hasUrlCredentials(cleaned)).toBe(false)
  })
})
