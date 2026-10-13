/**
 * The borrow of the global (`user_id IS NULL`) `stage_models` row.
 *
 * Alembic 012's NULLS NOT DISTINCT constraint allows exactly one such row, and
 * it is the operator layer every stage's model resolution falls through, so a
 * file that sets it is setting it for every other file running at the same
 * time. Three files do: `mastra/stage-models.test.ts`,
 * `app/api/settings/stage-models/route.test.ts` and
 * `app/settings/stage-models-to-provider.test.tsx`. Per-user `stage_models`
 * rows need no borrow, since the user id isolates them.
 *
 * See `borrowed-rows.ts` for why the snapshot lives in the database rather
 * than in the borrower's memory, and `row-lock.ts` for the lock ordering rule.
 * This is the second lock in that order, so a file that also needs the
 * `api_keys` row takes that one first.
 */
import { STAGE_MODELS_SETTING_KEY } from "@/mastra/stage-models"

import { createBorrowedRows } from "./borrowed-rows"

const stageModelsRow = createBorrowedRows({
  lockKey: 510_120_262,
  label: "global stage_models row",
  keys: [STAGE_MODELS_SETTING_KEY],
  backupKey: "stage_models__test_borrow_backup",
})

/**
 * Takes the global row for this process. Call it first in `beforeAll`, before
 * reading or writing the row.
 */
export const borrowGlobalStageModelsRow = stageModelsRow.borrow

/**
 * Puts the row back and releases it. Call it last in `afterAll`, before
 * `closeDb()`, which would otherwise hang waiting on the checked-out client.
 */
export const returnGlobalStageModelsRow = stageModelsRow.giveBack
