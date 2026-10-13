/**
 * Parity tests for the pure metadata helpers of the WordPress publish hook
 * (ledger item 5.3c-iii-b-1-c-i).
 *
 * The oracle in `data/wp-publish-metadata-parity.json` is written by
 * `api/scripts/export_wp_publish_metadata_parity.py`. Its frontmatter half
 * calls the real `_extract_frontmatter`; its manifest half pulls the
 * manifest-indexing block out of `publish_to_wordpress` with
 * `inspect.getsource` and executes it, so the recorded answers cannot drift
 * from the function they describe without the export failing loudly. Nothing
 * in this file asserts a hand-written expectation except the two structural
 * checks at the top and the two prototype-safety checks.
 *
 * Both maps arrive as pair lists rather than JSON objects because `__proto__`
 * is an ordinary key on the Python side and does not survive a round trip
 * through a JavaScript object literal.
 */
import { describe, expect, it } from "vitest"

import parity from "./data/wp-publish-metadata-parity.json"
import { extractFrontmatter, indexManifestImages } from "./publish-metadata"

interface FrontmatterCase {
  name: string
  input: string
  meta: [string, string][]
  body: string
}

interface ManifestCase {
  name: string
  input: Record<string, unknown> | null
  byFile: [string, Record<string, unknown>][]
  featuredFilename: string | null
}

const frontmatterCases = parity.frontmatter as FrontmatterCase[]
const manifestCases = parity.manifests as ManifestCase[]

describe("the wp-publish-metadata oracle", () => {
  it("was generated from the real publish hook", () => {
    expect(parity.manifestBlockSource).toContain("manifest = post.image_manifest or {}")
    expect(parity.manifestBlockSource).toContain("featured_filename = fname")
    expect(frontmatterCases.length).toBeGreaterThanOrEqual(40)
    expect(manifestCases.length).toBeGreaterThanOrEqual(19)
  })

  it("covers both a parsed and an unparsed frontmatter block", () => {
    const parsed = frontmatterCases.filter((c) => c.meta.length > 0)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.length).toBeLessThan(frontmatterCases.length)
    expect(manifestCases.some((c) => c.featuredFilename !== null)).toBe(true)
    expect(manifestCases.some((c) => c.featuredFilename === null)).toBe(true)
  })
})

describe("extractFrontmatter", () => {
  it.each(frontmatterCases.map((c) => [c.name, c] as const))(
    "matches Python on %s",
    (_name, testCase) => {
      const { meta, body } = extractFrontmatter(testCase.input)
      expect([...meta]).toEqual(testCase.meta)
      expect(body).toBe(testCase.body)
    },
  )

  it("keeps the frontmatter keys off the prototype", () => {
    const { meta } = extractFrontmatter("---\n__proto__: pwned\n---\nBody.\n")
    expect(meta.get("__proto__")).toBe("pwned")
    expect(({} as Record<string, unknown>).pwned).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty("pwned")
  })
})

describe("indexManifestImages", () => {
  it.each(manifestCases.map((c) => [c.name, c] as const))(
    "matches Python on %s",
    (_name, testCase) => {
      const { byFile, featuredFilename } = indexManifestImages(testCase.input)
      expect([...byFile]).toEqual(testCase.byFile)
      expect(featuredFilename).toBe(testCase.featuredFilename)
    },
  )

  it("keeps a prototype-shaped filename off the prototype", () => {
    const { byFile } = indexManifestImages({
      images: [{ url: "/media/p1/__proto__", alt_text: "pwned" }],
    })
    expect(byFile.get("__proto__")).toEqual({ url: "/media/p1/__proto__", alt_text: "pwned" })
    expect(({} as Record<string, unknown>).alt_text).toBeUndefined()
  })

  it("marks a filename featured even when a later inline entry replaces its record", () => {
    const { byFile, featuredFilename } = indexManifestImages({
      images: [
        { url: "/media/p1/a.webp", placement: "featured" },
        { url: "/media/p2/a.webp", placement: "inline" },
      ],
    })
    expect(featuredFilename).toBe("a.webp")
    expect(byFile.get("a.webp")).toEqual({ url: "/media/p2/a.webp", placement: "inline" })
  })
})
