/**
 * `_parse_manifest` from `api/src/pipeline/stages/images.py` ported to
 * TypeScript.
 *
 * This is the only thing between Claude's prose-wrapped answer and the
 * `image_manifest` JSONB column, and the stage branches on the `error` key it
 * synthesises, so the port has to agree with Python on the unparseable inputs
 * as well as the parseable ones. Three primitives do not survive a naive
 * translation:
 *
 * * `str.strip()` uses Python's whitespace class, which omits `﻿` and
 *   includes `\x1c`-`\x1f` and `\x85`, where `String.trim()` does the reverse,
 * * `\s` inside the fenced-block pattern is that same Python class,
 * * `.` under `re.DOTALL` matches every character, which is `[\s\S]` here
 *   rather than `.`, whose JavaScript exclusions are wider than Python's.
 *
 * One divergence is not repaired: `json.loads` accepts the `NaN`, `Infinity`
 * and `-Infinity` literals and `JSON.parse` rejects them, so a manifest
 * carrying one parses in Python and falls back here. Reproducing it would mean
 * hand-rolling a JSON parser for output no image model asks for.
 */
import { PY_WHITESPACE, pythonStrip } from "../textstat"

/**
 * `json.loads` is not constrained to objects, so a model that answers with a
 * bare array or scalar gets that value through rather than the fallback. The
 * Python annotation claims `dict` and is wrong; the step is what narrows this.
 */
export type ParsedManifest = unknown

const FENCED_BLOCK = new RegExp(`\`\`\`(?:json)?[${PY_WHITESPACE}]*\\n([\\s\\S]*?)\\n\`\`\``, "u")

const PARSE_FAILED = Symbol("parse failed")

function loads(text: string): ParsedManifest | typeof PARSE_FAILED {
  try {
    return JSON.parse(text)
  } catch {
    return PARSE_FAILED
  }
}

/** `_parse_manifest`: pull the image manifest JSON out of a Claude response. */
export function parseManifest(content: string): ParsedManifest {
  let text = pythonStrip(content)

  // Claude wraps the manifest in a fenced block and often adds commentary
  // after it, so prefer the first fenced block over the whole response.
  const fenced = FENCED_BLOCK.exec(text)
  if (fenced) {
    text = fenced[1]
  } else if (text.startsWith("```")) {
    text = text
      .split("\n")
      .filter((line) => !pythonStrip(line).startsWith("```"))
      .join("\n")
  }

  const direct = loads(text)
  if (direct !== PARSE_FAILED) return direct

  // Last resort: the outermost JSON object embedded in surrounding prose.
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start !== -1 && end > start) {
    const embedded = loads(text.slice(start, end + 1))
    if (embedded !== PARSE_FAILED) return embedded
  }

  return { images: [], style_brief: {}, error: "Failed to parse manifest" }
}
