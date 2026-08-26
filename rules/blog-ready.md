# Ready-stage invariants

The ready stage is deterministic code. It does not call a language model.

It receives final Markdown and a validated image manifest, then produces one Markdown document.

Required behavior:

1. Preserve one YAML frontmatter block and one article body.
2. Remove trailing workflow notes from legacy edit output.
3. Put the successful featured image URL and alt text in frontmatter only.
4. Insert every successful body image exactly once after its resolved heading.
5. Omit failed images.
6. Fail when a placement heading is missing or ambiguous.
7. Validate the assembled document before it can be saved or published.

Forbidden output:

- A second representation of the article
- WordPress source markup
- Workflow comments or notes
- Image placeholders
- Output filename headings
- Multiple frontmatter blocks
- Unresolved or duplicate image embeds

Publishing-target conversion happens after this stage in the relevant publisher.
