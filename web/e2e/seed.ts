/**
 * Row seeding for the e2e suite, over the app's own HTTP API.
 *
 * `CLAUDE.md` forbids tests that only assert on mocks, and the specs that used
 * `page.route("**\/api/...")` to fabricate a post and a profile were exactly
 * that: they exercised the client's rendering of a fixture object and nothing
 * below it. They also drifted, because a fixture written by hand has no way to
 * fail when the API's shape changes.
 *
 * Everything here goes through the real route handlers, so the rows are owned
 * by the e2e account (`getRequestUser()` scopes every write) and the browser
 * sees exactly what a user's own data would look like. `auth.setup.ts` deletes
 * the account's posts and profiles at the start of every run, so seeds do not
 * accumulate.
 *
 * `stage_status` and `current_stage` are deliberately absent: no endpoint
 * writes them, only the pipeline does. Every seeded post is therefore a
 * never-run post carrying content, which is enough for the editor, the tabs
 * and the analytics bar, and is why nothing here asserts on stage badges.
 */
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test"

export interface SeededProfile {
  id: string
  name: string
  website_url: string
}

export interface SeededPost {
  id: string
  slug: string
  topic: string
}

export interface SeededLink {
  id: string
  url: string
  title: string | null
}

const jsonOf = async (response: APIResponse, what: string) => {
  expect(response.ok(), `${what} answered ${response.status()} ${await response.text()}`).toBeTruthy()
  return response.json()
}

/** `POST /api/profiles`. `name` and `website_url` are the only required fields. */
export async function seedProfile(
  request: APIRequestContext,
  fields: { name: string; website_url: string } & Record<string, unknown>,
): Promise<SeededProfile> {
  return jsonOf(await request.post("/api/profiles", { data: fields }), "POST /api/profiles")
}

/**
 * `POST /api/posts` followed by `PATCH /api/posts/{id}` for the stage content,
 * because `PostCreate` carries no content fields and `PostUpdate` does. The
 * patch is what the editor itself calls when it saves.
 */
export async function seedPost(
  request: APIRequestContext,
  fields: { slug: string; topic: string; profile_id: string } & Record<string, unknown>,
  content: Record<string, string> = {},
): Promise<SeededPost> {
  const post: SeededPost = await jsonOf(
    await request.post("/api/posts", { data: fields }),
    "POST /api/posts",
  )
  if (Object.keys(content).length === 0) return post

  return jsonOf(
    await request.patch(`/api/posts/${post.id}`, { data: content }),
    `PATCH /api/posts/${post.id}`,
  )
}

/** `POST /api/profiles/{id}/links`. The handler always records `source: "manual"`. */
export async function seedLink(
  request: APIRequestContext,
  profileId: string,
  fields: { url: string } & Record<string, unknown>,
): Promise<SeededLink> {
  return jsonOf(
    await request.post(`/api/profiles/${profileId}/links`, { data: fields }),
    `POST /api/profiles/${profileId}/links`,
  )
}
