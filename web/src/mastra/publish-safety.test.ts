// @vitest-environment node
import { describe, expect, it } from "vitest"

import {
  findPublishArtifacts,
  validateImageManifestForPublish,
  validatePublishContent,
} from "./publish-safety"

describe("publish content safety", () => {
  it.each([
    ["fenced frontmatter", "```yaml\n---\ntitle: Bad\n---\n```"],
    ["WordPress format separator", "Valid paragraph\n\n---WORDPRESS_HTML---"],
    ["publishing notes", "<!-- PUBLISHING NOTES: leaked -->"],
    ["writing notes", "<!-- WRITING NOTES: leaked -->"],
    ["image placeholder", "[IMAGE: diagram goes here]"],
    ["Gutenberg source block", "<!-- wp:image -->"],
    ["draft filename heading", "# 03-draft.md"],
    ["multiple frontmatter blocks", "---\ntitle: One\n---\n\n---\ntitle: Two\n---"],
  ])("detects %s", (label, content) => {
    expect(findPublishArtifacts(content)).toContain(label)
    expect(() => validatePublishContent(content)).toThrow(`unsafe publish content: ${label}`)
  })

  it("accepts one normal frontmatter block", () => {
    const content = "---\ntitle: Safe\n---\n\n# Safe\n\nBody."
    expect(findPublishArtifacts(content)).toEqual([])
    expect(() => validatePublishContent(content)).not.toThrow()
  })

  it("accepts a thematic separator after normal frontmatter", () => {
    const content = "---\ntitle: Safe\n---\n\n# Safe\n\nIntro.\n\n---\n\nConclusion."
    expect(findPublishArtifacts(content)).toEqual([])
    expect(() => validatePublishContent(content)).not.toThrow()
  })

  it("blocks an unapproved generated image that requires review", () => {
    expect(() =>
      validateImageManifestForPublish({
        images: [
          {
            id: "technical-diagram",
            generated: true,
            human_review_required: true,
            human_review_approved: false,
          },
        ],
      }),
    ).toThrow("image requires human technical review before publish: technical-diagram")
  })
})
