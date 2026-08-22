/**
 * The input and output contract shared by all six stage steps.
 *
 * A step is handed a post id, not the post's content: it reads its inputs from
 * the columns the previous steps committed and writes its own output back to a
 * column before returning. That keeps the workflow snapshot small and, more
 * importantly, means a resumed run rebuilds state from the table rather than
 * from anything a dead process was holding.
 *
 * The output is Python's `_stage_meta` plus the post id, so the next step in
 * the chain receives a valid input without a mapping step between them.
 */
import { z } from "zod"

import { STAGES } from "../state"

export const stageStepInputSchema = z.object({
  postId: z.uuid(),
})

export type StageStepInput = z.infer<typeof stageStepInputSchema>

export const stageStepOutputSchema = z.object({
  postId: z.uuid(),
  stage: z.enum(STAGES),
  /** The model id the provider reported running, not the one requested. */
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  durationS: z.number().nonnegative(),
})

export type StageStepOutput = z.infer<typeof stageStepOutputSchema>
