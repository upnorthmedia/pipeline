/**
 * Cross-file mutual exclusion on the global (`user_id IS NULL`) `stage_models`
 * row.
 *
 * Alembic 012's NULLS NOT DISTINCT constraint allows exactly one such row, and
 * it is the operator layer every stage's model resolution falls through, so a
 * file that sets it is setting it for every other file running at the same
 * time. Three files do: `mastra/stage-models.test.ts`,
 * `app/api/settings/stage-models/route.test.ts` and
 * `app/settings/stage-models-to-provider.test.tsx`. Per-user `stage_models`
 * rows need no lock, since the user id isolates them.
 *
 * See `row-lock.ts` for the mechanics. This is the second lock in the ordering
 * rule stated there, so a file that also needs the `api_keys` row takes that
 * one first.
 */
import { createRowLock } from "./row-lock"

const stageModelsRow = createRowLock(510_120_262, "global stage_models row")

/**
 * Blocks until this process owns the global row. Call it first in `beforeAll`,
 * before reading the row to save it.
 */
export const lockGlobalStageModelsRow = stageModelsRow.lock

/**
 * Releases the row. Call it last in `afterAll`, after restoring the row and
 * before `closeDb()`.
 */
export const unlockGlobalStageModelsRow = stageModelsRow.unlock
