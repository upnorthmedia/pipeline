# Pipeline Reliability & Automated Runs

Grounded in code review of `worker.py`, `graph.py`, `gates.py`, all stage files, `llm.py`, API routes, and SSE events.

---

## Phase 0: Developer Experience (Do First)

*Objective: Fast iteration loop for everything that follows.*

### Task 0.1: Docker hot-reload for worker

The worker container currently requires `docker compose restart worker` after code changes.

**Change:** Update `docker-compose.yml` worker command to use `watchfiles`:
```yaml
command: uv run watchfiles "python -m src.worker" src/
```
Add `watchfiles` to `pyproject.toml` dev dependencies.

**Verify live:** Edit a log message in any stage file. Within ~2s the worker process restarts automatically (visible in `docker compose logs -f worker`). No manual restart needed.

---

## Phase 1: Critical Bug Fixes

*Objective: Fix things that are silently broken right now.*

### Task 1.1: Fix ARQ job timeout

`worker.py:505` sets `job_timeout = 600` (10 min). A full 6-stage pipeline with extended thinking (60-90s per Claude call) + sequential image generation easily exceeds this. When it does, ARQ kills the job silently — no SSE error event, no stage_logs entry, just silence.

**Change:** `job_timeout = 3600` in `WorkerSettings`.

**Verify live:**
1. `POST /api/posts/{id}/run-all` on a post
2. Monitor `GET /api/events/{id}` — the stream should emit `stage_start` / `stage_complete` for all 6 stages without dropping off mid-pipeline
3. `GET /api/posts/{id}` should show `current_stage: "complete"` and `stage_logs` populated for all 6 stages
4. Previously this would go silent after ~10 min; now it completes

### Task 1.2: Fix interrupt exception handling in full pipeline mode

`worker.py:265` catches `except Exception` which swallows LangGraph's `interrupt()` exception. When any gate is set to `review` or `approve_only`, the interrupt is treated as a crash — triggering retries and eventually dead-letter queue.

**Change:** In `_run_full_pipeline`, catch `GraphInterrupt` (from `langgraph.errors`) before the generic `except Exception`. On interrupt:
- Set `current_stage` to the interrupted stage
- Set `stage_status[stage]` to `"review"`
- Publish an SSE event (`stage_review` or similar) so the frontend knows
- Return cleanly (no retry, no DLQ)

**Verify live:**
1. Set a profile's outline gate to `review` mode via `PATCH /api/settings` or directly on the post's `stage_settings`
2. `POST /api/posts/{id}/run-all`
3. Pipeline should complete research (auto), then pause at outline with `stage_status.outline = "review"`
4. `GET /api/queue/review` should list this post
5. `POST /api/posts/{id}/approve` should resume the pipeline from outline onward
6. Previously this would appear in `GET /api/queue/dead-letter` after 3 retries

### Task 1.3: Fix silent image manifest parse failure

`images.py:149-163` — when Claude returns unparseable JSON for the image manifest, `_parse_manifest` returns `{"images": [], "error": "..."}`. The stage reports "complete" with zero images. No error is surfaced.

**Change:**
- When `_parse_manifest` fails, set `stage_status.images = "failed"` instead of "complete"
- Include the parse error in `stage_logs.images`
- Publish an SSE `stage_error` event with the raw Claude response (truncated) for debugging
- Optionally: retry the Claude manifest call once before failing

**Verify live:**
1. Run a post through the pipeline
2. If image manifest parsing fails, `GET /api/posts/{id}` shows `stage_status.images = "failed"` and `stage_logs.images` contains the error message and raw response
3. `GET /api/events/{id}` emits a `stage_error` event for the images stage (not a silent `stage_complete`)
4. `POST /api/posts/{id}/rerun/images` can retry the stage

---

## Phase 2: Observability Improvements

*Objective: Make the pipeline's behavior visible so you can verify everything else.*

### Task 2.1: Persist execution logs to DB per post

**The problem:** Currently all step-by-step execution info is ephemeral. `publish_stage_log()` fires 19 messages across the 6 stages ("Rules loaded...", "Calling Claude...", "Received N tokens in Xs") over Redis pub/sub to SSE clients. If the browser isn't connected, these vanish. Worker `logger.info/error/warning` calls go to stdout only. The `stage_logs` JSONB column stores only final metrics per stage — no timeline, no progress, no error history.

You can never go back and answer "what happened when this post was generated?" from the DB alone.

