/**
 * `MODEL_COSTS` in `api/src/pipeline/helpers.py`, the per-model price table in
 * US dollars per million tokens.
 *
 * Two things read it in Python: `log_stage_execution()`, which prices a stage's
 * token counts into the `cost_usd` field of its `stage_logs` entry, and the
 * analytics router, which serves the table itself as `model_costs_reference` so
 * the monitor page can show what a cost was computed from.
 *
 * Reproduced value for value rather than recomputed from current provider
 * pricing: the numbers here are what already priced every `stage_logs` entry in
 * the database, so changing them would make historical costs disagree with the
 * reference the same response ships. Repricing is a product decision, not part
 * of the port.
 *
 * The two models ledger item 6.1 adopted are appended rather than substituted,
 * for the same reason: runs recorded before the cutover were priced against the
 * rows above and keep them. The new rows carry the providers' current published
 * rates, checked on 2026-08-23 (see `evidence/phase-6.md` #6.1). Gemini's image
 * output is billed per image rather than per token, and the number below is the
 * per-million-token rate the provider quotes alongside it.
 *
 * `web/src/mastra/execution-log.ts` reads this table too, as of the fix for
 * ledger item P2.38. It used to reproduce the two rates `api/src/worker.py:244`
 * hardcoded for its `stage_complete` entry, which were Opus prices applied to
 * every stage including the Perplexity call in `research` and the Gemini calls
 * in `images`. Python's split between a per-model table and a hardcoded pair
 * was a defect on the hardcoded side, so the port now has one price table and
 * `model-costs.test.ts` holds it to covering every model a stage can be
 * configured to run.
 *
 * `perplexity/sonar` is the `research` stage's model since P2.71b moved it off
 * the Sonar Chat Completions endpoint. `sonar-pro` stays above it for the same
 * reason every other superseded row does: it priced the runs already recorded.
 * The rate is the one `GET https://api.perplexity.ai/v1/models` publishes for
 * the id, checked on 2026-08-24, and it reproduces a live call's token cost to
 * the cent. What it cannot express is the Agent API's per-search fee, which
 * this table has no column for; see ledger item P2.71b-ii.
 *
 * `claude-opus-4-6` is the one row that was repriced rather than pinned, at
 * ledger item P2.93. It came over from Python at 15.0 / 75.0, which is what
 * Anthropic charged for the model at launch and no longer charges: the
 * published rate is 5.0 / 25.0. Every other superseded number above is kept
 * because the model it prices is on no allowlist, so its row can only ever
 * describe runs already recorded. This one is on four stages' allowlists, so
 * its row prices the next run a user configures, and a launch price there is a
 * 3x overstatement of a live bill rather than a faithful record of an old one.
 * Repricing it moves no recorded cost: every `stage_logs` entry carries the
 * `cost_usd` it was written with and `GET /api/analytics/costs` sums those
 * stored numbers rather than recomputing them from this table.
 *
 * `claude-fable-5` is the one row with no Python ancestor: item 6.1 put it on
 * the `outline`, `write`, `edit` and `ready` allowlists without a price, and a
 * selectable model with no price would report every stage run on it as costing
 * nothing. Its rate is Anthropic's published one for the model.
 */
export interface ModelCost {
  input: number
  output: number
}

export const MODEL_COSTS: Record<string, ModelCost> = {
  "sonar-pro": { input: 3.0, output: 15.0 },
  "perplexity/sonar": { input: 0.25, output: 2.5 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "gemini-3.1-flash-image-preview": { input: 0.1, output: 60.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "gemini-3-pro-image": { input: 2.0, output: 120.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
}
