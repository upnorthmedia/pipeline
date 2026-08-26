// @vitest-environment node
import { describe, expect, it } from "vitest"

import { assembleReadyContent } from "./ready"

const FINAL_MD = [
  "---",
  'title: "Best AR15 Optics"',
  'keywords: "ar15, optics"',
  "---",
  "",
  "# Best AR15 Optics",
  "",
  "Intro paragraph.",
  "",
  "## Budget Picks",
  "",
  "Budget content here.",
  "",
  "---",
  "",
  "<!--",
  "PUBLISHING NOTES",
  "Meta Description: Find the best AR15 optics.",
  "-->",
  "",
].join("\n")

const MANIFEST = {
  images: [
    {
      id: "featured",
      type: "featured",
      url: "/media/post-123/featured.webp",
      alt_text: "AR15 with mounted optic",
      placement: { location: "featured_image" },
      generated: true,
    },
    {
      id: "content-1",
      type: "content",
      url: "/media/post-123/budget.webp",
      alt_text: "Budget AR15 optics comparison",
      placement: { location: "after_heading", after_section: "Budget Picks" },
      generated: true,
    },
  ],
}

describe("deterministic ready assembly", () => {
  it("removes notes, updates featured metadata, and inserts each generated image once", () => {
    const result = assembleReadyContent(FINAL_MD, MANIFEST)

    expect(result).not.toContain("PUBLISHING NOTES")
    expect(result).not.toContain("WORDPRESS_HTML")
    expect(result).toContain('featuredImage: "/media/post-123/featured.webp"')
    expect(result).toContain('featuredImageAlt: "AR15 with mounted optic"')
    expect(result).toContain(
      "## Budget Picks\n\n![Budget AR15 optics comparison](/media/post-123/budget.webp)",
    )
    expect(result.match(/\/media\/post-123\/budget\.webp/g)).toHaveLength(1)
  })

  it("does not duplicate an image already present in edited markdown", () => {
    const image = "![Budget AR15 optics comparison](/media/post-123/budget.webp)"
    const result = assembleReadyContent(FINAL_MD.replace("Budget content here.", `${image}\n\nBudget content here.`), MANIFEST)

    expect(result.split(image)).toHaveLength(2)
  })

  it("fails closed when a generated inline image has no matching heading", () => {
    expect(() =>
      assembleReadyContent(FINAL_MD, {
        images: [
          {
            id: "missing-target",
            generated: true,
            url: "/media/post-123/missing.webp",
            alt_text: "Missing",
            placement: { location: "after_heading", after_section: "Not Present" },
          },
        ],
      }),
    ).toThrow("image missing-target target heading not found: Not Present")
  })
})