**Change:** Add an `execution_logs` column to the Post model — a JSONB array of ordered log entries that captures the full execution timeline.

#### 2.1a: Add the `execution_logs` column

New Alembic migration adding:
```python
execution_logs: Mapped[list] = mapped_column(JSONB, server_default="[]", default=list)
```

Each entry in the array:
```python
{
    "ts": "2026-02-27T12:34:56.789Z",  # ISO timestamp
    "stage": "research",                 # which stage
    "level": "info",                     # info | warning | error
    "event": "stage_start",              # event type (see below)
    "message": "Calling Perplexity sonar-pro...",
    "data": {}                           # optional structured payload
}
```

Event types:
- `stage_start` — stage is beginning
- `stage_complete` — stage finished successfully (data: `{model, tokens_in, tokens_out, duration_s, cost_usd}`)
- `stage_error` — stage failed (data: `{error, attempt, max_attempts, traceback?}`)
- `stage_review` — stage paused for human review
- `log` — progress message from within a stage (the current `publish_stage_log` messages)
- `pipeline_start` — full pipeline run initiated
- `pipeline_complete` — all stages done
- `retry` — a stage is being retried (data: `{attempt, max_attempts, error}`)
- `image_generated` — individual image done (data: `{index, bytes, path}`)
- `image_failed` — individual image failed (data: `{index, error}`)

**Verify live:**
1. `GET /api/posts/{id}` — `execution_logs` is an array (empty for old posts, populated for new runs)
2. Run a stage — `execution_logs` grows with each step in chronological order
3. The array persists across browser refreshes — it's in the DB, not in SSE memory

#### 2.1b: Create `append_execution_log()` helper

In `helpers.py`, add a function that appends a log entry to the post's `execution_logs` array. Use a raw SQL `jsonb_array_append` or equivalent to avoid read-modify-write races:

```python
async def append_execution_log(
    session: AsyncSession,
    post_id: UUID,
    stage: str,
    level: str,       # "info" | "warning" | "error"
    event: str,       # "stage_start" | "log" | "stage_error" | etc.
    message: str,
    data: dict | None = None,
) -> None:
```

This function should:
1. Append to `execution_logs` in DB (atomic, no read-modify-write)
2. Also call the existing `publish_stage_log()` for SSE (keep real-time streaming working)

**Verify live:**
1. Run two stages concurrently on different posts — no log entries are lost or interleaved within a single post
2. Check DB directly: `SELECT jsonb_array_length(execution_logs) FROM posts WHERE id = '...'` grows during execution

#### 2.1c: Instrument all pipeline code paths

Replace bare `publish_stage_log()` calls and add logging at points that currently only go to stdout:

| Location | Current behavior | New behavior |
|---|---|---|
| `publish_stage_log()` calls in all 6 stage files (19 calls) | SSE only | SSE + DB append (`event: "log"`) |
| `stage_start` SSE events in worker | SSE only | SSE + DB append (`event: "stage_start"`) |
| `stage_complete` SSE events in worker | SSE only | SSE + DB append with metrics (`event: "stage_complete"`) |
| `stage_error` SSE events in worker | SSE only | SSE + DB append with error + traceback (`event: "stage_error"`) |
| `pipeline_complete` SSE event in worker | SSE only | SSE + DB append (`event: "pipeline_complete"`) |
| Per-image success in `images.py` | `logger.info` (stdout only) | DB append (`event: "image_generated"`, data: `{index, bytes, path}`) |
| Per-image failure in `images.py` | `logger.error` (stdout only) | DB append (`event: "image_failed"`, data: `{index, error}`, level: "error") |
| Retry attempts in worker | `logger.exception` (stdout only) | DB append (`event: "retry"`, data: `{attempt, error}`, level: "warning") |
| Manifest parse failure in `images.py` | `logger.warning` (stdout only) | DB append (`event: "log"`, level: "warning", message includes raw response snippet) |
| DLQ entry in worker | Redis list only | DB append (`event: "stage_error"`, level: "error", data: `{attempts, moved_to_dlq: true}`) |

**Verify live:**
1. Run a full pipeline: `GET /api/posts/{id}` → `execution_logs` has 30-40 entries covering the entire timeline
2. Trigger an error (e.g., bad API key): `execution_logs` contains the error with level "error" and the traceback
3. Run images stage: `execution_logs` has individual `image_generated`/`image_failed` entries per image
4. Close the browser, run a pipeline, reopen — full execution history is visible from the DB, nothing lost

