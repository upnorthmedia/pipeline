/**
 * Ids that are deliberately not in the database.
 *
 * `unique-test-ids.test.ts` requires a UUID literal to belong to one test file,
 * because two files seeding one row id race each other. These three are the
 * exception the rule is built to allow: nothing ever inserts them, so every
 * file asking "what happens for an id that does not exist" wants the same
 * value. Keeping them here rather than re-spelling them per file is what makes
 * that claim checkable, and it means a stray insert of one of these is a single
 * grep away rather than a sweep.
 */

/** No `posts` row has this id. */
export const ABSENT_POST_ID = "00000000-0000-4000-8000-000000000000"

/** No `website_profiles` row has this id. */
export const ABSENT_PROFILE_ID = "00000000-0000-4000-8000-0000000000fe"

/** No `internal_links` row has this id. */
export const ABSENT_LINK_ID = "00000000-0000-4000-8000-0000000000fd"
