// @vitest-environment node
/**
 * The pure half of the crawl job's port: the slug derivation and the duplicate
 * fold (ledger item 5.2c-ii-1). The database and HTTP half is
 * `../workflows/sitemap-crawl.test.ts`.
 *
 * `data/crawl-slug-parity.json` is the oracle, produced by running the exact
 * expression `crawl_profile_sitemap` uses under the `api/` interpreter:
 *
 * ```py
 * parsed = urlparse(u)
 * path = parsed.path.strip("/")
 * slug = path.split("/")[-1] if path else None
 * ```
 *
 * Both halves are asserted, `path` as well as `slug`, because `urlPath` is
 * where the two implementations can diverge: `new URL()` throws on three of
 * these inputs, so the port cannot use it and has to reproduce `urlparse`'s
 * splitting by hand.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { SitemapEntry } from "../sitemap"
import { foldEntries, slugFromUrl, urlPath } from "./sitemap-crawl"

interface SlugCase {
  url: string
  path: string
  slug: string | null
}

const oracle = JSON.parse(
  readFileSync(path.join(__dirname, "data", "crawl-slug-parity.json"), "utf-8"),
) as { python_version: string; cases: SlugCase[] }

function entry(url: string, title: string | null = null): SitemapEntry {
  return { url, title, lastmod: null }
}

describe("the slug derivation", () => {
  it("has an oracle covering every shape the job can meet", () => {
    expect(oracle.cases.length).toBe(16)
  })

  it.each(oracle.cases)("matches urlparse on $url", ({ url, path: expected }) => {
    expect(urlPath(url)).toBe(expected)
  })

  it.each(oracle.cases)("derives Python's slug for $url", ({ url, slug }) => {
    expect(slugFromUrl(url)).toBe(slug)
  })
})

const PROFILE = "00000000-0000-4000-8000-0000000005c2"

describe("folding entries into rows", () => {
  it("keeps one row per URL", () => {
    const rows = foldEntries(PROFILE, [
      entry("https://example.com/a"),
      entry("https://example.com/b"),
      entry("https://example.com/a"),
    ])

    expect(rows.map((row) => row.url)).toEqual(["https://example.com/a", "https://example.com/b"])
  })

  /**
   * Python's `if entry.title:` per duplicate, so the last entry that carries a
   * title wins and one that does not carry a title changes nothing.
   */
  it("takes the last truthy title among duplicates", () => {
    const [row] = foldEntries(PROFILE, [
      entry("https://example.com/a", "first"),
      entry("https://example.com/a", null),
      entry("https://example.com/a", "third"),
      entry("https://example.com/a", ""),
    ])

    expect(row.title).toBe("third")
  })

  it("leaves the title null when no duplicate carries one", () => {
    const [row] = foldEntries(PROFILE, [entry("https://example.com/a"), entry("https://example.com/a")])

    expect(row.title).toBeNull()
  })

  it("carries the profile id and the derived slug onto every row", () => {
    const rows = foldEntries(PROFILE, [entry("https://example.com/blog/deep/leaf"), entry("https://example.com/")])

    expect(rows).toEqual([
      {
        profileId: PROFILE,
        url: "https://example.com/blog/deep/leaf",
        title: null,
        slug: "leaf",
      },
      { profileId: PROFILE, url: "https://example.com/", title: null, slug: null },
    ])
  })

  it("folds nothing into nothing", () => {
    expect(foldEntries(PROFILE, [])).toEqual([])
  })
})