#### 2.1d: Expose execution logs in the API

Update `PostRead` schema to include `execution_logs: list[dict]`. Add a dedicated endpoint for large posts:

```
GET /api/posts/{id}/logs?level=error&stage=images
```

Supports filtering by:
- `level` — show only errors, or warnings+errors
- `stage` — show only a specific stage's logs
- `since` — show logs after a timestamp (for polling)

**Verify live:**
1. `GET /api/posts/{id}/logs` returns the full ordered log array
2. `GET /api/posts/{id}/logs?level=error` returns only error entries
3. `GET /api/posts/{id}/logs?stage=images` returns only images stage entries
4. `GET /api/posts/{id}/logs?level=warning&level=error` returns warnings and errors across all stages

### Task 2.2: Fix stage metrics in full pipeline mode (existing `stage_logs`)

`worker.py:220-224` — the metadata loop overwrites `_stage_meta` each iteration. Only the last stage's metrics (ready) are logged. Stages 1-5 have no recorded duration, token counts, or cost.

**Change:** Accumulate metrics per-stage during `_run_full_pipeline`. After `graph.ainvoke` completes, the final state contains all stage outputs. Log each stage's metrics individually to `stage_logs`.

**Verify live:**
1. `POST /api/posts/{id}/run-all`
2. After completion, `GET /api/posts/{id}` — `stage_logs` should have entries for all 6 stages, each with `model`, `duration_s`, `tokens_in`, `tokens_out`, `cost_usd`
3. Previously only `stage_logs.ready` was populated in run-all mode

### Task 2.2: Fix images stage timer to include Gemini calls

`images.py:38-55` — `StageTimer` wraps only the Claude manifest call. The Gemini image generation loop (potentially minutes) is unmetered.

**Change:** Wrap the entire `images_node` execution in the timer, or add a separate timer for the Gemini loop and sum them.

**Verify live:**
1. Run a post through images stage
2. `GET /api/posts/{id}` — `stage_logs.images.duration_s` should reflect the full stage time (including image generation), not just the manifest call
3. For a post with 4-5 images, this should be minutes, not seconds

### Task 2.3: Add worker health visibility

The worker health check (`docker-compose.yml`) only pings Redis. It doesn't tell you if the worker is actually processing jobs or stuck.

**Change:** Add a `GET /api/queue/worker-status` endpoint that checks:
- Is the ARQ worker registered in Redis? (check `arq:worker:*` keys)
- How many jobs are currently running vs queued?
- When was the last job completed? (store a Redis key on job completion)

**Verify live:**
1. `GET /api/queue/worker-status` returns `{active_jobs: N, queued_jobs: N, last_completed: "2025-...", worker_alive: true}`
2. Stop the worker container — `worker_alive` becomes `false`
3. Enqueue 5 jobs with `max_jobs=3` — `active_jobs: 3, queued_jobs: 2`

---

## Phase 3: Robustness Hardening

*Objective: Make failures recoverable and retries intelligent.*

### Task 3.1: Discriminate transient vs permanent errors in retry logic

`llm.py:18-30` — the `_retry` wrapper retries all exceptions 3 times. Auth errors (401), validation errors (400), and rate limits (429) are all treated the same.

**Change:** Only retry on:
- HTTP 429 (rate limit) — with respect for `Retry-After` header
- HTTP 5xx (server errors)
- `httpx.TimeoutException` / `httpx.ConnectError`
- Raise immediately on 401, 403, 400 (no retry will help)

**Verify live:**
1. Temporarily set an invalid API key in `.env` for one provider
2. Run a stage using that provider
3. `stage_logs` should show failure after 1 attempt (not 3), with a clear "authentication failed" message
4. `GET /api/events/{id}` emits `stage_error` within seconds (not after 3 retries with backoff)

### Task 3.2: Add explicit timeouts to Claude and Gemini clients

`llm.py` — only `PerplexityClient` has an explicit timeout (120s). Claude and Gemini rely on SDK defaults which are undefined/generous.

**Change:**
- `ClaudeClient`: Set `timeout=httpx.Timeout(300.0)` on the `AsyncAnthropic` client (extended thinking needs headroom)
- `GeminiClient`: Set a timeout on the `run_in_executor` call using `asyncio.wait_for(..., timeout=180.0)`

