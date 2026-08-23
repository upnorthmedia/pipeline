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
 * This is not the table `web/src/mastra/execution-log.ts` uses. That file
 * reproduces the two rates `api/src/worker.py:244` hardcoded for its
 * `stage_complete` log entry, which are Opus prices applied to every stage.
 * Python had the same split and both halves are served through the API, so they
 * stay separate here too.
 */
export interface ModelCost {
  input: number
  output: number
}

export const MODEL_COSTS: Record<string, ModelCost> = {
  "sonar-pro": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "gemini-3.1-flash-image-preview": { input: 0.1, output: 60.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "gemini-3-pro-image": { input: 2.0, output: 120.0 },
}
