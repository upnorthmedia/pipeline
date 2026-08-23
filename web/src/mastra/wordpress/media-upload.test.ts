// @vitest-environment node
/**
 * Parity tests for the upload loop of the WordPress publish hook (ledger item
 * 5.3c-iii-b-1-c-ii-3).
 *
 * The oracle in `data/wp-media-upload-parity.json` is written by
 * `api/scripts/export_media_upload_parity.py`, which pulls the twenty upload
 * lines and the two rewrite lines out of the real `publish_to_wordpress` with
 * `inspect.getsource` and executes them against the same case table this file
 * rebuilds, with the same real files on disk and a recording stand-in for the
 * WordPress client. Nothing here asserts a hand-written expectation except the
 * provenance checks and the naive-port controls at the end.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import parity from "./data/wp-media-upload-parity.json"
import {
  rewriteImageUrls,
  sweepMediaDirectory,
  uploadMediaFiles,
  type MediaUploader,
} from "./media-upload"
import { COMMON_TYPES, TYPES_MAP } from "./mimetypes"
import type { ManifestImageIndex } from "./publish-metadata"

interface FileSpec {
  name: string
  bytes: string
  mime: string | null
}

interface UploadCall {
  bytes: string
  filename: string
  mime: string
  alt_text: unknown
}

interface UploadCase {
  name: string
  files: FileSpec[]
  manifest_by_file: Record<string, Record<string, unknown>>
  featured_filename: string | null
  title: string
  post_id: string
  html: string
  responses: Record<string, unknown>
  raises?: string
  expected: {
    uploads: UploadCall[]
    image_map?: [string, unknown][]
    featured_media_id?: unknown
    html?: string
    raises?: string
    message?: string
  }
}

// The inferred JSON type unions every case shape, so the widening goes
// through `unknown` rather than pretending the two overlap.
const cases = parity.cases as unknown as UploadCase[]

/** The `_FakeClient` of the export script: it records and it answers. */
class RecordingUploader implements MediaUploader {
  readonly calls: UploadCall[] = []

  constructor(private readonly responses: Record<string, unknown>) {}

  async uploadMedia(
    imageBytes: Uint8Array<ArrayBuffer>,
    filename: string,
    mimeType: string,
    altText: unknown,
  ): Promise<unknown> {
    this.calls.push({
      bytes: Buffer.from(imageBytes).toString("hex"),
      filename,
      mime: mimeType,
      alt_text: altText,
    })
    return this.responses[filename]
  }
}

const indexOf = (testCase: UploadCase): ManifestImageIndex => ({
  byFile: new Map(Object.entries(testCase.manifest_by_file)),
  featuredFilename: testCase.featured_filename,
})

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "wp-media-upload-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** Writes a case's files and returns them in the order the case lists them. */
async function build(testCase: UploadCase) {
  const files = []
  for (const spec of testCase.files) {
    const target = path.join(scratch, spec.name)
    await writeFile(target, Buffer.from(spec.bytes, "hex"))
    files.push({ name: spec.name, path: Buffer.from(target) })
  }
  return files
}

describe("the upload loop matches publish_to_wordpress", () => {
  it("was generated from the real function", () => {
    expect(parity.source).toBe("api/src/pipeline/publish.py::publish_to_wordpress")
    expect(parity.loop_body).toContain("media = await client.upload_media(")
    expect(parity.loop_body).toContain('alt = img_info.get("alt_text", title)')
    expect(parity.rewrite_body).toBe(
      "for local, remote in image_map.items():\n    wp_html = wp_html.replace(local, remote)",
    )
    expect(cases.length).toBeGreaterThan(20)
  })

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const files = await build(testCase)
      const client = new RecordingUploader(testCase.responses)
      const options = {
        postId: testCase.post_id,
        title: testCase.title,
        manifest: indexOf(testCase),
        client,
      }

      if (testCase.expected.raises) {
        // The loop and the rewrite are one statement in Python, so which of
        // the two raises is part of what the oracle records: the uploads that
        // happened before it are asserted either way.
        await expect(
          uploadMediaFiles(files, options).then((result) =>
            rewriteImageUrls(testCase.html, result.imageMap),
          ),
        ).rejects.toThrow(testCase.expected.message)
        expect(client.calls).toEqual(testCase.expected.uploads)
        return
      }

      const result = await uploadMediaFiles(files, options)
      expect(client.calls).toEqual(testCase.expected.uploads)
      expect([...result.imageMap]).toEqual(testCase.expected.image_map)
      expect(result.featuredMediaId).toEqual(testCase.expected.featured_media_id ?? null)
      expect(rewriteImageUrls(testCase.html, result.imageMap)).toBe(testCase.expected.html)
    })
  }
})