**Verify live:**
1. These are defensive — you verify them by observing that a stuck LLM call eventually times out instead of hanging forever
2. Simulate by temporarily pointing to a non-responsive endpoint: the stage should fail with a timeout error in `stage_logs` within the configured window, not hang indefinitely

### Task 3.3: Parallelize image generation

`images.py:72-120` — images are generated sequentially. 5 images = 5 serial Gemini calls.

**Change:** Use `asyncio.gather` with a concurrency semaphore (limit 3) to generate images in parallel.

**Verify live:**
1. Run a post that generates 4+ images
2. `stage_logs.images.duration_s` should be roughly the time of the slowest single image (+ manifest call), not the sum of all images
3. Compare before/after: a 5-image post that took ~5 min should now take ~2 min

---

## Phase 4: Orchestration Simplification

*Objective: Replace LangGraph with a direct sequential loop. This is the largest change — phases 1-3 must be stable first.*

### Task 4.1: Implement sequential pipeline runner

Replace `graph.ainvoke()` in `_run_full_pipeline` with a direct loop:

```python
STAGES = ["research", "outline", "write", "edit", "images", "ready"]

for stage in STAGES:
    # 1. Load current post from DB (fresh state each iteration)
    # 2. Check gate mode — if "review", save status and return
    # 3. Call the stage node function directly
    # 4. Save output to DB + publish SSE
    # 5. Log metrics to stage_logs
```

Key design points:
- Each iteration reads fresh state from DB (no in-memory state drift)
- Gate logic is a simple if/elif inline (no separate module needed)
- On review gate: set `stage_status[stage] = "review"`, publish SSE, return. The approve endpoint enqueues a new job starting from that stage.
- Each stage's output is saved immediately after completion (crash recovery = resume from last saved stage)

**Verify live:**
1. `POST /api/posts/{id}/run-all` completes all 6 stages
2. `GET /api/events/{id}` shows `stage_start`/`stage_complete` for each stage in order
3. `GET /api/posts/{id}` shows all content columns populated, `stage_status` all "complete", `stage_logs` all populated
4. Set one gate to `review` — pipeline pauses at that stage, `GET /api/queue/review` lists it, approve resumes it
5. Kill the worker mid-pipeline (e.g., after stage 3). Restart it. `POST /api/posts/{id}/run-all` resumes from stage 4 (because stages 1-3 content is already in DB)

### Task 4.2: Remove LangGraph dependencies

After Task 4.1 is verified working:

**Change:**
- Delete `api/src/pipeline/graph.py`
- Delete or simplify `api/src/pipeline/gates.py` (gate logic is now inline in the loop)
- Remove `langgraph`, `langgraph-checkpoint-postgres`, `psycopg`, `psycopg-binary` from `pyproject.toml`
- Remove `thread_id` column from Post model (no more LangGraph checkpoints) — Alembic migration
- Remove checkpoint DB URL conversion logic
- Update `create_pipeline_graph` references in worker

**Verify live:**
1. `uv pip list` in the worker container — no langgraph/psycopg packages
2. Full pipeline run still works end-to-end (same verification as Task 4.1)
3. `docker compose up` starts cleanly with no import errors
4. DB no longer has LangGraph checkpoint tables (verify via `psql`)

### Task 4.3: Simplify worker entry points

Currently two code paths: `_run_single_stage` (direct node call) and `_run_full_pipeline` (graph.ainvoke). After removing LangGraph, both paths should share the same sequential runner — `_run_single_stage` just runs the loop for a single iteration.

**Change:** Unify into one `run_pipeline` function that accepts an optional `stages` parameter (defaults to all remaining stages).

**Verify live:**
1. `POST /api/posts/{id}/run?stage=edit` runs only the edit stage
2. `POST /api/posts/{id}/run-all` runs all remaining stages
3. `POST /api/posts/{id}/rerun/research` re-runs just research
4. All three use the same code path (verify by checking worker logs — same log format for all)

---

## Phase 5: Automated Pipeline Runs

*Objective: Pipeline starts automatically on post creation. No manual "Run" needed.*

### Task 5.1: Auto-enqueue pipeline on post creation

**Change:** In `api/src/api/posts.py`, after creating a post via `POST /api/posts`, automatically enqueue `run_pipeline_stage` with `mode="run-all"` if the post's `stage_settings` has at least one `auto` gate.

