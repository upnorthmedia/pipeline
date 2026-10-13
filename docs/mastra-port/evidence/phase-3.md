# Phase 3 evidence

Moved out of `LEDGER.md` on 2026-08-23 to cut the context
re-read every iteration. Verbatim, nothing edited.


## 3.1a


  Split out of 3.1 because it is not research-specific: all six stages render their prompt
  through the same two Python functions, so porting them once, proven against all 12 golden
  fixtures, is a self-contained unit and stops each of 3.1b through 3.6 re-deriving it.

  **What was ported.** `web/src/mastra/state.ts` carries the stage vocabulary from
  `api/src/pipeline/state.py` (`STAGES`, `STAGE_CONTENT_MAP`, `STAGE_PROVIDER_MAP`,
  `STAGE_RULES_MAP`, `STAGE_OUTPUT_KEY`, the status constants) plus `pipelineContextSchema`,
  the Zod schema for the prompt-visible subset of `PipelineState`. API keys, `stage_status`
  and run-control fields are deliberately absent from that schema: they never reach a prompt,
  so a step cannot leak a credential into a provider payload through it.
  `web/src/mastra/prompts.ts` ports `load_rules()` and `build_stage_prompt()` from
  `api/src/pipeline/helpers.py`, including `_build_config_context`, `_get_previous_output` and
  `_build_links_context`.

  **The prompt contract is not uniform across the six stages.** The parity run against the
  golden fixtures established, rather than assumed, which stages the shared assembly covers:

  | Stage | Prompt actually sent |
  | --- | --- |
  | `research`, `outline`, `write` | exactly `build_stage_prompt()` |
  | `images` | `build_stage_prompt()` as prompt 1 of N; prompts 2..N are per-image (item 3.5) |
  | `edit` | `build_stage_prompt()` + `"\n\n---\n\n"` + `_build_analytics_section()` (item 3.4) |
  | `ready` | not `build_stage_prompt()` at all: `_build_ready_prompt()` is a separate builder (item 3.6) |

  So the test asserts byte equality for the first four, an exact-prefix relationship for
  `edit`, and for `ready` it pins the fixture's distinguishing markers (`- **SLUG**:`, the
  fenced `## Image Manifest (generated images only)` block, no `- **BLOG_POST_TOPIC**:`) so
  item 3.6 cannot wire up the wrong builder unnoticed.

  **Verification.**

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/prompts.test.ts

   RUN  v4.0.18 /Users/cody/.../objective-port-jena-46c1e6-1/web

   ✓ src/mastra/prompts.test.ts (21 tests) 20ms

   Test Files  1 passed (1)
        Tests  21 passed (21)
     Start at  21:20:40
     Duration  203ms (transform 31ms, setup 81ms, import 33ms, tests 20ms, environment 0ms)
  ```

  The 21 cover: 8 byte-exact fixture comparisons (4 stages x 2 posts), 2 `edit` prefix
  comparisons, 2 `ready` non-applicability pins, a check that the two captured posts really do
  differ in `article_type`/`output_format`, TODAY_DATE injection in both directions, rule-file
  loading for all six stages against the on-disk bytes, the `RULES_DIR` override plus
  missing-file behaviour, and four assembly edge cases.

  **Negative controls** (each applied, run, reverted):

  ```
  $ # 1. swap the NICHE and INTENT rows of CONFIG_FIELDS
   Test Files  1 failed (1)
        Tests  10 failed | 11 passed (21)

  $ # 2. drop the non-ASCII escaping from pythonJsonDumps
   FAIL  src/mastra/prompts.test.ts > buildStagePrompt edge cases >
         escapes non-ASCII in a serialized manifest the way json.dumps does
   Test Files  1 failed (1)
        Tests  1 failed | 20 passed (21)

  $ # 3. join sections with "\n\n" instead of "\n\n---\n\n"
   Test Files  1 failed (1)
        Tests  10 failed | 11 passed (21)

  $ # restored
   Test Files  1 passed (1)
        Tests  21 passed (21)
  ```

  Control 2 is the one the golden fixtures could not catch on their own, because neither
  captured manifest contains a non-ASCII character. Python's `json.dumps(..., indent=2)`
  defaults to `ensure_ascii=True` and `JSON.stringify` does not, so the two stacks would have
  diverged on exactly the manifests carrying typographic punctuation. Confirmed against the
  real Python:

  ```
  $ python3 -c 'import json
  print(json.dumps({"alt": "café — 90% sure ☕"}, indent=2))'
  {
    "alt": "caf\u00e9 \u2014 90% sure \u2615"
  }
  ```

  which is the exact string the TypeScript assertion expects.

  **Frontend gates:**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ pnpm lint
  lint exit=0

  $ NO_COLOR=1 pnpm test
   Test Files  2 failed | 22 passed (24)
        Tests  9 failed | 259 passed (268)
  test exit=1

  $ pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 238 -> 259, which is the 21 new tests. No `api/` file
  was touched (`git status --porcelain` listed only the three new `web/src/mastra/` files), so
  the pytest and ruff baselines are unchanged by construction.

## 3.1b


  Split from the original 3.1b, which bundled the agent, the step, the meta-response
  retry loop, the persistence contract and the parity test into one item. The agent half
  carries the port's biggest unknown for Phase 3 (can Mastra's model router reach
  Perplexity at all, and where does the API key come from) and is verifiable on its own
  with a live call, so it is its own iteration. The step half is 3.1c.

  **What was built**

  - `web/src/mastra/api-keys.ts`: `getApiKeys()` / `requireApiKey()`, ported from
    `get_api_keys()` in `api/src/services/api_keys.py`. Reads the encrypted `api_keys`
    row out of the `settings` table and decrypts it with `web/src/lib/crypto.ts` (item
    1.3). Same `PROVIDERS` tuple and same "missing provider maps to empty string"
    behaviour as Python.
  - `web/src/mastra/agents/research.ts`: the `research` Mastra `Agent`.
    `RESEARCH_SYSTEM_MESSAGE` is byte-identical to the `system=` string
    `research_node` sends; `RESEARCH_MODEL_ID` is `perplexity/sonar-pro`.
  - `web/src/mastra/index.ts`: `agents: { research: researchAgent }`.

  **Credential path decision.** The key is resolved inside the agent's dynamic `model`
  resolver, from the database, per call. It is deliberately *not* passed through the
  workflow input or `RequestContext`: the evented engine serialises run input into Redis
  Streams payloads and into the `mastra_workflow_snapshot` rows in Postgres, so a key
  routed that way would be persisted in the run history of every pipeline that ever ran.
  Resolving per call also means rotating the key on the settings page takes effect
  without restarting the worker, and it works identically in `web` and `worker` because
  both reach the same database. The cost is one indexed single-row read per provider
  call.

  **Model choice.** `sonar-pro` is carried over unchanged from
  `PerplexityClient.chat()`'s default. Per section 5, keeping a working incumbent is a
  success; choosing a stronger research model with its live verification and cost
  delta is ledger item 6.1, and changing it here would be an unverified choice. The
  live response below confirms the incumbent id resolves through Mastra's router.

  **Mastra's provider registry reaches Perplexity with no extra dependency.**
  `node_modules/@mastra/core/dist/provider-registry.json` carries a `perplexity`
  provider (`apiKeyEnvVar: PERPLEXITY_API_KEY`, models `sonar`, `sonar-deep-research`,
  `sonar-pro`, `sonar-reasoning-pro`, `npm: @ai-sdk/perplexity`), and the router
  resolves `{ id: "perplexity/sonar-pro", apiKey }` (an `OpenAICompatibleConfig`, see
  `@mastra/core/dist/llm/model/shared.types.d.ts:24-35`) without `@ai-sdk/perplexity`
  being installed. No new dependency was added for this item.

  **Evidence**

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/api-keys.test.ts
   Test Files  1 passed (1)
        Tests  6 passed (6)
  exit=0

  $ cd web && PERPLEXITY_API_KEY=<redacted> NO_COLOR=1 pnpm exec vitest run \
      src/mastra/agents/research.test.ts
   ✓ src/mastra/agents/research.test.ts (6 tests) 834ms
       ✓ reaches Perplexity and reports back the configured model id  810ms
   Test Files  1 passed (1)
        Tests  6 passed (6)
  exit=0
  ```

  The live smoke test writes the real key into the `settings` table encrypted with a
  throwaway Fernet key, runs one minimal generate, asserts the provider's own reported
  model id, and removes the row again, so it exercises the whole production path
  (encrypted row -> `crypto.ts` -> model router -> Perplexity) instead of a stub. It is
  `describe.skipIf(!process.env.PERPLEXITY_API_KEY)` so the default `pnpm test` needs no
  credentials; in the unkeyed run it reports as 1 skipped. The dev database is left with
  zero `settings` rows afterwards:

  ```
  $ PGPASSWORD=<redacted> psql -h localhost -p 5435 -U pipeline -d content_pipeline \
      -c "select count(*) from settings;"
   count
  -------
       0
  (1 row)
  ```

  **Live provider response (redacted).** Captured from a scratch call before the agent
  was written, confirming both the resolved model id and that the router carries
  Perplexity's citations and cost metadata through:

  ```
  MODELID: {"modelId":"sonar-pro","id":"24482d0f-621f-42cb-83d6-ed0c69ac6df8"}
  SOURCES: [{"type":"source","payload":{"sourceType":"url",
             "url":"https://www.reddit.com/r/CRM/comments/1f0yp7n/..."}}, ...]
  PROVIDERMETA: {"perplexity":{"images":null,
    "usage":{"citationTokens":null,"numSearchQueries":null},
    "cost":{"inputTokensCost":0.00007,"outputTokensCost":0.00042,
            "requestCost":0.006,"totalCost":0.00649}}}
  USAGE: {"inputTokens":15,"outputTokens":1,"totalTokens":16,"reasoningTokens":0, ...
          "raw":{"raw":{"cost":{"request_cost":0.006,"total_cost":0.00606}}}}
  ```

  Two notes this hands forward. `result.sources` exposes Perplexity's citation URLs as
  structured `source` parts, which is a better input for the `link_validator` TS port
  (item 5.7) than re-parsing them out of the markdown. And `result.usage.raw.raw.cost`
  carries the provider's own per-request cost in dollars, so Phase 8's cost column does
  not have to maintain a price table for Perplexity.

  **Negative controls** (each applied, run, reverted)

  1. Changed `RESEARCH_SYSTEM_MESSAGE`'s opening clause to "You are a helpful
     assistant.": `× sends the system message the Python stage sent, per the golden
     fixtures`, `AssertionError: expected 'You are an expert SEO content researc...' to
     be 'You are a helpful assistant. Respond ...'`. Proves the system message is
     checked against the golden fixtures, not against a copy of itself.
  2. Changed `RESEARCH_MODEL_ID` to `perplexity/sonar`: three tests red, including the
     live one with `AssertionError: expected 'sonar' to be 'sonar-pro'` reported by
     Perplexity itself. Proves the live assertion reads the provider's response rather
     than echoing the configured constant.
  3. Made `getApiKeys()` return the stored value without calling `decrypt()`: 4 of 6
     api-key tests red, including `expected 'gAAAAABqiQn5BeTxPn8UOkO4LVYYgH9X-KDUD...'
     to be 'pplx-only'`. Proves the reader decrypts real Fernet ciphertext out of the
     real table.

  **Intentional test update.** `no-next-imports.test.ts`'s expected package list gained
  `@mastra/core/agent`, `drizzle-orm` and `node:crypto`, which the registered agent
  legitimately pulls into the entry point's import graph, and the test name changed from
  "the packages the scaffold needs" to "the packages the registered primitives need".
  The load-bearing assertion in that file (no `next/*` or `server-only` anywhere in the
  graph) is untouched and still passes.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 24 passed (26)
        Tests  9 failed | 270 passed | 1 skipped (280)
  test exit=1

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 259 -> 270, which is the 11 new non-skipped
  tests. No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

## 3.1c-i


  **Split rationale.** 3.1c bundled four separable things: the posts-table bridge, the
  meta-response retry loop, the `createStep` wiring and the parity test. The bridge is
  shared by all six stages rather than specific to `research`, and it is the piece the
  crash-resume gate (item 4.5) actually depends on, so it is worth proving on its own
  against the real database before any stage is built on it. Item 3.1c-ii is the
  `research` step itself.

  **What was built.** `web/src/mastra/post-state.ts`:
  - `pipelineStateSchema` / `PipelineState`: `pipelineContextSchema` extended with the
    identity and run-control fields (`postId`, `slug`, `profileId`, `imageStyle`,
    `imageBrandColors`, `imageExclude`, `finalHtml`, `currentStage`, `stageSettings`,
    `stageStatus`). `api_keys` stays out, unlike Python's `PipelineState`, so a
    credential cannot ride into a provider payload inside the prompt-input object.
  - `stateFromPost(post, internalLinks)`: column-for-column port, including Python's
    falsy coalescing (`or`, not `??`, so `word_count` 0 becomes 2000) and the three
    defaults `2000` / `"Conversational and friendly"` / `"markdown"` plus the
    all-six-stages-`auto` `stage_settings` fallback.
  - `saveStageOutput(postId, stage, content, stageStatus?)`: writes the stage's column,
    advances `current_stage`, and replaces `stage_status` only when the caller supplies
    one. The drizzle property for each stage's column is resolved at import time from
    `getTableColumns(posts)` by the database column name in `STAGE_CONTENT_MAP`, so the
    two maps cannot drift into writing the wrong column.

  **Two behaviours found in the Python original that a naive port would have lost.**
  1. `save_stage_output()` runs through SQLAlchemy's Core `update()`, so
     `TimestampMixin.updated_at`'s `onupdate` fired on every stage write. Postgres has
     no trigger doing this, so the TypeScript version stamps `updatedAt` explicitly.
     Negative control 3 below is the proof that the database does not do it for us.
  2. `stage_settings` differs by writer, as recorded under item 1.4: the fixtures'
     all-`auto` six-stage value came from the SQLAlchemy model default, which happens to
     equal `stateFromPost`'s NULL fallback, while a drizzle insert would get the
     database's five-stage all-`review` default. The parity test inserts NULL so the
     fallback branch is the one under test.

  **Parity oracle.** The golden fixtures' `state_input` block is a verbatim dump of the
  state the Python pipeline ran on. The test inserts a row built from `post_spec` into
  the real Alembic-owned dev database, reads it back through drizzle, and asserts
  `stateFromPost(row, links)` deep-equals `state_input` with keys camelized and
  `api_keys` dropped. Keys are camelized generically rather than by a listed mapping, so
  a field the port forgot to map surfaces as a missing key instead of being silently
  excluded from the comparison.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/post-state.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   ✓ src/mastra/post-state.test.ts (6 tests) 35ms

   Test Files  1 passed (1)
        Tests  6 passed (6)
  ```

  **Negative controls** (each reverted immediately):
  1. `wordCount: post.wordCount || DEFAULT_WORD_COUNT` -> `?? `: `× coalesces a zero
     word count to Python's 2000, not to zero`, `AssertionError: expected +0 to be 2000`.
     Proves the test pins Python's falsy coalescing rather than any coalescing.
  2. Deleted the `articleType` mapping: both fixture parity tests red with
     `- "articleType": "how-to",` and `- "articleType": "listicle",` in the diff. Proves
     the generic camelization really does catch an unmapped field.
  3. Deleted the explicit `updatedAt: new Date()`: `AssertionError: expected
     1787366289626 to be greater than 1787366289626`. The two timestamps being identical
     is the evidence that Postgres does not stamp `updated_at` on its own, so the
     explicit stamp is load bearing and not decoration.
  4. Renamed `STAGE_CONTENT_MAP.research` to `reserch_content`: import-time
     `Error: posts has no column 'reserch_content' for stage 'research'`, `Tests no
     tests`. Proves the column resolver fails loudly instead of writing nowhere.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 25 passed (27)
        Tests  9 failed | 276 passed | 1 skipped (286)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 270 -> 276, which is the 6 new tests. `lint`
  reports zero problems. No `api/` file was touched, so the pytest and ruff baselines
  are unchanged by construction.

## 3.1c-ii


  **What was built**

  - `web/src/mastra/steps/stage-io.ts`: the input/output contract every stage step
    shares. Input is `{ postId }` only. A step reads its inputs from the columns
    previous steps committed rather than from the workflow snapshot, which is what
    makes a resume cheap and correct; the snapshot never carries article-sized
    strings. Output is Python's `_stage_meta` (`stage`, `model`, `tokens_in`,
    `tokens_out`, `duration_s`) plus `postId`, so the next step in the chain gets a
    valid input with no mapping step between them.
  - `web/src/mastra/steps/research.ts`: `researchStep` via `createStep` from
    `@mastra/core/workflows/evented` (the same engine the scaffold workflow uses, per
    item 2.4), plus the ported `isValidResearch`, `REFUSAL_PATTERNS`,
    `EXPECTED_SECTIONS`, `MAX_RESEARCH_ATTEMPTS` and `reinforcedPrompt`.
  - `web/src/mastra/post-state.ts` gains `loadInternalLinks` and `loadPipelineState`,
    the read path a step uses: post row plus the profile's crawled links, matching
    `_fetch_internal_links()` in `api/src/worker.py`. A missing post throws rather
    than yielding an empty state, so a bad id cannot bill a provider call for a
    prompt full of empty strings.

  Nothing was registered on the Mastra instance by this item: `createStep` products
  reach the instance through the workflow they are composed into, which is item 4.1.

  **Parity oracle.** The fixture's `post_spec` is inserted into the real
  Alembic-owned database, the step reads it back through drizzle, and the prompt it
  hands the agent is compared byte for byte against the fixture's
  `rendered_prompts[0]`. The provider call is replayed from the fixture's recorded
  response body rather than made live; the live Perplexity call is item 3.1b's smoke
  test, and re-billing a 6k-token research call on every `pnpm test` would prove
  nothing this replay does not. Both database round trips run for real.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/steps/research.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   ✓ src/mastra/steps/research.test.ts (9 tests) 57ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
  ```

  **Negative controls** (each reverted immediately):
  1. `loadRules("research")` -> `loadRules("outline")`: both prompt parity tests red
     with `- # Blog Research Agent` / `+ # Blog Outline Agent` in the diff. Proves the
     comparison is against the real rendered prompt, not a self-consistent rebuild.
  2. `tokensIn +=` -> `tokensIn =`: `AssertionError: expected 1510 to be 1610`. Proves
     the retry test pins Python's sum-across-attempts billing rather than last-call
     billing.
  3. Reworded the retry preamble (`your limitations` -> `your limits`): retry test red
     with the two `IMPORTANT: You must respond with ONLY...` strings differing. Worth
     recording that the first version of this assertion compared against
     `reinforcedPrompt()` itself and stayed green under this control, because both
     sides moved together; it now compares against a `PYTHON_RETRY_PREAMBLE` literal
     copied from `_reinforced_prompt`.
  4. Deleted the `break` out of the retry loop: four tests red, including
     `expected [ ...(3) ] to have a length of 1 but got 3`. Proves a valid first
     response really does stop the loop instead of being re-asked three times.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 26 passed (28)
        Tests  9 failed | 285 passed | 1 skipped (295)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 276 -> 285,
  which is the 9 new tests. No `api/` file was touched, so the pytest and ruff
  baselines are unchanged by construction.

  **Discrepancy noted.** `research_node` publishes four SSE progress lines through
  `publish_stage_log` (rules loaded, calling Perplexity, retry warnings, token
  count). The step logs the retry and degraded-research cases through
  `mastra.getLogger()` but publishes no SSE. The event bus that carries these to the
  dashboard is item 5.5, and Phase 8 reads step progress from Mastra's own stream
  events rather than from hand-published log lines, so wiring a second channel here
  would be building something Phase 8 replaces.

## 3.2


  Ported as an agent (`web/src/mastra/agents/outline.ts`, registered on the Mastra
  instance) plus a step (`web/src/mastra/steps/outline.ts`) reusing the item-3.1a
  prompt assembly and the item-3.1c-i posts-table bridge. Unlike `research` this
  stage has no validator and no retry loop, so the step is one provider call
  wrapped in the state contract.

  The shared Claude call settings live in `web/src/mastra/agents/claude.ts`, which
  the remaining three Anthropic stages (`write`, `edit`, `ready`) will reuse: they
  all go through the same `ClaudeClient.chat()` with nothing but `max_tokens` and
  the system message differing.

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/outline.test.ts src/mastra/agents/outline.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   OK src/mastra/steps/outline.test.ts (5 tests) 58ms
   OK src/mastra/agents/outline.test.ts (8 tests | 1 skipped) 74ms

   Test Files  2 passed (2)
        Tests  12 passed | 1 skipped (13)
     Duration  945ms
  ```

  The skipped test is the live Anthropic smoke test, gated on `ANTHROPIC_API_KEY`
  so the default `pnpm test` needs no credentials. Run with the real key:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
      src/mastra/agents/outline.test.ts -t "live smoke"
   OK src/mastra/agents/outline.test.ts (8 tests | 7 skipped) 2082ms
       OK reaches Anthropic and reports back the configured model id  2063ms

   Test Files  1 passed (1)
        Tests  1 passed | 7 skipped (8)
  ```

  That asserts `response.modelId === "claude-opus-4-6"`, so `anthropic/claude-opus-4-6`
  resolves through Mastra's model router against the live API. The model choice
  itself is still the incumbent; item 6.1 owns picking and justifying a better one.

  **Provider request parity, and the token-budget divergence it exposed.**
  `outline` is the first stage whose provider request carries more than a model and
  a system message. Python enables extended thinking
  (`thinking={"type": "enabled", "budget_tokens": 10000}`) and computes
  `max_tokens = max(8000, 10000 + 1024) = 11024`, treating `max_tokens` as the
  total budget the way Anthropic's API does. The AI SDK provider inside
  `@mastra/core` instead treats `maxOutputTokens` as the **text** budget and puts
  `max_tokens = maxOutputTokens + budget_tokens` on the wire
  (`node_modules/@mastra/core/dist/dist-BcUqNSEb.js`:
  `baseArgs.max_tokens = maxTokens + (thinkingBudget != null ? thinkingBudget : 0)`).
  Passing Python's 11024 straight through would have sent 21024. `claudeStageOptions`
  subtracts the thinking budget so both stacks send 11024.

  `agents/outline.test.ts` proves that on the real serialized request rather than on
  the agent's configuration: it swaps `globalThis.fetch`, runs `agent.generate()`,
  and compares the captured body against the request recorded in the golden fixture.

  Negative control, dropping the subtraction in `claudeStageOptions`:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/outline.test.ts
       x puts Python's model, max_tokens and thinking budget on the wire 60ms
    AssertionError: expected 21024 to be 11024 // Object.is equality
        Tests  1 failed | 6 passed | 1 skipped (8)
  ```

  Negative control, not seeding the chain input (`researchContent: null`) so the
  step renders without the research document the previous stage committed:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/outline.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       x sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       x carries the research document the previous stage committed
       x commits the outline to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
        Tests  4 failed | 1 passed (5)
  ```

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  tsc exit=0

  $ cd web && NO_COLOR=1 pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 28 passed (30)
        Tests  9 failed | 297 passed | 2 skipped (308)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 285 -> 297,
  which is the 12 new tests, and skips moved 1 -> 2, which is the live smoke test.
  No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

  **Discrepancies noted.**
  1. Python's Anthropic SDK sends `system` as a bare string; the AI SDK sends the
     same text as `[{"type": "text", "text": ...}]`. Anthropic accepts both, so the
     test compares the text and not the shape.
  2. A `url` override on the model config is **not** a way to capture an Anthropic
     request: it routes the agent through Mastra's OpenAI-compatible client, which
     POSTs to `/chat/completions` and passes `budgetTokens` through unconverted.
     Only `globalThis.fetch` capture exercises the native provider.
  3. `outline_node` publishes three SSE progress lines through `publish_stage_log`;
     the step publishes none, for the same reason recorded under item 3.1c-ii (the
     event bus is item 5.5 and Phase 8 reads progress from Mastra's stream events).
  4. The step test seeds no internal links. `buildStagePrompt` offers them to `edit`
     only, so they cannot affect this stage's prompt; `edit`'s parity test (item 3.4)
     is where the link inventory has to be seeded for real.

## 3.3


  Ported as an agent (`web/src/mastra/agents/write.ts`, registered on the Mastra
  instance) plus a step (`web/src/mastra/steps/write.ts`). Structurally the same as
  `outline`: no validator, no retry loop, one Claude call wrapped in the state
  contract, reusing the item-3.1a prompt assembly, the item-3.1c-i posts-table
  bridge and the shared `agents/claude.ts` call settings. What differs is the chain
  input (`posts.outline_content` rather than `posts.research_content`), the token
  budget and the column the draft is committed to (`posts.draft_content`).

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts src/mastra/agents/write.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   OK src/mastra/steps/write.test.ts (6 tests) 69ms
   OK src/mastra/agents/write.test.ts (8 tests | 1 skipped) 73ms

   Test Files  2 passed (2)
        Tests  13 passed | 1 skipped (14)
     Duration  970ms
  ```

  The skipped test is the live Anthropic smoke test, gated on `ANTHROPIC_API_KEY`
  so the default `pnpm test` needs no credentials. Run with the real key:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
      src/mastra/agents/write.test.ts -t "live smoke"
   OK src/mastra/agents/write.test.ts (8 tests | 7 skipped) 1928ms
       OK reaches Anthropic and reports back the configured model id  1910ms

   Test Files  1 passed (1)
        Tests  1 passed | 7 skipped (8)
  ```

  That asserts `response.modelId === "claude-opus-4-6"`, so `anthropic/claude-opus-4-6`
  resolves through Mastra's model router against the live API. The model choice is
  still the incumbent; item 6.1 owns picking and justifying a better one.

  **The other branch of the token-budget divergence.** Item 3.2 recorded that
  Python's `effective_max = max(max_tokens, thinking_budget + 1024)` and the AI SDK's
  `max_tokens = maxOutputTokens + budget_tokens` only agree because
  `claudeStageOptions` subtracts the budget. `outline`'s 8000 exercises the clamped
  branch (raised to the 11024 floor); `write`'s 16000 is the first stage that clears
  the floor, so it exercises the pass-through branch and pins `max_tokens = 16000`
  on the wire against the golden fixture. Both branches are now covered.

  **The internal-link inventory is withheld from `write`, and that is now pinned.**
  The `how-to-choose-a-crm-for-a-small-team` fixture was captured with three internal
  links in `state["internal_links"]` and its recorded prompt has no link section,
  because `build_stage_prompt` offers links to `edit` only. So this step's test seeds
  a real `website_profiles` row and three real `internal_links` rows, attaches the
  post to that profile, and asserts the prompt still matches byte for byte and
  contains neither the heading nor any of the three URLs. The second fixture has no
  links and stays unattached, so the no-links path through `stateFromPost` is still
  covered.

  Negative control, seeding `outlineContent: null` so the step renders without the
  outline the previous stage committed:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       x sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       x carries the outline the previous stage committed, not the research
       OK withholds the internal-link inventory even when the post has links
       x commits the draft to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
        Tests  4 failed | 2 passed (6)
  ```

  Negative control, extending `buildStagePrompt`'s link condition from
  `stage === "edit"` to `stage === "edit" || stage === "write"`. Both the
  withholding test and the first fixture's byte-parity test go red, which also
  proves the seeded links really reach the prompt path rather than the assertion
  passing vacuously:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       OK sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       OK carries the outline the previous stage committed, not the research
       x withholds the internal-link inventory even when the post has links
       OK commits the draft to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
    AssertionError: expected '# Blog Writing Agent...' not to contain 'Available Internal Links'
        Tests  2 failed | 4 passed (6)
  ```

  Negative control, `WRITE_MAX_TOKENS` set to `outline`'s 8000 so the clamp applies:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/write.test.ts
       x puts Python's model, max_tokens and thinking budget on the wire 53ms
       x passes 16000 through untouched because it clears the thinking floor 0ms
    AssertionError: expected 11024 to be 16000 // Object.is equality
    AssertionError: expected 8000 to be 16000 // Object.is equality
        Tests  2 failed | 5 passed | 1 skipped (8)
  ```

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  tsc exit=0

  $ cd web && NO_COLOR=1 pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 30 passed (32)
        Tests  9 failed | 310 passed | 3 skipped (322)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 297 -> 310,
  which is the 13 new tests, and skips moved 2 -> 3, which is the live smoke test.
  No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

  **Discrepancies noted.**
  1. Python builds `write_node`'s `system=` by concatenating five adjacent string
     literals; `WRITE_SYSTEM_MESSAGE` reproduces the concatenation with the same
     splits, and both golden fixtures' recorded `system` are asserted equal to it.
  2. `write_node` publishes three SSE progress lines through `publish_stage_log`;
     the step publishes none, for the same reason recorded under item 3.1c-ii.
  3. The `system`-as-block-list and `url`-override discrepancies recorded under item
     3.2 apply unchanged here; they are properties of the shared Anthropic path, not
     of this stage.

## 3.4a


    **Why this is its own item**

    `compute_analytics` calls two textstat entry points, `sentence_count()` and
    `flesch_reading_ease()`, and prints both numbers into the edit prompt
    (`- **Flesch Reading Ease:** {analytics.flesch_reading_ease}`). Byte-exact
    prompt parity therefore needs textstat's arithmetic reproduced exactly, and
    that arithmetic bottoms out in two data sets: the CMU pronouncing dictionary
    (reached through `nltk`) and `pyphen`'s `hyph_en_US.dic` TeX patterns, which
    `count_syllables` falls back to for out-of-vocabulary words. The usual
    JavaScript syllable heuristics disagree with the CMU dictionary on ordinary
    words, and one syllable across a 2,000 word draft moves the Flesch score by
    enough to change the rendered digit, so an approximation is not usable here.

    **What was built**

    - `api/scripts/export_textstat_data.py`: freezes what Python reads into
      `web/src/mastra/textstat/data/`. It writes `cmudict-syllables.txt.gz`
      (`word -> syllables in the first pronunciation`, 123,455 entries, 388 KB
      gzipped), copies `hyph_en_US.dic` and its licence notice verbatim out of the
      installed `pyphen`, and writes `textstat-parity.json`, the oracle. The data
      files are frozen rather than pulled from npm because no JavaScript package
      guarantees the same revision of either data set, and because both vanish
      from this repo when `api/` is deleted in Phase 7.
    - `web/src/mastra/textstat/hyphenator.ts`: port of `pyphen`'s `HyphDict` and
      `Pyphen.positions`, at `left=2` / `right=2` (pyphen's constructor defaults,
      which it applies in preference to the `LEFTHYPHENMIN` / `RIGHTHYPHENMIN`
      directives inside the dictionary file). Only `positions()` is ported;
      `iterate`, `wrap` and `inserted` have no consumer in `count_syllables`.
    - `web/src/mastra/textstat/index.ts`: `pythonSplit`, `removePunctuation`,
      `listWords`, `countWords`, `countSentences`, `cmuSyllables`,
      `countSyllables`, `wordsPerSentence`, `syllablesPerWord`,
      `fleschReadingEase`.
    - `web/src/mastra/textstat/textstat.test.ts`: 52 parity tests.

    **How the parity is proved**

    The centrepiece is a SHA-256 over an exhaustive table rather than a sample:
    every CMU dictionary word with its syllable count and its `pyphen` hyphenation
    positions, `<word>\t<syllables>\t<comma-joined positions>` per line, sorted,
    joined by `\n`. Python writes the digest, TypeScript rebuilds the table from
    the two frozen files and compares. That proves the port over 123,455 real
    words from a 20 KB assertion. Recording positions rather than their count
    means a port that reaches the right count for the wrong reason still fails.

    On top of the digest: the 400 golden-fixture words that miss the CMU
    dictionary (the only words that reach the hyphenator in real content), a
    150-word readable sample so a digest mismatch is debuggable, and 41 whole-text
    expectations, 29 of which are the real research documents, outlines, drafts
    and final markdown captured in `docs/mastra-port/golden/`.

    ```
    $ cd web && pnpm vitest run src/mastra/textstat/textstat.test.ts
     RUN  v4.0.18 /Users/cody/.../objective-port-jena-46c1e6-1/web

     v src/mastra/textstat/textstat.test.ts (52 tests) 522ms

     Test Files  1 passed (1)
          Tests  52 passed (52)
       Start at  22:23:11
       Duration  909ms
    ```

    **Negative controls** (each applied, run, reverted)

    1. `LEFT_HYPHEN_MIN` 2 -> 1 in `hyphenator.ts`: `Tests  34 failed | 18 passed`.
       The digest, the sample, the out-of-vocabulary words and every text carrying
       an out-of-vocabulary word all go red.
    2. `PY_WHITESPACE` replaced by JavaScript's `\s`:
       `Tests  1 failed | 51 passed`, on the assertion that pins Python's
       whitespace set against JavaScript's.
    3. The Unicode word-boundary emulation in `SENTENCE` replaced by JavaScript's
       `\b`: `Tests  1 failed | 51 passed`, on
       `unicode-initial-single-letter-word`.
    4. `countSyllables` forced down the hyphenator path, ignoring the CMU
       dictionary: `Tests  30 failed | 21 passed`.

    Control 3 initially passed, which was informative: the golden fixtures and the
    first set of hand-written cases never place a non-ASCII letter where the two
    engines' `\b` disagree, so the emulation was untested. A case was added to the
    exporter (`"A" ist gut. Das war alles was wir sagen wollten.` with a leading
    single-letter umlaut word) where Python counts 2 sentences and JavaScript's
    `\b` counts 1, and the control then failed as it should.

    One control was applied and did **not** fail, and the code was corrected rather
    than the control discarded: dropping the trailing zero-length pair from
    `parsePattern` (Python's `re.findall` emits one at end of string) changes
    nothing, because that pair only ever appends a zero value and the caller chops
    trailing zeros. The pair is kept for readability against `re.findall`, and its
    comment now says it is not load-bearing instead of claiming it is.

    **Recorded discrepancies**

    1. Python's `\w` and Node's `\p{L}\p{N}_` come from different Unicode
       revisions: 4,382 code points (for example `U+1C89`, `U+A7CB`, the
       `U+105C0` block) are word characters to Node and not to Python 3.13.
       Measured by enumerating both classes over the full code point range. None is
       reachable from a blog draft.
    2. Python's `\s` (identical to `str.isspace()`, verified by enumerating both
       over the full range) covers `\x1c`-`\x1f` and `\x85`, which JavaScript's
       `\s` does not, and omits `U+FEFF`, which JavaScript's includes. Spelled out
       as `PY_WHITESPACE` rather than borrowed, and pinned by a test.
    3. `analytics.py` wraps these numbers in Python's `round()`, which is
       round-half-to-even and unlike JavaScript's `Math.round`. That belongs to
       item 3.4b, not here; this module returns the unrounded score, matching
       textstat, whose own rounding is off by default (`__round_points is None`).
    4. The data files are read with `readFileSync` relative to `process.cwd()`,
       the same assumption `rulesDir()` already makes. `next build`'s output file
       tracing does not follow that, so both need handling before the Phase 7
       Railway deploy. Logged in `todo.md` rather than solved here.

    **One defect fixed in passing**, because it made an honest gate reading
    impossible: `research`, `outline` and `write` step tests each seeded the
    golden fixtures' posts under the fixtures' own ids, so vitest running the three
    files in parallel raced on the `posts` primary key. It surfaced as
    `duplicate key value violates unique constraint "posts_pkey"` and
    `post ... not found`, 6 to 9 extra failures depending on scheduling, and it was
    present before this iteration's files existed (verified by moving
    `src/mastra/textstat/` aside and re-running: `Tests  16 failed | 303 passed`).
    Each file now namespaces its rows by rewriting the fixture id's second-to-last
    byte, which no rendered prompt reads.

    ```
    $ cd web && pnpm vitest run src/mastra/steps
     v src/mastra/steps/research.test.ts (9 tests) 63ms
     v src/mastra/steps/write.test.ts (6 tests) 79ms
     Test Files  3 passed (3)
          Tests  20 passed (20)
    ```

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit ; echo "tsc exit=$?"
    tsc exit=0

    $ cd web && pnpm lint ; echo "lint exit=$?"
    lint exit=0

    $ cd web && pnpm test
     Test Files  2 failed | 31 passed (33)
          Tests  9 failed | 362 passed | 3 skipped (374)

    $ cd web && pnpm build ; echo "build exit=$?"
    build exit=0

    $ cd api && uv run ruff check scripts/export_textstat_data.py ; echo "exit=$?"
    All checks passed!
    exit=0

    $ cd api && uv run ruff format --check scripts/export_textstat_data.py ; echo "exit=$?"
    1 file already formatted
    exit=0

    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 14.92s
    ```

    `pnpm test` is 9 failed / 362 passed, which is the recorded failure baseline
    (6 in `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with
    passes moving 310 -> 362: the 52 new tests. Run three times with identical
    results, where before the step-test fix the same command returned 15, 16 and 18
    failures on consecutive runs. `pytest` is at the Phase 0 baseline of
    125 failed / 235-236 passed / 25 errors; the repo-wide `ruff check .` and
    `ruff format --check .` baselines (41 errors, 10 files) are untouched, and the
    one file this iteration added to `api/` passes both.

## 3.4b


    **Why the fixtures are the primary oracle here**

    The captured edit prompts already contain the numbers Python produced, as
    literals: `- **Word Count:** 2128 (target: 1800)`,
    `- **Flesch Reading Ease:** 65.7 (target: 60-70; ...)`,
    `- **Avg Sentence Length:** 15.1 words (target: <20)` and one
    `- **<keyword>:** <density>% (target: 1-2%)` line per keyword, plus a
    `[PASS]` / `[FAIL]` line per boolean check. Nothing in this repo generated
    those digits for the benefit of the test, so the strongest assertion
    available is to recompute them in TypeScript and look them up in the
    captured prompt. That is `describe("golden fixture edit prompts")`, and it
    covers both fixtures.

    **What was built**

    - `web/src/mastra/analytics/index.ts`: `computeAnalytics`, `seoChecklist`,
      `stripMarkdown` and `urlNetloc`, a statement-for-statement port of
      `compute_analytics`, `_seo_checklist` and `_strip_markdown`. The SEO
      checklist keeps Python's insertion order and its mixed value type
      (booleans for the checks, integers for `internal_link_count` and
      `external_link_count`), because `edit_node` renders the dict in order and
      filters on `isinstance(passed, bool)`.
    - `web/src/mastra/analytics/python-round.ts`: `pythonRound`, Python's
      `round(float, ndigits)` in `BigInt` arithmetic over the double's exact
      binary value.
    - `api/scripts/export_analytics_parity.py`: writes
      `web/src/mastra/analytics/data/analytics-parity.json`, the second oracle,
      covering what the fixtures cannot reach.
    - `web/src/mastra/textstat/index.ts`: `pythonStrip` and `PY_WHITESPACE`
      exported so the analytics port spells Python's whitespace class the same
      way rather than re-deriving it; `pythonSplit` now calls `pythonStrip`.

    **Three Python primitives that do not survive a naive translation**

    1. `round()` is round-half-to-even over the double's *exact binary value*.
       JavaScript has no equivalent: `Math.round` breaks ties upward and
       `Number.prototype.toFixed` breaks them away from zero. This is reachable
       from real data, not just theory: `avg_sentence_length` is
       `word_count / sentence_count`, so a 405 word draft with 20 sentences is
       exactly `20.25`, and Python prints `20.2` where `toFixed(1)` prints
       `20.3`. A double is an exact tie at `n` decimals only when it is
       `odd / 2**k` with `k <= n + 1`, so `pythonRound` compares the true
       remainder in `BigInt` rather than re-parsing a decimal approximation.
       Verified against 52 exported `round()` results including every tie of
       that form at 1 and 2 decimals.
    2. `re.MULTILINE`'s `^` matches only after `\n`. JavaScript's `m` flag also
       matches after `\r`, `U+2028` and `U+2029`. Every multiline anchor in the
       port is written `(?:^|(?<=\n))` and the `m` flag is never used, so
       `Carriage return\r## not a heading in Python` stays body text in both
       stacks.
    3. Python's `.` excludes `\n` alone; JavaScript's excludes `\r`, `U+2028`
       and `U+2029` too. Written as `[^\n]`. This one is not observable through
       `compute_analytics`'s output (the H2 captures only feed substring tests
       and a count), and it is ported faithfully anyway.

    Also ported rather than approximated: `str.count` is non-overlapping, and
    `urlparse(url).netloc` is empty for a URL with no `//`, so a profile whose
    `website_url` is a bare `example.com` classifies every link as external.
    Both are pinned by tests, the second against 17 exported `urlparse` results.

    **Test run**

    ```
    $ cd web && pnpm vitest run src/mastra/analytics/analytics.test.ts
     RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

     ✓ src/mastra/analytics/analytics.test.ts (46 tests) 48ms

     Test Files  1 passed (1)
          Tests  46 passed (46)
    ```

    46 tests: 4 on `pythonRound`, 1 comparing `urlNetloc` against all 17
    exported `urlparse` results, 17 comparing `computeAnalytics` against the
    exported `compute_analytics` results, 16 comparing `stripMarkdown` against
    the exported `_strip_markdown` output, 2 reading the analytics literals back
    out of the captured edit prompts, 5 pinning the Python primitives above, and
    1 asserting the oracle file is the one this test expects.

    **Oracle regeneration**

    ```
    $ cd api && uv run python scripts/export_analytics_parity.py
    wrote web/src/mastra/analytics/data/analytics-parity.json: 17 cases, 52 round cases, 17 netloc cases
    ```

    **Four negative controls, applied and reverted**

    ```
    == NC1: toFixed instead of round-half-even ==
          Tests  2 failed | 44 passed (46)
    == NC2: JavaScript m flag for the multiline anchors ==
          Tests  4 failed | 42 passed (46)
    == NC3: overlapping substring count ==
          Tests  1 failed | 45 passed (46)
    == NC4: permissive netloc (bare host treated as authority) ==
          Tests  3 failed | 43 passed (46)
    == reverted ==
          Tests  46 passed (46)
    ```

    NC1 is the honest one to read carefully: swapping `pythonRound` for
    `Number(value.toFixed(ndigits))` fails only the two dedicated tie tests and
    leaves all 17 fixture and golden cases green. The captured drafts never land
    on an exact tie, which is precisely why the 52 exported `round()` results
    exist rather than trusting the fixtures to cover it.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit          # exit 0, no output
    $ cd web && pnpm lint                  # exit 0, no output
    $ cd web && pnpm test
     Test Files  2 failed | 32 passed (34)
          Tests  9 failed | 408 passed | 3 skipped (420)
    $ cd web && pnpm build
    ✓ Compiled successfully in 3.1s
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 362 -> 408: the 46 new tests. The 3 skipped are the live-provider
    smoke tests, which need keys this worktree does not carry. `db` and `redis`
    must be up for an honest reading: with them down the same command reports
    15 failed files and 73 skipped tests, which is a missing datastore and not a
    regression.

    ```
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.08s
    $ cd api && uv run ruff check scripts/export_analytics_parity.py
    All checks passed!
    $ cd api && uv run ruff format --check scripts/export_analytics_parity.py
    1 file already formatted
    ```

    `pytest` is at the Phase 0 baseline. The repo-wide `ruff check .` and
    `ruff format --check .` baselines are untouched; the one file this iteration
    added to `api/` passes both.

    **Discrepancies recorded, not fixed**

    1. `edit_node` renders the floats with an f-string, so `str(float)` always
       carries a decimal point and a density of exactly zero prints `0.0%` where
       JavaScript's `String(0)` gives `0%`. The golden fixture
       `how-to-choose-a-crm-for-a-small-team` contains
       `- **crm comparison:** 0.0%`, so item 3.4e needs a production
       `str(float)` shim; this item's test carries a local one.
    2. Python's `str.lower()` and JavaScript's `toLowerCase()` are not the same
       function for every code point. Both fixtures' keywords and headings are
       ASCII, so nothing here discriminates between them. If a non-ASCII keyword
       ever appears, this is the first place to look.
    3. `tsconfig.json` targets ES2017, where BigInt *literals* (`0n`) are a type
       error even though `lib: esnext` provides the type. `pythonRound` names its
       constants through `BigInt(...)` rather than raising the app-wide target.

## 3.4c


    **Why this needed its own oracle shape**

    `link_validator` is the only service in the pipeline that reaches the
    network, so it cannot be pinned by a table of inputs and outputs the way
    `analytics-parity.json` pins `compute_analytics`. The oracle is therefore
    split in two, both halves written by one script:

    1. **Network cases.** Python stands up a local HTTP server whose routes
       return exactly the status codes the stripper cares about (404, 410 and
       451 strip; 200, 418 and 500 keep), plus a 301 to a 410, a 302 to a 200, a
       refused connection on a closed port, and a route that sleeps past
       `_REQUEST_TIMEOUT`. It runs the real `validate_links` against them and
       records the resulting content and `removed` list with the base URL
       templated back to `{BASE}`. The vitest file stands up the equivalent
       server in Node on its own port and runs the TypeScript port against it.
       Nothing is mocked on either side: both implementations open real sockets
       to a real server.
    2. **Extraction and strip cases.** `_MD_LINK_RE.findall` and the `re.sub`
       loop are pure, so they are exported as plain input/output tables. The
       eight golden cases carry a pointer into `docs/mastra-port/golden/`
       instead of a copy of the text, so the test reads the real captured stage
       content rather than a transcription made for its benefit.

    **What was built**

    - `web/src/mastra/links/index.ts`: `validateLinks`, plus `findMarkdownLinks`
      and `stripDeadLinks` exported because they are the pure half of the module
      and therefore the half a test can pin exactly. `CONCURRENCY_LIMIT` and
      `REQUEST_TIMEOUT_MS` mirror `_SEMAPHORE_LIMIT` and `_REQUEST_TIMEOUT`.
    - `api/scripts/export_link_validator_parity.py`: writes
      `web/src/mastra/links/data/link-validator-parity.json` (16 KB): 22 network
      cases, 22 extraction cases, 9 strip cases.
    - `web/src/mastra/links/links.test.ts`: 57 tests.

    **Four details that do not survive a naive translation**

    1. `re.escape` escapes a superset of what a JavaScript regex needs, but the
       two agree on every character that is actually special outside a character
       class, so `escapeRegExp` escapes the JavaScript set and the `u` flag is
       never used. Under `u`, `\&` is a SyntaxError rather than an identity
       escape, so escaping Python's full set would not even compile.
    2. `re.sub`'s replacement `\1` inserts the captured text verbatim.
       `String.prototype.replace` with `"$1"` also inserts it verbatim, but a
       `$&`, `$1`, `` $` `` or `$'` *inside the captured link text* is a
       replacement special only if the text is used as the replacement pattern.
       It is not, and a dedicated test pins that.
    3. `str.startswith(("http://", "https://"))` is case-sensitive, so a link
       written `HTTP://...` is never checked and never stripped. Pinned by the
       `uppercase-scheme` case.
    4. Python iterates `dead_urls`, a `set`, whose iteration order is
       hash-randomised per process. The substitutions are independent for every
       URL, so the order is unobservable for any content this pipeline produces;
       the port substitutes in first-appearance order so it is deterministic at
       all. The `removed` list's order is *not* arbitrary in Python (it comes
       from the `results` dict, which is insertion-ordered), and the port
       reproduces it, pinned by `two-dead-out-of-order` and `mixed`.

    **Recorded discrepancies**

    1. `httpx`'s `timeout=10` is a per-phase budget (connect, read, write, pool
       each get 10s); `AbortSignal.timeout(10_000)` is a deadline over the whole
       request. A server that dribbles a response for more than 10s total
       without ever stalling 10s in one phase is answered by Python and aborted
       here. Both branches keep the link unless the slow answer was a 404, so
       the divergence is in the conservative direction. Not reachable through
       the fixtures.
    2. `validate_links` calls `logger.warning(f"Dead link ({status}): {url}")`
       per dead URL. The port logs nothing: `edit_node` separately publishes a
       `Stripped N dead link(s): ...` SSE line from the returned `removed` list,
       and that line is item 3.4e's business, for the same reason recorded under
       item 3.1c-ii.
    3. `strip_dead_links_html` is deliberately not ported. It has no caller
       anywhere in the repo outside its own pytest:

       ```
       $ grep -rn "strip_dead_links_html" --include='*.py' --include='*.ts' --include='*.tsx' . | grep -v node_modules
       api/tests/phase9/test_link_validator.py:8:    strip_dead_links_html,
       api/tests/phase9/test_link_validator.py:138:def test_strip_dead_links_html():
       api/tests/phase9/test_link_validator.py:140:    result = strip_dead_links_html(html, {"https://dead.com"})
       api/tests/phase9/test_link_validator.py:147:    result = strip_dead_links_html(html, {"https://dead.com"})
       api/src/services/link_validator.py:110:def strip_dead_links_html(html: str, dead_urls: set[str]) -> str:
       ```

       The WordPress HTML path (`wp_html.py`) does not use it. Porting it would
       be speculative; if a caller appears before Phase 7 deletes `api/`, the
       Python source is the reference.

    **The concurrency probe, and why the first reading was wrong**

    `_SEMAPHORE_LIMIT` is pinned by a case with 12 links to a route that sleeps
    0.3s, with the server recording the highest number of simultaneous in-flight
    requests. The first Python run reported 6 for a limit of 5, from two
    separate measurement bugs rather than from `asyncio.Semaphore`:

    - counting a request as in flight across the response *write* leaves the
      handler thread counted after the client has already been answered and
      released its slot, so the next request overlaps it. Fixed by releasing the
      counter before responding.
    - the `/hang` route sleeps 12s but the client gives up at 10s, so its
      handler thread was still holding a slot open during the case that ran
      next. Fixed by not counting `/hang` at all.

    With both fixed the reading is exactly 5, twice in a row, and the Node
    server reproduces the same 5.

    **Test run**

    ```
    $ cd web && npx vitest run src/mastra/links/links.test.ts
     RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

     ✓ src/mastra/links/links.test.ts (57 tests) 10954ms
         ✓ matches Python for timeout  10003ms
         ✓ matches Python for semaphore-probe  914ms

     Test Files  1 passed (1)
          Tests  57 passed (57)
       Start at  22:53:48
       Duration  11.18s (transform 27ms, setup 129ms, import 19ms, tests 10.95s, environment 0ms)
    ```

    The 10s case is the real `REQUEST_TIMEOUT_MS` elapsing against a route that
    never answers. It asserts both that the link survives and that the wait
    ended at the deadline rather than at the server's 12s sleep, so a port with
    no timeout at all fails it.

    **Negative controls, each applied then reverted**

    ```
    $ # DEAD_STATUSES gains 500
    FAIL  matches Python for kept-500
    $ # redirect: "manual" instead of "follow"
    FAIL  matches Python for redirect-to-dead
    $ # url.toLowerCase().startsWith(...) instead of url.startsWith(...)
    FAIL  matches Python for uppercase-scheme
    $ # escapeRegExp returns its argument unchanged
    FAIL  matches Python for regex-special-url
    FAIL  matches re.sub for regex-special
    $ # CONCURRENCY_LIMIT raised from 5 to 8
    FAIL  matches Python for semaphore-probe
    FAIL  admits exactly CONCURRENCY_LIMIT requests at a time
    $ # the AbortSignal.timeout line deleted
    FAIL  matches Python for timeout
    $ # the per-URL text list deduplicated through a Set
    FAIL  matches Python for duplicate-url-same-text
    $ # urls checked in .sort() order instead of first-appearance order
    FAIL  matches Python for mixed
    FAIL  matches Python for two-dead-out-of-order
    ```

    The Set control is the informative one: it *passed* against the original
    case list, because `duplicate-url` used two different link texts for the
    same URL and a Set therefore collapsed nothing. Two cases were added to the
    oracle to close that hole (`duplicate-url-same-text`, which repeats both the
    URL and the text, and `two-dead-out-of-order`, whose two dead URLs are in
    reverse alphabetical order), and the control fails against them.

    **Gates**

    ```
    $ cd web && npx tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    > content-pipeline-dashboard@0.1.0 lint
    > eslint
    (no output)
    $ cd web && pnpm test
     Test Files  2 failed | 33 passed (35)
          Tests  9 failed | 465 passed | 3 skipped (477)
    $ cd web && pnpm build
    (succeeded; route table printed)
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test .venv/bin/pytest -q
    125 failed, 236 passed, 25 errors in 15.15s
    $ cd api && .venv/bin/ruff check scripts/export_link_validator_parity.py
    All checks passed!
    $ cd api && .venv/bin/ruff format --check scripts/export_link_validator_parity.py
    1 file already formatted
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 408 -> 465: the 57 new tests. `pytest` is at the Phase 0 baseline of
    125 failed / 236 passed / 25 errors. The repo-wide `ruff check .` baseline of
    32 errors is untouched; the one file this iteration added to `api/` passes
    both ruff gates.

## 3.4d


    **What was built**

    - `web/src/mastra/agents/edit.ts`: `editAgent`, the provider-facing half of
      `edit_node`. `EDIT_SYSTEM_MESSAGE` reproduces Python's twelve adjacent
      string literals with the same splits, `EDIT_MAX_TOKENS` is Python's
      `max_tokens=16000`, `EDIT_MODEL_ID` is the incumbent
      `anthropic/claude-opus-4-6`, and the credential is resolved per call
      through `requireApiKey` so no key enters `RequestContext`, the Redis event
      payloads or the Postgres workflow snapshots. Extended thinking comes from
      the shared `claudeStageOptions`, as for `outline`, `write` and (later)
      `ready`.
    - `EDIT_FORMAT_INSTRUCTION` is spelled out as its own constant because
      `edit_node` is the only stage that names a `format_instruction`. In Python
      it is a local variable, which reads like a branch point; the comment above
      it records that it is not one (the stage always emits Markdown, with the
      WordPress HTML conversion deferred to publish time).
    - Registered on the Mastra instance as `agents.edit`.
    - `web/src/mastra/agents/edit.test.ts`: 10 tests, 9 of which run without
      credentials.

    **Divergences recorded, not fixed**

    1. The `system`-as-block-list divergence recorded under item 3.2 applies
       unchanged: Python sends `system` as a bare string, the AI SDK sends the
       same text as a one-element `[{type: "text", text}]` list. The test asserts
       the AI SDK shape against the fixture's string, so the text is pinned even
       though the envelope differs.
    2. `edit_node` publishes three `publish_stage_log` progress lines plus up to
       three warning lines; the agent publishes none, for the same reason
       recorded under item 3.1c-ii. The warnings themselves are the step's
       business, item 3.4e.
    3. `EDIT_SYSTEM_MESSAGE` contains two literal U+2014 em-dashes, because the
       Python string does and this port must not change the bytes the provider
       sees. This is the one place the repo's own no-em-dash writing rule is
       deliberately not applied; the file says so at the constant.

    **Evidence**

    ```
    $ docker compose up -d db redis
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/edit.test.ts
     OK src/mastra/agents/edit.test.ts (10 tests | 1 skipped) 90ms

     Test Files  1 passed (1)
          Tests  9 passed | 1 skipped (10)
       Duration  925ms
    ```

    The skipped test is the live Anthropic smoke test, gated on
    `ANTHROPIC_API_KEY` so the default `pnpm test` needs no credentials. Run
    with the real key, which is what confirms `claude-opus-4-6` still resolves:

    ```
    $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/agents/edit.test.ts -t "live smoke"
     OK src/mastra/agents/edit.test.ts (10 tests | 9 skipped) 2074ms
         OK reaches Anthropic and reports back the configured model id  2056ms

     Test Files  1 passed (1)
          Tests  1 passed | 9 skipped (10)
       Duration  2.96s
    ```

    **Negative controls**, each applied to `agents/edit.ts` (or `index.ts`) and
    reverted; every one turned the suite red:

    | mutation | result |
    | --- | --- |
    | requirement 1's em-dash replaced with a hyphen | FAIL |
    | the `\n` after requirement 1 replaced with a space | FAIL |
    | `EDIT_FORMAT_INSTRUCTION` suffix replaced with `""` | FAIL |
    | `EDIT_MAX_TOKENS` 16000 -> 8000 | FAIL |
    | model id opus -> sonnet | FAIL |
    | trailing space dropped after `blog editor and SEO specialist.` | FAIL |
    | `edit: editAgent` removed from the Mastra instance | FAIL |

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    (exit 0, no output)
    $ cd web && pnpm lint
    (exit 0, no output)
    $ cd web && pnpm build
    (exit 0)
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 34 passed (36)
          Tests  9 failed | 474 passed | 4 skipped (487)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 465 -> 474 (the 9 new credential-free tests) and skips 3 -> 4 (the
    new live smoke test).

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.08s
    $ cd api && uv run ruff check .
    Found 32 errors.
    ```

    Both at the Phase 0 baseline; no file under `api/` was touched this
    iteration. Note for future iterations: `pytest` must be run with `.env`
    sourced. This worktree's Postgres is on `POSTGRES_HOST_PORT=5435`, while
    `api/tests/conftest.py` falls back to `localhost:5433` when
    `TEST_DATABASE_URL` is unset, which points at a different Postgres and turns
    the baseline into `4 failed, 205 passed, 177 errors` with
    `InvalidPasswordError` rather than a real regression.

## 3.4e


    **What was built**

    - `web/src/mastra/steps/edit.ts`: `editStep`, plus the two pure functions it
      is built from. `buildAnalyticsSection` is `_build_analytics_section` and
      `editOutputWarnings` is `_validate_edit_output`, the latter returning its
      warnings rather than publishing them so they are assertable without a
      logger spy. The step's own body is Python's ordering exactly: load state,
      render the rules prompt, append the analytics section behind
      `\n\n---\n\n`, call the agent, warn on the output, validate links, commit
      to `final_md`, return `_stage_meta`.
    - `web/src/mastra/analytics/python-float.ts`: `pythonFloat`, the production
      `str(float)` shim item 3.4b said this item would need. Three of
      `compute_analytics`'s numbers are interpolated into the prompt with an
      f-string, and Python's float repr always carries a decimal point where
      JavaScript's does not.
    - `web/src/mastra/steps/edit.test.ts`: 14 tests, all credential-free, all
      against the real Alembic-owned database.

    **Why this stage's prompt test proves more than the three before it**

    `research`, `outline` and `write` render prompts assembled entirely from
    columns and `rules/*.md`. Roughly a kilobyte of the `edit` prompt is
    *computed*: the analytics section is `compute_analytics` over the draft the
    `write` stage committed, so a byte-exact prompt match here is simultaneously
    an end-to-end check of the item 3.4a textstat port, the item 3.4b analytics
    port and Python's float formatting. Both fixtures are load-bearing and in
    different ways: `how-to-choose-a-crm-for-a-small-team` has three internal
    links (which `edit` alone is offered) and a keyword density of exactly zero,
    which is the `str(float)` case; `best-time-tracking-tools-for-agencies` has
    a Flesch score of 47.8, the only fixture that reaches the `SIMPLIFY` branch
    of the `ACTION REQUIRED` block.

    **Two Python primitives that do not survive a naive translation**

    1. `check.replace("_", " ")` replaces *every* underscore in Python and only
       the *first* in JavaScript, so `keyword_in_title` would render as
       `Keyword In_Title`. Written as `replaceAll`.
    2. `str.title()` is not `capitalize each word`: it uppercases the first
       cased character of each run of cased characters and lowercases the rest,
       which is what turns `keyword_in_first_100_words` into
       `Keyword In First 100 Words`. `pythonTitleAscii` spells that rule out; it
       is ASCII-only because every key `_seo_checklist` produces is ASCII
       snake_case, and the comment says so rather than implying full Unicode
       coverage.

    **Divergences recorded, not fixed**

    1. `edit_node` publishes its warnings (em-dashes, low Flesch, remaining SEO
       failures, stripped dead links) through `publish_stage_log(level=
       "warning")`. The step logs them through `mastra.getLogger()` and
       publishes no SSE, for the reason recorded under item 3.1c-ii: the event
       bus is item 5.5 and Phase 8 reads step progress from Mastra's own stream
       events.
    2. `pythonFloat` deliberately does not implement Python's exponent form.
       Python switches to scientific notation below `1e-4` and writes a
       two-digit exponent (`1e-05`) where JavaScript switches below `1e-7` and
       writes one (`1e-7`), but every value that reaches it has been through
       `pythonRound(x, 1)` or `pythonRound(x, 2)`, so the smallest non-zero
       magnitude reachable is `0.01`. Not guessed at rather than guessed at.
    3. `ACTION REQUIRED — Fix These Failures` carries a literal U+2014, as
       `EDIT_SYSTEM_MESSAGE` does, and for the same reason: it is the bytes the
       provider sees.

    **Evidence**

    ```
    $ docker compose up -d db redis
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/edit.test.ts
     OK src/mastra/steps/edit.test.ts (14 tests) 226ms
       OK sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team 51ms
       OK sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies 19ms
       OK offers the internal-link inventory that the earlier stages were denied 14ms
       OK renders a keyword density of exactly zero the way Python's str(float) does 6ms
       OK reaches the SIMPLIFY branch only on the fixture whose Flesch score is under 55 7ms
       OK appends nothing at all when the draft column is empty 14ms
       OK matches the section Python appended, character for character 12ms
       OK warns about em-dashes, readability and the SEO checks the edit left failing 16ms
       OK counts em-dashes in the output the way Python's str.count does 6ms
       OK strips a dead link over real sockets and keeps the live one 19ms
       OK commits the model's own output when link validation throws 14ms
       OK commits the final markdown to its column and reports Python's stage meta 13ms
       OK fails loudly on a post that does not exist rather than billing a call 8ms
       OK returns the empty string for a post with no draft 6ms

     Test Files  1 passed (1)
          Tests  14 passed (14)
    ```

    `validateLinks` reaches the public internet and both fixtures' outputs cite
    real domains, so the module is wrapped rather than replaced: the prompt tests
    hand it a pass-through, and one test clears the stub and drives the real
    implementation over real sockets against a local `node:http` server that
    answers `/gone` with a 404, asserting both that the dead link is stripped
    from the committed column and that the live one survives.

    **Negative controls**, each applied and reverted; every one turned the suite
    red:

    | mutation | result |
    | --- | --- |
    | `pythonFloat` drops the trailing `.0` | 1 failed / 13 passed |
    | `replaceAll("_", " ")` -> `replace("_", " ")` | 3 failed / 11 passed |
    | checklist labels not title-cased | 3 failed / 11 passed |
    | SIMPLIFY threshold 55 -> 45 | 2 failed / 12 passed |
    | analytics separator `\n\n---\n\n` -> `\n\n` | 3 failed / 11 passed |
    | ACTION REQUIRED lines reordered | 3 failed / 11 passed |
    | that heading's em-dash replaced with a hyphen | 3 failed / 11 passed |
    | link counts no longer filtered out of the checklist | 3 failed / 11 passed |
    | raw model output committed instead of the link-stripped content | 1 failed / 13 passed |
    | earlier stages' `stage_status` not merged in | 1 failed / 13 passed |
    | analytics computed over the outline instead of the draft | 3 failed / 11 passed |
    | word-count target hardcoded to 2000 | 3 failed / 11 passed |
    | `validateLinks` failure allowed to propagate | 1 failed / 13 passed |

    One further mutation, computing the analytics over `state.finalMd || draft`,
    stayed green and is recorded here rather than dropped: both fixtures were
    captured with `final_md` empty, so that expression is a no-op against them.
    It is a gap in the fixtures, not in the port.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 35 passed (37)
          Tests  9 failed | 488 passed | 4 skipped (501)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 474 -> 488, which is the 14 new tests. Skips stay at 4.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.16s
    $ cd api && uv run ruff check .
    Found 32 errors.
    ```

    Both at the Phase 0 baseline; no file under `api/` was touched this
    iteration.

## 3.5a


    **Why this is its own item**

    `_parse_manifest` is the only thing between Claude's answer and the
    `image_manifest` JSONB column, and the stage branches on the `error` key it
    synthesises: a parse failure short-circuits the whole stage to
    `stage_status.images = "failed"` before Gemini is ever called. So the port has
    to agree with Python on the *unparseable* inputs as much as the parseable
    ones, and the disagreements are all in primitives the rest of item 3.5 does
    not touch. It also has an oracle available now (both golden fixtures carry a
    real Claude manifest response) that the Gemini half of the stage does not,
    since every recorded Gemini call in the fixtures is a 429.

    **What was built**

    - `api/scripts/export_manifest_parity.py`: calls
      `src.pipeline.stages.images._parse_manifest` over 37 inputs and writes
      `web/src/mastra/images/data/manifest-parity.json`. Two inputs are the raw
      Claude manifest text out of `docs/mastra-port/golden/*/images.json`; the
      other 35 are synthetic and each one names the branch or primitive it
      exercises in a `why` field.
    - `web/src/mastra/images/manifest.ts`: `parseManifest`, reusing the item-3.4a
      `pythonStrip` and `PY_WHITESPACE`.
    - `web/src/mastra/images/manifest.test.ts`: 43 tests.

    **The three primitives that do not survive a naive translation**

    | Python | Naive JavaScript | Why it matters |
    | --- | --- | --- |
    | `str.strip()` | `String.trim()` | Python's class omits `﻿` and includes `\x1c`-`\x1f` and `\x85`; JavaScript's does the reverse |
    | `\s` in the fenced-block pattern | `\s` | same class difference, inside the pattern that decides whether a fence matches at all |
    | `.` under `re.DOTALL` | `.` | JavaScript's `.` also excludes `\r`, `U+2028` and `U+2029`, so the fence body cannot span lines |

    The oracle stores Python's result as a JSON string rather than as a value, and
    the test compares after both sides have been through a JSON parse. That is
    deliberate: `json.dumps` writes Python's `1.0` float as `1.0` and its exact
    20-digit int in full, neither of which a JavaScript number holds, so comparing
    spellings would fail on cases where the values the port writes to
    `image_manifest` are identical.

    **One divergence recorded, not repaired**

    `json.loads` accepts the `NaN`, `Infinity` and `-Infinity` literals and
    `JSON.parse` rejects them, so `{"images": [], "score": NaN}` parses in Python
    (`{'images': [], 'score': nan}`) and falls back to the synthesised error
    manifest here. Reproducing it means hand-rolling a JSON parser for output no
    image model produces. The two inputs are exported under `divergences` rather
    than `cases` and the test asserts the fallback explicitly, so the difference
    is pinned rather than inherited silently.

    **A dead branch in the Python stage, found while pinning the manifest shape**

    `images_node` tests `image_spec.get("placement") == "featured"` before it
    tests `type`, and in both golden manifests `placement` is an object
    (`{"location": "featured_image", "after_section": null}`), never the string
    `"featured"`. That first comparison is therefore always false and the
    `image_size = "2K"` / `aspect_ratio = "16:9"` override behind it is
    unreachable. The featured image in the fixtures was sent at `2K`/`16:9`
    because the manifest itself asked for them, which the recorded Gemini request
    confirms. Item 3.5e still has to port the branch, but this corrects the note
    in the iteration-4 log that read the override as live behaviour.

    **Evidence**

    ```
    $ cd api && uv run python scripts/export_manifest_parity.py
    wrote web/src/mastra/images/data/manifest-parity.json: 37 cases, 2 divergences

    $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/images/manifest.test.ts
     ✓ src/mastra/images/manifest.test.ts (43 tests)
     Test Files  1 passed (1)
          Tests  43 passed (43)
    ```

    **Negative controls.** Each mutation applied to `manifest.ts` alone, the whole
    file restored afterwards, and the final `diff` against the original empty.

    | Mutation | Result |
    | --- | --- |
    | `pythonStrip` -> `String.trim()` | 2 failed / 41 passed |
    | fence pattern's `PY_WHITESPACE` -> JavaScript `\s` | 1 failed / 42 passed |
    | `[\s\S]*?` -> `[^\n]*?` (DOTALL dropped) | 1 failed / 42 passed |
    | last fenced block taken instead of the first | 1 failed / 42 passed |
    | line filter tests the line without stripping it | 1 failed / 42 passed |
    | fallback object shared between calls instead of fresh | 3 failed / 40 passed |
    | outermost-brace fallback removed | 5 failed / 38 passed |
    | fenced-block branch removed | 3 failed / 40 passed |

    Two of those mutations passed against the first version of the corpus. Both
    gaps were real: no case had a fenced body spanning more than one line whose
    brace fallback gave a different answer, and no case had an indented fence
    marker carrying a brace. `pretty printed fenced json with braces in the
    trailing prose` and `indented closing fence followed by braces` were added to
    close them, and both mutations then failed. The two strip discriminators
    (`python-only whitespace around a json array`, `byte order mark before a json
    scalar`) were added for the same reason: every earlier whitespace case reached
    the same value down the brace-fallback path either way.

    **Gates**

    ```
    $ cd web && pnpm exec tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    ✓ Compiled successfully in 3.2s
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 36 passed (38)
          Tests  9 failed | 531 passed | 4 skipped (544)
    ```

    `pnpm test` holds the recorded failure baseline of 9 (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) with passes moving
    488 -> 531, which is the 43 new tests. Skips stay at 4.

    A first run of that gate reported 17 failed files / 11 failed / 97 skipped.
    That was `docker compose up -d db redis` not being up in this worktree, not a
    regression: every database-backed suite skips or errors on
    `ECONNREFUSED 127.0.0.1:5435`. The numbers above are from the re-run with the
    containers started.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.16s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 122 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check` counts one more
    formatted file than the last recorded run because
    `export_manifest_parity.py` is new and formatted; the would-reformat count is
    unchanged at 9. The pytest run wrote three `media/test-123/featured-*.webp`
    files (the defect already logged in `todo.md`); they were deleted before
    committing and `git status` is clean of them.

