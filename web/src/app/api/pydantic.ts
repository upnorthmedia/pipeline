/**
 * The pieces of pydantic behaviour every ported write endpoint needs: its lax
 * scalar coercions and the 422 body FastAPI answered a bad request with.
 *
 * This started life inside `profiles/validation.ts` and moved here when the
 * post handlers needed the same rules. Nothing router-specific belongs in this
 * file: a field list or a column mapping lives next to the router that owns it.
 *
 * Every shape here was read off a real pydantic model rather than assumed, and
 * only the `type`/`loc`/`msg`/`input` keys are reproduced. pydantic's `ctx` and
 * `url` keys are not, and nothing in `web/src/lib/api.ts` reads them.
 */
import { z } from "zod"

/**
 * An unconstrained `dict` field. Both stacks land these in a jsonb or json
 * column, so the value shape is not narrowed here either. A `$type` on the
 * column is a convention the writers follow, not a check the database makes.
 */
export const jsonObject = z.record(z.string(), z.unknown())

/**
 * pydantic's lax mode parses an `int` out of a string that holds nothing but an
 * optionally signed run of digits, surrounding whitespace allowed, and rejects
 * anything else. A float is accepted only when it is integral, which
 * `z.number().int()` already enforces.
 */
const INTEGRAL_STRING = /^[+-]?\d+$/

export const pydanticInt = z.preprocess(
  (value) =>
    typeof value === "string" && INTEGRAL_STRING.test(value.trim()) ? Number(value) : value,
  z.number().int(),
)

/**
 * A `uuid.UUID` body field. pydantic splits its two failures: a value that is
 * not a string at all is `uuid_type`, while a string it cannot parse is
 * `uuid_parsing`. Zod reports both as one issue shape, so the exact pydantic
 * error is attached to the issue instead and read back in `detailFor`.
 *
 * The `uuid_parsing` message drops pydantic's `ctx.error` tail, which comes
 * from the Rust uuid crate's parser and cannot be reproduced faithfully. That
 * is the same choice `posts/params.ts` already made for the path parameter.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const pydanticUuid = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string") {
    ctx.addIssue({
      code: "custom",
      message: "UUID input should be a string, bytes or UUID object",
      params: { type: "uuid_type" },
    })
    return
  }
  if (!UUID_PATTERN.test(value)) {
    ctx.addIssue({
      code: "custom",
      message: "Input should be a valid UUID",
      params: { type: "uuid_parsing" },
    })
  }
}) as unknown as z.ZodType<string>

export interface ValidationErrorDetail {
  type: string
  loc: (string | number)[]
  msg: string
  input: unknown
}

/** pydantic's error type and message for each type zod reports as `expected`. */
const TYPE_ERRORS: Record<string, { type: string; msg: string }> = {
  string: { type: "string_type", msg: "Input should be a valid string" },
  number: { type: "int_type", msg: "Input should be a valid integer" },
  array: { type: "list_type", msg: "Input should be a valid list" },
  record: { type: "dict_type", msg: "Input should be a valid dictionary" },
}

/** pydantic separates a string it could not read as an int from a wrong type. */
const INT_PARSING = {
  type: "int_parsing",
  msg: "Input should be a valid integer, unable to parse string as an integer",
}

/**
 * The submitted value a zod issue points at. Zod 4 drops `input` from the
 * finalised issues it exposes on `ZodError`, keeping only `code`, `expected`,
 * `path` and `message`, so the value has to be walked out of the body instead.
 */
function valueAt(body: unknown, path: readonly PropertyKey[]): unknown {
  let value = body
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<PropertyKey, unknown>)[segment]
  }
  return value
}

function detailFor(issue: z.core.$ZodIssue, body: unknown): ValidationErrorDetail {
  const loc = ["body", ...issue.path.map((segment) => segment as string | number)]
  if (issue.code === "invalid_type") {
    if (valueAt(body, issue.path) === undefined) {
      // pydantic reports the containing object as the input of a missing key.
      return {
        type: "missing",
        loc,
        msg: "Field required",
        input: valueAt(body, issue.path.slice(0, -1)),
      }
    }
    const input = valueAt(body, issue.path)
    if (issue.expected === "number" && typeof input === "string") {
      return { ...INT_PARSING, loc, input }
    }
    const expected = TYPE_ERRORS[issue.expected]
    if (expected) return { ...expected, loc, input }
  }
  if (issue.code === "custom") {
    // A schema that knows its own pydantic error attaches it to the issue.
    const type = (issue.params as { type?: string } | undefined)?.type
    if (type) return { type, loc, msg: issue.message, input: valueAt(body, issue.path) }
  }
  return { type: "value_error", loc, msg: issue.message, input: valueAt(body, issue.path) }
}

/** FastAPI's `RequestValidationError` response for a set of zod issues. */
export function unprocessableBody(issues: readonly z.core.$ZodIssue[], body: unknown): Response {
  return Response.json({ detail: issues.map((issue) => detailFor(issue, body)) }, { status: 422 })
}

/**
 * FastAPI answered a body that is not JSON with a 422 carrying a single
 * `json_invalid` entry, not a 400, so a client cannot tell a malformed body
 * from an invalid one by status alone.
 */
export function invalidJsonBody(): Response {
  return Response.json(
    { detail: [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }] },
    { status: 422 },
  )
}