**Verify live:**
1. Create a post via the UI (`/posts/new`) or API
2. Without clicking any "Run" button, `GET /api/events/{id}` immediately starts streaming `stage_start` events
3. `GET /api/queue` shows `running: 1`
4. Post reaches `complete` (or pauses at first `review` gate) without manual intervention

### Task 5.2: Auto-resume after approval

**Change:** The existing `POST /api/posts/{id}/approve` endpoint already advances to the next stage and enqueues it. Verify this works correctly with the new sequential runner — approval should continue the pipeline through all remaining `auto` stages, not just the next one.

**Verify live:**
1. Set research gate to `review`, all others to `auto`
2. Create a post — it runs research, then pauses
3. Approve the research stage
4. Pipeline automatically continues through outline -> write -> edit -> images -> ready without further intervention
5. `GET /api/events/{id}` shows the full progression after approval

### Task 5.3: Batch creation with auto-run

**Change:** Ensure `POST /api/posts/batch` also auto-enqueues each created post.

**Verify live:**
1. Create 3 posts via batch endpoint
2. `GET /api/queue` shows `running: 3` (or `running: max_jobs, pending: remainder`)
3. All 3 posts progress through the pipeline without manual intervention

---

## Verification Checklist (End-to-End)

After all phases, this sequence should work with zero manual intervention:

1. `POST /api/posts` with topic "How to Train a Puppy"
2. SSE stream (`GET /api/events/{id}`) shows:
   - `stage_start: research` -> `log` events -> `stage_complete: research`
   - `stage_start: outline` -> ... -> `stage_complete: outline`
   - (repeat for write, edit, images, ready)
   - `pipeline_complete`
3. `GET /api/posts/{id}` shows:
   - `current_stage: "complete"`
   - `completed_at` is set
   - All 6 content columns populated
   - `stage_logs` has metrics for all 6 stages
   - `image_manifest` has images with `generated: true`
   - `execution_logs` has 30-40 chronological entries covering the full timeline
4. `GET /api/posts/{id}/logs` returns the complete execution history — every stage start/complete, every progress message, every image generated
5. `GET /api/posts/{id}/logs?level=error` returns empty (no errors on a clean run)
6. `GET /api/queue` shows the post counted under `complete`
7. `GET /api/posts/{id}/export/all` downloads a ZIP with all artifacts
8. Close browser, reopen, navigate to the post — full execution history is still visible (persisted, not SSE-dependent)

Total time: 5-15 minutes depending on content length and image count.

---

## Progress Checklist

### Phase 0: Developer Experience
- [x] Task 0.1: Docker hot-reload for worker

### Phase 1: Critical Bug Fixes
- [x] Task 1.1: Fix ARQ job timeout
- [x] Task 1.2: Fix interrupt exception handling in full pipeline mode
- [x] Task 1.3: Fix silent image manifest parse failure

### Phase 2: Observability Improvements
- [x] Task 2.1a: Add `execution_logs` column
- [x] Task 2.1b: Create `append_execution_log()` helper
- [x] Task 2.1c: Instrument all pipeline code paths
- [x] Task 2.1d: Expose execution logs in the API
- [x] Task 2.2a: Fix stage metrics in full pipeline mode
- [x] Task 2.2b: Fix images stage timer to include Gemini calls
- [x] Task 2.3: Add worker health visibility

### Phase 3: Robustness Hardening
- [x] Task 3.1: Discriminate transient vs permanent errors in retry logic
- [x] Task 3.2: Add explicit timeouts to Claude and Gemini clients
- [x] Task 3.3: Parallelize image generation

### Phase 4: Orchestration Simplification
- [x] Task 4.1: Implement sequential pipeline runner
- [x] Task 4.2: Remove LangGraph dependencies
- [x] Task 4.3: Simplify worker entry points

### Phase 5: Automated Pipeline Runs
- [x] Task 5.1: Auto-enqueue pipeline on post creation
- [x] Task 5.2: Auto-resume after approval
- [x] Task 5.3: Batch creation with auto-run

---

## Notes

### Phase 0
- Added `watchfiles` to main dependencies (not dev) because the Dockerfile uses `uv sync --no-dev` — dev deps aren't available in the Docker container.

### Phase 1
- Task 1.2: `run-all` endpoint overrides all gates to `auto` before enqueueing, so the `GraphInterrupt` handler won't fire via that path. It will be exercised once Phase 5 auto-enqueue (without gate override) is in place.
- Removed "Run Next", "Run All", and per-stage "Run {Stage}" buttons from the frontend (post detail page and posts list) in preparation for fully automated runs.

