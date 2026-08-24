/**
 * WordPress writes its REST error messages for a browser, not for an API
 * client: the translated strings behind `rest_*` codes and everything
 * `wp_die()` produces carry `<strong>`, anchors and curly quotes written as
 * numeric character references. The dashboard relays those messages verbatim
 * because the install's own sentence is the only thing that says what it
 * objected to, and React escapes what it renders, so the tags arrive as
 * literal text in front of the user.
 *
 * This is the one place that turns such a message back into the sentence it
 * was meant to be. It is a display-layer function: nothing here decides
 * anything, and no caller may feed the result back into markup.
 */

/**
 * Only the entities a WordPress message realistically carries. An unknown one
 * is left written as it was rather than guessed at, so a message is never
 * silently changed into a different message.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Written as escapes so the table is unambiguous next to the ASCII entries
  // above: every value here is exactly the one character the entity names.
  nbsp: "\u00a0",
  hellip: "\u2026",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ndash: "\u2013",
  mdash: "\u2014",
}

function decodeReference(whole: string, reference: string): string {
  if (!reference.startsWith("#")) {
    return NAMED_ENTITIES[reference.toLowerCase()] ?? whole
  }
  const hex = reference[1] === "x" || reference[1] === "X"
  const code = Number.parseInt(hex ? reference.slice(2) : reference.slice(1), hex ? 16 : 10)
  if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return whole
  return String.fromCodePoint(code)
}

/**
 * Strip tags, decode character references, and collapse the whitespace a
 * stripped block tag leaves behind. Tags are matched only when they close, so
 * a bare `<` in a sentence survives.
 */
export function plainMessage(message: string): string {
  return message
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, decodeReference)
    .replace(/\s+/g, " ")
    .trim()
}
