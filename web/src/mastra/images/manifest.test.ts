/**
 * Parity tests for the `_parse_manifest` port (ledger item 3.5a).
 *
 * Both golden fixtures captured a bare-JSON manifest, so they only exercise one
 * of this function's four branches. `data/manifest-parity.json`, written by
 * `api/scripts/export_manifest_parity.py` by calling Python's
 * `_parse_manifest` directly, covers the other three plus the whitespace and
 * `json.loads` edges where the two languages disagree.
 *
 * The oracle stores Python's result as a JSON string rather than as a value, so
 * comparison happens after both sides have been through a JSON parse. That is
 * deliberate: `json.dumps` writes Python's `1.0` float as `1.0` and its exact
 * 20-digit int in full, neither of which a JavaScript number can hold, and
 * normalising both sides through `JSON.parse` compares the values the port will
 * actually write to `image_manifest` rather than their spellings.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { parseManifest } from "./manifest"

interface ParityCase {
  name: string
  why: string
  input: string
  expected: string
}

interface DivergenceCase {
  name: string
  why: string
  input: string
  python_repr: string
}

interface ParityData {
  generated_by: string
  source: string
  cases: ParityCase[]
  divergences: DivergenceCase[]
}

const parity: ParityData = JSON.parse(
  readFileSync(path.join(__dirname, "data", "manifest-parity.json"), "utf8"),
)

const FALLBACK = { images: [], style_brief: {}, error: "Failed to parse manifest" }

describe("parseManifest", () => {
  it("has a corpus covering every branch, both golden manifests included", () => {
    expect(parity.source).toBe("api/src/pipeline/stages/images.py::_parse_manifest")
    expect(parity.cases.filter((c) => c.name.startsWith("golden/"))).toHaveLength(2)
    expect(parity.cases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(parity.cases.map((c) => [c.name, c] as const))(
    "matches Python on %s",
    (_name, testCase) => {
      expect(parseManifest(testCase.input)).toEqual(JSON.parse(testCase.expected))
    },
  )

  it("parses both golden manifests into the shape the images stage iterates", () => {
    const golden = parity.cases.filter((c) => c.name.startsWith("golden/"))
    for (const testCase of golden) {
      const manifest = parseManifest(testCase.input) as {
        error?: unknown
        images: { prompt: string; filename: string; type?: string; placement?: unknown }[]
      }
      expect(manifest.error).toBeUndefined()
      expect(manifest.images.length).toBeGreaterThan(0)
      for (const image of manifest.images) {
        expect(typeof image.prompt).toBe("string")
        expect(typeof image.filename).toBe("string")
      }
      expect(manifest.images.filter((i) => i.type === "featured")).toHaveLength(1)
    }
  })

  /**
   * `images_node` tests `image_spec.get("placement") == "featured"` before it
   * tests `type`, and in both real manifests `placement` is an object
   * (`{location, after_section}`), so that first comparison is always false and
   * the `2K`/`16:9` override behind it is unreachable. The featured image in
   * the fixtures got `2K`/`16:9` because the manifest asked for them. Item 3.5e
   * has to port the dead branch anyway, but this pins why it never fires.
   */
  it("records that placement is an object in both golden manifests, never the string featured", () => {
    const golden = parity.cases.filter((c) => c.name.startsWith("golden/"))
    for (const testCase of golden) {
      const manifest = parseManifest(testCase.input) as {
        images: { type?: string; placement?: unknown; image_size?: string; aspect_ratio?: string }[]
      }
      for (const image of manifest.images) {
        expect(image.placement).toBeTypeOf("object")
        expect(image.placement).not.toBe("featured")
      }
      const featured = manifest.images.find((i) => i.type === "featured")
      expect(featured).toBeDefined()
      expect(featured?.image_size).toBe("2K")
      expect(featured?.aspect_ratio).toBe("16:9")
    }
  })

  it("returns a fresh fallback object so a caller cannot poison the next parse", () => {
    const first = parseManifest("not json") as Record<string, unknown>
    expect(first).toEqual(FALLBACK)
    first.error = "mutated"
    expect(parseManifest("also not json")).toEqual(FALLBACK)
  })

  it.each(parity.divergences.map((c) => [c.name, c] as const))(
    "falls back on %s, which Python parses (recorded divergence)",
    (_name, testCase) => {
      expect(testCase.python_repr).toContain("images")
      expect(parseManifest(testCase.input)).toEqual(FALLBACK)
    },
  )
})
