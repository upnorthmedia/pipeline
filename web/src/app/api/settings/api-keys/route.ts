/**
 * Port of `GET /api/settings/api-keys` in `api/src/api/settings.py`.
 *
 * The response is `dict[str, ApiKeyStatus]` keyed by provider, which is
 * `Record<string, ApiKeyStatus>` in `web/src/lib/api.ts`. It never contains a
 * key: `getMaskedKeys()` reduces each plaintext to a last-four hint.
 *
 * `api_keys` is a single global row (`settings.key` is the primary key and
 * `save_api_keys()` never set `user_id`), so unlike the collection endpoints in
 * `../route.ts` there is nothing to scope by user. The session is still
 * required, matching Python's `Depends(get_current_user)`. Changing the row to
 * be per user would be a schema change, which the port does not do.
 */
import { z } from "zod"

import { validateKeys } from "@/mastra/api-key-validator"
import {
  getMaskedKeys,
  PROVIDERS,
  saveApiKeys,
  saveValidationResults,
  type ApiKeyStatus,
  type Provider,
} from "@/mastra/api-keys"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  return Response.json(await getMaskedKeys())
}

/**
 * `ApiKeyUpdate` from `api/src/models/schemas.py`: one optional nullable string
 * per provider, spelled out the same way Python spelled it. Both stacks ignore
 * unknown fields (pydantic by default, zod by stripping), so a client naming a
 * fourth provider has it dropped rather than getting a 422.
 */
const updateSchema = z.object({
  anthropic: z.string().nullish(),
  perplexity: z.string().nullish(),
  gemini: z.string().nullish(),
})

/**
 * Port of `PUT /api/settings/api-keys`, the write half of the settings router.
 *
 * The order matters and is Python's: validate live, then store, then read
 * back. Keys are stored **even when validation fails**, because the common
 * cause is a key that is fine but a provider that is momentarily unreachable,
 * and discarding the user's input would make that unrecoverable from the
 * settings page. The failure is reported through `valid: false` instead.
 *
 * The returned `valid` for a provider checked in this request comes from this
 * request's result rather than from the row just written, so the response is
 * consistent even if a concurrent write lands between the two.
 */
export async function PUT(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ detail: "Invalid JSON body" }, { status: 422 })
  }

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ detail: "Each provider key must be a string" }, { status: 422 })
  }

  const supplied: Partial<Record<Provider, string>> = {}
  for (const provider of PROVIDERS) {
    const value = parsed.data[provider]
    if (typeof value === "string") supplied[provider] = value
  }

  const validation = await validateKeys(supplied)

  await saveApiKeys(supplied)
  await saveValidationResults(
    Object.fromEntries(
      Object.entries(validation).map(([provider, result]) => [provider, result.valid]),
    ),
  )

  const masked = await getMaskedKeys()
  const result = {} as Record<Provider, ApiKeyStatus>
  for (const provider of PROVIDERS) {
    const checked = validation[provider]
    result[provider] = checked ? { ...masked[provider], valid: checked.valid } : masked[provider]
  }

  return Response.json(result)
}
