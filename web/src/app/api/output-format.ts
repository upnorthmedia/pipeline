/**
 * The `output_format` vocabulary, enforced at the two write boundaries that
 * can put a value in the column: `POST`/`PATCH /api/posts` and
 * `POST`/`PATCH /api/profiles`.
 *
 * This is a deliberate divergence from the Python schemas, which took the
 * field as a bare `str`. Nothing downstream of the column can report a reason
 * to anyone: the Output Format picker renders a value it does not recognise as
 * "Unrecognised format", the auto-publish hook silently declines, and
 * `POST /api/posts/{id}/publish` refuses, all of them after the six pipeline
 * stages have been paid for. The value the ledger item is about is `both`,
 * which was the column default until `drizzle/0003` and named two
 * destinations while reaching neither.
 *
 * Closing the vocabulary here is the alternative to widening the publish
 * endpoint's dispatch: `both` stops being storable rather than starting to
 * mean something the picker never offered. Rows written before `drizzle/0003`
 * ran are the reason the readers keep their fallbacks.
 *
 * A `custom` zod issue with no pydantic error type attached is reported as
 * `value_error`, which is what pydantic itself answers for a failed validator.
 */
import { z } from "zod"

import { OUTPUT_FORMAT_VALUES } from "@/lib/publishing"

/** Written for the person choosing, and precise enough for an API client. */
export const OUTPUT_FORMAT_INVALID = `Output format should be one of ${OUTPUT_FORMAT_VALUES.join(
  ", ",
)}`

/** `z.string()` plus the membership check, so every caller keeps its own defaults. */
export const outputFormatField = z.string().superRefine((value, ctx) => {
  if (!OUTPUT_FORMAT_VALUES.includes(value)) {
    ctx.addIssue({ code: "custom", message: OUTPUT_FORMAT_INVALID })
  }
})
