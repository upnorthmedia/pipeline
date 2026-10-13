/**
 * The path-parameter and not-found behaviour shared by every
 * `/api/profiles/{profile_id}` handler.
 *
 * FastAPI parsed `profile_id` as a `uuid.UUID` path parameter and rejected a
 * malformed one with a 422 before the handler ran. Postgres would instead
 * raise on the comparison and surface a 500, so the same check happens here.
 * The body carries FastAPI's `type`/`loc`/`msg`/`input` keys; its `ctx` and
 * `url` keys are not reproduced, and nothing in `web/src/lib/api.ts` reads
 * them.
 *
 * `_get_user_profile()` matched on both the id and the owner and raised
 * `HTTPException(404, "Profile not found")` when either missed, so another
 * user's profile is indistinguishable from one that does not exist. That is
 * the multi-tenancy boundary and it is preserved verbatim.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function unprocessableUuid(input: string): Response {
  return Response.json(
    {
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "profile_id"],
          msg: "Input should be a valid UUID",
          input,
        },
      ],
    },
    { status: 422 },
  )
}

export function profileNotFound(): Response {
  return Response.json({ detail: "Profile not found" }, { status: 404 })
}