### Phase 2
- Task 2.1: `execution_logs` is a JSONB array column with atomic `|| :entry::jsonb` append (no read-modify-write races). `publish_stage_log()` now auto-persists to DB when `session_factory` is in the event context, so all 19 existing SSE log calls in stage files also write to DB without changes to stage code.
- Task 2.2a: Added `_stage_metas` key to `PipelineState` with `Annotated[dict, operator.or_]` merge reducer so each stage's metrics accumulate in the graph state. Worker reads `result["_stage_metas"][stage_name]` instead of the old `result["_stage_meta"]` (which only captured last stage). Kept `_stage_meta` for backward compat with single-stage reruns.
- Task 2.2b: Moved `StageTimer` to wrap the entire `images_node` function body (manifest + all Gemini calls), not just the Claude manifest call.
- Task 2.3: Worker sets `arq:worker:last_completed` Redis key after each successful job. Endpoint checks `arq:worker:*` keys for heartbeat, `arq:queue` zset for queued jobs, DB for active (running) posts.

### Phase 3
- Task 3.1: Added `_is_retryable()` classifier — only retries HTTP 429, 5xx, `httpx.TimeoutException`, `httpx.ConnectError`, `asyncio.TimeoutError`, `ConnectionError`, `OSError`. Auth errors (401/403) and validation errors (400) raise immediately. Added `_retry_after()` to respect `Retry-After` header on 429 responses. Works with both `httpx.HTTPStatusError` (Perplexity) and `anthropic.APIStatusError` (Claude).
- Task 3.2: `ClaudeClient` now passes `timeout=httpx.Timeout(300.0)` to `AsyncAnthropic`. `GeminiClient.generate_image` wraps `run_in_executor` in `asyncio.wait_for(..., timeout=180.0)`. `asyncio.TimeoutError` is retryable via Task 3.1.
- Task 3.3: Replaced sequential `for` loop in `images_node` with `asyncio.gather` + `asyncio.Semaphore(3)`. Each image generated as an independent coroutine, max 3 concurrent. Results preserved in manifest order via `gather` semantics.

### Phase 4
- Task 4.1: Replaced `graph.ainvoke()` in `_run_full_pipeline` with a direct sequential `for stage in STAGES` loop. Each iteration loads fresh post state from DB, checks gate mode (pauses for review/approve_only), calls the stage node function directly, and saves output to DB immediately. Added `STAGE_OUTPUT_KEY` mapping to `state.py`. Added `_fetch_internal_links` helper. Edit stage now also saves `final_html_content` column.
- Task 4.2: Deleted `graph.py` and `gates.py`. Removed `langgraph`, `langgraph-checkpoint-postgres`, and `psycopg[binary]` from `pyproject.toml`. Created Alembic migration 005 to drop `thread_id` column. Removed `thread_id` from Post model and PostRead schema. Removed `_stage_metas` (LangGraph merge reducer) from PipelineState and all 6 stage node returns — worker now uses `_stage_meta` per-stage. Updated `__init__.py` to export from `state.py` only. Deleted `test_graph_structure.py` and `test_checkpointing.py`. Rewrote `test_gates.py` to test `STAGE_OUTPUT_KEY` mapping. Updated `test_ready_stage.py` imports to use `state.py`.
- Task 4.3: Unified `_run_single_stage` and `_run_full_pipeline` into one `_run_pipeline(stages, check_gates)` function. `stages=None` runs all remaining stages with gate checks (full pipeline). `stages=["edit"]` runs just that stage without gate checks (rerun). Both paths share identical stage execution logic: publish SSE, set event context, call node, save output, log metrics. Full pipeline path additionally logs `pipeline_start`/`pipeline_complete` and runs `_post_completion_hook`.

### Phase 5
- Task 5.1: Added `Request` parameter to `create_post`. After commit, checks `_has_auto_gate()` — if any stage is `auto`, enqueues `run_pipeline_stage` with no stage arg (full pipeline with gate checks). Posts with all-review gates don't auto-start.
- Task 5.2: Changed `approve_stage` to enqueue `run_pipeline_stage` without a specific stage arg instead of just the next stage. This means after approval, the sequential runner continues through all remaining stages, pausing at the next review gate automatically.
- Task 5.3: Added `Request` parameter to `batch_create_posts`. After commit, iterates created posts and enqueues each one that has auto gates.