describe("the sweep composes the walk, the filter and the loop", () => {
  it("uploads only the images in the directory, in Python's order", async () => {
    await writeFile(path.join(scratch, "b.png"), Buffer.from("89504e47", "hex"))
    await writeFile(path.join(scratch, "a.jpg"), Buffer.from("ffd8ffe0", "hex"))
    await writeFile(path.join(scratch, "notes.txt"), "hi")
    // The images stage writes `.webp`, which the deployed table does not know:
    // see the oracle case of the same name and the entry in `todo.md`.
    await writeFile(path.join(scratch, "c.webp"), Buffer.from("52494646", "hex"))

    const client = new RecordingUploader({
      "a.jpg": { id: 1, source_url: "https://wp.example/a.jpg" },
      "b.png": { id: 2, source_url: "https://wp.example/b.png" },
    })
    const result = await sweepMediaDirectory(scratch, {
      postId: "p1",
      title: "T",
      manifest: { byFile: new Map(), featuredFilename: null },
      client,
    })

    expect(client.calls.map((call) => call.filename)).toEqual(["a.jpg", "b.png"])
    expect(result.featuredMediaId).toBe(1)
    expect([...result.imageMap.keys()]).toEqual(["/media/p1/a.jpg", "/media/p1/b.png"])
  })

  it("uploads nothing when the media directory does not exist", async () => {
    const client = new RecordingUploader({})
    const result = await sweepMediaDirectory(path.join(scratch, "missing"), {
      postId: "p1",
      title: "T",
      manifest: { byFile: new Map(), featuredFilename: null },
      client,
    })

    expect(client.calls).toEqual([])
    expect(result).toEqual({ imageMap: new Map(), featuredMediaId: null })
  })
})

describe("the naive ports the oracle rules out", () => {
  const manifest = (entry: Record<string, unknown>): ManifestImageIndex => ({
    byFile: new Map([["a.png", entry]]),
    featuredFilename: null,
  })

  it("does not treat a null alt_text as absent, which `??` would", async () => {
    await writeFile(path.join(scratch, "a.png"), Buffer.from("89504e47", "hex"))
    const client = new RecordingUploader({ "a.png": { id: 1, source_url: "u" } })
    await uploadMediaFiles([{ name: "a.png", path: Buffer.from(path.join(scratch, "a.png")) }], {
      postId: "p1",
      title: "the title",
      manifest: manifest({ alt_text: null }),
      client,
    })
    expect(client.calls[0].alt_text).toBeNull()
  })

  it("does not read alt_text off a prototype, which `in` would", async () => {
    await writeFile(path.join(scratch, "a.png"), Buffer.from("89504e47", "hex"))
    const client = new RecordingUploader({ "a.png": { id: 1, source_url: "u" } })
    // Unreachable from a JSONB column, since `JSON.parse` gives every key as
    // an own property: `Object.hasOwn` is depth rather than a fix. Pinned so
    // that a later caller which builds entries some other way cannot leak a
    // prototype value into the alt text.
    const entry = Object.create({ alt_text: "injected" }) as Record<string, unknown>
    await uploadMediaFiles([{ name: "a.png", path: Buffer.from(path.join(scratch, "a.png")) }], {
      postId: "p1",
      title: "the title",
      manifest: manifest(entry),
      client,
    })
    expect(client.calls[0].alt_text).toBe("the title")
  })

  it("has no mime type whose 'image/' is not a prefix", () => {
    // `startsWith` and `includes` are the same test over this table, which is
    // why the mutation that swaps them is equivalent rather than uncaught.
    for (const type of TYPES_MAP.values()) {
      expect(type.indexOf("image/")).toBeLessThanOrEqual(0)
    }
    for (const type of COMMON_TYPES.values()) {
      expect(type.indexOf("image/")).toBeLessThanOrEqual(0)
    }
  })

  it("inserts a source_url holding $& literally, which replaceAll would not", () => {
    const map = new Map<string, unknown>([["/media/p1/a.png", "https://wp.example/$&.png"]])
    const html = '<img src="/media/p1/a.png"/>'
    expect(rewriteImageUrls(html, map)).toBe('<img src="https://wp.example/$&.png"/>')
    expect(html.replaceAll("/media/p1/a.png", "https://wp.example/$&.png")).not.toBe(
      rewriteImageUrls(html, map),
    )
  })

  it("raises at the rewrite, not at the upload, for a non-string source_url", () => {
    const map = new Map<string, unknown>([["/media/p1/a.png", 7]])
    expect(() => rewriteImageUrls("<p/>", map)).toThrow(
      "replace() argument 2 must be str, not int",
    )
  })
})