## 3.5b


    **The dependency decision: sharp**

    `sharp` 0.35.3 was added to `web/` as a runtime dependency. It is the only
    mature Node image library with a native WebP encoder, it ships prebuilt
    binaries for the platforms this app deploys to, and Next.js already treats it
    as a first-class optional dependency for its own image optimizer, so it is
    not a new class of dependency for this repo. The deciding fact came out of
    the installed package rather than the docs:

    ```
    $ cd web && node -e "console.log(require('sharp').versions.webp, require('sharp').versions.vips)"
    1.6.0 8.18.3
    $ cd api && uv run python -c "from PIL import features; print(features.version('webp'))"
    1.6.0
    ```

    sharp and Pillow drive the *same* libwebp 1.6.0. That turned out to matter
    more than expected (see the byte-identity finding below).

    Pure-JS alternatives (`jimp`, `@napi-rs/image`) were not evaluated further
    once byte-identity with Pillow's encoder was demonstrated with sharp; nothing
    else can match that without linking libwebp.

    **The oracle**

    `api/scripts/export_optimize_parity.py` builds 14 deterministic PNG inputs,
    runs Python's `optimize_image` over each, and commits both the input and
    Pillow's WebP output to
    `web/src/mastra/images/data/optimize-parity/`. The golden fixtures cannot
    serve here: every Gemini call recorded in them returned 429, so no real
    generated image was ever optimized, and there is no captured PNG anywhere in
    the repo to feed this function.

    ```
    $ cd api && uv run python scripts/export_optimize_parity.py
    smooth-2400x1350-w1200: RGB 2400x1350 (115011B png) -> 1200x675 (49386B webp)
    smooth-2400x1350-w1920: RGB 2400x1350 (115011B png) -> 1920x1080 (89594B webp)
    odd-1600x901-w1200: RGB 1600x901 (78939B png) -> 1200x675 (53246B webp)
    odd-1001x1000-w1000: RGB 1001x1000 (63543B png) -> 1000x999 (62002B webp)
    exact-1200x800-w1200: RGB 1200x800 (59806B png) -> 1200x800 (57820B webp)
    small-800x600-w1200: RGB 800x600 (40045B png) -> 800x600 (39616B webp)
    tiny-3x2-w1200: RGB 3x2 (85B png) -> 3x2 (76B webp)
    wide-3000x400-w1200: RGB 3000x400 (54829B png) -> 1200x160 (19802B webp)
    tall-1500x2400-w1200: RGB 1500x2400 (113777B png) -> 1200x1920 (95546B webp)
    detailed-1600x900-w1200: RGB 1600x900 (132493B png) -> 1200x675 (128306B webp)
    detailed-1200x675-w1200: RGB 1200x675 (99434B png) -> 1200x675 (142386B webp)
    alpha-1600x900-w1200: RGBA 1600x900 (151796B png) -> 1200x675 (136100B webp)
    grayscale-1600x900-w1200: L 1600x900 (115120B png) -> 1200x675 (89486B webp)
    palette-1600x900-w1200: P 1600x900 (81063B png) -> 1200x675 (136662B webp)

    14 cases -> web/src/mastra/images/data/optimize-parity
    ```

    Regeneration is byte-stable, which is what makes committing the outputs
    worth the 2.4 MB the directory costs:

    ```
    $ md5 -q web/src/mastra/images/data/optimize-parity/*.webp | md5   # before
    f0ddaff4a101962cdd93ade20bbace36
    $ cd api && uv run python scripts/export_optimize_parity.py && cd ..
    $ md5 -q web/src/mastra/images/data/optimize-parity/*.webp | md5   # after
    f0ddaff4a101962cdd93ade20bbace36
    ```

    The generated inputs are posterized to 3 bits per channel purely to keep that
    directory small: an un-posterized bicubic gradient costs about 1 MB per case
    as PNG and the corpus came out at 8.4 MB. Posterizing does not weaken the
    oracle, since banding adds edges for the resampler to disagree about rather
    than removing them.

    **What was built**

    - `web/src/mastra/images/optimize.ts`: `optimizeImage`, plus
      `OPTIMIZE_QUALITY`. The two Python decisions that are observable
      downstream are reproduced exactly: an image at or under `max_width` is
      never touched (and never upscaled), and the resized height is
      `Math.trunc(height * maxWidth / width)`.
    - `web/src/mastra/images/optimize.test.ts`: 51 tests.

    **The finding that changed the shape of the test: the encoder halves are equal**

    For all four cases where no resize happens, sharp's output is not merely
    close to Pillow's, it is **byte-identical**, at 57820, 39616, 76 and 142386
    bytes. Same libwebp, same quality 82, same method/effort 4, same alpha
    quality 100, and Pillow passes no ICC or EXIF through `save()` while sharp
    strips metadata by default. So the encoder is an equality, not an
    approximation, and only the resampler is approximate. The test asserts
    `Buffer.compare(...) === 0` for those four cases rather than a tolerance,
    which is a far sharper guard: negative control 3 (quality 82 -> 80) failed 8
    tests.

    **Three divergences found, all recorded rather than papered over**

    1. **Pillow ignores LANCZOS for palette images.** `Image.resize` contains
       `if self.mode in ("1", "P"): resample = Resampling.NEAREST`, so Python's
       palette output is nearest-neighbour while sharp's is lanczos3 (MAE 3.97,
       max channel difference 189). sharp produces the better image here. This
       is accepted, not reproduced, and the case carries its own tolerance and a
       comment naming the cause. It is close to unreachable in production
       anyway: Gemini returns RGB PNG.
    2. **Near-transparent pixels.** Pillow converts RGBA to the premultiplied
       RGBa mode before resizing, and libvips premultiplies too, so the
       algorithms agree, but unpremultiplying a pixel with alpha near zero
       amplifies any difference by up to 255x. Measured on the alpha case: MAE
       3.36 and max difference 255 over all pixels, but MAE 2.29 and max
       difference 63 once pixels below alpha 8 are excluded.
    3. **Everything else stays under MAE 1.6.** The remaining eight resized
       cases measured 0.61 to 1.56 MAE with a max channel difference of 43, so
       the default tolerance is pinned at MAE 1.7 / max 48.

    **Why lanczos3 rather than a kernel picked by name**

    Pillow's LANCZOS has no exact libvips equivalent, so the kernel was chosen by
    measuring all four sharp offers against Pillow's output. Summed over the ten
    resized cases: lanczos3 15.66, lanczos2 16.61, cubic 16.79, mitchell 18.66.
    lanczos2 actually beats lanczos3 on two individual smooth cases, so the test
    asserts the total rather than a per-case win, and it drives the shipped
    number through `optimizeImage` so switching the kernel fails the test instead
    of quietly costing image fidelity.

    **Verification**

    ```
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/images/optimize.test.ts
     ✓ src/mastra/images/optimize.test.ts (51 tests) 5987ms

     Test Files  1 passed (1)
          Tests  51 passed (51)
    ```

    **Negative controls** (each applied to `optimize.ts`, run, reverted)

    | mutation | result |
    | --- | --- |
    | `Math.trunc` -> `Math.round` on the scaled height | 3 failed / 48 passed |
    | quality 82 -> 80 | 8 failed / 43 passed |
    | kernel `lanczos3` -> `cubic` | 2 failed / 49 passed |
    | effort 4 -> 6 | 5 failed / 46 passed |
    | default `maxWidth` 1200 -> 1920 | 1 failed / 50 passed |
    | `fit: "fill"` -> `fit: "inside"` | 3 failed / 48 passed |

    One control stayed green and is recorded rather than dropped: changing
    `width > maxWidth` to `width >= maxWidth` kept all 51 tests passing. That is
    not a hole in the corpus, it is unobservable in both stacks, because a
    scale-1 resize is a no-op on both sides:

    ```
    sharp scale-1 resize is a no-op: true 57820 57820
    pillow scale-1 resize is a no-op: True 57820 57820
    ```

    The first control is only a control because the corpus was fixed for it. The
    case originally shipped as 1601x901, where `901 * 1200 / 1601` is 675.32 and
    `round` and `int` both give 675, so `Math.round` passed. It was regenerated
    at 1600x901, where the value is 675.75 and the two disagree.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 37 passed (39)
          Tests  9 failed | 582 passed | 4 skipped (595)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 531 -> 582, which is the 51 new tests. Skips stay at 4.

    Two earlier full-suite runs in this iteration reported 13 and 10 failures,
    the extras being `src/mastra/agents/{edit,research,write}.test.ts` wire-payload
    and credential-resolution tests. Each passes on its own and the third full run
    came back at the baseline, so they are flaky under parallel load rather than
    regressed. Logged in `todo.md` as `[investigate]`; not chased here.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.06s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 123 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check` counts one more
    formatted file than the last recorded run because
    `export_optimize_parity.py` is new and formatted; the would-reformat count is
    unchanged at 9.

## 3.5c


    **What was built**

    - `web/src/mastra/agents/images.ts`: `imagesAgent`, the provider half of step 1
      of `images_node`. `IMAGES_SYSTEM_MESSAGE` reproduces Python's four adjacent
      string literals, `IMAGES_MAX_TOKENS` is Python's 8000, the credential is
      resolved per call through `requireApiKey`, and extended thinking comes from
      the shared `claudeStageOptions`.
    - `imagesAgent` registered on the Mastra instance as `agents.images`.
    - `web/src/mastra/agents/images.test.ts`: 12 tests (11 credential-free).

    **Why this stage is not just another copy of `outline`**

    `images_node` is the only node that calls two providers, so the fixture's
    `provider_calls` list has an Anthropic entry followed by five or six Gemini
    entries. A test asserts that shape rather than assuming `provider_calls[0]`
    is the manifest call, because items 3.5d and 3.5e read the rest of the list.

    Its `max_tokens=8000` is below the extended-thinking floor, so 11024 is what
    reaches Anthropic. `outline` shares that branch, but the assertion here is
    pinned against `images.json`'s own recorded `max_tokens`, not against
    `OUTLINE_MAX_TOKENS`, so the two stages cannot drift into agreeing with each
    other while both disagreeing with Python.

    **Finding: the fenced-block branch of `parseManifest` has no fixture coverage**

    The system message ends `Output ONLY valid JSON, no code fences.` and both
    recorded answers obey it: each `text` block opens at `{`. Item 3.5a's
    fenced-block branch is therefore exercised only by that item's synthetic
    corpus, never by a real recorded response. A test asserts the fence-free
    property directly, so a future prompt change that makes Claude start fencing
    shows up as a failing test rather than as silently-live parsing code.

    Both recorded responses carry a `thinking` block ahead of the `text` block,
    so the test extracts the manifest text the way Python's `ClaudeClient.chat()`
    does (text blocks only) rather than reading `response.content` as a string.

    ### Item test

    ```
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/images.test.ts
     OK src/mastra/agents/images.test.ts (12 tests | 1 skipped) 95ms

     Test Files  1 passed (1)
          Tests  11 passed | 1 skipped (12)
    ```

    ### Live Anthropic call confirming the model id resolves

    The key is read out of the developer `.env` and never written to the repo; the
    test encrypts it into the `settings` table with a throwaway Fernet key for the
    duration of the call and deletes the row afterwards.

    ```
    $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/agents/images.test.ts -t "live smoke"
     OK src/mastra/agents/images.test.ts (12 tests | 11 skipped) 2514ms
         OK reaches Anthropic and reports back the configured model id  2495ms

     Test Files  1 passed (1)
          Tests  1 passed | 11 skipped (12)
    ```

    The assertion inside it is `response.modelId === "claude-opus-4-6"`, which is
    the model id Anthropic reported back for the request, plus a non-empty text
    and a non-zero `usage.outputTokens`.

    ### Negative controls

    Each mutation was applied to `agents/images.ts` (or `index.ts` for control 7),
    the item test run, then the file restored from a copy taken before the first
    mutation. `images.ts` is new and untracked this iteration, so
    `git checkout` would not have restored it.

    | # | Mutation | Result |
    | --- | --- | --- |
    | 1 | `IMAGES_MAX_TOKENS` 8000 -> 16000 | 3 failed |
    | 2 | `IMAGES_MODEL_ID` -> `anthropic/claude-sonnet-4-5` | 4 failed |
    | 3 | Space dropped at the first literal boundary | 4 failed |
    | 4 | Fourth literal (`Output ONLY valid JSON...`) dropped | 5 failed |
    | 5 | `defaultOptions: claudeStageOptions(...)` removed | 2 failed |
    | 6 | `instructions` removed from the Agent | 3 failed |
    | 7 | `images: imagesAgent` removed from the Mastra instance | 1 failed |
    | 8 | Sentence join turned into a newline | 4 failed |

    ```
    $ # after reverting all eight
          Tests  11 passed | 1 skipped (12)
    ```

    ### Gates

    ```
    $ cd web && NO_COLOR=1 pnpm tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 38 passed (40)
          Tests  9 failed | 593 passed | 5 skipped (607)
    $ cd web && NO_COLOR=1 pnpm build
    (built; route table printed, exit 0)
    ```

    Failures hold at the Phase 0 baseline of 9 (6 `image-preview`, 3 `PostDetail`).
    Totals moved 595 -> 607, which is the 12 new tests, and skips moved 4 -> 5,
    which is the new live smoke test. The suite was run twice with identical
    counts, because iteration 30 recorded the three agent test files failing
    intermittently under a full run.

    ```
    $ cd api && set -a && . ../.env && set +a && NO_COLOR=1 uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.19s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 123 files already formatted
    ```

    All three at the Phase 0 baseline. No file under `api/` was touched this
    iteration.

## 3.5d


    **The oracle had to be built, because the fixtures have none**

    Every Gemini call in both golden fixtures is a 429, so they pin the prompt text
    and nothing else: not the request that carries it, not the shape of a successful
    answer, and not the token accounting. `api/scripts/export_gemini_parity.py`
    supplies all three by driving the real `GeminiClient` with
    `google.genai._api_client.SyncHttpxClient.request` replaced, so both the
    outbound request and the parsing of a canned answer come from the production
    Python path rather than from a reading of it. It writes
    `web/src/mastra/images/data/gemini-parity.json`: 5 `wire` cases (the exact
    request `google-genai` builds) and 14 `responses` cases (a canned status and
    body, with the resulting `ImageGenResponse` or the raised exception, plus the
    number of HTTP attempts Python actually made).

    **Three things the corpus settled that reading the Python did not**

    1. *The retry wrapper is inert for this client.* `_retry` wraps the call, but
       `_is_retryable` tests for `httpx.HTTPStatusError` and
       `anthropic.APIStatusError`, and `google.genai.errors.ClientError` inherits
       from neither (`ClientError -> APIError -> Exception`, checked against the
       installed 1.65.0). So a 429 fails on the first attempt and no `Retry-After`
       is ever read. The corpus records `attempts: 1` for both the 429 and the 500
       case, which matches the fixtures having exactly one recorded 429 per image.
       Only the 180s timeout and transport failures retry, and the port reproduces
       that split with `GeminiTransportError` as the single retryable class.
    2. *A part carrying `inline_data` with no bytes ends the search.* Python breaks
       on the first part whose `inline_data` is truthy and only then checks for
       `None`, so such a part fails the call with "No image returned in Gemini
       response" rather than deferring to a later image part. Corpus case
       `inline-data-without-bytes` confirms it against a body whose second part is
       a valid image.
    3. *Byte equality on the request body is unreachable.* `json.dumps` writes
       `", "` and `": "` as separators and escapes every non-ASCII character;
       `JSON.stringify` does neither. The corpus records both the parsed body and
       the raw string, and the test asserts
       `sent === JSON.stringify(JSON.parse(pythonRaw))`, which normalises exactly
       those two differences and nothing else, so key order and every value still
       have to match.

    **What was built**

    - `api/scripts/export_gemini_parity.py`, the corpus generator.
    - `web/src/mastra/images/gemini.ts`: `generateImage`, `GeminiApiError`,
      `GeminiTransportError` and the constants (`GEMINI_IMAGE_MODEL_ID`,
      `GEMINI_IMAGE_SIZE_TOKENS`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`,
      `GEMINI_BASE_DELAY_MS`, `GEMINI_API_BASE`).
    - `web/src/mastra/images/gemini.test.ts`: 38 tests.

    **Why this posts to `generateContent` directly instead of adding `@google/genai`**

    The oracle is a recorded request. Matching a recorded request byte for byte is
    not a check the JS SDK can be made to perform on itself, and the surface in use
    is one POST with a five-field body, so a dependency whose own request shape
    would then need a second parity corpus buys nothing. The recorded URL, method,
    header names and body are asserted directly instead. No dependency was added.

    **Deliberate divergence**

    `GeminiApiError`'s message is `${code} ${status}. ${JSON.stringify(details)}`
    where Python's `APIError` uses `f'{code} {status}. {details}'` with `details`
    rendered by `repr(dict)`. That string reaches the `image_manifest` JSONB column
    through the stage's `str(e)` on a failed image, so the divergence is real but
    confined to failure text; reproducing Python's dict `repr` for arbitrary
    provider payloads would need a second float-and-string formatting port. The
    code and the `${code} ${status}. ` prefix are asserted to match.

    ### Corpus and tests

    ```
    $ cd api && uv run python scripts/export_gemini_parity.py
    wrote web/src/mastra/images/data/gemini-parity.json
      wire cases: 5
      response cases: 14

    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/images/gemini.test.ts
     OK src/mastra/images/gemini.test.ts (38 tests | 2 skipped) 16ms
     Test Files  1 passed (1)
          Tests  36 passed | 2 skipped (38)
    ```

    ### Negative controls, each applied and reverted

    Every mutation below was applied to `gemini.ts` alone, the file's suite run, and
    the file restored. The two marked `(*)` passed on the first attempt and
    the tests were tightened until they failed: both assertions were computing the
    expected value from the port's own exported constant, which made them
    self-referential. The retry tests now advance the fake clock by literal 999 /
    1 / 1999 / 1 ms and assert the attempt count at each step.

    ```
    NC1  drop `role: "user"` from the body                    5 failed | 31 passed
    NC2  unknown-size fallback 1100 -> 1200                   1 failed | 35 passed
    NC3  trust a reported candidatesTokenCount of 0           7 failed | 29 passed
    NC4  skip an inlineData part that carries no bytes        1 failed | 35 passed
    NC5  retry status errors as well as transport errors      9 failed | 27 passed
    NC6  GET instead of POST                                  5 failed | 31 passed
    NC7  credential in `authorization` not `x-goog-api-key`   5 failed | 31 passed
    NC8  swap the two generationConfig keys                   5 failed | 31 passed
    NC9  tokensIn read from candidatesTokenCount              2 failed | 34 passed
    NC10 v1beta -> v1 in the base URL                         6 failed | 30 passed
    NC11 MAX_RETRIES 3 -> 2                                (*) 2 failed | 34 passed
    NC12 drop the empty-parts guard                           2 failed | 34 passed
    NC13 backoff base 1s -> 5s                             (*) 3 failed | 33 passed
    NC14 linear backoff instead of exponential                1 failed | 35 passed
    ```

    ### Live API

    The key is read out of the developer `.env` and never written to the repo.

    ```
    $ cd web && GEMINI_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/images/gemini.test.ts -t "live smoke"
     OK src/mastra/images/gemini.test.ts (38 tests | 37 skipped) 151ms
     Test Files  1 passed (1)
          Tests  1 passed | 37 skipped (38)
    ```

    That test GETs `v1beta/models/gemini-3.1-flash-image-preview` and asserts the
    returned `name` and that `supportedGenerationMethods` contains
    `generateContent`. The live body, for the record:

    ```
    $ curl -s -H "x-goog-api-key: <redacted>" \
        https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview
    {
      "name": "models/gemini-3.1-flash-image-preview",
      "version": "3.0",
      "displayName": "Nano Banana 2",
      "description": "Gemini 3.1 Flash Image Preview.",
      "inputTokenLimit": 65536,
      "outputTokenLimit": 65536,
      "supportedGenerationMethods": ["generateContent", "countTokens", "batchGenerateContent"],
      "temperature": 1, "topP": 0.95, "topK": 64, "maxTemperature": 1, "thinking": true
    }
    HTTP 200
    ```

    **Gap: the end-to-end image call cannot run on this account.** The second live
    test does the real `generateImage` round trip and is gated on a second env var,
    `GEMINI_IMAGE_QUOTA`, because the developer key's project has no image quota at
    all. Run without that gate it fails, and this is the real failure, which is also
    why every Gemini call in the golden fixtures is a 429:

    ```
    $ cd web && GEMINI_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/images/gemini.test.ts -t "live smoke"
     FAIL  src/mastra/images/gemini.test.ts > live smoke > reaches Gemini and returns
           bytes for the configured model id
    GeminiApiError: 429 RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"You exceeded
    your current quota ... * Quota exceeded for metric:
    generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0,
    model: gemini-3.1-flash-image ...","status":"RESOURCE_EXHAUSTED", ...}}
     Test Files  1 failed (1)
          Tests  1 failed | 36 skipped (37)
    ```

    `limit: 0` is a free-tier entitlement, not a rate limit that clears, so no wait
    or retry reaches a successful image on this key. What the 429 does establish is
    that the request is well formed enough to be routed and quota-checked against
    this exact model: an unknown model id returns 404 NOT_FOUND, not a quota
    violation naming `gemini-3.1-flash-image`. The bytes-out path is therefore
    covered by the corpus and by the `optimize.ts` parity work of item 3.5b, and is
    unproven against a live image only. Item 6.1 revisits the model choice and will
    need a billed project to close this.

    ### Gates

    ```
    $ cd web && NO_COLOR=1 pnpm tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 39 passed (41)
          Tests  9 failed | 629 passed | 7 skipped (645)
    $ cd web && NO_COLOR=1 pnpm build
    (built; route table printed, exit 0)
    ```

    Failures hold at the Phase 0 baseline of 9 (6 `image-preview`, 3 `PostDetail`).
    Totals moved 607 -> 645, which is the 38 new tests, and skips moved 5 -> 7,
    which is the two new live tests. The first full run of this iteration showed 10
    failures, adding `src/mastra/api-keys.test.ts`; that is the shared-`settings`-row
    flake already logged in `todo.md`, now seen to hit `api-keys.test.ts` as well as
    the three agent suites, and the note has been updated. The rerun above is clean
    at baseline.

    ```
    $ cd api && set -a && . ../.env && set +a && NO_COLOR=1 uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.19s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 124 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check`'s "already formatted"
    count moved 123 -> 124, which is the new script; the reformat count is
    unchanged.

