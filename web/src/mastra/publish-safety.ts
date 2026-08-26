const FORBIDDEN_PATTERNS: [string, RegExp][] = [
  ["fenced frontmatter", /^```(?:ya?ml)?\s*\n---/i],
  ["WordPress format separator", /WORDPRESS_HTML/i],
  ["publishing notes", /PUBLISHING NOTES/i],
  ["writing notes", /WRITING NOTES/i],
  ["image placeholder", /\[IMAGE:/i],
  ["Gutenberg source block", /<!--\s*\/?wp:/i],
  ["draft filename heading", /^#{1,6}\s+03-draft\.md\s*$/m],
]

export function findPublishArtifacts(content: string): string[] {
  const found = FORBIDDEN_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(
    ([label]) => label,
  )
  const delimiters = content.match(/^---\s*$/gm) ?? []
  if ((content.startsWith("---") && delimiters.length < 2) || delimiters.length >= 4) {
    found.push("multiple frontmatter blocks")
  }
  return found
}

export function validatePublishContent(content: string): void {
  const [artifact] = findPublishArtifacts(content)
  if (artifact) throw new Error(`unsafe publish content: ${artifact}`)
}

export function validateImageManifestForPublish(manifest: unknown): void {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return
  const images = (manifest as Record<string, unknown>).images
  if (!Array.isArray(images)) return
  for (const image of images) {
    if (typeof image !== "object" || image === null || Array.isArray(image)) continue
    const entry = image as Record<string, unknown>
    if (!entry.generated) continue
    if (entry.human_review_required && !entry.human_review_approved) {
      const id = entry.id || entry.url || "unknown image"
      throw new Error(`image requires human technical review before publish: ${String(id)}`)
    }
  }
}
