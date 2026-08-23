/**
 * `detail = response.json().get("error", response.text[:200])` and the
 * `f"Webhook returned {status}: {detail}"` that renders it, from
 * `test_nextjs_connection` in `api/src/api/nextjs.py`.
 *
 * The whole expression sits behind a bare `except Exception`, so three
 * different failures collapse onto the truncated response text: a body that is
 * not JSON at all, a body that is JSON but not an object (`None.get` and
 * `list.get` both raise `AttributeError`), and a JSON object with no `error`
 * key, which is the documented `.get` default rather than an exception.
 *
 * Only a string `error` is handed to the f-string unchanged. Anything else goes
 * through `str()`, which is why `None` renders as `None` rather than `null` and
 * why a nested list or object renders with Python's `repr` quoting.
 *
 * Known divergence: JSON has one number type and `JSON.parse` erases Python's
 * int/float split, so `{"error": 1.0}` renders `1` here where Python renders
 * `1.0`. Every other number, including one with a fractional part, matches.
 */

/** `str(x)` for a value that came out of `json.loads`. */
export function pythonStr(value: unknown): string {
  return typeof value === "string" ? value : pythonRepr(value)
}

/** `repr(x)` for a value that came out of `json.loads`. */
function pythonRepr(value: unknown): string {
  if (value === null) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return stringRepr(value)
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${stringRepr(key)}: ${pythonRepr(item)}`)
    .join(", ")}}`
}

/**
 * `repr` of a string picks the quote character rather than always escaping:
 * single quotes normally, double quotes when the string contains a single quote
 * and no double quote, and single quotes with the apostrophes escaped when it
 * contains both. Backslashes are always doubled.
 */
function stringRepr(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\")
  if (value.includes("'") && !value.includes('"')) return `"${escaped}"`
  return `'${escaped.replace(/'/g, "\\'")}'`
}

/** The `detail` half of the message, given the webhook's response body. */
export function webhookDetail(text: string): string {
  const truncated = text.slice(0, 200)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return truncated
  }
  // `.get` exists on dicts only: Python raised `AttributeError` for a JSON
  // `null`, list or scalar and its `except` swallowed that into the same
  // fallback the `.get` default produces. Only `null` needs its own branch,
  // because an array parsed from JSON can never carry an `error` key and so
  // reaches the fallback through the `in` check anyway.
  if (parsed === null || typeof parsed !== "object") return truncated
  const record = parsed as Record<string, unknown>
  return "error" in record ? pythonStr(record.error) : truncated
}