## 3.5e


    **Why this splits off from the step**

    `_generate_one` is a closure inside `images_node`, and everything
    interesting about the `images` stage that is not the manifest, the WebP
    encoder or the Gemini wire format lives inside it: which aspect ratio and
    image size reach Gemini, which optimize width applies, what the written
    filename is, what URL is recorded, and which keys the returned image spec
    carries in the success and both failure shapes. Those are the fields that
    end up in the `image_manifest` JSONB column, so they need their own oracle
    and their own negative controls. The remaining half (prompt assembly, the
    `.foreach()` fan-out, the manifest-parse failure branch, `_stage_meta` /
    `_stage_meta_gemini` and `saveStageOutput`) is item 3.5f.

    **What was ported**

    `web/src/mastra/images/generate-one.ts` is `_generate_one`, the closure
    inside `images_node`: the aspect-ratio and image-size decision including the
    featured overrides, the 1920-vs-1200 optimize width, `Path(filename).stem`,
    the featured filename rewrite, the disk write and the
    `/media/<post_id>/<filename>` URL, plus the success and both failure shapes
    of the manifest entry. `ensureMediaDir` is the stage's one
    `media_dir.mkdir(parents=True, exist_ok=True)`.

    **The oracle**

    `api/scripts/export_image_generation_parity.py` runs the real Python stage
    with `ClaudeClient` and `GeminiClient` replaced, a frozen
    `datetime.now(UTC)` and a frozen `random.randint`, and a temporary media
    directory. Everything between the two providers ran for real over there, so
    `web/src/mastra/images/data/image-generation-parity.json` records what
    Python actually stored, wrote and billed: 16 manifest entries covering every
    branch, the 14 Gemini calls they produced with the exact arguments sent, the
    9 files that survived on disk with their dimensions and (where no resize
    happened) Pillow's sha256, the `_stage_meta_gemini` totals, and a 15-case
    direct oracle for `Path(...).stem`.

    Two inputs are used: a 64x48 PNG, narrow enough that `optimize_image` never
    resizes, so its WebP bytes are byte-identical across Pillow and sharp (item
    3.5b) and the committed sha256 is an equality rather than a tolerance; and a
    2400x1600 PNG, which is the only thing that can tell the 1920 branch from
    the 1200 one. The two resized files are compared on dimensions only, because
    Pillow's Lanczos convolution and libvips' reduce do not agree byte for byte.

    **What the corpus exposed**

    1. The featured aspect-ratio and image-size overrides key off
       `placement == "featured"`, a *string*, while `is_featured`, which picks
       the optimize width and the filename rewrite, also accepts
       `type == "featured"`. Both golden fixtures show Claude writing
       `placement` as an object (`{location, after_section}`), so on real
       manifests the overrides never fire and the width and filename rules
       always do. Three of the corpus cases exist only to cover the string form.
    2. The overrides rewrite the local variables, never the entry, so a stored
       manifest entry can read `image_size: "1K"` for a call made at `2K`, or
       carry no `aspect_ratio` at all for a call made at `16:9`. Logged in
       `todo.md`.
    3. A Gemini call that succeeded is billed even when `optimize_image` then
       rejects the bytes: Python accumulates `gemini_tokens_in/out` immediately
       after the call and the optimizer runs inside the same `try`. The port
       reports usage separately from success so the sum can be reproduced;
       reporting only successes would under-report spend.
    4. Every featured entry gets the same filename, so four featured entries in
       the corpus produced one file: the last write wins and all four entries
       record the same URL. Latent on real manifests (one featured image each),
       1-in-90 otherwise. Logged in `todo.md`.
    5. An empty `filename` writes the dotfile `.webp`. Logged in `todo.md`.
    6. `Path("..png").stem` is `"."` and `Path("...").stem` is `"..."`, because
       the rule is `0 < i < len(name) - 1` rather than "strip after the last
       dot", and `Path(".").name` is `""` while `Path("..").name` is `".."`.
       `pathStem` reimplements the rule rather than approximating it, which is
       also what flattens `sub/dir/nested.png` to `nested.webp` and keeps a
       manifest entry from writing outside the media directory.

    **Known divergence, recorded not fixed.** Python reads `aspect_ratio`,
    `image_size` and `filename` with `dict.get(key, default)`, which returns an
    explicit JSON `null` rather than the default. The port treats a non-string
    as absent. No rule asks the model for a null there and no fixture has one,
    so the `None` behaviour would have to be invented rather than observed.
    Logged in `todo.md` for a decision before Phase 7.

    ```
    $ cd api && uv run python scripts/export_image_generation_parity.py
    wrote web/src/mastra/images/data/image-generation-parity.json
      images: 16
      gemini calls: 14
      files written: 9
    ```

    ```
    $ pnpm -C web exec vitest run src/mastra/images/generate-one.test.ts
     ✓ src/mastra/images/generate-one.test.ts (30 tests) 2228ms

     Test Files  1 passed (1)
          Tests  30 passed (30)
       Duration  2.51s
    ```

    **Negative controls.** Eleven mutations applied to
    `generate-one.ts` one at a time and reverted; every one failed the suite,
    with the failure count in brackets:

    | mutation | failures |
    | --- | --- |
    | `DEFAULT_ASPECT_RATIO` `"4:3"` -> `"3:4"` | 1 |
    | featured override forces 16:9 unconditionally | 1 |
    | override keyed off `isFeatured` instead of the string `placement` | 1 |
    | optimize width always `CONTENT_MAX_WIDTH` | 1 |
    | `pathStem`'s `dot > 0` relaxed to `dot >= 0` | 1 |
    | `featuredFilename` renders `DDMMYY` instead of `MMDDYY` | 3 |
    | usage recorded only after the optimizer succeeds | 2 |
    | empty prompt string treated as usable | 5 |
    | default filename `image-<index>.png` -> `image.png` | 2 |
    | featured filename rewrite applied to every image | 3 |
    | (control) unmodified file | 0 |

    The fourth is the one that justified adding the 2400x1600 input: with only
    the 64x48 PNG it passed, because nothing was ever wide enough to resize.

    **Gates.**

    ```
    $ pnpm -C web tsc --noEmit
    (exit 0, no output)

    $ pnpm -C web lint
    (exit 0, no output)

    $ pnpm -C web test
     ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed) 42ms
     ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed) 3475ms

     Test Files  2 failed | 40 passed (42)
          Tests  9 failed | 659 passed | 7 skipped (675)

    $ pnpm -C web build
    ✓ Compiled successfully
    ```

    9 failures is the standing baseline (6 `image-preview` from Phase 0 plus the
    3 `PostDetail` timeouts). Both were re-confirmed on a clean tree this
    iteration: with this iteration's work stashed,
    `vitest run src/app/posts/PostDetail.test.tsx` still reported
    `3 failed | 12 passed (15)`. Passing tests move 629 -> 659, which is the 30
    added here.

    ```
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.09s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 125 files already formatted
    ```

    All three at the Phase 0 baseline; the `already formatted` count moves
    124 -> 125 for the new script. `TEST_DATABASE_URL` has to be passed
    explicitly because `api/tests/conftest.py` defaults to port 5433 while this
    worktree's compose project publishes postgres on 5435; without it every
    database test errors with `InvalidPasswordError` against whatever is
    listening on 5433.

