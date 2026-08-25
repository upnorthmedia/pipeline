/**
 * The frame the two pause endpoints publish once the row is written.
 *
 * Every other pipeline control announces its write with the run it starts:
 * `/run`, `/rerun`, `/restart`, `/run-all` and `resume-all` all enqueue, and
 * the first thing the run does is publish `stage_start`, which every open
 * reader refetches on. A pause enqueues nothing by design (it is a signal the
 * next stage step reads, ledger item P2.115), so the one surface that learned
 * about it was the tab that pressed the button and refetched by hand. A second
 * tab, and `/monitor` between two of its ten-second polls, kept the run on
 * screen as running until its reader reloaded.
 *
 * It carries no stage, because there is no honest one to carry: the pause
 * overwrites `current_stage`, and the stage that was in flight is still
 * finishing. The frame says the row changed and a reader reads the row.
 *
 * A failed publish is logged and swallowed. The write is the authority, the
 * worker reads it from the database rather than from this frame, and answering
 * a pause with a 500 because Redis was unreachable would tell the operator the
 * run was not stopped when it was.
 */
import { logger, pubsub } from "./index"
import { publishPipelineEvent } from "./pipeline-events"

/** The event name, shared with `use-sse.ts`'s `NAMED_EVENTS` by convention. */
export const RUN_PAUSED_EVENT = "run_paused"

export async function announceRunPaused(postIds: string[]): Promise<void> {
  for (const postId of postIds) {
    try {
      await publishPipelineEvent(pubsub, postId, RUN_PAUSED_EVENT, {
        message: "Run paused",
      })
    } catch (error) {
      logger.warn("failed to announce a pause", { postId, error })
    }
  }
}
