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
import { getMaskedKeys } from "@/mastra/api-keys"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  return Response.json(await getMaskedKeys())
}