## 3.5f-i


      **Why `.foreach()` forces a three-step stage**

      `Workflow.foreach(step, opts)` is declared on `Workflow`, typed
      `TPrevIsArray extends true ? Step<...> : 'Previous step must return an array
      type'`, and takes `ForeachOptions { concurrency: number | ForeachConcurrencyResolver }`
      (`node_modules/@mastra/core/dist/workflows/workflow.d.ts:337`,
      `types.d.ts:591`). `EventedWorkflow extends Workflow`, so the evented engine
      this port runs on has it. There is no step-level equivalent, so honouring the
      objective's "use `.foreach()` rather than a hand-rolled loop" means the stage is

      ```
      createWorkflow({ id: "images" })
        .then(imagesManifestStep)   // this item
        .map(...)                   // manifest entries -> per-image jobs
        .foreach(generateImageStep, { concurrency: 3 })   // item 3.5f-ii
        .then(imagesAssembleStep)                          // item 3.5f-ii
        .commit()
      ```

      registered on the Mastra instance as a nested workflow. `.map()` is what lets
      the manifest step keep a rich object output while still handing `.foreach()` an
      array, and `getStepResult(step)` (`workflows/step.d.ts:34`) is what lets the
      assembling step read the manifest back.

      **What Python's single function guarantees that the split has to preserve**

      1. *One write per stage.* `api/src/worker.py:223` saves
         `STAGE_OUTPUT_KEY["images"]` exactly once, from whichever dict `images_node`
         returned, including on the parse-failure path. So this step commits nothing
         at all; the assembling step is the only writer. A test asserts the post row
         is byte-identical before and after.
      2. *One timer over the whole stage.* `StageTimer` wraps the manifest call and
         every image (`stages/images.py:48`), so `duration_s` cannot be measured
         here. The step returns `stageStartedAtMs` instead and 3.5f-ii subtracts it.
      3. *The parse failure is a branch, not an exception.* A manifest Claude wrote as
         prose is stored verbatim with `stage_status.images = "failed"` and no Gemini
         call is billed. Signalled with `parseFailed`, because throwing would lose the
         synthesised document Python stores.

      **Found while reading the Python, and reproduced**

      - `timer.duration` is `0` until `StageTimer.__exit__` runs
        (`api/src/pipeline/helpers.py:376-388`), and the parse-failure branch returns
        from *inside* the `with` block. So Python reports `duration_s: 0.0` for a
        failed manifest, not the elapsed time. 3.5f-ii has to reproduce that.
      - Python tests `manifest.get("error")` for *truthiness*, not for key presence,
        so a manifest in which the model itself wrote `"error": "I cannot ..."`
        short-circuits the stage exactly like a parse failure, while `"error": ""`
        does not. `pythonTruthy` is here because the two engines disagree on empty
        containers: `[]` and `{}` are falsy in Python and truthy in JavaScript, and
        this is the branch that decides whether Gemini is billed at all.
      - `response.content[:500]` slices by code point; `String.prototype.slice`
        slices by UTF-16 unit. `rawSnippet` uses `[...content]`, so 600 emoji give
        500 characters rather than 250.
      - `manifest.get("images", [])` returns the default only for an *absent* key, so
        the port tests `"images" in manifest` rather than using `??`. An explicit
        `null` raises out of `len(None)` in Python and out of the output schema here.

      **Recorded divergences**

      - A manifest that parses to an array or a scalar reaches `manifest.get("error")`
        in Python and raises `AttributeError`. `JSON.parse` admits both too, so this
        port throws a `TypeError` with its own message. Same outcome (the stage
        fails), different text.
      - A present but non-array `images` value fails the output schema here, where
        Python would `enumerate` whatever it is (a string yields its characters).
        Neither golden fixture has one and no rule in `rules/blog-images.md` asks for
        one, so the behaviour is not invented.
      - The parse-failure log is a `mastra.getLogger().warn` rather than
        `publish_stage_log(..., level="warning", data={error, raw_snippet})`. The
        event bus is item 5.5; the payload is carried on the log's metadata so the
        port to SSE is a change of sink, not of content.

      **The oracle**

      Prompt parity is byte equality against `rendered_prompts[0]` in both golden
      fixtures (the other five recorded prompts are Gemini's and belong to 3.5f-ii).
      The manifest entries have a second, independent oracle: Python stores
      `{**image_spec, generated, index, ...}` per entry, so stripping those
      bookkeeping keys off `stage_output.image_manifest.images` recovers the exact
      specs Python parsed, and the step's `images` output is compared against *that*
      rather than against a re-run of this port's own parser.

      ```
      $ NO_COLOR=1 pnpm -C web test --run src/mastra/steps/images-manifest.test.ts
       ✓ src/mastra/steps/images-manifest.test.ts (18 tests) 157ms

       Test Files  1 passed (1)
            Tests  18 passed (18)
         Duration  718ms
      ```

      **Negative controls.** Each mutation was applied to
      `web/src/mastra/steps/images-manifest.ts`, the suite re-run, and the file
      restored (`diff` against the pre-mutation copy confirms `restored identical`).

      | mutation | result |
      | --- | --- |
      | `pythonTruthy` uses JS truthiness for containers | Tests 1 failed \| 17 passed (18) |
      | `rawSnippet` slices UTF-16 units | Tests 1 failed \| 17 passed (18) |
      | `"images" in manifest` becomes `manifest.images ?? []` | Tests 1 failed \| 17 passed (18) |
      | parse failure still forwards the parsed images | Tests 1 failed \| 17 passed (18) |
      | non-mapping manifest is not rejected | Tests 1 failed \| 17 passed (18) |
      | rules file swapped to `blog-ready.md` | Tests 2 failed \| 16 passed (18) |
      | stage start not recorded (`stageStartedAtMs = 0`) | Tests 1 failed \| 17 passed (18) |
      | model reported as requested rather than as returned | Tests 1 failed \| 17 passed (18) |
      | parse-failure warning dropped | Tests 1 failed \| 17 passed (18) |
      | error truthiness replaced by key presence | Tests 1 failed \| 17 passed (18) |

      **Gates.**

      ```
      $ cd web && npx tsc --noEmit
      tsc exit=0
      $ NO_COLOR=1 pnpm -C web lint
      (no output, exit 0)
      $ NO_COLOR=1 pnpm -C web test --run
       Test Files  2 failed | 41 passed (43)
            Tests  9 failed | 677 passed | 7 skipped (693)
      $ NO_COLOR=1 pnpm -C web build
      exit 0
      ```

      Failures stay at the 9-test baseline (`image-preview.test.tsx` plus the shared
      `settings`-row flake logged in `todo.md`). Totals moved 675 -> 693, which is the
      18 new tests; skips unchanged at 7.

      ```
      $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
      125 failed, 236 passed, 25 errors in 15.12s
      $ cd api && uv run ruff check .
      Found 32 errors.
      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 125 files already formatted
      ```

      All three at the Phase 0 baseline; no Python file was touched this iteration.

## 3.5f-ii


      **What was built**

      - `web/src/mastra/steps/images-generate.ts`: `imagesGenerateStep`, the Mastra
        shell around item 3.5e's `generateOneImage`. It resolves the Gemini
        credential itself, per image, rather than taking it on the job, because a
        job is serialised into the workflow snapshot Postgres persists *and* into
        the Redis event that hands the step to the worker.
      - `web/src/mastra/steps/images-assemble.ts`: `imagesAssembleStep`, the stage's
        only writer, plus `foldManifest` as a separate pure function so the folded
        document's key order is assertable.
      - `web/src/mastra/workflows/images.ts`: `imagesWorkflow`, registered on the
        Mastra instance as `images`.
      - `web/src/mastra/images/generate-one.ts` gains `mediaRoot()`, the port of
        `settings.media_dir` with the same `MEDIA_DIR` override `rulesDir()` has.

      The committed graph is exactly the shape item 3.5f predicted, read back off
      `imagesWorkflow.serializedStepGraph`:

      ```
      [ { "type": "step",    "step": { "id": "images-manifest" } },
        { "type": "mapping", "id": "mapping_images_0" },
        { "type": "foreach", "step": { "step": { "id": "images-generate" } },
                             "opts": { "concurrency": 3 } },
        { "type": "step",    "step": { "id": "images-assemble" } } ]
      ```

      **The oracles**

      1. Both golden fixtures. Every recorded Gemini call was a 429, so
         `stage_output.image_manifest` is a whole failed stage and
         `_stage_meta_gemini` records one that billed nothing while still naming a
         model. Feeding the stored entries back through the fold reproduces the
         stored document, both totals, `stage_status` and both meta records.
      2. `images/data/image-generation-parity.json` (item 3.5e), where 12 of 16
         entries succeeded. Its `stage_meta_gemini` is `tokens_in: 225`,
         `tokens_out: 1395` over 14 calls, and re-deriving those sums from the
         exporter's own token schedule only works if the `BADBYTES` entry is
         billed: it is stored as failed and paid for all the same.
      3. A real run of the workflow through the evented engine against the live
         Postgres and Redis, with only the two provider calls stubbed. sharp
         encodes, the files land on disk, and the manifest is read back out of the
         `posts` row.

      **Recorded divergences**

      - Postgres `jsonb` sorts object keys by length and then bytes, so the key
        order Python's dict carried does not survive the write and cannot be
        asserted on the row. "JSONB shape byte for byte" therefore means the key
        and value set, not the order. The order is still what every in-process
        reader sees between the fold and the write, so it is pinned on
        `foldManifest`'s return value instead.
      - Python acquires the semaphore *inside* `_generate_one`, after the
        no-prompt check, so an entry with no prompt never takes a slot; here the
        whole step occupies one. Invisible in the stored manifest.
      - Python assigns `gemini_model` as each call returns, so on a mixed-model
        response the last *completed* call wins; this port takes the last call in
        manifest order. Both golden fixtures and the 3.5e corpus report one model
        for every call, so the two cannot disagree on any recorded data.
      - `.map()`'s parse-failure short-circuit is not redundant even though the
        manifest step already returns `images: []` on that branch: without it the
        stage would still check the Gemini key and create the media directory,
        which Python does not because it returns before both. The test asserts the
        directory's absence, which is the only observable difference.

      **Item tests.**

      ```
      $ NO_COLOR=1 npx vitest run src/mastra/steps/images-assemble.test.ts src/mastra/workflows/images.test.ts
       ✓ src/mastra/steps/images-assemble.test.ts (19 tests) 100ms
       ✓ src/mastra/workflows/images.test.ts (8 tests) 3402ms
           ✓ fans nothing out and bills nothing when the manifest never parses  1116ms

       Test Files  2 passed (2)
            Tests  27 passed (27)
         Duration  4.24s
      exit=0
      ```

      **Negative controls.** Each mutation was applied to the file named, both
      suites re-run, and the file restored from a pre-mutation copy (`diff`
      reports `restored identical` for all twelve).

      | mutation | result |
      | --- | --- |
      | `foldManifest` appends `images` after the totals | Tests 1 failed \| 26 passed (27) |
      | parse failure reports the measured duration | Tests 2 failed \| 25 passed (27) |
      | parse failure marks the stage complete | Tests 2 failed \| 25 passed (27) |
      | parse failure still reports a Gemini record | Tests 2 failed \| 25 passed (27) |
      | only generated entries are billed | Tests 1 failed \| 26 passed (27) |
      | Gemini model falls back to `""` not the requested id | Tests 2 failed \| 25 passed (27) |
      | duration measured in the assembling step, not from the stage start | Tests 5 failed \| 22 passed (27) |
      | `stage_status` not advanced on the success path | Tests 4 failed \| 23 passed (27) |
      | fan-out concurrency raised from 3 to 5 | Tests 1 failed \| 26 passed (27) |
      | jobs all carry `index: 0` | Tests 1 failed \| 26 passed (27) |
      | media directory never created | Tests 5 failed \| 22 passed (27) |
      | parse failure still runs the mapping body | Tests 1 failed \| 26 passed (27) |

      The last one passed at first: the manifest step already returns `images: []`
      on that branch, so mapping over nothing produced the same jobs. It only
      became a control once the test asserted that no media directory is created
      for the unparseable post.

      **`no-next-imports.test.ts`'s allowlist was updated, deliberately.**
      Registering `imagesWorkflow` makes the stage steps reachable from the entry
      point for the first time, so its transitive package set legitimately grows by
      `node:fs` (reading `rules/*.md`), `node:fs/promises` and `node:path` (writing
      images), `sharp` (encoding them) and `node:zlib` (the textstat dictionaries
      the `edit` analytics gunzip). The `next/*` assertion the file exists for is
      unchanged and still passes.

      **Gates.**

      ```
      $ cd web && npx tsc --noEmit
      tsc exit=0
      $ NO_COLOR=1 pnpm lint
      (no output, exit 0)
      $ NO_COLOR=1 pnpm test --run
       Test Files  2 failed | 43 passed (45)
            Tests  9 failed | 704 passed | 7 skipped (720)
      $ NO_COLOR=1 pnpm build
      build exit=0
      ```

      Failures are back to the 9-test baseline exactly (6 in
      `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`); the first full run of
      this iteration also hit the shared-`settings`-row flake in
      `write.test.ts` logged in `todo.md`, which the second run did not.
      Totals moved 693 -> 720, which is the 27 new tests; skips unchanged at 7.
      `next build` emits one BetterAuth base-URL warning; it was confirmed
      pre-existing by building `git show HEAD:web/src/mastra/index.ts` in place
      and seeing the same line, then restoring the file.

      ```
      $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
      125 failed, 236 passed, 25 errors in 15.11s
      $ cd api && uv run ruff check .
      Found 32 errors.
      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 125 files already formatted
      ```

      All three at the Phase 0 baseline; no Python file was touched this iteration.

## 3.6


  **Ported as:**
  - `web/src/mastra/agents/ready.ts`: `readyAgent`, registered on the Mastra
    instance under `ready`. `READY_SYSTEM_MESSAGE` (byte-identical to both
    fixtures), `READY_MAX_TOKENS = 16_000`, `READY_MODEL_ID =
    "anthropic/claude-opus-4-6"`, and the shared `claudeStageOptions` thinking
    configuration. The incumbent model is carried over unchanged; choosing a
    stronger one is item 6.1.
  - `web/src/mastra/steps/ready.ts`: `readyStep`, plus `buildReadyPrompt` and
    `generatedImages` exported as pure functions so the prompt half is
    assertable without a provider.
  - `web/src/mastra/prompts.ts`: `pythonJsonDumps` exported. It was written for
    `buildStagePrompt`'s previous-output section, but `ready` is the stage that
    actually serializes JSON and it does not use that path, so it needs the same
    `ensure_ascii` escaping around a *filtered* manifest.

  **The golden fixture is not the production oracle for this stage.** This is
  the finding of the iteration and it changed how the item was verified.
  `capture_golden.py` builds one in-memory `Post`, threads a single state dict
  from stage to stage (`state.update(saved)`), and never touches Postgres.
  `_run_pipeline` does the opposite: it reloads the post from the database
  before every stage (`api/src/worker.py:144`, "Load fresh post from DB each
  iteration"). The ready prompt embeds the image manifest as pretty-printed
  JSON, and `jsonb` does not store a document, it stores a normalised value:
  object keys come back sorted by length, then bytewise. So the prompt in
  `docs/mastra-port/golden/<slug>/ready.json` and the prompt the Python worker
  sends for the same post differ, in the order of the manifest's keys, for both
  fixtures.

  The port reads its state from the table (that is what makes a crash
  resumable), so its oracle has to be the production path.
  `api/scripts/export_ready_prompt_parity.py` produces it: for each fixture it
  writes `final_md_content` and `image_manifest` into the real `posts` table,
  reads the row back, builds the state the way the worker does, and renders the
  real `_build_ready_prompt` over it. No provider is called and no API key is
  read.

  ```
  $ cd api && DATABASE_URL=postgresql://pipeline:pipeline@localhost:5435/content_pipeline \
      uv run python scripts/export_ready_prompt_parity.py
  how-to-choose-a-crm-for-a-small-team: prompt 20429 chars, differs from fixture: True
  best-time-tracking-tools-for-agencies: prompt 24954 chars, differs from fixture: True
  wrote .../web/src/mastra/steps/data/ready-prompt-parity.json
  ```

  Both oracles are now gates, and a third test pins the relationship between
  them: the step's database-sourced prompt is byte-equal to Python's production
  prompt; `buildReadyPrompt` fed the fixture's in-memory manifest is byte-equal
  to the fixture's captured prompt; and the two differ *only* in the manifest's
  key order, with everything outside that section identical and the parsed
  documents deep-equal.

  **Three more divergences recorded, none of them invented behaviour:**
  1. Both captures ran against an account with zero image quota, so every
     manifest entry in both fixtures has `generated: false` and the
     generated-images filter's only observable effect there is an empty list.
     Item 3.5e's parity corpus came out of the real Python images stage and
     carries 12 generated and 4 failed entries, so it stands in as the filter's
     oracle.
  2. `if manifest:` is falsy for `{}` in Python and truthy in JavaScript, and
     `manifest.get("images", [])` distinguishes an absent key from an explicit
     `null`. Both are reproduced explicitly rather than with `??`.
  3. A manifest whose `images` is not a list, or whose entries are not mappings,
     raises out of `_build_ready_prompt` before any call is billed. The port
     throws rather than guessing, and both branches are asserted.

  **Tests** (31 credential-free, 1 live):

  ```
  $ cd web && NO_COLOR=1 npx vitest run \
      src/mastra/steps/ready.test.ts src/mastra/agents/ready.test.ts
   RUN  v4.0.18 .../web
   OK src/mastra/steps/ready.test.ts (23 tests) 145ms
   OK src/mastra/agents/ready.test.ts (9 tests | 1 skipped) 81ms

   Test Files  2 passed (2)
        Tests  31 passed | 1 skipped (32)
     Duration  1.01s
  ```

  The skipped test is the live Anthropic smoke test, gated on
  `ANTHROPIC_API_KEY` so the default `pnpm test` needs no credentials. Run with
  the real key, which is what confirms `claude-opus-4-6` still resolves for this
  stage:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 npx vitest run \
      src/mastra/agents/ready.test.ts -t "live smoke"
   OK src/mastra/agents/ready.test.ts (9 tests | 8 skipped) 2015ms
       OK reaches Anthropic and reports back the configured model id  1997ms

   Test Files  1 passed (1)
        Tests  1 passed | 8 skipped (9)
     Duration  3.06s
  ```

  **Negative controls**, each applied to `steps/ready.ts`, `agents/ready.ts` or
  `index.ts` and reverted; every one turned the suite red:

  | mutation | result |
  | --- | --- |
  | `OUTPUT_FORMAT` line hardcoded to `markdown` | 2 failed |
  | `{...manifest, images}` -> `{images, ...manifest}` (key moves) | 7 failed |
  | empty `final_md` section no longer suppressed | 1 failed |
  | `Object.keys(manifest).length > 0` -> `if (manifest)` (JS truthiness) | 1 failed |
  | `pythonTruthy(generated)` -> `generated === true` | 1 failed |
  | `"images" in manifest ? ... : []` -> `manifest.images ?? []` | 1 failed |
  | `pythonJsonDumps` -> `JSON.stringify(..., 2)` (no `ensure_ascii`) | 1 failed |
  | section separator `\n\n---\n\n` -> `\n\n***\n\n` | 13 failed |
  | `stage_status` replaced instead of merged | 1 failed |
  | reported model hardcoded instead of read off the response | 1 failed |
  | system message: `publishing notes` -> `publication notes` | 3 failed |
  | system message literals joined with a newline | 3 failed |
  | `READY_MAX_TOKENS` 16000 -> 8000 | 2 failed |
  | agent unregistered from the Mastra instance | 1 failed |
  | `saveStageOutput(postId, "ready", ...)` -> `"edit"` | 1 failed |

  The "reported model hardcoded" control only became a control once a test
  replayed a response carrying a server-side alias: both fixtures recorded the
  same id the agent asks for, so fixture equality alone cannot tell a
  passthrough from a constant.

  **Gates.**

  ```
  $ cd web && npx tsc --noEmit
  tsc exit=0
  $ NO_COLOR=1 pnpm lint
  (no output, exit 0)
  $ NO_COLOR=1 pnpm test --run
   Test Files  2 failed | 45 passed (47)
        Tests  9 failed | 735 passed | 8 skipped (752)
  $ NO_COLOR=1 pnpm build
  build exit=0
  ```

  Failures are the 9-test baseline exactly (6 in `image-preview.test.tsx`, 3 in
  `PostDetail.test.tsx`). Totals moved 720 -> 752, which is the 32 new tests;
  skips moved 7 -> 8, which is the new live smoke test. `next build` emits the
  same pre-existing BetterAuth base-URL warning recorded under item 3.5f-ii.

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.26s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  All three at the Phase 0 baseline. The only Python file added is the parity
  exporter, which is why `already formatted` moved 125 -> 126; the 9 files that
  would be reformatted and the 32 ruff errors are unchanged and all pre-existing.

  With this item all six stages are ported. Phase 4 composes them.
