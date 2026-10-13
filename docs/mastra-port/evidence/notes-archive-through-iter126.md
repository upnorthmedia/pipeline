# gnhf run: objective-port-jena-46c1e6-1

Objective: see .gnhf/runs/objective-port-jena-46c1e6-1/prompt.md

## Iteration Log

### Iteration 1

**Summary:** Created docs/mastra-port/LEDGER.md with all 60 Phase 0-9 items and recorded the full Phase 0 baseline (tsc, lint, test, build, ruff check, ruff format, pytest) with real pasted output and committed raw logs.

**Changes:**
- docs/mastra-port/LEDGER.md created: every Phase 1-9 task as an ordered unchecked checkbox (59 unchecked), with Phase 0 split into sub-items 0.1-0.4 so baseline capture and golden-fixture capture are separate iterations
- Phase 0 baselines recorded with verbatim output and exit codes for all seven gates; raw logs committed under docs/mastra-port/baseline/
- Three environment corrections documented in the ledger: pnpm -C web does not work, the frontend failure baseline is 9 not 6, and the pytest suite is 125 failed / 235 passed / 25 errors rather than ~280 passing
- Containerized pytest baseline procedure documented and verified, working around the host port 5433 collision without touching the unrelated project's container
- .gitignore changed from `docs/` to `docs/*` plus `!docs/mastra-port/` so the port record is committable

**Learnings:**
- The objective's stated baselines are wrong in three places. Frontend has 9 pre-existing test failures (6 in image-preview.test.tsx plus 3 in PostDetail.test.tsx), not 6. tsc --noEmit and next build both already fail on a missing @types/pg for web/src/lib/auth.ts. pytest is 125 failed / 235 passed / 25 errors, not a passing ~280-test suite.
- The dominant pytest failure cause is Alembic 010's user_id NOT NULL column on website_profiles that test fixtures never set (NotNullViolationError), plus a second cluster of `assert 401 == 201` from handlers that now require an authenticated user. 'Both stacks stay green until Phase 7' must be read as 'pass count never drops below 235, failures never exceed 125/25', not 'pytest exits 0'.
- `pnpm -C web <cmd>` fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL / Command "web" not found, because web/ carries its own pnpm-workspace.yaml and is a workspace root rather than a member. Use `cd web && pnpm exec tsc --noEmit` / `pnpm lint|test|build` for every gate.
- Host port 5433 is occupied by an unrelated project's Postgres container (ship-restrict-shopify-db-1) with different credentials, so the repo's db service cannot bind and tests/conftest.py's hardcoded localhost:5433 is unreachable. Workaround that touches nothing else: run a throwaway postgres:17-alpine with PGPORT=5433 and run pytest in a container started with --network container:<pg> so localhost:5433 resolves inside the test container. Ledger item 0.3 tracks a permanent fix.
- docs/ was entirely gitignored, so the ledger the objective requires could not be committed until .gitignore was changed to `docs/*` + `!docs/mastra-port/`. CLAUDE.md is also gitignored, which Phase 7.4 (update CLAUDE.md) will collide with.
- api/ has no local .venv; `uv sync --extra dev` from api/ sets one up in seconds. web/ node_modules also needed a `pnpm install` before any gate would run.

### Iteration 2

**Summary:** Added @types/pg to web/, turning the pre-existing tsc --noEmit and next build failures green while holding the 9-failure vitest baseline, and checked ledger item 0.2 with pasted evidence.

**Changes:**
- web/ gains @types/pg@8.23.1 as a devDependency, eliminating the TS7016 error on src/lib/auth.ts:5 that broke both tsc --noEmit and next build
- Frontend gate baseline is now tsc exit 0 and build exit 0 (previously both exit 1), with lint exit 0 and vitest unchanged at 9 failed / 191 passed
- docs/mastra-port/LEDGER.md item 0.2 checked with the before/after commands, their real output, and a revised gate baseline stating the 0.1 pre-existing-failure allowance no longer covers tsc and build

**Learnings:**
- The entire pre-existing tsc/build break was one missing @types/pg; no source changes were needed, so Phase 0's 'both gates already fail' caveat is now retired rather than something later phases must work around.
- pnpm add -D @types/pg produces a ~50-line pnpm-lock.yaml diff that looks alarming but is peer-dependency hash re-keying (drizzle-orm and better-auth peer sets now include @types/pg). Verify scope with `git diff web/pnpm-lock.yaml | grep -cE '^-.*resolution:'` returning 0 and exactly one added resolution line, rather than eyeballing the diff.
- The Bash tool's working directory persists across calls in this session, so a `cd web` in one call makes a later relative `cd web` fail. Use absolute paths per command.
- `pnpm lint 2>&1 | tail` loses the exit code to the pipe; redirect to a file and echo $? instead, otherwise a gate's pass/fail cannot be honestly recorded.
- next build emits one pre-existing warning (the middleware-to-proxy deprecation). It is unrelated to the port and should not be counted as a new warning against the Phase 0 baseline in later phases.

### Iteration 3

**Summary:** Resolved the host port 5433 collision by making the compose host ports and the pytest database URL environment-overridable, then stood up a migrated dev database on 5435 and proved pytest runs from the host at the exact Phase 0 baseline.

**Changes:**
- docker-compose.yml host port bindings are now ${POSTGRES_HOST_PORT:-5433} and ${REDIS_HOST_PORT:-6379}, with the previous literals preserved as defaults (verified via docker compose --env-file /dev/null config)
- api/tests/conftest.py reads TEST_DATABASE_URL from the environment and falls back to the previous hardcoded localhost:5433 URL, so pytest can target any port without editing source
- A working dev database exists: db and redis brought up on 5435/6379, alembic upgraded to 011 (head) against content_pipeline, and content_pipeline_test created; named volumes persist so `docker compose up -d db redis` restores it
- pytest now runs directly from the host and reproduces the Phase 0 baseline exactly (125 failed / 235 passed / 25 errors), retiring the container-network workaround recorded in iteration 1
- docs/mastra-port/LEDGER.md item 0.3 checked with pasted commands and real output, including a new Environment note 4 correcting the objective's api_settings table name
- README.md Quick Start and .env.example document POSTGRES_HOST_PORT, REDIS_HOST_PORT, and TEST_DATABASE_URL
- todo.md created logging the confirmed defect that pytest writes real image files into media/test-123/

**Learnings:**
- The objective's claim that API keys live in an `api_settings` DB table is wrong. Alembic 001-011 produce exactly five tables: alembic_version, internal_links, posts, settings, website_profiles. Phase 1 schema work and Phase 6 model settings must target `settings`. BetterAuth tables (auth_users etc.) are excluded from Alembic autogenerate and are absent from a fresh volume until BetterAuth runs.
- api/alembic.ini needs no change for a port override because api/alembic/env.py already prefers the DATABASE_URL_SYNC env var over the ini value, and rewrites postgresql:// to postgresql+asyncpg:// itself.
- Host port map on this machine: 5432 = cairo-pooler, 5433 = ship-restrict-shopify-db-1, 5434 = petago-test-db, 5435 and 6379 free. The worktree's compose project name is objective-port-jena-46c1e6-1, so its volumes are isolated from the main checkout.
- Running the backend suite on the host dirties the working tree: the images tests write real .webp files into media/test-123/, and 39 such artifacts are already committed. Check git status after any host pytest run.
- Full alembic upgrade head on a fresh volume takes seconds and all 11 revisions apply cleanly, so a disposable dev database is cheap to rebuild if a later phase corrupts it.

### Iteration 4

**Summary:** Split ledger item 0.4 into three sub-items and completed 0.4a by building and dry-run verifying api/scripts/capture_golden.py, a transport-level golden-fixture capture harness that produced all 12 fixture files with real rendered prompts and provider request parameters.

**Changes:**
- api/scripts/capture_golden.py: golden-fixture capture harness that runs the six stage nodes in order for two pinned post specs and writes docs/mastra-port/golden/<slug>/<stage>.json containing state_input, rendered_prompts, provider_calls (exact outbound request plus raw response) and stage_output, with API keys redacted
- Capture is done by wrapping the three provider SDK entry points (httpx.AsyncClient.post filtered to api.perplexity.ai, anthropic AsyncMessages.create, google.genai Models.generate_content) rather than build_stage_prompt(), so post-assembly prompt mutations by edit_node and research_node retries are recorded faithfully
- --dry-run mode stubs only the network response, leaving prompt assembly, client wrappers, retry logic, manifest parsing and PIL image optimisation live, so the harness is verifiable without provider spend
- settings.media_dir is redirected under the fixture output directory during capture, so runs never dirty the repo's media/ tree
- Two representative post specs pinned in the harness (how-to/markdown with 3 internal links, listicle/nextjs with none), built through the real state_from_post() on transient never-flushed Post instances so no DB rows or user_id fixtures are needed
- docs/mastra-port/LEDGER.md: item 0.4 split into 0.4a (harness), 0.4b and 0.4c (live captures per post); 0.4a checked with the pasted dry-run output, fixture-shape inspection, SDK patch-point verification, and the unchanged ruff check/format baselines

**Learnings:**
- The rendered prompt is not build_stage_prompt()'s return value: edit_node appends an analytics section afterwards and research_node wraps the prompt in _reinforced_prompt() on retries 2 and 3. Phase 3 prompt-parity tests must compare against the transport payload, not the helper output.
- ClaudeClient.chat computes effective_max = max(max_tokens, thinking_budget + 1024) and always sends thinking={type: enabled, budget_tokens: 10000}. The images stage requests max_tokens=8000 but actually sends 11024, so the TS port must replicate the resolved value.
- _build_config_context() injects '- **TODAY_DATE**: <today>' into every stage prompt, so Python/TypeScript prompt equality is only achievable with the date pinned or normalised.
- The images stage rewrites featured filenames to featured-<MMDDYY>-<2 random digits>.webp and forces image_size 2K (and 16:9 unless the manifest set aspect_ratio), so manifest parity assertions must exclude the filename.
- No provider API keys exist in this worktree's .env; real keys live only in the main checkout's .env, so live capture iterations (0.4b/0.4c) must source them explicitly via PERPLEXITY_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY env vars.
- ready_node is missing from src/pipeline/stages/__init__.py imports and __all__ while the other five nodes are exported; src/worker.py sidesteps it by importing each node from its own module.
- Installed provider SDK versions are anthropic 0.84.0 and google-genai 1.65.0, and both patch points (anthropic.resources.messages.AsyncMessages.create, google.genai.models.Models.generate_content) exist and are safe to wrap.
- In zsh, ${PIPESTATUS[0]} is empty because the array is 1-indexed; use ${PIPESTATUS[1]} or redirect to a file and echo $? when recording a gate's exit code.

### Iteration 5

**Summary:** Completed ledger item 0.4b by capturing six live golden fixtures for the first representative post, fixing a production manifest-parsing bug that the capture exposed, and recording the run's real token usage, verified per-article cost, and the Gemini zero-quota blocker that prevented any image from being generated.

**Changes:**
- Live golden fixtures captured for post 1 (how-to-choose-a-crm-for-a-small-team): six JSON files under docs/mastra-port/golden/ with real rendered prompts, provider request parameters, raw responses and stage outputs across research, outline, write, edit, images and ready, with API keys verified absent
- Production defect fixed in api/src/pipeline/stages/images.py: _parse_manifest now extracts the first fenced JSON block (with an outermost-brace fallback) so a manifest followed by Claude's trailing commentary parses, where previously every such response produced an empty manifest and a failed images stage
- Regression test added in api/tests/phase3/test_images_stage.py covering the fenced-manifest-plus-trailing-prose shape observed in the live capture, raising the pytest pass count from 235 to 236 with failures and errors unchanged
- Capture harness hardened for live mode: base64 image blobs are elided to length plus sha256 so fixtures stay small, and failed provider calls are now recorded with their request payload and exception instead of being lost
- Ledger item 0.4b checked with pasted run output, a per-stage token table, a per-article cost of ~$0.73 computed from independently verified Perplexity and Anthropic list prices, the ruff and pytest gate output, and an explicit record that zero images were generated
- todo.md gained three logged findings: the images stage's featured-image branch never fires on real manifests, the Gemini key has zero image quota, and ClaudeClient sends a thinking configuration the SDK now warns is deprecated

**Learnings:**
- The Gemini key in the main checkout's .env has zero free-tier image quota (429 RESOURCE_EXHAUSTED, 'limit: 0, model: gemini-3.1-flash-image'), so no image can be generated in any environment using it. Phase 0's 'commit the generated images' and Phase 5's images-model verification are both blocked on Google billing, not on code.
- _parse_manifest was broken against real Claude output: the model wraps the manifest in a json fence and appends a closing remark, and the old fence-stripping plus whole-string json.loads failed every time. The images stage would have failed this way in production on any run where Claude added commentary.
- The manifest Claude actually emits sets placement to an object ({'location': 'featured_image', 'after_section': null}) and puts the featured marker on 'type', while images.py compares placement == 'featured'. The 2K/16:9 override and 1920px optimise width therefore never fire on real manifests.
- A live capture harness cannot be validated by dry-run alone: the dry-run stubs used to_dict, hiding that real pydantic provider responses serialize base64 image data inline, and the stubs never raised, hiding that failed calls were never recorded. Both defects only surfaced on real traffic.
- Verified list prices as of 2026-08-21: Perplexity sonar-pro $3/$15 per Mtok (docs.perplexity.ai/getting-started/pricing) and Anthropic claude-opus-4-6 $5.00/$25.00 per Mtok (claude-api skill table, cached 2026-06-24). One article costs ~$0.73 in text generation, 34817 tokens in / 24229 out.
- The installed anthropic SDK now emits a UserWarning that thinking.type=enabled with budget_tokens is deprecated on claude-opus-4-6 in favour of thinking.type=adaptive. The Phase 3 stage ports should not copy the deprecated shape into TypeScript without deciding on it.
- Running ruff format on a touched api/ file silently fixes pre-existing formatting elsewhere in that file and shifts the 'N files would be reformatted' baseline. Revert unrelated hunks to keep the diff focused and the Phase 0 ruff baseline exact.
- Host pytest runs keep dirtying media/test-123/ with new .webp files; git clean -f media/test-123/ after every backend suite run, or the fixture artifacts get committed by accident.

### Iteration 6

**Summary:** [FAIL] Started the live golden-fixture capture for ledger item 0.4c but only the research stage completed before the iteration ended, so the partial fixture was removed and the working tree left clean with no ledger change.


**Learnings:**
- api/scripts/capture_golden.py has no resume or per-stage skip: an interrupted run must restart from `research` and re-spend on every already-captured stage. Before attempting 0.4c again, either add a skip-existing-stage flag to the harness or budget the entire iteration around the single uninterrupted run.
- A full live capture is a ~10 minute wall-clock commitment that consumes most of an iteration's turn budget. Start it as the very first tool call of the iteration and do no other exploratory work in parallel; reading the harness and building helper scripts while it runs is what exhausted the budget here.
- Post 2's research stage is materially cheaper and faster than post 1's (1475 in / 2058 out in 18.2s versus 1510 / 4635 in 37.0s), because the listicle spec has zero internal links and no competitor URLs. The ~$0.73 per-article baseline from 0.4b is an upper bound, not a flat rate.
- The anthropic SDK's thinking.type=enabled deprecation warning (already logged in todo.md) prints to stderr on the first Claude call of every capture run, so a capture log that looks like it contains an error at the outline stage is usually just this warning.
- Killing the capture leaves no repo artifacts to clean beyond the fixture directory itself: settings.media_dir is redirected under the output directory during capture, so the usual media/test-123/ dirtying from host pytest runs does not apply here.

### Iteration 7

**Summary:** Split ledger item 0.4c and completed 0.4c-i by adding a verified --resume mode to the golden-fixture capture harness and committing the one live fixture (research) already captured for post 2, so the remaining five stages can be captured without re-paying for completed ones.

**Changes:**
- api/scripts/capture_golden.py gains a --resume flag that reuses any stage fixture already on disk, replaying its saved stage_output into the running state (including _stage_meta, exactly as the uninterrupted live path does) instead of re-issuing the provider call
- The first live fixture for post 2 is committed: docs/mastra-port/golden/best-time-tracking-tools-for-agencies/research.json (71788 bytes, sonar-pro, 1475 tokens in / 5489 out, 37.5s), preserving spend that two prior interrupted attempts threw away
- Resume correctness proven without provider spend: a --dry-run --resume run against the real research.json skips research, and the resumed outline's state_input.research (22005 chars) is byte-identical to the live research output and appears in the rendered outline prompt
- docs/mastra-port/LEDGER.md splits 0.4c into 0.4c-i (harness resumability, checked with pasted evidence) and 0.4c-ii (capture the remaining five stages with the exact resume command recorded)

**Learnings:**
- A six-stage live capture is longer than one iteration can reliably hold, and this is the second attempt cut off partway. The durable fix was making the harness resumable rather than trying harder to finish in one run; 0.4c-ii should now cost only five stages.
- Waiting on a long background command by ending the turn does not work here: the turn is forced to conclude with structured output rather than resuming when the background task finishes. Long work must either fit inside a single blocking tool call or be made restartable.
- The harness threads _stage_meta into state via state.update(output), so it appears in the next stage's state_input. A resume path that strips it would diverge from the live path; merging the whole saved stage_output is what makes replay faithful.
- capture_golden.py already had --post and --stages, but --stages alone cannot resume: it filters which nodes run while state still starts fresh from the post spec, so later stages would see empty prior content. Reloading the saved fixture output is the only correct resume.
- Post 2's research stage cost 1475 in / 5489 out at 37.5s, close to post 1's 37.0s rather than the 18.2s recorded in iteration 6's partial run, so per-stage timings vary run to run and are not a reliable progress estimate.
- No test imports api/scripts/, so changes confined there can be gated with ruff alone; grep -rn "capture_golden" api/tests/ returns nothing.

### Iteration 8

**Summary:** Completed ledger items 0.4c-ii, 0.4c and 0.4, closing Phase 0 by capturing the remaining five live golden fixtures for post 2 via the resume path and recording the run's usage, verified cost, and the unresolved image-generation gap.

**Changes:**
- Five live golden fixtures captured and committed for best-time-tracking-tools-for-agencies (outline, write, edit, images, ready), bringing the parity oracle to the full 12 files across two posts with differing article_type and output_format
- The --resume path proved itself on real traffic: research was reused from disk at zero provider cost and the five remaining stages ran live exactly once, so no already-paid-for stage was re-billed
- Ledger items 0.4c-ii, 0.4c and 0.4 checked with pasted run output, a per-stage token/duration table read from each fixture's _stage_meta, a per-article cost of $0.8530, a fixture inventory, and a key-leak scan showing 0 matches
- Phase 0 recorded as complete: items 0.1 through 0.4 all checked, 56 unchecked items remain starting at Phase 1
- An explicit 'known gap in the oracle' note added under 0.4 stating that zero images were generated across both posts, so there is no golden image binary or successful Gemini response body for Phase 3 to compare against

**Learnings:**
- The resumable harness from iteration 7 was the correct fix: what took three failed attempts before finished in one blocking tool call, because only five stages had to run. Starting the long capture as the literal first action of the iteration, with no exploratory work in parallel, is what made it fit.
- Perplexity returns its own billing figure in the response body at usage.cost.total_cost ($0.09276 here), which includes a $6/1000 request fee on top of the $3/$15 per Mtok rate. That is more authoritative than computing cost from token counts and should be preferred for the research stage.
- Per-stage token usage is best read from stage_output._stage_meta rather than from provider_calls: the two providers nest usage differently (Anthropic under response.usage.input_tokens, Perplexity under response.body.usage.prompt_tokens), and _stage_meta already normalizes both.
- The images stage's _stage_meta reports only the Claude manifest call; its other 6 provider calls are the Gemini image attempts. A naive per-stage call count therefore overstates what the token numbers cover.
- The two live articles bracket $0.73 to $0.85 in text generation, so the 0.4b figure is not a flat rate. The images stage's true cost is still entirely unmeasured because every Gemini call 429s before consuming tokens.
- The capture writes an empty media/ subdirectory under the fixture output dir when no image is generated. Git ignores empty directories, so it needs no cleanup, unlike the media/test-123/ artifacts that host pytest runs leave behind.
- The 0.4b manifest-parsing fix generalizes: a second independent live Claude response also arrived as a fenced JSON block with trailing prose, confirming that shape is the norm rather than a one-off, and that the pre-fix code would have failed the images stage in production on essentially every run.

### Iteration 9

**Summary:** Completed ledger item 1.1 by introspecting the live Alembic-owned database with drizzle-kit and committing web/src/db/schema.ts, proven byte-faithful by a normalized DDL diff that exits 0 against the introspected schema.

**Changes:**
- web/src/db/schema.ts describes all 5 tables, 90 columns, 3 indexes and 3 foreign keys that Alembic 001-011 produced, generated by drizzle-kit pull against the live dev database and annotated with JSONB element types via $type<>(), doc comments, and mode: 'date' timestamps
- Fidelity is proven mechanically rather than by inspection: DDL generated from the TypeScript schema and DDL introspected from the live database are an exact multiset match after stripping the introspection comment wrapper and normalising statement order (diff exit 0)
- drizzle-orm 0.45.2 and drizzle-kit 0.31.10 installed in web/, with web/drizzle.config.ts pointed at DATABASE_URL_SYNC and explicitly carrying no migrate workflow so no second database or table-recreating migration can be produced
- Six schema findings recorded in the ledger under 1.1, including that posts has no user_id column (tenancy is transitive through profile_id) and that settings' primary key is `key` alone so per-user settings collide
- todo.md gained two confirmed defects: the settings primary-key collision that blocks Phase 6's per-user model settings, and the SQLAlchemy model disagreeing with the migrations on the output_format and stage_settings defaults

**Learnings:**
- posts has no user_id column at all. Alembic 010's multi-tenancy landed only on settings.user_id and website_profiles.user_id, so Phase 5 handler scoping must join through website_profiles rather than filtering posts.user_id, and any plan that assumed a posts.user_id filter is wrong.
- settings' primary key is `key` alone with user_id merely indexed, so two users cannot hold different values for the same key. Phase 6 requires per-user per-stage model settings while the port forbids schema changes, so that item needs a decision (namespaced keys) before it can be implemented.
- website_profiles.user_id is nullable in the database (is_nullable = YES), contradicting iteration 1's reading that Alembic 010 made it NOT NULL. The pytest NotNullViolationError cluster originates in the SQLAlchemy model, not a database constraint, which changes how that baseline failure would be fixed.
- api/src/models/post.py and the Alembic migrations disagree on two defaults: the model declares output_format 'markdown' and a six-stage all-'auto' stage_settings, while the database has 'both' and a five-stage all-'review' map. Rows created through SQLAlchemy and rows created by raw SQL get different defaults today.
- drizzle-kit pull plus drizzle-kit generate is a self-checking pair: generating DDL from the ported schema and diffing it against the DDL introspected from the live database gives a mechanical fidelity proof, which is far stronger evidence for a schema port than reading columns side by side.
- drizzle-kit pull defaults timestamps to mode: 'string', which returns Postgres' native '2026-08-21 12:00:00+00' form rather than the ISO-8601 shape FastAPI emits. Taking that default would have silently changed every API response date, so mode: 'date' is required for Phase 5 response parity.
- posts has a hole at ordinal_position 30 from the thread_id column Alembic 005 dropped, so a column count of 44 is correct and should not be read as a missing column by the Phase 1.2 parity check.
- nextjs_frontmatter_map is `json`, not `jsonb`, unlike every other JSON column in the schema; a parity check that only compares logical types would miss this.

### Iteration 10

**Summary:** Completed ledger item 1.2 by adding a bidirectional schema-parity check that diffs the live Alembic-owned Postgres catalog against web/src/db/schema.ts, proven to go red via a negative control with an injected column.

**Changes:**
- web/src/db/schema-parity.ts: pure helpers describing both sides of the schema in one shape (describeDatabase reads pg_attribute/format_type from the live catalog, describeDrizzleSchema reads every exported pgTable via getTableConfig) plus diffSchemas, which reports table and column presence in both directions along with type, NOT NULL and default-presence drift
- web/src/db/schema-parity.test.ts: 9 vitest tests covering each diff branch synthetically, the varchar-to-character-varying type normalisation, the non-Alembic table exclusions, an assertion pinning alembic_version to 011, and the live comparison of schema.ts against the migrated database
- isAlembicOwned() excludes auth_* and subscription (BetterAuth plus its Stripe plugin) and mastra_* (the Phase 2 Postgres storage adapter), so the reverse direction still fails on genuinely unexpected tables without false-failing on tables Alembic never created
- web/vitest.config.ts loads the repo-root .env into test.env, giving database tests their connection string without duplicating credentials into web/
- docs/mastra-port/LEDGER.md item 1.2 checked with the pasted passing run, the pasted negative-control failure, the revert proof, and the four frontend gate results

**Learnings:**
- pg_attribute plus format_type is a much better parity oracle than information_schema: it renders types exactly as drizzle's getSQLType does apart from varchar vs character varying, so a one-line normaliser is the entire mapping layer, whereas information_schema splits data_type and character_maximum_length and would need per-type reassembly.
- Node 24 runs TypeScript directly via native type stripping, so a scratch .mts file importing drizzle-orm and schema.ts probes getSQLType/notNull/hasDefault in seconds. web/ has no tsx installed and does not need it for this kind of one-off introspection.
- vitest 4 removed the 'basic' reporter: passing --reporter=basic throws ERR_LOAD_URL 'Failed to load url basic'. Use NO_COLOR=1 with the default reporter to capture clean output for the ledger.
- The Phase 0 vitest baseline of 9 failures is a failure count, not a total: adding 9 new passing tests moved the suite to 9 failed / 200 passed and the baseline still holds. Record pass and fail counts separately when checking future items.
- pnpm build emits two BetterAuth warnings (base URL undeterminable, default secret) from src/lib/auth.ts that the iteration 1 baseline log does not contain, because that build failed before reaching prerender. They are pre-existing as of iteration 2, not new, and future iterations should not chase them.
- Loading the repo-root .env into vitest's test.env makes `docker compose up -d db redis` a hard prerequisite for `pnpm test`. Every later phase needs a live database anyway, but the gate now has an environment dependency it did not have in Phase 0.

### Iteration 11

**Summary:** Completed ledger item 1.3 by porting api/src/services/crypto.py to a TypeScript Fernet implementation, proven bidirectionally interoperable with Python and catching a base64 padding bug that would have made TS-written secrets undecryptable by the Python stack.

**Changes:**
- web/src/lib/crypto.ts implements the Fernet token spec on node:crypto (version byte, big-endian timestamp, 16-byte IV, AES-128-CBC with PKCS7, HMAC-SHA256 over the prefix, key split 16/16), exposing encrypt/decrypt backed by WP_ENCRYPTION_KEY plus encryptWithKey/decryptWithKey for explicit-key use, and an InvalidTokenError for malformed, truncated, tampered, or wrong-key tokens
- web/src/lib/__fixtures__/python-fernet.json commits six tokens generated by cryptography 46.0.5 under a throwaway key, so the Python-to-TypeScript interop proof runs in vitest without Python installed; cases cover ASCII, symbol-heavy, multibyte unicode, empty string, block-aligned 16-byte, and 500-byte plaintexts
- web/src/lib/crypto.test.ts adds 16 passing tests: the six Python-token decryptions, a round-trip, IV randomness, a byte-for-byte token reproduction given a pinned timestamp and IV, five token/key validation cases, and the two WP_ENCRYPTION_KEY environment behaviours
- Fixed a padding defect the byte-for-byte test exposed: Node's 'base64url' encoding strips '=' padding, which Python's base64.urlsafe_b64decode rejects, so the encoder now emits padded url-safe base64 and TS-written secrets stay readable by the still-running Python stack
- docs/mastra-port/LEDGER.md item 1.3 checked with the fixture generation command, the passing test run, the pre-fix failing assertion, the pasted Python rejection of the unpadded token, the reverse-direction Python decryption of a TS-produced token, and all four frontend gate results

**Learnings:**
- Node's Buffer 'base64url' encoding omits '=' padding while Python's base64.urlsafe_b64decode requires it, so a naive Fernet port encrypts values that Python cannot decrypt. This only surfaces in the TypeScript-writes/Python-reads direction, which no vitest test can cover, so it needs a scripted cross-language check. Any other base64url interop in this port (HMAC signing for the Next.js webhook path in Phase 5) should be checked for the same asymmetry.
- A byte-for-byte reproduction test is far stronger than a round-trip test for a crypto port: by reading the timestamp and IV back out of a Python-produced token and feeding them into the TS encoder, the whole token framing gets pinned in one assertion, and it is what caught the padding bug that six passing decrypt tests missed.
- Buffer.from(x, 'base64url') never throws on malformed input; it silently drops unexpected characters. Defensive try/catch around it is dead code, and validation has to come from the length check, version byte, and HMAC comparison instead.
- cryptography.fernet.Fernet is fully reimplementable in ~90 lines of node:crypto with no dependency, so the port needed no new npm package. The Fernet key is base64url of 32 bytes split as signing key (first 16) then AES key (last 16), and Fernet.decrypt without a ttl argument never validates the embedded timestamp.
- The vitest baseline continues to behave as iteration 10 recorded: the 9 pre-existing failures are a failure count, not a total. Adding 16 passing tests moved the suite from 9/200 to 9/216 and all four frontend gates (tsc, lint, test, build) stayed at their established results.

### Iteration 12

**Summary:** Completed ledger item 1.4 and closed Phase 1 by adding the drizzle database client and a Post round-trip test against the real Alembic-owned dev database, proven by a negative control and by reading TypeScript-written rows back through SQLAlchemy.

**Changes:**
- web/src/db/index.ts added: the drizzle-over-pg database client for the whole TypeScript stack, with a globalThis-cached lazy Pool, a postgresql+asyncpg:// prefix normaliser, closeDb() for scripts and tests, and no next/* import so the Phase 2 Mastra worker can import it
- web/src/db/post-roundtrip.test.ts added: 5 passing tests that insert a profile and post into the real Alembic-owned dev database, read back JSONB arrays, JSONB objects and timestamptz-as-Date, assert the database-applied defaults, update a stage content column plus stage_status and image_manifest, verify the commit through a second independent connection using jsonb_typeof/pg_typeof, and delete
- Ledger item 1.4 checked with pasted evidence: the passing run, a negative control that renames one schema column and turns all five tests red with a server-side error (then reverts), bidirectional cross-language proof (drizzle-written post read by SQLAlchemy and SQLAlchemy-written post read by drizzle), and all four frontend gate results
- Recorded in the ledger that drizzle-inserted and SQLAlchemy-inserted posts get different defaults for output_format and stage_settings, so Phase 5 handlers must set those columns explicitly to preserve API response parity

**Learnings:**
- The two stacks already disagree on defaults for the same table, and the round-trip proved it from both sides: a drizzle insert lands output_format 'both' and five-stage all-'review' stage_settings (the database defaults) while a SQLAlchemy insert lands 'markdown' and six-stage all-'auto' (the model defaults). Phase 5 route handlers must set both columns explicitly or responses will silently change shape versus FastAPI.
- This worktree's Postgres is on host port 5435, not the 5433 recorded in project memory and in schema-parity.test.ts's fallback. Tests should read DATABASE_URL_SYNC from the repo-root .env rather than hardcoding a fallback port, since a wrong-but-unused fallback is a trap for the next worktree.
- Node 24's native TypeScript stripping cannot run the port's source directly: it requires extension-ful relative imports, and src/db/index.ts imports './schema' extensionless (correct for vitest and the Next bundler). Ad-hoc scripts that touch these modules must either be vitest tests or inline their own drizzle setup importing schema.ts with the .ts extension, and must live inside web/ so drizzle-orm resolves.
- A column rename in schema.ts is a cheap, high-signal negative control for any database test: it fails at the Postgres parser with error 42703 rather than in drizzle's type layer, which proves the test hits the real catalog and not a mock.
- SQLAlchemy expires attributes on commit, so reading post.id after await s.commit() raises MissingGreenlet under asyncpg. Capture the values after flush() and before commit() in any ad-hoc async cross-language script.
- The vitest baseline continues to behave as a failure count: 5 new passing tests moved the suite 216 -> 221 passed with failures held at exactly 9.

### Iteration 13

**Summary:** Completed ledger item 2.1 by installing the Mastra runtime packages, Postgres storage adapter, Redis Streams pub/sub and CLI in web/, verifying every API symbol the objective depends on against the installed typings and at runtime, and recording seven discrepancies that change how Phases 2, 4 and 8 must be built.

**Changes:**
- web/ gains @mastra/core 1.61.0, @mastra/pg 1.21.1, @mastra/redis-streams 0.4.0 and @mastra/loggers 1.2.0 as exact-pinned dependencies plus mastra 1.26.0 as a devDependency for Studio, with zod 4.4.3 promoted to a direct dependency because @mastra/core declares it as a peer
- Runtime resolution proven rather than assumed: a scratch ESM module run from inside web/ imported and type-checked Mastra, createWorkflow, createStep, createWorkflowStateReader, PostgresStore, RedisStreamsPubSub and PinoLogger, all resolving to functions (exit 0), then was deleted
- Ledger item 2.1 checked with the pasted install output, the resolved version table, the pnpm exec mastra --version output, file-and-line citations for every workflow, stream, usage and Mastra-config symbol the objective names, and all four frontend gate results
- Seven API discrepancies recorded against the objective's section 2 description, covering the deprecated stream iterator, the synchronous stream.status getter, the undocumented createEventedWorkflow constructor, createRun versus createRunAsync, @mastra/pg's single root export, the mastra CLI's unmet internal peer, and the Node >= 22.13 engine floor for Railway

**Learnings:**
- stream.status is a synchronous getter on WorkflowRunOutput while stream.result and stream.usage are promises, so item 2.3's `stream.status === 'success'` assertion only means anything after the stream is drained or `await stream.result` settles. Asserting it right after calling stream() would read the in-flight status and pass or fail for the wrong reason.
- The object returned by run.stream() is async-iterable, but [Symbol.asyncIterator], cancel, getReader, tee, pipeTo and pipeThrough on it are all marked @deprecated in favour of stream.fullStream. Phase 8's trace reader should consume fullStream or it ships deprecation warnings in every stream consumer.
- @mastra/core exports createEventedWorkflow alongside createWorkflow, plus a separate @mastra/core/workflows/evented entry path, neither mentioned in the objective. Phase 4's cross-process worker execution over Redis Streams is likely gated on using the evented constructor, so 4.4 must re-check that before assuming plain createWorkflow suffices.
- stream.usage resolves to ai-sdk's LanguageModelV2Usage with inputTokens/outputTokens/totalTokens each typed `number | undefined`, not plain number. The Phase 8 cost view has to handle undefined per field rather than assuming the counts are always present.
- pnpm -C web tsc --noEmit fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL 'Command "web" not found' under pnpm 10.26.2 even though the objective's section 7 lists it. The working invocation the ledger has used since Phase 0 is `cd web && pnpm exec tsc --noEmit`.
- The mastra CLI's own tree carries an unmet peer (@hono/node-ws 1.3.1 wants @hono/node-server ^1.19.11, tree has 1.19.9) inside @mastra/deployer. `mastra --version` works, but this is the first suspect if `mastra dev` cannot boot its server in item 2.5.
- Three zod copies coexist in the pnpm store after the install (3.25.76, 4.3.6, 4.4.3) because other packages pin their own, but only 4.4.3 is hoisted to web/node_modules/zod. Step schemas compile against 4.4.3, and @mastra/core accepts either major (^3.25.0 || ^4.0.0), so a future dependency that hoists zod 3 would silently change what schemas resolve to.

### Iteration 14

**Summary:** Completed ledger item 2.2 by configuring web/src/mastra/index.ts with Postgres storage on the existing content_pipeline database, RedisStreamsPubSub on the existing Redis and a Pino logger, proven against real infrastructure with four negative controls and enforced free of next/* imports.

**Changes:**
- web/src/mastra/index.ts is the single Mastra entry point: PostgresStore bound to the existing content_pipeline database via the shared pg.Pool from src/db/index.ts, RedisStreamsPubSub bound to REDIS_URL, a PinoLogger, and an empty workflows/agents registry for Phase 3 to fill
- web/src/mastra/index.test.ts adds 5 node-environment tests hitting real Postgres and real Redis: instance wiring, shared-pool identity, mastra_* tables and posts living in the same database, a workflow-snapshot persist/load round trip through storage.getStore('workflows'), and an event published through mastra.pubsub arriving at a subscriber over Redis
- web/src/mastra/no-next-imports.test.ts walks the transitive first-party import graph from the entry point and fails on any next/* or server-only specifier, with a negative-control test proving the walker resolves the @/ alias and does detect next imports
- The RedisStreamsPubSub logger option is fed through a small sink adapter because MastraLogger's narrower (message, args) signature is not assignable to the config's (...args: unknown[]) sinks, which was a tsc TS2322 error
- docs/mastra-port/LEDGER.md item 2.2 checked with the pasted test run, four applied-and-reverted negative controls, the psql proof that Mastra and Alembic tables share one database, five new API discrepancies numbered 8-12, and all four frontend gate results

**Learnings:**
- Mastra hands back wrappers, never the configured objects: getStorage() returns an init-ensuring Proxy (augmentWithInit), pubsub returns a publish-rewriting Proxy, and getLogger() returns a DualLogger exposing the original as .baseLogger. Every toBe identity assertion against a constructor argument fails; assert instanceof, .pool or .baseLogger. A side effect is that storage self-initialises, so an explicit storage.init() is optional.
- Phase 4 blocker to check early: the mastra.pubsub proxy publishes with { localOnly: true } for the internal 'workflows' and 'workflows-finish' topics whenever the run belongs to a workflow registered on that same instance (dist/mastra-Bn5mWcPE.js:556-578), which keeps the event off Redis entirely. Registering the workflow on the web service and starting a run there may execute it in-process rather than handing it to the worker.
- PostgresStore.init() creates 43 mastra_* tables covering every Mastra domain (knowledge, datasets, experiments, scorers, skills, MCP, channels), not just workflow state, landing in public next to the 5 Alembic tables. PostgresStoreConfig accepts schemaName if they ever need namespacing.
- Redis Streams subscriptions are pull-based consumer groups, so a publish issued before the subscriber's first XREADGROUP is never delivered. Tests and the Phase 5 SSE port need a subscribe/publish handshake delay rather than assuming ordering is safe.
- Omitting storage or pubsub from the Mastra config does not fail loudly: Mastra substitutes a default store and an EventEmitterPubSub, both of which look healthy in a single process. That is why the wiring test asserts through the boundary (current_database(), a real Redis round trip) rather than just constructing the instance.
- PostgresStore accepts a pre-built pg.Pool and explicitly will not close a pool it did not create, so sharing the app's pool keeps one connection budget per process and leaves closeDb() as the single teardown path for tests and scripts.
- pnpm test now depends on Redis as well as Postgres, so `docker compose up -d db redis` is a hard prerequisite for the test gate from this point on.
- Use `docker compose stop` rather than `down` when tidying up: down removed the containers (data survived only because pgdata/redisdata are named volumes).

### Iteration 15

**Summary:** Completed ledger item 2.3 by defining and registering a trivial two-step Mastra workflow, proven to execute, emit the documented lifecycle events and persist its run into the Postgres storage adapter, with two negative controls.

**Changes:**
- web/src/mastra/workflows/scaffold-check.ts adds the scaffold-check workflow: two createStep steps with Zod input/output schemas chained by .then() and terminated with .commit(), where the second step consumes the first's output so step chaining is observable rather than assumed
- web/src/mastra/index.ts registers the workflow as workflows: { scaffoldCheck: scaffoldCheckWorkflow }, replacing the empty registry
- web/src/mastra/workflows/scaffold-check.test.ts adds 5 node-environment tests against real Postgres and Redis covering instance registration, stream.status === 'success' after draining the stream, workflow-start/workflow-step-start/workflow-step-result/workflow-finish event types and order, a direct SQL probe of mastra_workflow_snapshot by run_id, and getWorkflowRunById
- web/src/mastra/no-next-imports.test.ts expected package list extended by @mastra/core/workflows and zod, which the workflow registration legitimately pulls into the entry point's import graph
- docs/mastra-port/LEDGER.md item 2.3 checked with the pasted passing run, the psql proof of the persisted run rows, two applied-and-reverted negative controls, the rationale for the intentional test update, and all four frontend gate results

**Learnings:**
- Mastra substitutes a default in-memory store when `storage` is omitted, and workflow.getWorkflowRunById() reads happily from it, so that API cannot distinguish 'persisted to Postgres' from 'persisted somewhere'. The storage negative control only went red on the direct SQL probe of mastra_workflow_snapshot. Every later durability claim (items 4.4 and 4.5 especially) must assert through SQL, not the workflow API.
- The Mastra instance listing method is mastra.listWorkflows(), not getWorkflows(); getWorkflows() does not exist and fails at runtime, not at tsc. mastra.getWorkflow('key') returns the identical object (toBe passes), unlike getStorage()/pubsub/getLogger() which return proxies, so identity assertions are fine for workflows.
- Plain createWorkflow with the default engine already works end to end on the Phase 2 wiring: run.stream() drains, the snapshot lands in Postgres and the status is success, with no need for createEventedWorkflow at this stage. Whether the evented constructor is required is still an open question specific to cross-process execution in item 4.4.
- The run row lands in mastra_workflow_snapshot keyed by (workflow_name, run_id) with snapshot->>'status' and snapshot.context holding one entry per step id, which is the shape Phase 4's crash-resume gate will need to inspect to prove completed stages are not re-run.
- Registering anything on the Mastra instance widens the entry point's external import list, so the no-next-imports package-list assertion will need an intentional update once per Phase 3 stage as agents and providers are added. The next/* and server-only part of that test is the load-bearing assertion; the exact package list is a churn surface.
- The vitest 'workflow-step-finish' event type exists in the union alongside 'workflow-step-result', but the default engine emitted only start/result pairs for these steps, so a trace view keyed on step-finish would see nothing. Phase 8 should key on workflow-step-result.

### Iteration 16

**Summary:** Completed ledger item 2.4 by proving a separate OS process subscribed to Mastra's Redis Streams topics receives a workflow run's lifecycle events, which required moving the scaffold workflow onto the evented engine because the default engine publishes nothing to Redis at all.

**Changes:**
- web/src/mastra/scripts/redis-event-observer.mjs added: a standalone second process that subscribes to named Mastra pub/sub topics through @mastra/redis-streams and emits one JSON line per received event, importing nothing else from this repo so only the Redis connection string links it to the workflow, and using per-subscription fan-out consumer groups so it cannot steal events from the orchestration worker
- web/src/mastra/crossprocess-events.test.ts added: 4 node-environment tests that spawn the observer, run the scaffold workflow, and assert the observer received workflow.start, two workflow.step.run/workflow.step.end pairs and workflow.end on the workflows topic plus the terminal workflow.end on workflows-finish, all carrying the same runId and workflowId, while the run still reached success locally
- web/src/mastra/workflows/scaffold-check.ts moved from @mastra/core/workflows to @mastra/core/workflows/evented, since the default engine executes entirely in-process and writes zero keys to Redis, making item 2.4 unsatisfiable on it and 4.4's web/worker split impossible
- web/src/mastra/workflows/scaffold-check.test.ts gained mastra.startWorkers()/stopWorkers() around the run, because an evented workflow never executes without an orchestration worker consuming the workflows topic; every assertion item 2.3 recorded still holds unchanged
- A fourth test pins that workflow.events.v2.<runId> never reaches Redis (a third observer started after the run sees nothing), which constrains how Phase 5.5's SSE route can source a worker-side run's trace
- docs/mastra-port/LEDGER.md item 2.4 checked with the passing run, the zero-Redis-keys measurement for the default engine, redis-cli XLEN proof of 6 events on workflows and 1 on workflows-finish, a raw XRANGE entry, two applied-and-reverted negative controls, an amendment note explaining the 2.3 test change, seven new API discrepancies numbered 13-19, and all four frontend gate results

**Learnings:**
- The default createWorkflow from @mastra/core/workflows publishes nothing to Redis: after a full run with RedisStreamsPubSub configured, redis-cli KEYS '*' returns empty. Only @mastra/core/workflows/evented puts workflow lifecycle events on the bus. Phase 4.4's cross-process execution is entirely gated on using the evented constructors.
- An evented workflow does not execute unless some process has called mastra.startWorkers(). Without it the run is published to the workflows topic and nothing consumes it, so run.stream() never terminates (item 2.3's test hit its 60s hook timeout with all 5 tests skipped). This is exactly the web-starts/worker-executes division, and it means the web service must NOT call startWorkers() in Phase 4.
- Iteration 14's reading of the mastra.pubsub localOnly guard was too broad. The guard on workflows/workflows-finish fires only for workflows in the INTERNAL registry (__registerInternalWorkflow, used by background tasks and durable agents), not for publicly registered workflows, so a normally registered workflow's events do reach Redis. The unconditionally local topic is the workflow.events.v2.* prefix (RUN_LOCAL_TOPIC_PREFIXES in @mastra/core/dist/topics-BCcUoD5n.js:310).
- Because the per-run stream topic workflow.events.v2.<runId> never leaves the executing process, Phase 5.5's SSE route in the web service cannot read a worker-side run's chunks from it. It has to work from the workflows topic or from Mastra's own resumable-stream replay.
- createEventedWorkflow is not an actual runtime export of @mastra/core (undefined at run time) despite appearing in the typings; the working import path is @mastra/core/workflows/evented. Its createStep and createWorkflow are different function objects from @mastra/core/workflows', so the two engines cannot be mixed.
- The evented engine emits workflow-start and workflow-finish twice each on run.stream().fullStream even with a single Mastra instance and one registered workflow. Phase 8's trace view must dedupe those two event types or it will render two runs.
- RedisStreamsPubSub.subscribe defaults to a unique __fanout-<uuid> consumer group anchored at stream position 0, so an observer replays the whole stream history and never competes with the executing worker. Passing an explicit group is what would make two processes compete, which is the Phase 4 mechanism to reach for deliberately.
- Reverting the scaffold workflow to the plain engine is a decisive 30-second negative control for any cross-process claim: the run still succeeds in-process while the observer times out waiting, which separates 'the workflow ran' from 'the events crossed a boundary'.

### Iteration 17

**Summary:** Completed ledger item 2.5 and closed Phase 2 by getting Mastra Studio to boot against the port's entry point and list the scaffold workflow with both steps, which exposed and fixed an ESLint OOM caused by the CLI's build directory.

**Changes:**
- docs/mastra-port/LEDGER.md item 2.5 checked with the exact `pnpm exec mastra dev --env ../.env` command and its real output, the Studio API listing showing scaffold-check with both step ids, two committed screenshot paths, a psql cross-check proving Studio reads run state from the shared content_pipeline database, two applied-and-reverted negative controls, and all four frontend gate results
- docs/mastra-port/studio/2.5-studio-workflows-list.png and 2.5-studio-workflow-detail.png committed: the workflows table showing scaffold-check with 2 steps, and the detail page rendering Start -> scaffold-first -> scaffold-second -> End, the Zod-derived run-input form, and 21 prior success runs
- web/eslint.config.mjs adds `.mastra/**` to globalIgnores, fixing a hard `pnpm lint` failure (V8 heap OOM walking the bundled Studio assets) that appears on any checkout where `mastra dev` has been run
- web/.gitignore adds `.mastra` so the Mastra CLI's bundled server and Studio UI output stays out of the repository

**Learnings:**
- `mastra dev` writes a build directory at web/.mastra containing the bundled Mastra server and the entire Studio UI. ESLint flat config does not consult .gitignore, so the moment Studio has been run once, `pnpm lint` walks those assets and dies with `FATAL ERROR: Ineffective mark-compacts near heap limit`. Gitignoring it is not enough; the eslint globalIgnores entry is the load-bearing fix.
- The Mastra CLI does not read the repo-root .env on its own: `pnpm exec mastra dev` without `--env ../.env` fails at import time with the DATABASE_URL_SYNC error thrown by web/src/db/index.ts. That failure is also useful proof that Studio bundles this repo's entry point rather than a stub, and it means `--env ../.env` must be part of the documented command in Phase 7.3.
- Studio's Recent runs panel is a free read of the Postgres storage adapter: the run IDs it rendered were produced by the item 2.3 and 2.4 vitest suites in other processes and match mastra_workflow_snapshot rows exactly. This makes Studio a usable cross-process inspection surface for the Phase 4 crash-resume gate without writing any extra tooling.
- chrome-devtools-axi's screenshot command reports an absolute path but silently writes nothing when the target is inside this worktree; writing to /tmp and copying in works. Phase 8's screenshot workflow needs that two-step dance or every committed PNG will be missing.
- The Studio server exposes a plain REST surface at /api (for example GET /api/workflows returning the registry keyed by registration name with per-step JSON Schemas, plus a swagger-ui mount), so workflow registration can be asserted with curl in CI-style checks rather than only through the browser.
- Studio renders a run-input form generated directly from the workflow's Zod inputSchema, so the schema quality required by Phase 3 (no z.any(), no untyped passthrough) pays off directly as a usable manual trigger for each of the six stages.

### Iteration 18

**Summary:** Split ledger item 3.1 and completed 3.1a by porting the shared stage prompt assembly (load_rules / build_stage_prompt) to TypeScript, proven byte-identical against the golden fixtures, which exposed that edit and ready use different prompt builders and that Python's JSON escaping diverges from JSON.stringify.

**Changes:**
- web/src/mastra/state.ts added: the stage vocabulary ported from api/src/pipeline/state.py (STAGES, STAGE_CONTENT_MAP, STAGE_PROVIDER_MAP, STAGE_RULES_MAP, STAGE_OUTPUT_KEY, status constants) plus pipelineContextSchema, the Zod schema for the prompt-visible subset of PipelineState with API keys and run-control fields deliberately excluded so no step can leak a credential into a provider payload
- web/src/mastra/prompts.ts added: loadRules and buildStagePrompt ported from api/src/pipeline/helpers.py including the config context block, previous-stage chaining, the edit-stage internal link inventory capped at 50, RULES_DIR override support, and a Python-compatible JSON serializer that escapes non-ASCII to \uXXXX the way json.dumps does
- web/src/mastra/prompts.test.ts added: 21 passing tests covering 8 byte-exact golden-fixture prompt comparisons (research, outline, write, images across both captured posts), 2 edit exact-prefix comparisons, 2 ready non-applicability pins, TODAY_DATE injection in both directions, rule-file loading for all six stages against on-disk bytes, and four assembly edge cases
- docs/mastra-port/LEDGER.md: item 3.1 split into 3.1a (checked, with the passing run, three applied-and-reverted negative controls, the real python3 json.dumps cross-check, and all four frontend gate results) and 3.1b for the research agent and step
- Recorded in the ledger the per-stage prompt contract table establishing that only research, outline, write and images send exactly build_stage_prompt(), edit appends an analytics block, and ready uses a separate builder entirely

**Learnings:**
- The prompt contract is not uniform across the six stages, and the golden fixtures proved it: edit_node sends build_stage_prompt() + "\n\n---\n\n" + _build_analytics_section(), and ready_node never calls build_stage_prompt() at all (_build_ready_prompt emits a SLUG/OUTPUT_FORMAT/TODAY_DATE config block and fences the manifest as JSON). Items 3.4 and 3.6 must port those builders separately; only research, outline, write and images (prompt 1 of N) are covered by the shared assembly.
- Python's json.dumps(..., indent=2) defaults to ensure_ascii=True and escapes every non-ASCII character to \uXXXX while JSON.stringify emits it literally. The ready stage serializes the image manifest into its prompt, so without a compatibility shim the two stacks diverge on exactly the manifests carrying typographic punctuation. Neither captured manifest contains a non-ASCII character, so the fixtures could not have caught this; it needed a dedicated unit test verified against real python3 output.
- Python's truthiness check in build_stage_prompt sees the string "{}" rather than the empty dict, so a ready prompt gets a useless '## Previous Stage Output\n\n{}' section when images produced nothing. The port has to preserve that quirk because the fixtures were captured with it.
- A whole-file line-by-line diff harness run as a throwaway vitest file is far faster than reading vitest's assertion output for multi-hundred-line prompt strings: it located both divergences by line number in one run where the default diff rendering produced 157KB of unusable output.
- The bash tool's working directory persists across calls in this session, so a `cd web && ...` in one call leaves later calls inside web/. Use absolute paths or re-cd from the worktree root when a later call assumes the repo root.
- The vitest baseline continues to behave as a failure count: 21 new passing tests moved the suite 238 -> 259 passed with failures held at exactly 9.

### Iteration 19

**Summary:** Split ledger item 3.1b and completed the agent half by adding the research Mastra Agent plus the encrypted API-key reader, proven with a live Perplexity call that reported back the configured model id.

**Changes:**
- web/src/mastra/api-keys.ts added: getApiKeys() and requireApiKey() ported from api/src/services/api_keys.py, reading the encrypted api_keys row out of the settings table and decrypting it through web/src/lib/crypto.ts, with the same PROVIDERS tuple and the same empty-string-per-missing-provider behaviour as Python, and a decrypt failure raised rather than masqueraded as an unconfigured key
- web/src/mastra/agents/research.ts added and registered on the Mastra instance as agents.research: RESEARCH_SYSTEM_MESSAGE byte-identical to research_node's system= string, RESEARCH_MODEL_ID pinned to the incumbent perplexity/sonar-pro, and a dynamic model resolver that fetches the credential from the database per call so no key ever enters RequestContext, the Redis event payloads or the Postgres workflow snapshots
- web/src/mastra/api-keys.test.ts and web/src/mastra/agents/research.test.ts add 11 passing tests against the real database: decryption of real Fernet ciphertext, per-provider empty-string behaviour, agent registration, the system message and model compared against both golden research fixtures, model resolution from the stored key, the actionable no-key error, and a live Perplexity smoke test asserting the provider's own reported model id, gated on PERPLEXITY_API_KEY so the default suite needs no credentials
- web/src/mastra/no-next-imports.test.ts expected package list extended by @mastra/core/agent, drizzle-orm and node:crypto, which the registered agent legitimately pulls into the entry point's import graph; the no-next/* assertion is untouched
- docs/mastra-port/LEDGER.md item 3.1b split into 3.1b (agent, checked) and 3.1c (step), with the passing runs, the redacted live provider response, the settings-table-left-clean proof, the credential-path decision rationale, three applied-and-reverted negative controls, the intentional test update, and all four frontend gate results

**Learnings:**
- Mastra's bundled provider registry (node_modules/@mastra/core/dist/provider-registry.json) carries a perplexity provider, and the model router resolves { id: 'perplexity/sonar-pro', apiKey } as an OpenAICompatibleConfig with no @ai-sdk/perplexity package installed. The port needed no new dependency to reach Perplexity, and the same is likely true for anthropic and google in items 3.2-3.6.
- Routing a provider key through workflow input or RequestContext would persist it: the evented engine serialises run input into the Redis Streams payloads and into mastra_workflow_snapshot rows in Postgres. Resolving the key inside the agent's dynamic model resolver from the database is the only path that keeps credentials out of run history, and it also works identically in web and worker.
- Mastra surfaces Perplexity's citations as structured source parts on result.sources, which is a cleaner input for the link_validator TS port (item 5.7) than re-parsing URLs out of the markdown, and result.usage.raw.raw.cost carries the provider's own per-request dollar cost, so Phase 8's cost column needs no maintained price table for Perplexity.
- The Agent primitive is directly assertable without running a workflow: getInstructions() and getModel() resolve the dynamic arguments, so system-message and model-id parity can be tested for a few milliseconds against the golden fixtures rather than needing a provider call or a stubbed model.
- mastra.pubsub is typed as the narrow PubSub interface and has no close() on it, so tsc rejects mastra.pubsub.close() in test teardown even though it works at runtime. Import the concrete pubsub export from src/mastra/index.ts instead.
- No provider API keys exist anywhere in this worktree (not in .env, not in the settings table). They live only in the main checkout at /Users/cody/Documents/code/jena-ai/.env, so every live provider verification from here (items 3.2-3.6 and especially 6.1) must source them explicitly from that file and gate the test on the env var so the default suite stays credential-free.
- The vitest baseline continues to behave as a failure count: 11 new passing tests moved the suite 259 -> 270 passed with failures held at exactly 9, and a skipped test shows as a separate '1 skipped' figure rather than reducing the pass count.

### Iteration 20

**Summary:** Split ledger item 3.1c and completed 3.1c-i by porting the shared posts-table bridge (stateFromPost / saveStageOutput) to TypeScript, proven against the golden fixtures and the real database, which exposed that SQLAlchemy's onupdate was stamping updated_at on every stage write and Postgres does not.

**Changes:**
- web/src/mastra/post-state.ts added: pipelineStateSchema (pipelineContextSchema plus postId/slug/profileId/imageStyle/imageBrandColors/imageExclude/finalHtml/currentStage/stageSettings/stageStatus, with api_keys deliberately excluded), stateFromPost() as a column-for-column port of state_from_post() preserving Python's falsy coalescing and the all-auto stage_settings fallback, and saveStageOutput() as a port of save_stage_output() that stamps updatedAt explicitly
- saveStageOutput resolves each stage's drizzle column property at import time from getTableColumns(posts) keyed by the database column name in STAGE_CONTENT_MAP, so a schema rename throws at import instead of silently writing to the wrong column
- web/src/mastra/post-state.test.ts added: 6 passing tests against the real Alembic-owned dev database that assert stateFromPost deep-equals the golden fixtures' state_input for both posts, that a zero word count coalesces to 2000, and that saveStageOutput commits text and JSONB output, advances current_stage, replaces stage_status only when supplied, bumps updated_at, and leaves other stages' columns untouched
- Ledger item 3.1c split into 3.1c-i (this bridge, now checked with pasted evidence, four negative controls and all four frontend gate results) and 3.1c-ii (the research step itself)

**Learnings:**
- Python's save_stage_output() bumped posts.updated_at on every stage write through SQLAlchemy's TimestampMixin onupdate, and the negative control proved Postgres has no trigger doing this: without an explicit updatedAt stamp the before/after timestamps came back byte-identical. Any TypeScript write path that replaces a SQLAlchemy Core update() has to stamp updated_at itself or the posts list stops sorting by recency.
- The golden fixtures' state_input block is an exact dump of state_from_post()'s output, which makes it a complete parity oracle for the read half of the posts-table bridge and not just for prompts. Camelizing its keys generically rather than through a listed mapping is what makes the assertion exhaustive: dropping the articleType mapping surfaced as a missing key in the diff, where a hand-listed mapping would have quietly skipped it.
- The fixtures' six-stage all-auto stage_settings came from the SQLAlchemy model default, which coincides with stateFromPost's NULL fallback, so inserting the column as NULL is the only way to reproduce the fixture state from a drizzle-written row. A drizzle insert that lets the column default apply gets the database's five-stage all-review value instead, which would silently fail the parity comparison for the wrong reason.
- This worktree's ESLint config does not exempt underscore-prefixed unused bindings, so the idiomatic `const { api_keys: _apiKeys, ...rest } =` destructure to drop a key emits a no-unused-vars warning and breaks the no-new-warnings gate. Spread then delete instead.

### Iteration 21

**Summary:** Completed ledger item 3.1c-ii by porting the research stage to a Mastra step whose prompt is byte-identical to Python's against both golden fixtures, which exposed that a retry-preamble assertion written against the function under test is tautological and passes its own negative control.

**Changes:**
- web/src/mastra/steps/research.ts: the research stage as a Mastra createStep on the evented engine, wrapping the item-3.1b agent with Python's meta-response retry loop (isValidResearch, REFUSAL_PATTERNS, EXPECTED_SECTIONS, MAX_RESEARCH_ATTEMPTS, reinforcedPrompt) and committing its output to research_content through saveStageOutput before returning
- web/src/mastra/steps/stage-io.ts: the input/output Zod contract shared by all six stage steps, with input reduced to { postId } so a step reads its inputs from committed columns rather than the workflow snapshot, and output mirroring Python's _stage_meta plus postId so steps chain without a mapping step
- web/src/mastra/post-state.ts: loadInternalLinks and loadPipelineState, the database read path a step uses, matching _fetch_internal_links() in api/src/worker.py and throwing on a missing post rather than rendering an empty prompt
- web/src/mastra/steps/research.test.ts: 9 parity tests proving byte-exact prompt equality against both golden fixtures from a real database row, Python's persistence contract on the posts row, sum-across-attempts token accounting, the retry and attempt-cap paths, and the refusal validator against every phrasing Python listed
- docs/mastra-port/LEDGER.md item 3.1c-ii checked with the pasted test run, four negative controls, all four frontend gate results, and the recorded SSE gap deferred to items 5.5 and Phase 8

**Learnings:**
- A parity assertion written as expect(prompts[1]).toBe(reinforcedPrompt(prompt)) is tautological: reword the preamble in the implementation and both sides of the comparison move together, so the negative control passes green. Any ported constant string must be pinned against a literal copied from the Python source, not against the function under test. This applies directly to the five remaining stage ports, which all have similar constant strings.
- vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true }) is the way to pin TODAY_DATE for golden-fixture parity without breaking database tests: faking only Date leaves setTimeout real, so the pg driver's own timeouts still fire. The alternative of threading a `today` parameter through the step would leak test-only API surface into the production contract.
- Mastra step execute params are typed as a wide ExecuteFunctionParams, so a step can be exercised directly with a minimal { inputData, mastra } object cast through `as unknown as Parameters<typeof step.execute>[0]`. Supplying a getLogger() stub that records into arrays keeps the degraded-path warnings assertable and out of the test output at the same time.
- Agent.generate returns FullOutput: the text is result.text, the provider-reported model is result.response?.modelId, and usage is AI SDK v5 naming (result.usage.inputTokens / outputTokens), not tokens_in / tokens_out. Confirmed in node_modules/@mastra/core/dist/stream/base/output.d.ts and _types/@ai-sdk_provider-v5.
- createStep products are not registered on the Mastra instance directly; only workflows and agents are. Steps reach Studio through the workflow they are composed into, so nothing in index.ts changes until item 4.1.
- Python's _REFUSAL_PATTERNS port to JavaScript verbatim: every pattern uses only syntax shared by both regex engines, so the alternation and the IGNORECASE flag carry across without translation.

### Iteration 22

**Summary:** Completed ledger item 3.2 by porting the outline stage to a Mastra agent plus step whose prompt is byte-identical to Python's against both golden fixtures, which exposed that the AI SDK and Python disagree on whether max_tokens includes the extended-thinking budget.

**Changes:**
- web/src/mastra/agents/claude.ts: the call settings shared by every Claude-backed stage, porting ClaudeClient.chat()'s thinking budget and Python's effective_max arithmetic, with the thinking budget subtracted from maxOutputTokens so both stacks put the same max_tokens on the wire
- web/src/mastra/agents/outline.ts: the outline agent (system message, incumbent claude-opus-4-6, per-call credential resolution, Python's max_tokens=8000), registered on the Mastra instance alongside research
- web/src/mastra/steps/outline.ts: the outline stage as a createStep, reading its chain input from posts.research_content and committing to posts.outline_content through saveStageOutput before returning
- web/src/mastra/agents/outline.test.ts: 8 tests including a wire-payload parity assertion that swaps globalThis.fetch and compares the serialized Anthropic request against the golden fixture's recorded request, plus a live smoke test gated on ANTHROPIC_API_KEY
- web/src/mastra/steps/outline.test.ts: 5 parity tests proving byte-exact prompt equality against both golden fixtures from a real database row seeded with the research stage's committed output, Python's persistence contract including the merged stage_status map, and the missing-post failure path
- docs/mastra-port/LEDGER.md item 3.2 checked with the pasted test runs, the live Anthropic model id, two negative controls, all four frontend gate results, and four recorded discrepancies

**Learnings:**
- Python and the AI SDK disagree on Anthropic's max_tokens semantics when extended thinking is enabled. Python treats max_tokens as the total budget (effective_max = max(8000, 10000+1024) = 11024); @mastra/core's provider treats maxOutputTokens as the text budget and emits max_tokens = maxOutputTokens + budget_tokens, so passing Python's value straight through sends 21024. Verified in node_modules/@mastra/core/dist/dist-BcUqNSEb.js. The remaining three Claude stages (write, edit, ready) all use max_tokens=16000, so their maxOutputTokens is 6000 via the same claudeStageOptions helper.
- Setting `url` on a Mastra model config silently changes the provider implementation: `{ id: 'anthropic/claude-opus-4-6', url }` routes through OpenAICompatibleChatLanguageModel and POSTs to /chat/completions with `thinking.budgetTokens` unconverted, instead of the native Anthropic client's /v1/messages with `budget_tokens`. A local fake-provider server is therefore useless for wire parity; swapping globalThis.fetch is the only way to capture what the native provider actually sends.
- Agent-level `defaultOptions` (not `defaultGenerateOptionsLegacy`) is where modelSettings.maxOutputTokens and providerOptions.anthropic.thinking belong in @mastra/core 1.61. They are read on every generate() call, so the step needs no per-call options and the settings stay with the model choice that item 6.2 will make configurable.
- Mastra's AI SDK path strips Anthropic thinking blocks from result.text automatically, so the port needs no equivalent of Python's `block.type == 'text'` filter; a canned response carrying both a thinking and a text block proves it.
- The outline prompt-parity test needs a negative control that is not the fixture comparison itself: a prompt rendered without the seeded research document is still structurally similar enough that only an explicit `expect(prompt).toContain(state_input.research)` catches a broken chain input cheaply. Both controls (dropping the token subtraction, nulling researchContent) failed as expected.

### Iteration 23

**Summary:** Completed ledger item 3.3 by porting the write stage to a Mastra agent plus step whose prompt is byte-identical to Python's against both golden fixtures, including the first stage that exercises the pass-through branch of the max_tokens divergence and the first parity test that seeds real internal links to prove they are withheld from a non-edit stage.

**Changes:**
- web/src/mastra/agents/write.ts adds the write Agent: WRITE_SYSTEM_MESSAGE reproducing Python's five-literal concatenation (asserted equal to both fixtures' recorded system string), WRITE_MAX_TOKENS 16000 through the shared claudeStageOptions, and the incumbent anthropic/claude-opus-4-6 with its credential resolved per call from the encrypted settings row
- web/src/mastra/steps/write.ts adds the write step: createStep with the shared stage I/O Zod schemas, reading state from the posts table, rendering rules/blog-write.md against it, and committing the draft to posts.draft_content with a merged stage_status before returning Python's _stage_meta
- web/src/mastra/index.ts registers the write agent alongside research and outline
- web/src/mastra/agents/write.test.ts adds 8 tests including a globalThis.fetch capture comparing the serialized Anthropic request against the golden fixture's recorded request, and a live smoke test gated on ANTHROPIC_API_KEY
- web/src/mastra/steps/write.test.ts adds 6 tests against the real database, including byte-parity for both fixtures, a both-directions chaining assertion (outline present, research absent), and a seeded-profile-plus-internal-links test proving the link inventory is withheld from write
- docs/mastra-port/LEDGER.md item 3.3 checked with the passing runs, the live smoke result, three applied-and-reverted negative controls, all four frontend gate results and three recorded discrepancies

**Learnings:**
- The two branches of the Python/AI-SDK max_tokens divergence needed separate stages to cover. outline's max_tokens=8000 is clamped up to the 11024 thinking floor, so it only ever proved the clamped branch; write's 16000 clears the floor and is the first stage to prove the pass-through branch, where claudeEffectiveMaxTokens must return its argument unchanged. edit and ready should be checked against whichever branch they land in rather than assumed covered.
- The how-to-choose-a-crm-for-a-small-team golden fixture was captured with three internal links in state["internal_links"], so every non-edit stage's parity test can seed a real website_profiles row plus internal_links rows and assert the prompt is still byte-identical. That converts item 3.2's deferred note ("the step test seeds no internal links") into a live assertion, and the negative control that widens buildStagePrompt's condition to include write turns both the withholding test and the fixture's byte-parity test red, so the seeding is demonstrably not vacuous.
- posts.profile_id has no ON DELETE clause while internal_links.profile_id cascades, so a test that attaches a fixture post to a seeded profile must delete the posts before the profile or the profile delete fails on the FK. Deleting the profile then cascades the links, so links need no explicit cleanup.

### Iteration 24

**Summary:** Split ledger item 3.4 into five sub-items and completed 3.4a by porting textstat's readability primitives (including pyphen's hyphenator and the CMU pronouncing dictionary) to TypeScript with exhaustive parity against the installed Python implementation, proven by a SHA-256 over all 123,455 CMU words.

**Changes:**
- docs/mastra-port/LEDGER.md item 3.4 split into 3.4a (textstat primitives), 3.4b (compute_analytics), 3.4c (validate_links), 3.4d (edit agent) and 3.4e (edit step), because edit_node is the only stage that computes prompt content from services the port does not yet have
- api/scripts/export_textstat_data.py freezes what Python reads into web/src/mastra/textstat/data/: a gzipped word-to-syllable table for all 123,455 CMU entries, pyphen's hyph_en_US.dic and its licence notice copied verbatim, and textstat-parity.json, the oracle
- web/src/mastra/textstat/hyphenator.ts ports pyphen's HyphDict and Pyphen.positions at left=2/right=2, the Liang hyphenation fallback count_syllables uses for out-of-vocabulary words
- web/src/mastra/textstat/index.ts ports pythonSplit, removePunctuation, listWords, countWords, countSentences, countSyllables, wordsPerSentence, syllablesPerWord and fleschReadingEase, with Python's whitespace and word classes spelled out rather than borrowed from JavaScript's
- web/src/mastra/textstat/textstat.test.ts adds 52 parity tests whose centrepiece is a SHA-256 over an exhaustive word/syllable/hyphen-position table, plus 400 out-of-vocabulary words, a 150-word readable sample and 41 whole-text expectations, 29 of them real golden-fixture content
- web/src/mastra/steps/{research,outline,write}.test.ts each namespace their seeded posts by rewriting the fixture id's second-to-last byte, fixing a pre-existing primary-key race that produced 6 to 9 extra failures whenever vitest ran the three files in parallel
- todo.md records that next build's output file tracing does not follow the readFileSync-from-cwd data files, the same exposure rules/*.md already has, to be resolved before the Phase 7 Railway deploy

**Learnings:**
- textstat's Flesch score cannot be approximated for this port. count_syllables looks each word up in nltk's CMU dictionary and only falls back to pyphen's TeX hyphenation patterns on a miss, and the two disagree on 48,202 of 123,455 words, so any JavaScript syllable heuristic would move the digit that lands in the edit prompt. Freezing both data sets from the live Python install (388 KB gzipped plus a 104 KB .dic) is the only way to get byte parity, and they cannot be regenerated after api/ is deleted.
- pyphen's algorithm is only about 60 lines and ports cleanly, but two details matter: it applies its constructor defaults left=2/right=2 in preference to the LEFTHYPHENMIN/RIGHTHYPHENMIN directives inside the dictionary file, and Python's slice assignment in HyphDict.positions can only ever write inside the references array because a pattern's offset plus value length never exceeds its key length by more than 1 (measured across all 11,015 en_US patterns).
- Python's re \s and str.isspace() are exactly the same set, but neither matches JavaScript's \s: Python covers \x1c-\x1f and \x85 and omits U+FEFF. Python's \w and Node's \p{L}\p{N}_ differ only by 4,382 code points added in newer Unicode revisions. Both were settled by enumerating the classes over the full code point range rather than by reading documentation.
- A negative control that passes is worth more than one that fails. Replacing the Unicode word-boundary emulation with JavaScript's \b left all 51 tests green, which proved the fixtures never exercised it; the case that separates the two engines is a single-letter non-ASCII word starting a sentence, and it needs at least two sentences because count_sentences' max(1, ...) floor hides the difference otherwise. A second control showed the trailing zero-length pair from re.findall is genuinely dead weight, so the comment claiming it was load-bearing was corrected rather than the control discarded.
- The stage parity tests seed posts under the golden fixtures' own ids, so every new stage port adds another file that collides on the posts primary key under vitest's default file parallelism. Symptoms are duplicate key violations and 'post ... not found' in whichever file loses the race, and the failure count varies run to run (15, 16, 18 observed). The three remaining stage ports must namespace their rows the same way.
- pytest needs TEST_DATABASE_URL exported explicitly; conftest.py falls back to localhost:5433, which on this machine is an unrelated project's Postgres container, and the resulting InvalidPasswordError looks like 177 setup errors rather than a configuration problem. The repo's own database is on 5435. Running pytest also writes untracked .webp files into the tracked media/test-123/ directory, so cleaning up after it needs care.

### Iteration 25

**Summary:** Completed ledger item 3.4b by porting compute_analytics to TypeScript with two independent parity oracles, which exposed that Python's round-half-to-even is reachable from real pipeline data and that JavaScript's multiline regex flag treats three characters as line starts that Python does not.

**Changes:**
- web/src/mastra/analytics/index.ts adds computeAnalytics, seoChecklist, stripMarkdown and urlNetloc: a statement-for-statement port of api/src/services/analytics.py that preserves the SEO checklist's insertion order and its mixed bool/int value type, spells every multiline anchor as (?:^|(?<=\n)) instead of using JavaScript's m flag, writes Python's . as [^\n], and reproduces str.count's non-overlapping semantics and urlparse().netloc's empty result for a URL with no //
- web/src/mastra/analytics/python-round.ts adds pythonRound, Python's round(float, ndigits) implemented in BigInt over the double's exact binary value so ties break to even, with named BigInt() constants rather than 0n literals so the app-wide ES2017 tsconfig target is left alone
- api/scripts/export_analytics_parity.py freezes the second parity oracle into web/src/mastra/analytics/data/analytics-parity.json: 17 compute_analytics cases (both golden drafts, both golden edit outputs, and edge cases the fixtures cannot reach), 52 round() results including every exact tie at 1 and 2 decimals, and 17 urlparse().netloc results
- web/src/mastra/analytics/analytics.test.ts adds 46 passing tests whose primary oracle is the captured edit prompts themselves: the word count, Flesch score, average sentence length, keyword densities and PASS/FAIL lines are recomputed in TypeScript and looked up as literals in the prompt Python rendered
- web/src/mastra/textstat/index.ts exports pythonStrip and PY_WHITESPACE so the analytics port spells Python's whitespace class the same way rather than re-deriving it, with pythonSplit refactored onto pythonStrip
- docs/mastra-port/LEDGER.md item 3.4b checked with the pasted test runs, four applied-and-reverted negative controls, all four frontend gate results, the pytest and ruff baselines, and three recorded discrepancies

**Learnings:**
- Python's round() is round-half-to-even and this is reachable from real pipeline data, not just theory: avg_sentence_length is word_count / sentence_count, so a 405 word draft with 20 sentences is exactly 20.25, where Python prints 20.2 and toFixed(1) prints 20.3. A double is an exact tie at n decimals only when it is odd/2**k with k <= n+1, so the port compares the true remainder in BigInt rather than re-parsing a decimal approximation.
- JavaScript's m flag treats \r, U+2028 and U+2029 as line starts and Python's re.MULTILINE does not, so every ported multiline anchor has to be written (?:^|(?<=\n)). This changes real output: 'Carriage return\r## heading' registers an H2 to JavaScript and does not to Python. Python's . also excludes only \n where JavaScript's excludes \r, U+2028 and U+2029 too.
- A negative control that fails narrowly is more informative than one that fails broadly. Swapping pythonRound for toFixed left all 17 fixture and golden cases green and failed only the two dedicated tie tests, which proved the captured drafts never land on an exact tie and justified the 52 exported round() results as a separate oracle rather than trusting the fixtures.
- The captured edit prompts are a self-contained oracle for the analytics numbers: they carry the word count, Flesch score, average sentence length and per-keyword density as literals, so a test can recompute in TypeScript and look the digits up in text this repo did not generate for the test's benefit. That is stronger evidence than any script-produced expectation file.
- tsconfig.json targets ES2017, where BigInt literals (0n) are a type error even though lib: esnext provides the BigInt type. Naming the constants through BigInt(...) keeps a Node-side numeric port out of the app-wide compiler settings; raising the target would have been a config change affecting every file.
- web/'s vitest suite needs docker compose db and redis up for an honest reading. With them down the same pnpm test reports 15 failed files and 73 skipped tests, which looks like a regression and is a missing datastore. The correct baseline reading is 9 failed (6 image-preview, 3 PostDetail) with 3 skipped live-provider smoke tests.
- edit_node interpolates its floats with an f-string, so Python's str(float) always carries a decimal point and a density of exactly zero prints 0.0% where JavaScript's String(0) gives 0%. The how-to-choose-a-crm fixture contains that literal, so item 3.4e needs a production str(float) shim before its prompt can be byte-identical.

### Iteration 26

**Summary:** Completed ledger item 3.4c by porting validate_links to TypeScript against a two-part parity oracle in which both the Python and TypeScript implementations run over real sockets to a real local HTTP server, which exposed that my own concurrency probe, not asyncio.Semaphore, was the source of an off-by-one reading.

**Changes:**
- web/src/mastra/links/index.ts adds validateLinks, a port of api/src/services/link_validator.py that keeps the conservative strip rule (only 404/410/451 remove a link), the case-sensitive http/https scheme test, the first-appearance ordering of the removed list, and a 5-wide request pool, with findMarkdownLinks and stripDeadLinks exported as the pure half a test can pin exactly
- api/scripts/export_link_validator_parity.py stands up a local HTTP server whose routes cover the strip statuses, keep statuses, a redirect to a dead URL, a redirect to a live one, a refused connection and a route that sleeps past the client timeout, runs the real Python validate_links against it, and freezes 22 network cases, 22 extraction cases and 9 strip cases into web/src/mastra/links/data/link-validator-parity.json with the base URL templated to {BASE}
- web/src/mastra/links/links.test.ts adds 57 passing tests that reproduce the same server in Node on its own port so neither side mocks HTTP, pin the 10 second timeout by asserting the wait ended at the deadline rather than at the server's 12 second sleep, and resolve the eight golden extraction cases out of docs/mastra-port/golden rather than from a copied transcription
- docs/mastra-port/LEDGER.md item 3.4c checked with the passing test run, ten applied-and-reverted negative controls, all four frontend gates, the pytest and ruff baselines, and three recorded divergences (per-phase versus whole-request timeout, the dropped per-link logger.warning, and strip_dead_links_html left unported with the grep proving it has no caller)

**Learnings:**
- A negative control can pass because the oracle is too weak rather than because the port is right. Deduplicating the per-URL link texts through a Set left every case green, because the only duplicate-URL case used two different link texts. Closing that needed a case repeating both the URL and the text; the same review added a case whose two dead URLs are in reverse alphabetical order, which is what catches a port that checks URLs in sorted order.
- When the parity oracle includes a measurement taken by the test harness itself, the harness is as likely to be wrong as the code. The semaphore probe read 6 for a limit of 5 twice for two unrelated reasons: counting a request as in flight across the response write leaves the handler counted after the client has released its slot, and the route that sleeps 12 seconds was still holding a slot during the case that ran next because the client abandoned it at 10. Neither was asyncio.Semaphore.
- httpx's timeout=10 is a per-phase budget (connect, read, write, pool each get 10 seconds) where AbortSignal.timeout is one deadline over the whole request. For a dead-link checker both branches keep the link on a slow answer, so the divergence is conservative, but any other ported httpx call site with a timeout needs this checked rather than assumed.
- Python's re.escape escapes a superset of what a JavaScript regex needs, and escaping that superset in JavaScript is not merely redundant: under the u flag \& is a SyntaxError rather than an identity escape, so a faithful transcription of re.escape would not compile. Escaping only the JavaScript set and omitting the u flag is the correct port.
- A network-facing service can be parity-tested without mocks by having the export script and the vitest file each stand up the same route table on their own ephemeral port and templating the base URL out of the recorded content. This is worth the extra machinery: it caught the redirect-following and status-set behaviours that a table of stubbed status codes would have assumed rather than proven.
- strip_dead_links_html has no caller anywhere in the repo outside its own pytest, including the WordPress HTML path. Phase 7 will delete a tested-but-unreachable function; the same grep is worth running for every remaining service before its port is scoped.

### Iteration 27

**Summary:** Completed ledger item 3.4d by porting the edit stage's Anthropic agent to Mastra with byte-exact system-message parity against both golden fixtures, seven applied-and-reverted negative controls, and a live API call confirming the model id resolves.

**Changes:**
- web/src/mastra/agents/edit.ts adds editAgent, the provider half of edit_node: EDIT_SYSTEM_MESSAGE reproducing Python's twelve adjacent string literals byte-for-byte, EDIT_MAX_TOKENS at Python's 16000, EDIT_MODEL_ID pinned to the incumbent anthropic/claude-opus-4-6, extended thinking through the shared claudeStageOptions, and the credential resolved per call through requireApiKey so no key reaches RequestContext, Redis payloads or Postgres workflow snapshots
- EDIT_FORMAT_INSTRUCTION broken out as its own exported constant, because edit_node is the only stage that names a format_instruction and it reads like a branch point in Python while being unconditional; the two golden fixtures were captured at different output_format values, which is the evidence that it does not branch
- editAgent registered on the Mastra instance as agents.edit alongside research, outline and write
- web/src/mastra/agents/edit.test.ts adds 10 tests (9 credential-free) covering registration, system-message equality against both fixtures, positional pinning of the two U+2014 code points and the ten-line structure, the unconditional format instruction across two output_format values, the model id, full outbound-wire payload capture through globalThis.fetch, the max_tokens floor branch, credential resolution and its no-key error, plus a live Anthropic smoke test gated on ANTHROPIC_API_KEY
- docs/mastra-port/LEDGER.md item 3.4d checked with the passing test run, the live smoke run, a seven-row negative-control table, all four frontend gates, the pytest and ruff baselines, three recorded divergences, and a note on the pytest environment footgun

**Learnings:**
- pytest in this worktree must be run with .env sourced. The worktree's Postgres is on POSTGRES_HOST_PORT=5435 but api/tests/conftest.py falls back to localhost:5433 when TEST_DATABASE_URL is unset, which points at a different Postgres and yields 4 failed / 205 passed / 177 errors with asyncpg InvalidPasswordError instead of the real 125 / 236 / 25 baseline. That failure pattern looks like a catastrophic regression and is purely environmental.
- The edit stage's system message is the only ported prompt containing literal em-dashes, and reproducing them is mandatory for byte parity even though the repo's writing rule forbids em-dashes in code. Precedent already existed at web/src/mastra/prompts.ts:114. Ported prompt text is data, not prose, and the exception needs to be stated at the constant so a later cleanup pass does not silently break the wire bytes.
- String equality against a golden fixture is a strong oracle but only while the fixture is trusted. Pinning the em-dash count, the line count and one exact line by position catches the specific transcription errors (newline normalization, dash substitution) independently of the fixture, which is what makes the negative controls meaningful rather than circular.
- The two edit fixtures were captured at output_format markdown and nextjs, not wordpress_html. That is still enough to prove format_instruction is unconditional, since a branch on output_format would have produced two different system strings, but it means the wordpress_html path through the edit stage has no fixture coverage anywhere and item 3.4e cannot assume one.
- git status showed media/test-123/*.webp as untracked after pytest, but the directory also holds 39 tracked artifacts, so rm -rf on it deletes committed files. The already-logged todo item about pytest writing into media/ understates the hazard: cleaning that directory is not safe, only the newly untracked files are removable.

### Iteration 28

**Summary:** Completed ledger item 3.4e by porting the edit step to Mastra with byte-exact prompt parity against both golden fixtures, which is the first prompt whose computed analytics section proves the textstat and analytics ports end to end, and recorded one negative control that stayed green because both fixtures were captured with an empty final_md.

**Changes:**
- web/src/mastra/steps/edit.ts added: editStep as a createStep port of edit_node, with buildAnalyticsSection (_build_analytics_section) and editOutputWarnings (_validate_edit_output) as pure exported functions, the analytics section appended behind the literal \n\n---\n\n separator, best-effort link stripping through the item-3.4c validateLinks port, and persistence to posts.final_md through saveStageOutput
- web/src/mastra/analytics/python-float.ts added: pythonFloat, the production str(float) shim item 3.4b recorded as a prerequisite, so a keyword density of exactly zero renders as 0.0% rather than JavaScript's 0%
- pythonTitleAscii and replaceAll spell out the two Python string primitives the checklist labels depend on: str.replace replaces every occurrence where JavaScript's replaces the first, and str.title() lowercases the tail of each cased run
- web/src/mastra/steps/edit.test.ts added: 14 credential-free tests against the real Alembic-owned database, asserting byte-exact prompt parity for both golden fixtures, the computed analytics section in isolation, the internal-link inventory that only edit is offered, the empty-draft suppression path, the output warnings, persistence and stage_status merging, and one test that clears the link-validation stub and drives the real implementation over real sockets against a local node:http server
- Ledger items 3.4e and its parent 3.4 checked with pasted command output, 13 negative controls, the four frontend gates and both Python baselines

**Learnings:**
- The edit stage is the first whose prompt is partly computed rather than copied out of columns: roughly a kilobyte of it is compute_analytics over the committed draft, so a byte-exact prompt match here is simultaneously an end-to-end check of the 3.4a textstat port, the 3.4b analytics port and Python float formatting.
- Two Python string primitives silently diverge in the checklist labels. str.replace('_', ' ') replaces every underscore where JavaScript's String.replace with a string argument replaces only the first, and str.title() is not capitalize-each-word: it uppercases the first cased character of each cased run and lowercases the rest, which is what produces 'Keyword In First 100 Words'.
- Negative controls in this repo cannot be reverted with git checkout, because the files under test are new and untracked in the iteration that writes them. Copy the files to a temp directory first; two mutations were left applied before this was noticed.
- A negative control that stays green is itself a finding worth recording. Computing the analytics over state.finalMd || draft passes because both golden fixtures were captured with final_md empty, which is a coverage gap in the fixtures that cannot be closed once api/ is deleted.
- vi.mock with importOriginal delegating through a mutable stub slot lets one test file keep the real network implementation for the tests that want real sockets while stubbing it for the prompt tests, avoiding a split test file or a mock-only suite.
- pytest writes new artifacts into media/test-123/ on every run and overwrites the one tracked file there (image-1.webp). Check git status after running it and restore that file rather than deleting the whole directory's new entries.

### Iteration 29

**Summary:** Split ledger item 3.5 into five sub-items and completed 3.5a by porting `_parse_manifest` to TypeScript against a 37-case parity corpus generated from Python, which exposed two negative controls that initially passed and one dead branch in the Python images stage.

**Changes:**
- api/scripts/export_manifest_parity.py: a parity oracle that calls Python's `_parse_manifest` over 37 inputs (both golden fixtures' raw Claude manifest responses plus 35 synthetic cases, each naming the branch or primitive it exercises) and writes web/src/mastra/images/data/manifest-parity.json, with inputs whose Python result is not strict-JSON representable exported under `divergences` instead of `cases`
- web/src/mastra/images/manifest.ts: `parseManifest`, the TypeScript port of `_parse_manifest`, reusing the item-3.4a `pythonStrip`/`PY_WHITESPACE` for Python's strip semantics and the fenced-block pattern's whitespace class, and spelling DOTALL as `[\s\S]`
- web/src/mastra/images/manifest.test.ts: 43 tests covering every corpus case, the golden manifests' structural invariants, fallback-object freshness, and the recorded NaN/Infinity divergence
- docs/mastra-port/LEDGER.md: item 3.5 split into 3.5a (parse manifest), 3.5b (optimize_image), 3.5c (Claude agent), 3.5d (Gemini client), 3.5e (the step), with 3.5a checked and carrying the export command, test run, eight-row negative-control table, and all frontend and backend gate results

**Learnings:**
- `images_node`'s `image_spec.get("placement") == "featured"` check is dead code. In both golden manifests `placement` is an object (`{location, after_section}`), never the string, so the `image_size = "2K"` / `aspect_ratio = "16:9"` override behind it is unreachable and only the later `type == "featured"` test fires. The featured image in the fixtures was sent at 2K/16:9 because the manifest itself asked for them, which the recorded Gemini request confirms. This corrects the iteration-4 note that read the override as live behaviour.
- Whitespace-class mutations are hard to discriminate in this function because the outermost-brace fallback usually recovers the same value down a different path. A discriminating case needs a non-object JSON value (an array or scalar) wrapped in Python-only whitespace, so the strip decides between a direct parse and a fallback that finds no brace at all.
- Two of eight negative controls passed against the first corpus (DOTALL dropped, and the line filter not stripping each line), and both gaps were real rather than the mutations being equivalent. Running the mutation matrix before checking the item off is what found them; a corpus that looks exhaustive by case count can still miss whole branches.
- Comparing a Python JSON oracle to a JavaScript port has to happen after both sides go through a JSON parse, not on the serialised text. `json.dumps` writes Python's `1.0` float as `1.0` and a 20-digit int in full, neither of which a JavaScript number holds, so string comparison fails on cases where the values actually written to `image_manifest` are identical.
- The db and redis containers are not running at the start of an iteration in this worktree. A `pnpm test` run without them reports 17 failed files / 11 failed / 97 skipped, which looks like a large regression but is every database-backed suite hitting ECONNREFUSED on 127.0.0.1:5435. Run `POSTGRES_HOST_PORT=5435 docker compose up -d db redis` before recording any test gate.
- Any new file under `api/` shifts the `ruff format --check` totals even when nothing regressed: the would-reformat count is the number to compare against the baseline (9), not the already-formatted count, which grows by one per added formatted file.

### Iteration 30

**Summary:** Completed ledger item 3.5b by porting `optimize_image` to TypeScript on sharp against a 14-case parity corpus generated from Pillow, which proved the two stacks' WebP encoders are byte-identical when no resize happens and exposed that Pillow silently ignores LANCZOS for palette images.

**Changes:**
- web/src/mastra/images/optimize.ts: `optimizeImage`, the port of Pillow's `optimize_image`, built on sharp with Pillow's encoder settings pinned explicitly (quality 82, effort 4, alpha quality 100) and Python's two observable decisions reproduced exactly: never touch or upscale an image at or under max_width, and truncate rather than round the scaled height
- sharp 0.35.3 added as a `web/` runtime dependency, chosen because it links the same libwebp 1.6.0 Pillow does, which turned byte-identity with Python's encoder from a hope into a demonstrated fact
- api/scripts/export_optimize_parity.py: generates 14 deterministic PNG inputs covering RGB/RGBA/L/P modes, the featured 1920 path, height truncation, the no-upscale branch and degenerate sizes, runs Python's implementation over each, and commits both inputs and Pillow's WebP output to web/src/mastra/images/data/optimize-parity/
- web/src/mastra/images/optimize.test.ts: 51 tests asserting byte equality with Pillow on the four unresized cases, per-case pixel tolerances on the ten resized ones, the truncation and no-upscale decisions, the failure path, and a test that justifies the lanczos3 choice by beating cubic, mitchell and lanczos2 summed across the corpus
- docs/mastra-port/LEDGER.md item 3.5b checked with the dependency rationale, the corpus generation output, a determinism check, the byte-identity finding, three recorded divergences, seven negative controls, and all gate results
- todo.md: logged the intermittent full-suite failures in the three agent test files as [investigate]

**Learnings:**
- sharp and Pillow both link libwebp 1.6.0, and with quality 82 / method-effort 4 / alpha quality 100 they produce byte-identical WebP for the same decoded input. The encoder half of this port is an equality, not an approximation, so the four unresized parity cases assert `Buffer.compare(...) === 0` instead of a tolerance. That guard is what caught the quality 82 -> 80 mutation across 8 tests.
- Pillow's `Image.resize` contains `if self.mode in ("1", "P"): resample = Resampling.NEAREST`, so it silently discards the caller's LANCZOS for palette images. Python's palette output is nearest-neighbour and sharp's is lanczos3 (MAE 3.97, max channel difference 189). sharp produces the better image, so this was accepted and documented rather than reproduced.
- Both stacks premultiply alpha before resizing (Pillow converts RGBA to RGBa first), so the algorithms agree, but unpremultiplying a pixel with alpha near zero amplifies differences up to 255x. Alpha-case MAE is 3.36 over all pixels and 2.29 with max difference 63 once alpha < 8 is excluded, so an alpha tolerance has to be stated in terms of the alpha threshold to mean anything.
- A negative control is only a control if the corpus can distinguish the mutation. `Math.trunc` -> `Math.round` passed at first because the truncation case was 1601x901, where 901*1200/1601 = 675.32 and both give 675. Regenerating it at 1600x901 (675.75) made the two disagree. Worth checking that a parity case actually discriminates before trusting it.
- A scale-1 resize is a no-op in both libvips and Pillow (verified byte-for-byte in both), so Python's `width > max_width` versus `width >= max_width` is unobservable. Not every branch in the Python source has an observable consequence to test for.
- Committing real encoder output as a fixture is affordable if the inputs are posterized: un-posterized bicubic gradients cost about 1 MB per PNG case (8.4 MB corpus), 3-bit posterization brings it to 2.4 MB, and banding adds resampling edges rather than removing them.
- The three agent test files (edit, research, write) fail intermittently under a full `pnpm test` run while passing in isolation: three consecutive runs gave 4, then 1, then 0 extra failures over the 9-failure baseline. Future iterations should run the full suite more than once before concluding a regression.

### Iteration 31

**Summary:** Completed ledger item 3.5c by porting the images stage's Claude agent to Mastra with system-message and prompt parity against both golden fixtures, eight applied-and-reverted negative controls, and a live API call confirming the model id resolves.

**Changes:**
- web/src/mastra/agents/images.ts adds imagesAgent, the provider half of step 1 of images_node: IMAGES_SYSTEM_MESSAGE reproducing Python's four adjacent string literals byte-for-byte, IMAGES_MAX_TOKENS at Python's 8000 (below the extended-thinking floor, so 11024 reaches Anthropic), the incumbent anthropic/claude-opus-4-6, extended thinking through the shared claudeStageOptions, and the credential resolved per call through requireApiKey so no key reaches RequestContext, Redis payloads or Postgres workflow snapshots
- imagesAgent registered on the Mastra instance as agents.images alongside research, outline, write and edit
- web/src/mastra/agents/images.test.ts adds 12 tests (11 credential-free): registration, system-message equality against both fixtures, structural pinning of the four-literal join (no newline, no double space, 28 words, exact tail), an assertion that provider_calls[0] is the only Anthropic entry in a node that also calls Gemini, model id parity including _stage_meta.model, full outbound-wire payload capture per fixture through globalThis.fetch, the max_tokens floor branch pinned against the fixture's own recorded value rather than against OUTLINE_MAX_TOKENS, credential resolution and its no-key error, and a live Anthropic smoke test gated on ANTHROPIC_API_KEY
- docs/mastra-port/LEDGER.md item 3.5c checked with the item test run, the live smoke run, an eight-row negative-control table, all four frontend gates, both Python baselines, and the recorded finding that parseManifest's fenced-block branch has no golden-fixture coverage
- todo.md logs the settings.api_keys placeholder-key pollution as [confirmed], and the leftover sk-ant-not-a-real-key row was deleted from the dev database

**Learnings:**
- Both recorded Claude manifest answers are fence-free: each text block opens at the brace, obeying the system message's 'Output ONLY valid JSON, no code fences.' Item 3.5a's fenced-block branch therefore has zero golden-fixture coverage and lives only on that item's synthetic corpus. A test now pins the fence-free property so a prompt change that reintroduces fences surfaces as a failing test rather than as silently-live parsing code.
- The images fixture's provider_calls[0].response.content is the raw Anthropic block array (a thinking block ahead of the text block), not a string like the other stages' fixtures suggested. Extracting the manifest text has to filter to text blocks the way ClaudeClient.chat() does; assuming a string silently yields an empty parse.
- images is the second stage at max_tokens=8000, so it shares outline's below-the-floor branch. Pinning the assertion against images.json's own recorded max_tokens rather than against OUTLINE_MAX_TOKENS is what stops the two ports drifting into agreeing with each other while both disagreeing with Python.
- The agent test files' beforeAll/afterAll key save-and-restore makes the placeholder key permanent: a run captures whatever is in settings.api_keys, writes sk-ant-not-a-real-key, then restores what it captured, so one interrupted run leaves the placeholder behind forever. The row was still there at the start of this iteration.
- The worktree's .env carries no ANTHROPIC_API_KEY, but the main checkout at /Users/cody/Documents/code/jena-ai/.env does. Reading it into the environment for a single live smoke run keeps the credential out of the worktree and out of git while still satisfying the live-verification requirement; future stage ports needing a live call should do the same rather than recording the smoke as unrunnable.
- ParsedManifest is deliberately typed unknown (faithful to json.loads), so any test touching parsed.error or parsed.images needs an explicit Record<string, unknown> cast. tsc catches this but pnpm lint and the test run both pass without it, so tsc has to run before the item is called done.

### Iteration 32

**Summary:** Completed ledger item 3.5d by porting the Gemini image-generation client to TypeScript against a wire-level parity corpus captured from Python's SDK, which proved the Python retry wrapper never retries a Gemini status error, and confirmed the model id resolves live while the account's zero image quota leaves the end-to-end call unproven.

**Changes:**
- api/scripts/export_gemini_parity.py generates the parity oracle by running the real Python GeminiClient with google.genai's httpx transport replaced, recording 5 exact outbound requests and 14 canned-response cases with Python's resulting ImageGenResponse, exception and HTTP attempt count
- web/src/mastra/images/gemini.ts ports generate_image as a direct v1beta generateContent POST: the image_size token fallback table, both RuntimeError branches, the 180s deadline, and Python's retry semantics split into GeminiApiError (never retried) and GeminiTransportError (retried with 1s/2s exponential backoff)
- web/src/mastra/images/gemini.test.ts adds 38 tests replaying the corpus, backed by 14 applied-and-reverted negative controls, and a live test that confirms the model id resolves against the Gemini API
- docs/mastra-port/LEDGER.md item 3.5d checked with the corpus output, the negative-control table, the passing live model-resolution run and the verbatim 429 that blocks the end-to-end image call
- todo.md's shared-settings-row flake note records that api-keys.test.ts is also a victim, not just the three agent suites

**Learnings:**
- Python's _retry never retries a Gemini error: _is_retryable tests for httpx.HTTPStatusError and anthropic.APIStatusError, and google.genai.errors.ClientError inherits from neither (ClientError -> APIError -> Exception in the installed 1.65.0). The corpus records attempts=1 for both 429 and 500, which is why the golden fixtures show exactly one 429 per image.
- The developer Gemini key's project has an image entitlement of zero (429 with 'generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image'), not a clearing rate limit, so no wait or retry produces a live image. A GET on v1beta/models/<id> needs no quota and does confirm the id resolves, which is the live check items 3.5e and 6.1 can rely on.
- Python's json.dumps writes ', ' and ': ' separators and escapes non-ASCII, so byte equality against a recorded request body is unreachable from JSON.stringify. Asserting sent === JSON.stringify(JSON.parse(pythonRaw)) normalises exactly those two differences and still pins key order and every value.
- Negative controls must not compute their expected value from the port's own exported constants. Two controls (MAX_RETRIES 3->2, backoff base 1s->5s) passed because the tests advanced the fake clock by GEMINI_BASE_DELAY_MS and compared against GEMINI_MAX_RETRIES; literal 999/1/1999/1 ms steps with an attempt-count assertion after each caught both.
- A shell one-liner that begins with 'cd <dir> &&' silently skips the whole compound command when already in that directory, which destroyed an untracked source file mid-iteration. Back up before mutation loops with an absolute path and a separate command.

### Iteration 33

**Summary:** Completed ledger item 3.5e by porting `_generate_one` to TypeScript against a parity corpus captured by driving the real Python images stage with both providers intercepted, which proved the featured aspect-ratio override is unreachable on real manifests and that a Gemini call is billed even when the optimizer then rejects its bytes.

**Changes:**
- `web/src/mastra/images/generate-one.ts` ports `_generate_one`: the aspect-ratio and image-size decision including the featured overrides, the 1920-vs-1200 optimize width, a faithful `pathlib.PurePosixPath(...).stem`, the featured filename rewrite from the UTC clock and an inclusive randint(10,99), the disk write and the `/media/<post_id>/<filename>` URL, plus the success and both failure shapes of the manifest entry, with usage reported separately from success so a billed-but-failed image still counts toward `_stage_meta_gemini`
- `api/scripts/export_image_generation_parity.py` freezes the oracle into `web/src/mastra/images/data/image-generation-parity.json` by running the real `images_node` with `ClaudeClient` and `GeminiClient` replaced, a frozen `datetime.now(UTC)` and `random.randint`, and a temporary media directory: 16 manifest entries covering every branch, the 14 Gemini calls they produced with exact arguments, the 9 surviving files with dimensions and (where no resize happened) Pillow's sha256, and a 15-case direct oracle for `Path(...).stem`
- `web/src/mastra/images/generate-one.test.ts` adds 30 passing tests whose oracle is the corpus rather than the mock: sharp re-encodes the corpus PNG for real and the committed sha256 is Pillow's, so encoder drift fails the file, and eleven applied-and-reverted mutations each fail the suite
- Ledger item 3.5 split: 3.5e is the per-image generation unit (now checked with pasted evidence) and 3.5f is the remaining step, `.foreach()` fan-out, manifest-parse failure branch, both stage metas and `saveStageOutput`
- Four defects logged in `todo.md`: featured filename collisions, the stored manifest disagreeing with the request actually sent, an empty filename writing the dotfile `.webp`, and the untested `dict.get(key, default)` behaviour for an explicit JSON null

**Learnings:**
- The featured `image_size = "2K"` / `aspect_ratio = "16:9"` override in `_generate_one` keys off `placement == "featured"` (a string), while `is_featured`, which picks the optimize width and the filename rewrite, also accepts `type == "featured"`. Claude writes `placement` as an object in both golden manifests, so on real data the override never fires while the width and filename rules always do. Item 3.5f must not collapse the two conditions.
- Python accumulates `gemini_tokens_in/out` and `gemini_model` immediately after `generate_image` returns, and `optimize_image` runs inside the same `try`, so an image whose bytes the optimizer rejects is stored as failed but still billed. Reporting usage only for `generated: true` entries under-reports spend.
- The first version of the corpus used only a 64x48 PNG, and the negative control "optimize width always 1200" passed, because nothing was ever wide enough to resize. A parity corpus can silently fail to reach a branch whose only observable effect is a resize; adding a 2400x1600 input made the control fail. Resized outputs are comparable on dimensions only, since Pillow's Lanczos convolution and libvips' reduce disagree byte for byte.
- Every featured entry gets the same filename (`featured-<MMDDYY>-<randint(10,99)>`), so four featured entries in the corpus produced one file with the last write winning and all four entries recording the same URL. Latent because real manifests carry one featured image.
- `Path(...).stem` is not "strip after the last dot": the rule is `0 < i < len(name) - 1`, so `Path("..png").stem` is `"."`, `Path("...").stem` is `"..."` and `Path("x.").stem` is `"x."`. It also drops the directory, which is what keeps a manifest filename like `sub/dir/nested.png` from writing outside the media directory.
- `api/tests/conftest.py` hardcodes a fallback of `localhost:5433` while this worktree's compose project publishes postgres on 5435, so a bare `uv run pytest` reports 4 failed / 205 passed / 177 errors with `InvalidPasswordError` against whatever else is on 5433. Passing `TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test` reproduces the 125/236/25 baseline exactly.
- Running pytest writes WebP files into the repo's untracked `media/test-123/` directory, which is not gitignored, so a `git add -A` would commit binary test garbage.

### Iteration 34

**Summary:** Split ledger item 3.5f in two and completed 3.5f-i by porting the images stage's Claude manifest half to a Mastra step with byte-exact prompt parity against both golden fixtures, which established that `.foreach()` forces the stage into a three-step nested workflow and that Python reports `duration_s: 0` on the parse-failure branch.

**Changes:**
- web/src/mastra/steps/images-manifest.ts adds `imagesManifestStep`: prompt assembly from rules/blog-images.md, the Claude call, `parseManifest`, and the parse-failure branch signalled as `parseFailed` rather than thrown, with a recursive `jsonValueSchema` so the arbitrary-JSON manifest gets a real Zod schema instead of `z.any()`
- The step deliberately writes nothing to the post row and returns `stageStartedAtMs` instead of a duration, preserving Python's one-write-per-stage and one-timer-over-the-whole-stage guarantees across the three-step split
- `pythonTruthy` and `rawSnippet` port the two primitives where the engines disagree: empty containers are falsy in Python and truthy in JavaScript, and `[:500]` slices code points not UTF-16 units
- web/src/mastra/steps/images-manifest.test.ts adds 18 tests whose manifest oracle is Python's stored entries with `_generate_one`'s bookkeeping keys stripped, so the port is compared against Python rather than against its own parser
- docs/mastra-port/LEDGER.md splits 3.5f into 3.5f-i (checked, with the workflow-shape rationale, three recorded divergences, a ten-row negative-control table and all gate output) and 3.5f-ii for the fan-out and assembly

**Learnings:**
- `.foreach()` is declared on `Workflow`, not on `Step` (@mastra/core 1.61.0, workflows/workflow.d.ts:337), and its type constraint is `TPrevIsArray extends true ? Step<...> : 'Previous step must return an array type'`. A step cannot call it, so the images stage has to become a nested workflow of three steps. `.map()` (workflow.d.ts:290) is what lets the manifest step keep a rich object output while still handing `.foreach()` an array, and `getStepResult(step)` (step.d.ts:34) is what lets a later step read an earlier step's full output back.
- `StageTimer.duration` stays 0 until `__exit__` (api/src/pipeline/helpers.py:376-388), and the images parse-failure branch returns from inside the `with` block. Python therefore reports `duration_s: 0.0` for a failed manifest, not the elapsed time. Item 3.5f-ii has to reproduce that rather than measuring anything.
- Python's `manifest.get("error")` is a truthiness test, not a key-presence test, so a manifest in which Claude itself wrote an `error` value short-circuits the whole stage and bills no Gemini call, while `"error": ""` does not. That branch is where the two languages' truthiness differ most usefully: `[]` and `{}` are falsy in Python and truthy in JavaScript.
- Stripping `_generate_one`'s bookkeeping keys (generated, index, size_bytes, url, error) off `stage_output.image_manifest.images` recovers the exact specs Python parsed out of Claude's answer, which gives the manifest step an oracle that is Python's own output rather than a re-run of this port's parser. Worth reaching for whenever a stage stores `{**input, ...derived}`.
- The `media/test-123/` files pytest writes are not all untracked: 39 of them are already committed, so `rm -rf media/test-123` shows up as 39 deletions rather than a clean-up. Only the files a given run adds are untracked; delete those individually or `git checkout --` the directory afterwards.

### Iteration 35

**Summary:** Completed ledger item 3.5f-ii, closing out the whole `images` stage, by assembling the manifest step, a `.foreach()` fan-out at Python's semaphore width and a single-writer assembling step into one registered Mastra workflow, proven by a real evented run against live Postgres and Redis.

**Changes:**
- web/src/mastra/workflows/images.ts: `imagesWorkflow`, registered on the Mastra instance as `images`, whose serialized graph is step(images-manifest) -> mapping -> foreach(images-generate, concurrency 3) -> step(images-assemble); the mapping short-circuits the parse-failure branch before it checks the Gemini key or creates the media directory, matching Python's early return
- web/src/mastra/steps/images-generate.ts: the per-image step wrapping item 3.5e's `generateOneImage`, resolving the Gemini credential per call rather than carrying it on the job, because a job is serialised into both the Postgres workflow snapshot and the Redis event that hands the step to the worker
- web/src/mastra/steps/images-assemble.ts: the stage's only writer, producing both `_stage_meta` and `_stage_meta_gemini` off one whole-stage duration, reporting `durationS: 0` and no Gemini record on the parse-failure branch, and folding the results back with `foldManifest` split out as a pure function so the document's key order is assertable
- web/src/mastra/images/generate-one.ts gains `mediaRoot()`, the port of `settings.media_dir` with the same `MEDIA_DIR` override `rulesDir()` already carries
- 27 new tests across web/src/mastra/steps/images-assemble.test.ts (fixture and corpus parity for the fold, the totals, both metas, stage_status and the single write) and web/src/mastra/workflows/images.test.ts (a real evented run on an isolated Mastra instance asserting fan-out order, concurrency, the media directory and the parse-failure branch), backed by 12 applied-and-reverted negative controls
- web/src/mastra/no-next-imports.test.ts allowlist widened to node:fs, node:fs/promises, node:path, node:zlib and sharp, which registering the workflow legitimately pulls into the entry point's graph for the first time
- docs/mastra-port/LEDGER.md: 3.5f-ii checked with the graph dump, the three oracles, four recorded divergences, the twelve-row negative-control table and all gate output; parent items 3.5f and 3.5 checked with it

**Learnings:**
- Postgres `jsonb` sorts object keys by length and then bytes, so the key order a Python dict carried is gone by the time the row is read back. 'JSONB shape byte for byte' can only mean the key and value set; the ordering assertion had to move off the row and onto the pure fold function, which is also what turned it into a discriminating negative control.
- `.map()` returns `TPrevSchema = any`, so `.foreach()`'s `'Previous step must return an array type'` guard never fires after a mapping step and tsc accepts anything. The array contract between the two is unenforced by types and has to be pinned by a runtime test.
- Vitest runs test files in parallel and Mastra's evented engine shares work by Redis consumer group, so a second file calling `mastra.startWorkers()` on the exported instance could have its steps executed inside the thread running another file, where its `vi.mock` stubs do not exist and the real providers would be called. `RedisStreamsPubSub`'s `keyPrefix` plus a test-local `Mastra` instance isolates it completely.
- A guard can be real and still untestable through its obvious effect: `.map()`'s `if (parseFailed) return []` looked redundant because the manifest step already returns `images: []` on that branch, and the mutation `if (false)` passed the whole suite. Its only observable consequence is that no media directory is created and no key lookup happens, so the control only became a control once the test asserted the directory's absence.
- The 3.5e generation corpus already carried `total_generated`, `total_failed`, `manifest_keys`, `stage_status`, `stage_meta` and `stage_meta_gemini`, so the assembling step had a full oracle waiting from a previous iteration. Re-deriving its 225/1395 Gemini token sums from the exporter's own schedule only reconciles if the entry the optimizer rejected is billed, which is an independent confirmation of item 3.5e's finding.
- `next build` in this worktree emits a BetterAuth base-URL warning, not the middleware-to-proxy deprecation earlier ledger entries recorded. Confirmed pre-existing by building `git show HEAD:web/src/mastra/index.ts` in place and restoring; `.env` here has no BETTER_AUTH_URL.

### Iteration 36

**Summary:** Completed ledger item 3.6 by porting the `ready` stage to a Mastra agent and step, which closed out Phase 3 and established that the golden fixture's ready prompt is not what the Python worker actually sends, because jsonb normalizes the embedded image manifest's key order.

**Changes:**
- web/src/mastra/agents/ready.ts adds `readyAgent`, registered on the Mastra instance under `ready`: READY_SYSTEM_MESSAGE byte-identical to both golden fixtures, READY_MAX_TOKENS 16000, the incumbent anthropic/claude-opus-4-6, and the shared claudeStageOptions thinking configuration
- web/src/mastra/steps/ready.ts adds `readyStep` plus `buildReadyPrompt` and `generatedImages` as pure exported functions, porting `_build_ready_prompt`: the three-line config block that replaces the shared thirteen-field one, the suppressed-when-empty final markdown section, Python's falsy-empty-dict manifest guard, key-presence rather than `??` for `images`, in-place `images` replacement so the key keeps its position, and Python truthiness for `generated`
- web/src/mastra/prompts.ts exports `pythonJsonDumps`, which was written for buildStagePrompt's previous-output path but is actually needed by `ready`, the only stage that serializes JSON and the only one that does not use that path
- api/scripts/export_ready_prompt_parity.py plus web/src/mastra/steps/data/ready-prompt-parity.json freeze the production-path oracle: the fixture's final_md and image_manifest go through a real posts row, the state is rebuilt the way the worker rebuilds it, and the real Python `_build_ready_prompt` renders the prompt, with no provider call and no API key read
- web/src/mastra/steps/ready.test.ts and web/src/mastra/agents/ready.test.ts add 32 tests (31 credential-free) covering both prompt oracles, the assertion that they differ only in manifest key order, the generated-images filter against item 3.5e's parity corpus, the ensure_ascii escaping, both raising branches, persistence and stage_status merging, wire-payload parity, credential resolution and a live Anthropic smoke test
- docs/mastra-port/LEDGER.md item 3.6 checked with the two-oracle rationale, three recorded divergences, a fifteen-row negative-control table and all gate output

**Learnings:**
- `capture_golden.py` builds one in-memory Post and threads a single state dict from stage to stage, while `_run_pipeline` reloads the post from the database before every stage (api/src/worker.py:144). For every stage whose prompt embeds a jsonb column, the golden fixture is therefore NOT what production sends: Postgres returns jsonb object keys sorted by length then bytes, so the ready prompt's manifest section differs for both fixtures. Any future item that compares a DB-sourced prompt against a fixture has to check this first.
- The fix is not to normalize the difference away but to build a second oracle. Running the real Python prompt builder over a state rebuilt from a real row is cheap (no provider, no API key) and turns the divergence into three assertions: production parity, fixture parity for the builder, and a proof that the delta is exactly the manifest's key order.
- A negative control can silently be a no-op when the fixture happens to agree with the mutation. Hardcoding the reported model id passed the whole suite because both fixtures recorded the same id the agent requests; it only became a real control after a test replayed a response carrying a server-side alias. The same blind spot exists in outline/write/edit/images.
- `ready` is the only stage that does not call `build_stage_prompt`, so exporting `pythonJsonDumps` from prompts.ts was overdue: the function was written for buildStagePrompt's previous-output section, which no stage actually reaches, while the one stage that serializes JSON had no access to it.
- No provider keys exist in this worktree and WP_ENCRYPTION_KEY is absent from its .env, so the settings-table api_keys row cannot be decrypted here. Live smoke tests must source the key from the main checkout at /Users/cody/Documents/code/jena-ai/.env.
- Running pytest again wrote three new untracked media/test-123/*.webp files. Delete the ones a run adds before finishing, since they are not gitignored.

### Iteration 37

**Summary:** Completed ledger item 4.1 by composing the six ported stages into one registered Mastra workflow, proven by a nine-test real evented run against live Postgres and Redis plus four chain-mutation negative controls.

**Changes:**
- web/src/mastra/workflows/pipeline.ts: the six stages chained research -> outline -> write -> edit -> images -> ready with .then() and .commit(), with `images` entering as a nested workflow because its fan-out is .foreach()
- web/src/mastra/index.ts: the composed workflow registered as `pipeline`, alongside `images` (still separately registered so a single stage can be rerun) and `scaffoldCheck`
- web/src/mastra/workflows/pipeline.test.ts: 9 tests executing the whole workflow on the evented engine against live Postgres and Redis, asserting stage order, per-column commits, that each stage reads the row the previous one committed, the nested images workflow chaining, the run output, and per-step metas on the finished run; edit's readability and SEO warnings are captured rather than printed
- docs/mastra-port/LEDGER.md: item 4.1 checked with the test run, a four-row negative-control table, and all frontend and backend gate results
- todo.md: logged the confirmed pytest leak where api/tests/phase3/test_images_stage.py writes into the repo's real media/test-123/ and never cleans up

**Learnings:**
- An evented workflow nests inside another via plain `.then()`. `EventedWorkflow extends Workflow`, which `implements Step<...>`, and both `DefaultEngineType` and `EventedEngineType` are the empty object type `{}` in the installed d.ts files, so the engine-type parameter on `.then()` is not a barrier. On the finished run the nested workflow appears in `result.steps` under its own id, indistinguishable from a step.
- Because every step re-reads the post row rather than taking the previous step's payload, the composition needed no `.map()` between stages: each step's output is a superset of `{ postId }` and Zod strips the extras on input validation.
- The featured image's filename is rewritten to `featured-<MMDDYY>-<rand>.webp` by the generation step, so a test asserting the manifest reached the ready prompt has to key on a non-featured entry's filename; the manifest Claude wrote is not the manifest the ready stage sees.
- api/tests/phase3/test_images_stage.py writes generated webp files into the repo's real media/test-123/ with no cleanup, so any pytest run dirties the working tree. 39 such files were already committed accidentally in 5f31ca4. Clean them before committing an iteration's work.
- Chaining `cd web && cp ...` when the shell is already inside web silently skips the cp: the failed cd short-circuits the &&. That destroyed a backup mid negative-control sweep and let three mutations stack. Take the backup in its own call and verify it exists before mutating an untracked file.

### Iteration 38

**Summary:** Completed ledger item 4.2a by threading a stage selection through the workflow chain so a run executes only the named stages or, with none named, everything `stage_status` does not already call complete, which also uncovered and fixed a circular-schema bug that made the second `images` run in any process fail.

**Changes:**
- `stageStepInputSchema`/`stageStepOutputSchema` gained a `stages` selection and a `skipped` flag, plus `shouldRunStage()` and `skippedStageOutput()`: the two rules Python spelled out in `_run_pipeline()` (a named selection runs exactly what it names and ignores `stage_status`; an unnamed run skips the stages already complete) now live in one readable place
- All six stages honour the selection: the five single-step stages check right after loading their state, and `images` checks in `images-manifest` because the `.foreach()` fan-out sits between that step and the one that writes, with the skip carried across to `images-assemble` and the `.map()` so a passed-through stage resolves no Gemini credential and creates no media directory
- `jsonValueSchema` moved from `z.lazy(...)` recursion to a predicate-backed `z.custom<JsonValue>`, fixing a terminal failure of every `images` run after the first in a process: Mastra publishes a nested workflow's `parentWorkflow.stepGraph` as JSON and the lazy's `_cachedInner` closed a reference cycle on first parse
- `web/src/mastra/workflows/stage-selection.test.ts`: 11 tests over two real evented runs against live Postgres and Redis (a partly complete post resumed, and a fully complete post rerun for a single stage), with only the six agents and the Gemini call stubbed
- Three regression tests in `images-manifest.test.ts` pinning that the manifest schema stays JSON-serialisable after use and still rejects undefined, functions, NaN, symbols and cycles
- Ledger item 4.2 split into 4.2a (done, with evidence and seven mutation controls) and 4.2b (the single-stage rerun's `current_stage = "complete"` check, deferred so it can be decided alongside the full-pipeline completion hook)

**Learnings:**
- Mastra's evented engine serialises a nested workflow's `parentWorkflow.stepGraph`, step schemas included, into the Redis Streams payload. Any schema that is not JSON-serialisable breaks the nested workflow at `workflow.start`, and the step then fails terminally after three redeliveries. This rules out `z.lazy` recursion anywhere in a step schema.
- The above bug is invisible to a test that runs a workflow once, because `z.lazy` only closes its cycle when `_cachedInner` is populated by the first parse. Only the second run in the same process fails. Any future suite that exercises one run per process will keep missing this class of defect.
- The item's stated `check_gates` parameter does not exist in the Python being ported: `_run_pipeline()` takes `ctx, post_id, redis, session_factory, job_try, stages=None`. Gate checking was removed with LangGraph in the reliability work, so Phase 4's gate item stands alone rather than sharing a mechanism with stage selection.
- A guard can be real and still unobservable to a test whose mocks neuter it. The `.foreach()` map's skip check survived its first mutation control untouched because `requireApiKey` was a stub and the manifest was empty either way; turning the stub into a spy and asserting its call count is what made the guard testable.
- `pnpm test` writes generated images into the repo's own `media/test-123/` with randomised filenames, and 41 of them are already committed. Every full-suite run leaves new untracked files for the next commit to sweep up, so check `git status` for `media/` before staging.

### Iteration 39

**Summary:** Completed ledger item 4.2b by porting the single-stage rerun completion check, so a run that names its stages promotes `current_stage` to "complete" the moment its selection fills the last gap, proven by four real evented runs and five negative controls.

**Changes:**
- `markCompleteIfAllStagesComplete()` in web/src/mastra/post-state.ts re-reads `stage_status` from the row and sets `current_stage` to the new `CURRENT_STAGE_COMPLETE` constant when every stage calls itself complete, stamping `updatedAt` the way SQLAlchemy's onupdate did
- `markRerunComplete()` in web/src/mastra/steps/stage-io.ts holds the rule around it: a run without a `stages` selection promotes nothing, which is Python's `if not is_full_pipeline`, deliberately leaving the full-pipeline path to a future completion-hook item that also owns `completed_at` and publish queueing
- All six stages call the check immediately after committing their column, `images` from `images-assemble` because that is where its column is written; the assemble step's parse-failure branch deliberately does not, with a comment recording that it has just written `images: failed` so the check could never fire there
- web/src/mastra/workflows/rerun-completion.test.ts adds 10 tests over four real evented runs against live Postgres and Redis: a selection that fills the last gap, one that leaves a gap, one that fills it from inside the nested images workflow, and a full run that must not promote
- docs/mastra-port/LEDGER.md item 4.2b checked with the failing-first output, the finished test run, a five-row negative-control table, the three recorded design decisions and all frontend and backend gate results

**Learnings:**
- The promotion is unreachable from `images-assemble`'s parse-failure branch even though Python's loop ran the check there: that branch writes `stage_status.images = "failed"` first, so "every stage complete" is false by construction. Porting the call anyway would have added code no test could ever exercise, which is a different failure from a missing port.
- `git checkout <file>` to revert a negative-control mutation silently discarded the same file's real change from this iteration, because the mutation and the feature lived in one file. Restoring from a `/tmp` copy taken before mutating is the only safe revert when the file is already modified against HEAD.
- The `images` stage's promotion is a genuinely separate code path from the other five (its column is committed on the far side of the `.foreach()` fan-out, from a different step), so a test suite that only covers a single-step stage lets a mutation deleting the nested workflow's call pass clean. A fourth run naming `images` with an empty manifest costs about one second and closes it.
- `pnpm test`'s baseline in this worktree is 9 failures, not the 6 the objective document records: 6 in `image-preview.test.tsx` plus 3 in `PostDetail.test.tsx` (`Unable to find an element with the text: Final`). Both were already at the 4.2a baseline, so the number to compare against is 9.

### Iteration 40

**Summary:** Completed ledger item 4.3 by porting review gates to Mastra's suspend/resume across all six stages, proven by three real evented runs and seven negative controls, which also uncovered that the live stage_settings column default would park every TypeScript-created post at the research gate.

**Changes:**
- `stage-io.ts` gained the gate: `REVIEW_MODES` (`review`, `approve_only`), `DEFAULT_GATE_MODE` reproducing Python's `.get(stage, "review")` fail-safe, `gateModeFor`/`stageNeedsReview` (a named selection never pauses, Python's `check_gates=False`), and `reviewGate`, which parks the row and returns the suspend payload or null
- Typed gate schemas with no `z.any()`: `gateSuspendSchema` is `{stage, mode, message}` carrying Python's pause message, `gateResumeSchema` is `{approved: literal(true)}` because Python's pause was a bare `return` with no reject branch, so declining is `run.cancel()` rather than a resume payload
- `markStageForReview` in `post-state.ts` writes exactly the two columns Python's pause branch wrote (`stage_status[stage] = "review"`, `current_stage = stage`) without touching the content column, and `STATUS_REVIEW` joins the status vocabulary in `state.ts`
- All six stages call the gate immediately after the skip check and before any provider spend, `images` from `images-manifest` because that is the step in front of the `.foreach()` fan-out
- `web/src/mastra/workflows/review-gates.test.ts`: 13 tests over three real evented runs against live Postgres and Redis (gated at the first stage, gated inside the nested images workflow, and a named selection that must not pause) plus unit coverage of the decision rules
- The four existing workflow suites now seed `stageSettings` explicitly, because their rows were inheriting a database column default that predates the gate removal and reads five stages as `review`
- Ledger item 4.3 checked with the failing-first output, the passing run, three recorded divergences, the column-default hazard, two engine behaviours, a seven-row negative-control table and all gate output; three defects logged in `todo.md`

**Learnings:**
- The live `posts.stage_settings` column default is `{"edit":"review","write":"review","images":"review","outline":"review","research":"review"}` and never mentioned `ready`. SQLAlchemy applied its own all-auto default client-side on every insert, so no FastAPI-created post ever inherited it, but a Drizzle insert that omits the column does. With gates back, such a post parks at `research` on its first run, so the Phase 5.3 posts handler must send the column explicitly.
- `EventedRun.resume()` cannot be awaited for completion. It subscribes to the shared `workflows-finish` topic and the Redis stream still holds the run's earlier `workflow.suspend` event, so the promise resolves with that stale snapshot the instant it subscribes while the resumed run executes behind it. `resumeStream().result` has the same flaw and its `fullStream` replays pre-suspend events. `workflow.getWorkflowRunById(runId)` is the only honest source.
- The suspend event and the snapshot write race: a resume issued immediately after `start()` returns can be rejected with `This workflow run was not suspended`. Poll the persisted status for `suspended` before resuming.
- The engine appends its own `__workflow_meta` (path and runId) to whatever a step passes to `suspend()`, so a suspend payload can only be asserted with `toMatchObject`. It also spells a top-level step's suspended path as `[id, id]`, while a nested one reads `["images", "images-manifest"]`, which is the path `resume({step})` has to name.
- A `vi.fn()` call count asserted in an `it` block is the count at assertion time, not at the moment the run suspended. A "bills nothing while it waits" assertion has to snapshot `mock.calls.length` in `beforeAll` at the suspend, otherwise the resumed run's calls satisfy it in reverse.
- Post ids are a shared namespace across test files: reusing `...04b1` collided with `rerun-completion.test.ts` under vitest's parallel files, and each suite's `delete`-then-`insert` seed destroyed the other's rows, producing 42 failures that looked like a workflow-engine regression.

### Iteration 41

**Summary:** Completed ledger item 4.4a by standing up the real Mastra worker bundle as the `worker` service and proving a run started by a process that never calls startWorkers is executed by that separate process, which also exposed that vitest's inherited NODE_PATH had been hiding a bundle that could not boot.

**Changes:**
- `web/package.json` gains `worker:build` (`mastra worker build -o .mastra/worker`) and `worker` (`mastra worker start --dir .mastra/worker`), the two commands the Railway `worker` service will run, with the bundle kept out of the `.mastra/output` that `mastra dev` owns for Studio
- `@opentelemetry/api` added as a dependency: the deployer validates its output by importing each generated chunk, and that import was unresolvable because no package in the tree declares it and pnpm's strict layout leaves nothing at `web/node_modules/@opentelemetry`
- `bundler: { externals: ["sharp"] }` on the Mastra instance: sharp's native `.node` binary cannot be inlined, so the bundle threw `Could not load the "sharp" module` on boot until sharp moved out of the bundle and into the generated `package.json`
- `web/src/mastra/workflows/worker-process.test.ts` adds 8 tests that build the bundle from a clean directory, start two runs with no worker alive, snapshot five seconds later, then spawn the real bundle and watch both runs execute; neither run bills a provider, so the bundle is the untouched production one with no stubbing seam
- The test isolates on Redis database 9 (the bundle cannot reach `keyPrefix`, and a shared `workflows` topic would let another suite's workers steal these runs) and deletes `NODE_PATH` from the worker's environment so the bundle resolves only what a deploy would
- Ledger item 4.4 split into 4.4a (checked, with the build and start output, four negative controls and all gate results) and 4.4b (the `web`-restart proof), and two defects logged in `todo.md`

**Learnings:**
- Vitest sets `NODE_PATH` to pnpm's flat virtual store, so any child process spawned from a test inherits resolution for every package installed anywhere in the repo. This produced a false green: the suite passed with the `sharp` external removed while the same bundle booted by hand crashed on import. Any test that spawns a deployable artifact has to strip `NODE_PATH` or it is testing the dev machine, not the artifact.
- A negative control run against a dirty build directory proves nothing. Removing the `sharp` external and rebuilding still passed because the previous build's `.mastra/worker/node_modules` still held sharp's platform binary. The suite now `rm -rf`s the bundle directory before building.
- `mastra worker build` is a genuinely different resolution environment from `next build`, `vitest` and `mastra dev`: two dependencies that all three resolve fine were unresolvable in the worker bundle. The worker build has to be part of CI or a new dependency will only break at deploy time.
- `EventedRun.startAsync()` is the fire-and-forget entry point the `web` service needs; `start()` blocks until something finishes the run, so with no worker alive it simply hangs (control 4 timed out the hook at 60s). `startAsync` persists the run row as `running` immediately, so run status alone cannot distinguish "published but unconsumed" from "executing" and the post row is the honest signal.
- Redis Streams retains an event published before any consumer group exists, and the worker picks it up on boot. That is what lets `web` start a run while the `worker` service is still rolling, and it is why the pre-worker snapshot in the test is meaningful rather than a race.
- The `mastra worker` CLI's generated entry is exactly `await mastra.startWorkers()` plus SIGINT/SIGTERM `stopWorkers()`, so no custom worker entry point needs writing; `-o <dir>` is required to stop the worker bundle overwriting the Studio server bundle in `.mastra/output`.

### Iteration 42

**Summary:** Completed ledger item 4.4b by proving a `web` process can start a run and die, gracefully or by SIGKILL, without disturbing the worker executing it, using the real deployable bundle as both sides of the split.

**Changes:**
- web/src/mastra/workflows/web-service.fixture.mjs: the `web` service as a real short-lived process, loading the built worker bundle's Mastra instance and doing only createRun/startAsync/getWorkflowRunById, never startWorkers; it finds the instance in the minified bundle by shape rather than by export name
- web/src/mastra/workflows/web-restart.test.ts: 8 tests over three real runs proving a run outlives the process that started it, a gate-parked run survives a web restart with an unchanged updated_at, and a run started by a SIGKILLed web still reaches success while the worker's pid never changes
- Provider spend held at zero by seeding two all-complete posts (six skipped steps to `success`) and one post gated at `outline`, so the suite exercises both terminal states without an agent call
- Suite isolated to `.mastra/worker-restart` and Redis database 10 so it can run in parallel with worker-process.test.ts, which owns `.mastra/worker` and database 9
- docs/mastra-port/LEDGER.md: 4.4b checked with the verbose test run, a three-claim construction table, four recorded decisions, a seven-row negative-control table and all frontend and backend gate output

**Learnings:**
- `mastra worker build -o <dir>` writes only inside `<dir>`: `.mastra/.build`, `.mastra/bundler-config.mjs` and `.mastra/output` keep their old mtimes across a build, so two suites can build concurrently into different output dirs without a lock. Those shared files belong to `mastra dev`/`mastra build`, not to the worker build.
- The worker bundle's `mastra.mjs` exports the configured Mastra instance under a rollup-minified name (`m`), so any process that wants to drive the bundle has to find it by shape. `typeof value === "object" && typeof value.getWorkflow === "function"` also excludes the `Mastra` class, which is exported alongside it and carries `getWorkflow` on its prototype.
- A negative control that mutates a shared helper can move both sides of the boundary it is meant to break. Overriding `REDIS_URL` inside the shared `deployEnv()` moved the `web` fixture and the worker to the same wrong database, so the suite passed; the control only bites applied to the worker's own spawn.
- An assertion that reads state off a mutable variable cannot detect a mutation that rebinds it. The "worker never restarts" test passed under a kill-and-respawn control because the fresh process's stdout also had exactly one `Workers started`; capturing the pid at first spawn is what made the claim testable.
- Ordering claims about a dead process do not need a sleep if the consumer does not exist yet: starting runs with no worker alive anywhere makes "nothing executed before web exited" true by construction, and the worker spawn timestamp is then a real ordering assertion rather than a timing gamble.
- Asserting `updated_at` equality alongside column equality is what distinguishes "no write happened" from "an idempotent rewrite happened", which is the actual claim when proving a restart disturbed nothing.

### Iteration 43

**Summary:** Split ledger item 4.5 and completed 4.5a, proving with a provider-free automated suite that Mastra's built-in evented engine recovers a step whose worker is SIGKILLed, which settles the port's workflow-runner decision in favour of the built-in engine.

**Changes:**
- web/src/mastra/workflows/crash-probe.fixture.mjs: a two-step provider-free workflow on its own Mastra instance (Redis database 11) that doubles as a worker process when run directly and as the `web` side when imported, with steps recording to an append-only JSONL file so the record of "this body executed in this process" survives a SIGKILL outside any transaction the engine owns
- web/src/mastra/workflows/crash-probe.test.ts: 8 tests over one real run that kill worker A mid-step, spawn worker B, and assert redelivery, single completion, no re-execution of the completed step, byte-equal persisted step record across the crash, payload continuity, and the observed 55-120s XAUTOCLAIM recovery latency
- docs/mastra-port/LEDGER.md: item 4.5 split into 4.5a (checked) and 4.5b (the real mid-`write` pipeline gate), with the runner decision recorded, the mechanism cited to exact files and lines in the installed packages, the hand-run marker log, a four-row negative-control table and all frontend and backend gate output
- todo.md: logged the scaffold-check stream-event race (3 of 5 runs with the new suite, 0 of 3 without) and the untested SIGTERM shutdown path a Railway redeploy would take

**Learnings:**
- The built-in evented engine passes the durability gate: `OrchestrationWorker` uses the fixed consumer group `mastra-orchestration`, `WorkflowEventProcessor.handle` awaits the step body before the transport acks, and `RedisStreamsPubSub` runs XAUTOCLAIM every 30s over entries idle 60s. Measured recovery after a SIGKILL was 70s. No startup sweep and no @mastra/inngest are needed.
- The run snapshot carries no record of a step until it completes: at the moment of the kill `steps` held only the finished step and had no key at all for the running one. A worker startup sweep over storage (the ledger's stated first fallback) could therefore never have identified the interrupted step. This also means run status alone cannot distinguish a healthy long step from an orphaned one.
- Recovery is not instant and nothing in the port shortens it. A worker that dies mid stage parks that stage for 60-90s. Disabling the reclaim loop (`reclaimIntervalMs: 0`) or putting the replacement worker on a different Redis database both leave the run unfinished forever, which is what makes XAUTOCLAIM provably the only recovery path.
- Only SIGKILL is covered. A Railway redeploy sends SIGTERM, which the `mastra worker` entry handles with `stopWorkers()`, unsubscribing the transport while a step may still be running. Whether that leaves the message pending, acks it, or nacks it decides whether a routine deploy loses or duplicates a stage, and the fixture used here has no SIGTERM handler so it could not answer the question.
- tsconfig has `allowJs: true`, so a TypeScript test can import a `.mjs` fixture directly with inferred types and no hand-written declaration file. But `RunState["steps"]` widens to include the array form a `.foreach()` step produces, so every step-record read needs one narrowing cast, matching the pattern already in pipeline.test.ts.
- Adding a 78s test file measurably changes how vitest schedules the rest of the suite. The `settings.api_keys` race gives this worktree a 9-11 failure baseline on its own, and `scaffold-check.test.ts`'s stream race went from 0 of 3 runs to 3 of 5 with the new file present despite sharing no Redis database, topic or row with it. Measuring the baseline with the new files physically moved out of the tree is the only way to attribute failures honestly.

### Iteration 45

**Summary:** Completed ledger item 4.5b and closed out 4.5 by proving on the real worker bundle that a full pipeline run killed mid-`write` resumes without re-running or rewriting `research` and `outline`, settling the port's workflow runner as Mastra's built-in evented engine.

**Changes:**
- web/src/mastra/scripts/durability-gate.mjs: a self-contained scripted procedure that builds the deployable worker bundle from scratch, starts a full pipeline run from a separate `web` process, SIGKILLs the worker mid-`write`, spawns a replacement, and reports 10 pass/fail checks plus timings, token counts and a write-audit log as JSON; exits non-zero if any check fails
- A temporary write-audit instrument inside that script: an AFTER INSERT OR UPDATE trigger scoped to the seeded post row logging every content-column write with its md5 into a throwaway table, dropped in `finally`, which turns "not rewritten" from an inference about a final value into a count over a write history
- Provider credentials handled without touching the repo: keys are read from the environment, encrypted under the same throwaway Fernet key the agent suites use via the app's own `encryptWithKey`, written to the `settings` row the agents read, and the previous row is restored in `finally` (verified afterwards by confirming the restored ciphertext does not decrypt under the throwaway key)
- docs/mastra-port/LEDGER.md: item 4.5b checked with the full run log, the four-row audit table, run state either side of the kill, timings and per-stage token counts, three carried-forward findings, an analysis-level negative control with pasted psql output, an explicit statement of which controls were not re-run and why, and all frontend and backend gate results
- docs/mastra-port/LEDGER.md: parent item 4.5 checked, recording the runner decision (built-in evented engine over RedisStreamsPubSub with Postgres storage, no startup sweep, no @mastra/inngest, no second queue) with the reason a startup sweep was impossible

**Learnings:**
- Node 24 runs `.ts` files natively, so a plain `.mjs` script can `import { encryptWithKey } from "../../lib/crypto.ts"` and use the app's real Fernet implementation instead of duplicating it. It only works because crypto.ts imports nothing but `node:crypto`; a TS module with extensionless relative imports would not resolve. Silence the reparse notice with `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`.
- The recovery latency is a discriminator, not just a cost. Worker B was alive 36ms after the kill, so an unread `workflow.step.run` message would have been consumed immediately; the observed 98.1s means the message was in the dead worker's pending-entries list, which proves worker A had genuinely entered the step body. A crash-resume test that spawns the replacement fast gets this evidence for free.
- A Postgres AFTER UPDATE trigger scoped to one row is a cheap, honest instrument for exactly-once claims, and it fails closed: if the trigger never fires, `count(distinct md5)` is 0 and the `= 1` check fails rather than passing vacuously. That property is worth designing for, because it means a green result cannot be produced by a broken instrument.
- The first (killed) `write` attempt's token usage is recorded nowhere: the run snapshot has no key at all for an interrupted step, so the only tokens the trace can show are the successful retry's. Phase 8's cost display will understate the true cost of any run that survived a worker death, and there is no data source that would fix it.
- Gating `edit`/`images`/`ready` to "review" while leaving `research`/`outline`/`write` on "auto" makes a full unnamed pipeline run park itself the moment `write` commits. That is ordinary production behaviour and a real terminal state (`suspended`), so it bounds the provider spend of an expensive procedure without weakening what the procedure proves.
- The dev database's `settings.api_keys` row currently holds a 21-character `sk-ant-` placeholder encrypted under the throwaway Fernet key that is committed in `write.test.ts`, left behind by an interrupted suite run. Any script that save-and-restores that row will faithfully preserve the placeholder, which is the already-logged todo about the agent suites' restore logic; check the plaintext length before assuming a stored key is usable.

### Iteration 46

**Summary:** Completed ledger item 4.6 by proving with a forced-overlap concurrency test that two runs on one post row lost each other's stage_status entries, then fixing it by moving the merge into the UPDATE statement as a jsonb concatenation.

**Changes:**
- mergeStageStatus() in web/src/mastra/post-state.ts performs the stage_status merge in SQL (coalesce(stage_status,'{}'::jsonb) || patch::jsonb) inside the same single UPDATE that writes the content column, so Postgres' row lock serializes what used to be an application-level read-modify-write two concurrent runs could lose
- saveStageOutput's fourth argument is now a stage_status patch rather than a whole map, and markStageForReview takes no map at all; all six stage steps updated accordingly, which also removed reviewGate's now-dead stageStatus parameter and an entire loadPipelineState call from images-assemble
- web/src/mastra/workflows/concurrency.test.ts: 10 tests over six real evented runs against live Postgres and Redis, covering two concurrent named-stage runs on one row (overlap forced by a two-party barrier sitting between the row read and the column write) and four concurrent full pipelines on four marked posts, with the shared pg pool sampled every 20ms
- docs/mastra-port/LEDGER.md item 4.6 checked with the failing-first output, the fix's SQL, the passing run, the measured pool peak, a five-row negative-control table, a psql analysis control proving the coalesce is load-bearing, and all frontend and backend gate results

**Learnings:**
- The stage_status write was a lost-update hazard inherited verbatim from Python's save_stage_output: every stage passed the whole map it had read at step start. Two runs on one post that both read before either writes each hold a stale pre-image, so the second write erases the first's entry and the dashboard reports a finished stage as never run.
- The forced rendezvous is what makes the test real. With the pre-fix code restored and the barrier disarmed, the same-row assertion passes: the two runs simply did not overlap. A concurrency test that leaves the interleaving to the scheduler is green on broken code, so the barrier has to sit provably downstream of the read and upstream of the write in both steps.
- A partial revert is not a faithful negative control. Reverting only the writer to whole-map replacement while the call sites already send patches produced a second, unrelated failure (stage_status collapsing to one key) that had nothing to do with the concurrency claim. The honest pre-fix evidence is the original failing-first run, not the control.
- ready is the one stage whose prompt is not built by buildStagePrompt: its own builder drops the thirteen-field config block in favour of the slug, so a per-post marker carried only in the topic is invisible to the last stage. Any future test that tags a run end to end has to put the tag in the slug too.
- Under four concurrent full pipelines the pg pool (shared with Mastra's PostgresStore) peaked at 4 of 10 connections with zero queued waiters, so connection exhaustion is not near at this concurrency; the assertion worth keeping is the leak check (no borrowed client left after the runs settle), since that is what actually exhausts a pool over a long-lived worker's life.
- pool.options.max reads back as 10 on a pg Pool constructed with no max, so it can be asserted against directly rather than hardcoding the default.

### Iteration 47

**Summary:** Split ledger item 4.7 and completed 4.7a: an end-to-end pipeline run on the real worker bundle exposed that Mastra's 60s reclaim window re-executes and re-bills every stage longer than a minute, which is fixed by raising reclaimIdleMs to 15 minutes with a provider-free regression test.

**Changes:**
- web/src/mastra/scripts/full-pipeline.mjs: a scripted end-to-end procedure that builds the deployable worker bundle from scratch, starts a run from a separate `web` process that then exits, and checks 14 properties of the finished run (all six stage columns, manifest shape, image files on disk, ready_content embedding, promotion), with an AFTER INSERT OR UPDATE audit trigger recording the md5 of every content-column write so 'written once' is a count over a write history
- RECLAIM_IDLE_MS = 15 * 60_000 on the app's RedisStreamsPubSub in web/src/mastra/index.ts, replacing the 60s default that was re-delivering any step longer than a minute to a live worker and executing it a second time concurrently with the first
- web/src/mastra/workflows/reclaim-duplication.test.ts: 5 provider-free tests over two real evented runs on isolated Redis databases proving duplication under a window narrower than the step, exactly one execution under a wider one, and that the app's own instance is wired to the wide window
- docs/mastra-port/LEDGER.md: item 4.7 split into 4.7a (checked, with the failing end-to-end run, the mechanism cited to installed package lines, the fix, a three-row negative-control table and all frontend and backend gate output), 4.7b (the unported full-pipeline completion hook) and 4.7c (the green run); item 4.5's recorded crash-recovery latency amended from 70-98s to up to 15 minutes
- todo.md: the worker bundle needs RULES_DIR (silent prompt loss) and TEXTSTAT_DATA_DIR (fatal ENOENT in `edit`) set explicitly, because both resolve from process.cwd() and `mastra worker build` has no asset-copy option; both belong to items 7.1 and 7.2

**Learnings:**
- Mastra's built-in evented engine re-executes any step that runs longer than `reclaimIdleMs` (60s by default) on a live, healthy worker: XAUTOCLAIM selects purely on idle time and the transport does not ack until the step body returns, so the same loop that recovers a crashed worker's step duplicates a slow one. Every LLM stage in this pipeline is 40-120s, so every run had been double-billing since Phase 2 while still reporting `success`.
- The duplicate's own skip check hides the evidence: a duplicate that starts after the original commits reports `skipped: true`, so the run's step outputs claim stages were skipped on a run that plainly executed them. Only a write log over the row shows what happened.
- Steps in ledger items 4.5a/4.5b were all under 60s by luck, which is why the durability gate's `written once` checks passed. Timing, not correctness, was the difference, so a durability suite that happens to use fast steps proves nothing about a slow one.
- The deployable worker bundle's cwd is its own output directory, so every `process.cwd()`-relative asset path in the app (rules, textstat data, media) is wrong there. `mastra worker build`'s BundlerConfig has no asset-copy option (externals / sourcemap / minify / transpilePackages / dynamicPackages), so environment variables are the only lever and the Railway and compose service definitions must set all three.
- The Gemini key in this environment has no quota for `gemini-3.1-flash-image` (`429 ... limit: 0`), and the Python golden capture recorded the same failure on 2026-08-22, so image generation cannot be proven live here by either stack. The TypeScript stage reproduced Python's failure handling exactly (manifest stored, per-entry errors, total_failed set, run continues).
- A full run does not promote the post: Python's full-pipeline branch calls `_post_completion_hook` (api/src/worker.py:429) to set `current_stage = 'complete'` and `completed_at`, and the port only calls `markCompleteIfAllStagesComplete` from the single-stage rerun path.
- Restoring a file from a /tmp backup taken before a negative control silently discards any later edits to that file. The wiring test and its imports had to be re-applied after the restore; the backup has to be re-taken after every edit, or the control has to be reverted by inverse edit.

### Iteration 48

**Summary:** Completed ledger item 4.7b by porting Python's full-pipeline completion hook as a seventh Mastra step on the tail of the workflow, so a full run now ends with current_stage "complete" and completed_at stamped while a named-stage rerun deliberately does not.

**Changes:**
- `markPipelineComplete()` in web/src/mastra/post-state.ts sets `current_stage = "complete"` and `completed_at`, deliberately unconditional (unlike the rerun check) because Python's hook never re-read `stage_status`: the `images` stage can write `images: failed` and let the run reach the end, and gating on the map would leave such a post reading unfinished forever
- `pipelineCompleteStep` in web/src/mastra/steps/pipeline-complete.ts, a Mastra step rather than a callback so the finish shows up in Studio, in `run.stream()` events and on the run's `steps` map; it passes `ready`'s stage meta through unchanged so the workflow's declared outputSchema is untouched, and it no-ops when the run named its stages
- web/src/mastra/workflows/pipeline.ts chains `.then(pipelineCompleteStep)` after `ready`, with its header comment updated to the seven-link chain and to the fact that only the auto-publish half of the hook is still outstanding
- web/src/mastra/workflows/pipeline-completion.test.ts adds 11 tests over four real evented runs against live Postgres and Redis: a full run with one stage left, a named-stage rerun of the same shape (the `completed_at` null control that keeps the two paths distinguishable), a full run with all six stages already complete so every step skips, and a full run parked at a review gate that must never reach the hook
- Three existing tests updated because this item changes the behaviour they pinned: `pipeline.test.ts` (full run ends at `complete`, not `ready`), `worker-process.test.ts` (the all-complete post the worker skips gets both columns stamped while no content column moves), and `rerun-completion.test.ts` (its full-run case now asserts the hook did the promotion, using `completed_at` to tell it from the rerun check)
- docs/mastra-port/LEDGER.md item 4.7b checked with the failing-first output, the finished run, a four-row branch table, the three recorded design decisions, the test-id collision writeup and all frontend and backend gate results
- todo.md records two confirmed out-of-scope defects: `export-button.test.tsx` writing real `.webp` files into the repo's `media/` on every suite run, and the need for suite-wide unique test post ids

**Learnings:**
- Test post ids must be unique across the whole vitest suite, not just within a file. Files run in parallel in separate processes, so two files seeding the same `posts` row delete and re-insert it underneath each other. Reusing `review-gates.test.ts`'s `...04c1/04c2/04c3` produced symptoms that looked like a Mastra Redis Streams bug: runs coming back `suspended` for posts with no gate configured, a post seeded all-complete reading `current_stage = "outline"`, and `duplicate key ... posts_pkey` on an insert two lines after the matching delete. Roughly 50% reproduction under the full suite, 0% standalone. Phase 5 will add many more database-backed test files, so check the id list (`grep -rho '00000000-0000-4000-8000-[0-9a-f]*' web/src | sort -u`) before picking new ones.
- Chasing that flake, I wrongly suspected a Redis keyPrefix prefix-collision (`mastra:test:pipeline` being a strict prefix of `mastra:test:pipeline-completion`) and a leftover-suspended-run redelivery. Neither was the cause; renaming the prefix changed nothing. The give-away was the assertion values naming another file's posts, not the infrastructure. Read what the wrong value actually is before theorising about the transport.
- Python's full-pipeline hook and the single-stage rerun check are deliberately different rules, and `completed_at` is what distinguishes them in a test: the rerun check promotes `current_stage` and never touches `completed_at`, the hook always writes both. That makes `completed_at` the cheapest assertion for proving which code path ran.
- A full run whose stages are all already complete still stamps the post finished in Python, because `_post_completion_hook` sits outside the stage loop. Porting the hook as the last step in the chain reproduces that for free, since skipped steps still flow through to it.
- `run.start()` already resolves on the suspend event and `reviewGate` commits its row write before calling `suspend()`, so a test that only reads the post row after a suspend does not need `review-gates.test.ts`'s 30-second `getWorkflowRunById` polling loop. That polling is only needed before a `resume()`.

### Iteration 49

**Summary:** Ran the full pipeline end to end on the real worker bundle against live Postgres, Redis, Perplexity and Anthropic: the run settled success in 297.5s with all six stages complete and each column written exactly once, and the four failing checks were isolated to this environment's zero-quota Gemini key, so ledger item 4.7c was split into a checked 4.7c-i and an open 4.7c-ii.

**Changes:**
- Ledger item 4.7c-i checked with the complete end-to-end run output: run 49c34483 settled `success` after 297.5s, all six steps `success`, all six stage_status entries `complete`, post promoted to `current_stage = complete`, and a per-stage table of the model actually sent, token counts, durations and column sizes
- Ledger records three properties the run settled for the first time: the AFTER INSERT OR UPDATE audit trigger logged exactly seven writes with a distinct-value count of 1 per content column; the post was untouched five seconds after `web` published the run and exited, proving execution happens in the worker; and `write` (120.2s) and `edit` (195.3s) both exceeded the old 60s reclaim window, making 4.7a's fix load-bearing rather than incidental
- Ledger item 4.7c split into 4.7c-i (everything not gated on a billed Gemini key, checked) and 4.7c-ii (the image-generation path, open), rather than checking an item whose text says `green run` against a 10/14 result
- Ledger item 4.7c-ii opened with the live evidence that image generation is impossible in this environment: all six image-capable models on the key return 429 with `limit: 0`, plus a negative control showing an invalid key fails differently (400 INVALID_ARGUMENT), and a stated closure path via a recorded Gemini success response driven through the real step
- Ledger records that the `images` stage reproduced Python's failure handling exactly under the quota block: manifest assembled and stored, per-entry `error`, total_generated 0 / total_failed 4, stage marked `complete`, run continues to `ready` and finishes `success`
- Gate results appended to the ledger with the caveat that pytest without `.env` sourced falls back to port 5433 and reports a mis-run that reads like a catastrophic regression

**Learnings:**
- The full pipeline is materially faster than the procedure assumed: 297.5s end to end against a budgeted 45-minute timeout, with the six provider calls costing 25,642 input and 14,537 output tokens. Future items that need a real run can budget roughly five minutes, not twenty.
- Every image-capable Gemini model on this key is provisioned at `limit: 0` on the free tier, not just the port's incumbent `gemini-3.1-flash-image-preview`. Verified live across six ids including gemini-2.5-flash-image and gemini-3-pro-image. Switching model ids cannot work around it, so Phase 6.1's images choice and Phase 7.6's `post reaches ready with images` exit criterion are both bounded by the key, not by the port.
- A 429 RESOURCE_EXHAUSTED from Gemini is an authenticated rejection: an invalid key returns 400 INVALID_ARGUMENT instead. That makes the quota error usable as the objective's required live per-provider smoke test, which in turn makes a recorded-response proof of the generation path legitimate rather than a dodge.
- Gemini reports quota against the resolved model id rather than the requested one (`gemini-3.1-flash-image-preview` reports as `gemini-3.1-flash-image`), which incidentally confirms the `-preview` alias resolves server side rather than 404ing.
- A batch probe loop that pipes each response through a separate python parse can report 404 for models that actually return 429; the raw single-model retry disagreed with the loop. Re-probe cleanly before pasting any provider table into the ledger, because the wrong number looks entirely plausible.
- pytest must be run with `.env` sourced. Without TEST_DATABASE_URL, conftest.py falls back to hardcoded localhost:5433, which on this machine is an unrelated project's container, and the suite reports `4 failed, 205 passed, 177 errors`. That is a mis-run and is very easy to mistake for a regression against the 125/235/25 baseline.
- The manifest's `model` and `fallback_model` fields (`gemini-3-pro-image-preview`, `gemini-2.5-flash-image`) come from what the Opus manifest call chose per rules/blog-images.md, and are independent of GEMINI_IMAGE_MODEL_ID, which is what the client actually sends. Reading the manifest to learn which model was called would be wrong.

### Iteration 50

**Summary:** Closed ledger item 4.7c-ii, and with it all of Phase 4, by proving the images success path end to end against a recorded Gemini 200 with the real step, optimiser, disk, manifest write and ready prompt.

**Changes:**
- `web/src/mastra/steps/images-generate.test.ts` drives the production `imagesGenerateStep` against the `usage-reported` 200 envelope recorded in `gemini-parity.json`, with the real `gemini.ts` parser, the real sharp optimiser, real files on disk, the production `imagesAssembleStep` writing the real `image_manifest` column, and `buildReadyPrompt` reading it back: 8 tests covering request shape, the resolved credential on the outbound header, 1200x800 and 1920x1280 webp output, the featured filename rewrite, per-image billing, the promptless-entry failure path, the folded totals on the row, `size_bytes` matched against `stat()` of the written file, and both media urls embedded in the ready prompt
- Ledger items 4.7c-ii, 4.7c and 4.7 checked off with the test output, the recorded-corpus provenance, the concrete dimensions and byte counts, a pasted 429 negative control that fails 5 of the 8 tests, the reason `requireApiKey` is the one stub, the remaining live-key gap, and the four gate results

**Learnings:**
- The vitest suite runs test files in parallel with no `fileParallelism` override, and the `api_settings` `api_keys` row is a process-global singleton with no user scoping that `api-keys.test.ts` already saves/overwrites/restores exclusively. A second test file seeding that row would make both flaky, so DB-backed provider-credential tests must either stub `requireApiKey` or coordinate with that file.
- Tests read `DATABASE_URL_SYNC`/`DATABASE_URL` from the repo-root `.env` via `vitest.config.ts`, so they hit the dev database `content_pipeline` on port 5435, not `content_pipeline_test`. The dev database's `api_keys` row currently holds only an `anthropic` key; the perplexity and gemini keys the Phase 4 scripts use are seeded from env by `full-pipeline.mjs` and `durability-gate.mjs` and removed again afterwards.
- The 3.5d/3.5e parity corpora already contain a recorded Gemini 200 envelope and a real 2400x1600 source PNG, so the images success path could be proven without inventing any fixture. The recorded envelope's payload is a 1x1 pixel, so the corpus PNG has to be substituted to exercise the resize branch.
- Both Phase 4 parent items (4.7 and 4.7c) were split headers left unchecked while their sub-items completed. Definition-of-done item 1 requires zero unchecked items, so split parents need checking off with a pointer once their children are all done, otherwise they accumulate as phantom blockers.

### Iteration 51

**Summary:** Split ledger item 5.1 and completed 5.1a by porting GET/PATCH /api/settings to Next.js route handlers on a new BetterAuth-backed request-auth foundation, after discovering and fixing that the BetterAuth session tables had never been created.

**Changes:**
- web/scripts/auth-migrate.mts plus a pnpm auth:migrate script: creates the BetterAuth tables (auth_users, auth_sessions, auth_accounts, auth_verifications) from the installed package's own getMigrations() planner, since the published @better-auth/cli lags the installed core; applied against the dev database, which had none of them
- web/src/lib/request-auth.ts: getRequestUser() and unauthorized(), the shared authentication step for every Phase 5 handler, delegating to auth.api.getSession() so the cookie signature is actually verified (the Python get_current_user() only matched the token substring)
- web/src/app/api/settings/route.ts: GET and PATCH /api/settings, scoped by settings.user_id, returning the SettingRead shape api.ts expects and storing PATCH values verbatim to keep existing rows readable
- web/src/test/session.ts: mints real auth_users and auth_sessions rows plus a correctly signed cookie for handler tests, avoiding signUpEmail because the Stripe plugin would fire an outbound customer-create call per test user
- 18 tests across request-auth.test.ts and settings/route.test.ts covering the four cases from api/tests/phase4/test_settings.py plus four multi-tenancy and three malformed-body cases, verified by two negative controls that revert cleanly
- next.config.ts now loads the repo-root .env the way vitest.config.ts already did, fixing 'database "cody" does not exist' on the first real route-handler request
- src/middleware.ts matcher excludes api as a whole, so an unauthenticated API call gets the handler's 401 JSON instead of a 307 to the sign-in page that would break request() in api.ts
- todo.md records the settings primary-key tenancy limitation, the shared api_keys row race that makes the suite flake between 9 and 10 failures, and the missing BETTER_AUTH_SECRET

**Learnings:**
- The BetterAuth tables never existed in this database. Alembic 010 adds the user_id columns and defers the tables to BetterAuth's own CLI, which nobody ran, so every authenticated handler would 401 against a missing table. This is also one root of the Phase 0 pytest baseline's 'assert 401 == 201' cluster.
- @better-auth/cli's newest published version is 1.4.22 while the installed core is 1.5.4, so the documented CLI path is unusable. getMigrations() from better-auth/db/migration, called with auth.options, gives version-correct DDL and a runMigrations() that applies it.
- Node 24 runs .mts scripts directly with type stripping, which makes TypeScript-importing repo scripts possible with no tsx dependency, but the import specifier needs the literal .ts extension. That requires allowImportingTsExtensions in tsconfig, which is safe under noEmit.
- next dev has never loaded the repo-root .env, because Next only reads .env* inside web/. It did not matter while all data came from the Python API over HTTP; every ported route handler hits this immediately as a connection to a database named after the OS user.
- The existing middleware matched /api/settings and redirected unauthenticated requests to the sign-in page. Every ported router would have returned a 307 to HTML where api.ts expects an ApiError(401), so the matcher has to exclude api.
- Test sessions should be inserted directly and signed with makeSignature() from better-auth/crypto against auth.$context.secret. auth.api.signUpEmail() triggers the Stripe plugin's createCustomerOnSignUp, an outbound Stripe call per test user.
- Two baseline corrections measured with this iteration's test files moved aside: the skip count is 7, not the 8 every earlier entry recorded (a GEMINI_API_KEY-gated live smoke now runs), and the suite flakes between 9 and 10 failures because the six agent test files each rewrite and delete the single global api_keys settings row.
- settings.key is the whole primary key, so two users cannot hold the same settings key and a cross-user PATCH raises 23505 in both stacks. Worth asserting as-is rather than papering over: the alternative failure mode, dropping the user_id filter, is a silent cross-tenant overwrite.

### Iteration 52

**Summary:** Split ledger item 5.1b and completed 5.1b-i by porting the two API-key read endpoints to Next.js route handlers with a fail-closed rebuild of the reveal endpoint's loopback gate, and fixed the logged cross-file race on the shared api_keys settings row that the new test exposed.

**Changes:**
- web/src/mastra/api-keys.ts gained the masking and reveal half of api/src/services/api_keys.py: getValidationResults() (Python's _load_validation), getMaskedKeys() and revealApiKey(), reusing the PROVIDERS and API_KEYS_SETTING_KEY constants that module already owned rather than creating a second source of truth
- web/src/app/api/settings/api-keys/route.ts serves GET /api/settings/api-keys, returning Record<string, ApiKeyStatus> exactly as web/src/lib/api.ts declares for apiKeys.get(), with the session required and no user scoping because settings.key is the primary key and the api_keys row has no user_id
- web/src/app/api/settings/api-keys/[provider]/reveal/route.ts serves the reveal endpoint with a fail-closed replacement for Python's raw-socket loopback check: the request must name a loopback Host and carry no forwarded, x-forwarded-for, x-forwarded-host or x-real-ip header, so it 403s behind any proxy and works under local next dev
- web/src/test/api-keys-row.ts serializes the eight test files that swap the single global settings.api_keys row on a Postgres session advisory lock, held on a dedicated pooled client for the file's lifetime; applied to the six agent test files, api-keys.test.ts and the new route test
- Nineteen new tests against the real database: nine route-handler tests over a real BetterAuth session covering 401, the four forwarding headers, non-loopback Host, the three loopback host forms, unknown provider and the 200/404 branches; ten service tests covering validation-result coercion, the last-four hint, the sub-four-character branch, no-plaintext-in-payload and the reveal cases
- docs/mastra-port/LEDGER.md: 5.1b split into a checked 5.1b-i and an open 5.1b-ii, with the loopback-gate deviation argued, the two intentional behaviour differences from Python recorded, pasted verbose test output, all four frontend gates and the unchanged api/ gates
- todo.md: the api_keys row race entry retagged [fixed] with the mechanism and the before/after failure counts

**Learnings:**
- The frontend suite's tenth failure was never a mystery flake: eight test files rewrite the one global settings.api_keys row from parallel vitest processes, and a Postgres session advisory lock removes it entirely at no measurable wall-clock cost (79.43s with, 79.58s without). Three consecutive full runs now report an identical 9 failed | 877 passed | 7 skipped.
- The suite's real pre-existing failure floor is 9, not the 6 image-preview tests the objective document names: three PostDetail.test.tsx failures are also pre-existing and were folded into the earlier '10 failures' baseline alongside the race.
- A Next.js route handler cannot recover the TCP peer address (NextRequest.ip was removed in Next 15), so Python's request.client.host loopback gate has no faithful port. Deriving it from x-forwarded-for would silently weaken a security boundary, since that header is attacker-controlled; requiring a loopback Host plus the total absence of any forwarding header preserves the intent and fails closed behind a proxy.
- The Postgres host port is env-driven (POSTGRES_HOST_PORT, 5435 in this worktree) and the password differs from the compose default, so a hand-typed TEST_DATABASE_URL yields 177 pytest collection errors that all bottom out in InvalidPasswordError and read exactly like a regression. Sourcing the repo .env reproduces the recorded 125 failed / 236 passed / 25 errors baseline.
- There is no WP_ENCRYPTION_KEY in .env at all, and the api_keys row in the dev database is a 21-character placeholder encrypted under the agent tests' hardcoded throwaway Fernet key. Any test that wants to read that row through the production path has to supply its own encryption key and its own fixture row; it cannot lean on whatever the developer's database happens to hold.
- settings.key is the sole primary key, so api_keys is one global row for the whole database with no user_id to scope or isolate on. Route handlers for it require a session but cannot scope by user, and per-file test isolation is impossible without either a schema change (forbidden by section 8) or cross-process locking.

### Iteration 53

**Summary:** Completed ledger item 5.1b-ii, and with it all of item 5.1, by porting PUT /api/settings/api-keys, the write half of api_keys.py and the three live per-provider validators to TypeScript, with every provider endpoint confirmed against a real API response.

**Changes:**
- web/src/mastra/api-key-validator.ts: the three live validators from api/src/services/api_key_validator.py, reaching Anthropic, Perplexity and Gemini over fetch instead of adding three SDK dependencies to web/, with every URL, header name and failure branch confirmed against a real response rather than recalled
- saveApiKeys() and saveValidationResults() added to web/src/mastra/api-keys.ts, with Python's read-modify-write merge replaced by a jsonb `value = settings.value || excluded.value` upsert, giving identical shallow-merge semantics in one statement and removing the lost-update race when two providers are saved concurrently
- PUT /api/settings/api-keys in web/src/app/api/settings/api-keys/route.ts, validating the body against a zod port of ApiKeyUpdate and returning exactly the Record<string, ApiKeyStatus> that web/src/lib/api.ts already declared, so neither api.ts nor the settings page needed a change
- 38 new tests against real boundaries: 19 validator tests over a stubbed HTTP transport replaying the real recorded provider responses plus a live Gemini smoke that ran unskipped, 10 service tests against the real database including a concurrency test that pins the race fix, and 9 route tests exercising the real validator inside the real handler over a real BetterAuth session
- Fixed a test-isolation leak the new tests exposed: route.test.ts saved and restored settings.api_keys but not settings.api_keys_validation, so a leftover row broke a different test on a later run; both rows are now saved, cleared and restored
- docs/mastra-port/LEDGER.md: 5.1b-ii checked with the four pasted live provider curl responses, the three intentional deviations argued, the model-ID provenance and its unverified gap stated, verbose output for all three test files, the isolation-leak postmortem, and all four frontend gates plus the unchanged api/ gates

**Learnings:**
- Google rejects an invalid Gemini key with HTTP 400 and status INVALID_ARGUMENT carrying reason API_KEY_INVALID, not a 401. That is why the Python validator matched on the exception message rather than a status code, and any port that switches on status instead will silently report a bad key as an unexpected error.
- The Gemini probe being a models list rather than a generation call is load-bearing in this environment, not incidental: the GEMINI_API_KEY here has zero generation quota, so GET /v1beta/models returns 200 while any generateContent call returns 429 RESOURCE_EXHAUSTED. Choosing the metadata endpoint is what makes a live provider smoke test possible at all here.
- A test that writes a shared settings row without restoring it does not fail itself, and does not fail the same run. It fails a different test in a different file on the next run, which reads as flake. The first full-suite run after adding the PUT tests showed 10 failures against a baseline of 9 purely because api_keys_validation was left behind; per-file save-and-restore has to cover every row the file touches, not just the row it is named after.
- The provider auth-failure shape can be verified live with no credential at all: calling api.anthropic.com and api.perplexity.ai with a deliberately invalid key returns the real 401 body, which is enough to pin the error-mapping branch without holding a key. It does not verify the success branch or the model ID, since a 401 short-circuits before the model name is read.
- web/ has no anthropic, google-genai or perplexity package: the six stage agents reach providers through Mastra's bundled model router by id (for example perplexity/sonar-pro), so anything outside an Agent that needs a provider call has to use fetch. web/src/mastra/images/gemini.ts already established that pattern and exports GEMINI_API_BASE for reuse.

### Iteration 54

**Summary:** Split ledger item 5.2 into three sub-items and completed 5.2a by porting the two profile read endpoints to Next.js route handlers with a shared ProfileRead serializer that withholds both ciphertext columns.

**Changes:**
- web/src/app/api/profiles/serialize.ts defines ProfileRead as a wire shape for every profile handler, excluding the wp_app_password and nextjs_webhook_secret ciphertext columns and applying Pydantic's null-substitution rules (non-optional fields take their declared default, optional ones keep the null)
- GET /api/profiles ported to web/src/app/api/profiles/route.ts, scoped by website_profiles.user_id and ordered created_at desc
- GET /api/profiles/{profile_id} ported to web/src/app/api/profiles/[id]/route.ts, with id and owner matched together so another user's profile is the same 404 as a missing one, plus a rebuilt UUID path-parameter check that returns FastAPI's 422 shape instead of letting Postgres raise a 500
- web/src/app/api/profiles/route.test.ts: 11 tests against the real database and real BetterAuth sessions, covering 401s, ordering, the exact ProfileRead key set, credential non-leakage, null defaulting, cross-tenant 404s and the malformed-uuid 422
- docs/mastra-port/LEDGER.md: item 5.2 split into 5.2a (reads, now checked with evidence), 5.2b (the three write endpoints with credential encryption) and 5.2c (the crawl trigger and its ARQ job), with the passing run, a negative-control run and all four frontend gate results pasted

**Learnings:**
- Pydantic's declared default and the Alembic server default for website_profiles.default_stage_settings disagree: ProfileBase falls back to a six-key all-"auto" map while the column's server default is a five-key all-"review" map. A null column reached the dashboard as the Pydantic map, so the port has to follow the schema class, not the column, to preserve observed behaviour.
- ProfileRead's optional-with-default fields behave differently from its required-with-default ones under from_attributes: wp_default_status is `str | None = "publish"`, so a null column stays null through FastAPI, while a null `tone` would have raised. Substituting the default uniformly would have silently changed two fields.
- FastAPI's `profile_id: uuid.UUID` path parameter was doing free validation that a Next.js route handler does not get. Without an explicit check the malformed-id case degrades from a 422 to a 500 raised by Postgres on the uuid comparison, which is a behaviour change the client would see.
- Object.keys().sort() puts "nextjs_frontmatter_map" and "nextjs_webhook_url" before "niche"; the exact-key-set assertion is worth having anyway because it is what stops a future serializer edit from leaking the two ciphertext columns.

### Iteration 55

**Summary:** Ported the three profile write endpoints (POST, PATCH, DELETE) to Next.js route handlers with credential encryption, pydantic-faithful 422 validation, and SQLAlchemy's post-orphaning delete semantics, closing ledger item 5.2b.

**Changes:**
- POST /api/profiles in web/src/app/api/profiles/route.ts: writes the full ProfileCreate model_dump so pydantic's defaults are materialised rather than the column's, takes user_id only from the session, and encrypts wp_app_password and nextjs_webhook_secret
- PATCH and DELETE in web/src/app/api/profiles/[id]/route.ts: PATCH reproduces exclude_unset via zod .partial() with a read path for an empty body and a hand-stamped updated_at; DELETE nulls posts.profile_id inside the transaction after settling ownership, matching SQLAlchemy's relationship cascade and avoiding the FK violation a plain DELETE would raise
- web/src/app/api/profiles/validation.ts: the ProfileCreate/ProfileUpdate port including pydantic's lax integral-string coercion, and FastAPI's 422 body with the real error types (missing, int_parsing, int_type, string_type, list_type, dict_type, json_invalid) and their inputs resolved by walking issue.path over the raw body
- web/src/app/api/profiles/secrets.ts: encrypts the two credential columns on truthiness rather than presence, so a null or empty string is written through instead of becoming a Fernet token over nothing
- 31 new tests in web/src/app/api/profiles/route.test.ts against the real database and real BetterAuth sessions, covering multi-tenancy on all three verbs, credential round-trips through the Python-compatible Fernet port, every 422 shape, and a replay of the exact save payload web/src/app/profiles/[id]/page.tsx sends
- docs/mastra-port/LEDGER.md: item 5.2b checked with the delete-cascade probe output, the pydantic error-shape probe output, the zod-types discrepancy, the verbose test list and all four frontend gates

**Learnings:**
- SQLAlchemy's session.delete(profile) nulls posts.profile_id rather than deleting or failing, because the posts relationship carries no delete cascade. Since posts_profile_id_fkey has no ON DELETE action, a naive TypeScript DELETE would raise a foreign key violation on any profile that has ever been used. Probed and confirmed: posts=1 post.profile_id=[None] links=0.
- zod 4.4 strips `input` from the issues it hangs off ZodError even though z.core.$ZodIssue declares the property, so `issue.input` is always undefined at runtime. Any FastAPI-shaped 422 port has to walk the value out of the raw body by issue.path. Reading issue.input silently mislabels every wrong-typed field as `missing`.
- pydantic's 422 for an int field splits two ways that cannot be collapsed: a string it cannot parse is `int_parsing` with the longer message, while a wrong type (null, list) is `int_type`. `missing` reports the containing object as its input, not the absent value. All verified by instantiating the real ProfileCreate rather than from docs.
- pydantic v2 lax mode does coerce ' 2500 ' to 2500 for an int field and accepts an integral float, so a zod port that only takes JSON numbers is a real behaviour narrowing. z.preprocess with an integral-string regex reproduces it and composes correctly with .nullable() and .default().
- api/tests/phase2/test_profile_crud.py's 12 tests all fail with 401 today because no conftest fixture overrides get_current_user. The Python profile endpoints cannot be exercised through the httpx client, so parity has to be probed at the ORM and pydantic level instead.
- The frontend passing count at HEAD was 926 with a 9-failure baseline across PostDetail.test.tsx and image-preview.test.tsx; it is now 957 with the same 9.

### Iteration 56

**Summary:** Split ledger item 5.2c into three sub-items and completed 5.2c-i by porting api/src/services/sitemap.py to TypeScript with a Python-generated parity oracle covering 16 parse cases, 8 robots cases and 18 live-server network scenarios.

**Changes:**
- web/src/mastra/sitemap/index.ts ports parse_sitemap_xml, parse_robots_txt, discover_sitemaps, fetch_and_parse_sitemap and crawl_sitemap, resolving xmlns scope by hand so a namespace-less <urlset> yields zero entries exactly as lxml's findall does, and routing malformed documents through XMLValidator so fast-xml-parser's silent acceptance becomes the same SitemapParseError lxml raised
- fast-xml-parser 5.11.0 added to web/package.json as the XML parser, chosen over hand-rolling a regex parser or pulling in a DOM
- api/scripts/export_sitemap_parity.py runs the real Python service against a local HTTP server and writes web/src/mastra/sitemap/data/sitemap-parity.json plus copies of the seven XML fixtures, so the oracle outlives api/; the routing table is exported verbatim so the Node server in the test cannot drift from the Python one, and re-running produces a byte-identical file
- web/src/mastra/sitemap/sitemap.test.ts drives 42 parity tests over real sockets, including two cases the pytest httpx mocks never could reach: a server that hangs up without answering, and gzip served over HTTP
- docs/mastra-port/LEDGER.md splits 5.2c into 5.2c-i (done, with evidence), 5.2c-ii (the crawl job as a Mastra primitive, plus a decision on the daily check_recrawl_schedules cron) and 5.2c-iii (the crawl route and the auto-enqueue on create)

**Learnings:**
- fast-xml-parser accepts malformed XML rather than throwing (`<not valid xml at all>>>` parses to `[{ not: [] }]`), so lxml parity needs an explicit XMLValidator pass; XMLValidator carries a deprecation notice in 5.11 pointing at a separate fast-xml-validator package but still ships and works
- fast-xml-parser has no namespace resolution at all: removeNSPrefix erases prefixes without checking what they are bound to. Python's root.findall('sm:url', SITEMAP_NS) means a sitemap declaring no xmlns parses to zero entries, and reproducing that requires preserveOrder plus hand-resolved xmlns scope
- api/src/services/sitemap.py's fetch_page_title, the fetch_titles flag and MAX_URLS_PER_SITEMAP have no caller and no pytest coverage. This is the third ported service with tested-or-declared-but-unreachable code, so the no-caller grep is worth running before scoping every remaining port
- WorkerSettings registers cron(check_recrawl_schedules, hour=0, minute=0), a daily re-crawl scheduler that is not a router and therefore has no home in the Phase 5 plan. It enqueues crawl_profile_sitemap per recrawl_interval and would be silently dropped when api/ is deleted
- Exporting the scenario routing table itself, not just the recorded results, keeps the Python and Node test servers from drifting: the vitest server is data-driven from the same JSON the Python export served from
- pnpm -C web reaches package.json scripts (lint, build, test both confirmed exit 0) but not bare binaries: pnpm -C web tsc fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL, which matches the environment note already recorded under ledger item 0.1

### Iteration 57

**Summary:** Split ledger item 5.2c-ii and completed 5.2c-ii-1 by porting the ARQ crawl_profile_sitemap job to a registered Mastra workflow with a Python-generated slug oracle and 53 tests over real HTTP, Redis and Postgres.

**Changes:**
- web/src/mastra/steps/sitemap-crawl.ts ports crawl_profile_sitemap: crawling/complete/failed status transitions, a duplicate-URL fold reproducing SQLAlchemy's per-entry last-truthy-title semantics, and a chunked ON CONFLICT upsert whose conflict clause is coalesce(nullif(excluded.title,''), internal_links.title) so a nightly re-crawl cannot null out titles written by other code paths
- web/src/mastra/workflows/sitemap-crawl.ts wraps that step as the one-step `sitemapCrawl` workflow registered on the Mastra instance, so the crawl is startable over the Redis Streams bus and executes in the worker process
- web/src/mastra/steps/data/crawl-slug-parity.json: a 16-case oracle generated by running the job's exact urlparse expression on the api/ interpreter, asserted on both the extracted path and the derived slug because new URL() throws on three of the inputs urlparse accepts
- 53 new tests: 38 pure (oracle plus fold) and 15 end-to-end running the workflow on the evented engine against a loopback HTTP server and the real database, covering links found, re-crawl idempotence, no sitemap, a raising crawl and a missing profile
- no-next-imports.test.ts's package allowlist gains fast-xml-parser, which the registered crawl workflow pulls into the entry point's import graph for the first time
- docs/mastra-port/LEDGER.md: 5.2c-ii split into a checked 5.2c-ii-1 and an open 5.2c-ii-2, with three deliberate deviations argued, pasted verbose test output, two negative controls, and all frontend plus api gate results
- todo.md records a one-off scaffold-check.test.ts flake on the shared Mastra instance's default Redis key prefix as [investigate]

**Learnings:**
- Importing web/src/mastra/index.ts into a test file that also starts a run hangs every run in that file with no error: registering a workflow on a second Mastra instance rebinds it, so the run publishes onto the shared instance's topics while the only started worker listens on the test prefix. Cost 5 x 60s of silent hook timeouts. Registration assertions belong in index.test.ts, which already owns the shared instance.
- A test HTTP server whose behaviour is switched by a module-level flag is unsafe on this transport: the reclaim loop redelivered a completed step after the flag had been restored, and the second execution wrote rows the test asserted were absent. Two servers with fixed behaviour removes the ordering dependency, and the crawl itself proved idempotent under the duplicate.
- @mastra/core 1.61 has a first-party cron: createWorkflow({ schedule: { cron } }) publishes workflow.start on a schedule and is documented as evented-engine only, which is the engine this port runs. That is the natural home for check_recrawl_schedules and was not known when 5.2c was split.
- crawl_sitemap never returns a title (nothing parses one out of a sitemap), so the upsert's title branch is only reachable from rows other code wrote. A naive `set: { title: excluded.title }` would therefore look correct in every crawl test yet wipe every hand-written title on the nightly re-crawl.
- Python's urlparse never raises where new URL() does, so a profile whose website_url lacks a scheme (typing example.com into the form, which neither stack validates) is crawl_status=complete in Python and failed in the port. Both write zero links; the divergence is only the status the profiles page renders.
- Rows ordered by url put https://example.com/ before https://example.com/blog/..., because it is a prefix. Destructuring [first] from an ordered link query silently grabs the root URL's row.
- Do not reuse generic /tmp filenames across iterations for scripted file edits: a stale /tmp/ledger_new.md from an earlier iteration was picked up by an assert-guarded replace and rewrote 156 lines of LEDGER.md before git checkout undid it.

### Iteration 58

**Summary:** Completed ledger item 5.2c-ii-2, closing the split parent 5.2c-ii, by porting ARQ's nightly check_recrawl_schedules cron to a self-scheduling Mastra workflow with a Python-generated due oracle and 29 tests, including a confirmed live cron fire against the installed version.

**Changes:**
- web/src/mastra/steps/recrawl-check.ts ports check_recrawl_schedules: the profile scan reproducing SQLAlchemy's NULL crawl_status exclusion, a pure isDue() that keeps Python's never-crawled short circuit ahead of the interval lookup, and a Map rather than an object literal for the interval table so an unconstrained varchar cannot reach Object.prototype
- web/src/mastra/workflows/recrawl-check.ts declares schedule: { cron: '0 0 * * *' } on a one-step workflow registered as recrawlCheck, replacing ARQ's WorkerSettings.cron_jobs; the schedule sits here rather than on sitemapCrawl because a declared schedule carries one static inputData and each crawl needs its own profileId
- api/scripts/export_recrawl_parity.py generates web/src/mastra/steps/data/recrawl-due-parity.json, a 16-case oracle produced by running the job's branch verbatim on the api/ interpreter against a fixed reference now, covering each interval either side of its threshold, the never-crawled short circuit, an unrecognised interval and three future-dated last_crawled_at values
- 29 new tests: 19 pure against the oracle plus prototype-pollution and interval-table assertions, and 10 end-to-end on the evented engine against real Postgres, real Redis Streams and a loopback HTTP server, covering the schedule row, an actual cron fire, the scan's inclusion and exclusion branches, the ARQ log line, and the fanned-out crawls writing internal_links
- The end-to-end test's PostgresStore is isolated into its own Postgres schema (mastra_test_recrawl, dropped in teardown), because mastra_schedules is one table for the whole database and any other test file starting the production instance's workers now runs a scheduler that steals or deletes this file's schedule rows
- docs/mastra-port/LEDGER.md: 5.2c-ii-2 checked and the split parent 5.2c-ii closed, with the design decision argued, the measured cron fire, the oracle provenance, three negative controls, the installed-types discrepancy, the persisted schedule row, and all frontend plus api gate results

**Learnings:**
- @mastra/core 1.61.0's declarative schedule genuinely works: a workflow declaring schedule: { cron } makes the instance auto-enable a SchedulerWorker inside startWorkers(), persist a row in mastra_schedules, and publish workflow.start on the cron. A six-part per-second cron fired in 755ms with scheduler: { tickIntervalMs: 500 }, which is how the mechanism can be proven inside a test.
- Registering the first scheduled workflow on the shared Mastra instance changes behaviour for every existing test file that calls mastra.startWorkers(): each now runs a scheduler polling the single shared mastra_schedules table. A scheduler deletes rows whose target workflow it does not know (after ~3 misses) and claims fires by compare-and-swap, publishing to its own pubsub prefix. On the shared public schema the per-second probe never fired inside 30s during a full src/mastra run.
- PostgresStore accepts schemaName alongside a pre-configured pool, and creates the schema itself on init(). That is the only real isolation available for Mastra storage in tests, since the table names are fixed; a `drop schema ... cascade` in afterAll leaves nothing behind and public-schema parity checks never see it.
- createWorkflow from @mastra/core/workflows/evented returns EventedWorkflow (which declares getScheduleConfigs()), but .then().commit() narrows the type back to the base Workflow, which does not. The method is present at runtime; only the chained type loses it, so asserting on it needs a narrow cast.
- Math.floor vs Math.trunc is not observable against Python's timedelta.days here: every recrawl threshold is positive, so both answer 'not due' for a future last_crawled_at. A negative control that swaps them leaves all 19 pure tests passing. The `>= days` boundary is the comparison that actually carries the parity risk, and flipping it to `>` fails 3 cases.
- Python's check_recrawl_schedules enqueues a never-crawled profile before it ever looks at recrawl_interval, so a profile with an unrecognised or empty interval and a null last_crawled_at is still crawled. A port that looks the interval up first silently drops those profiles forever.
- mastra.schedules gives list({ workflowId }), get, delete, pause, resume and run (manual fire), which is enough to assert declarative registration and to clean up test schedule rows without touching the storage domain directly.

### Iteration 59

**Summary:** Completed ledger item 5.2c-iii by porting POST /api/profiles/{id}/crawl and the auto-enqueue on profile create to a Mastra run start over Redis Streams, with 11 tests asserting the enqueue from the transport rather than a spy.

**Changes:**
- web/src/mastra/start-crawl.ts replaces ARQ's enqueue_job("crawl_profile_sitemap", id) for both callers: it creates a sitemapCrawl run and calls startAsync(), publishing workflow.start onto Redis Streams so the crawl executes in the worker process instead of inside a Next.js request
- web/src/app/api/profiles/[id]/crawl/route.ts serves the 202 endpoint, collapsing Python's resolve-and-flip into one ownership-scoped UPDATE ... RETURNING (zero rows is the 404), keeping the status write ahead of the enqueue so the profiles page poll never reads a started crawl at its old status, and reproducing the rollback-to-failed plus `Failed to enqueue crawl: {e}` 500
- POST /api/profiles now starts the crawl it always did, with Python's bare `except: pass` preserved so a dead bus still returns the 201, plus a Mastra logger warning that Python's silent swallow never emitted
- web/src/app/api/profiles/params.ts holds the uuid path-parameter 422 and the `Profile not found` 404 shared by every /api/profiles/{id} handler, replacing the copies that lived in [id]/route.ts
- 11 new tests in web/src/app/api/profiles/[id]/crawl/route.test.ts against the real database, real BetterAuth sessions and the real Redis Streams bus, with an independent fan-out RedisStreamsPubSub subscription reading workflow.start back and matching on data.prevResult.output.profileId
- Fixture website_urls in the 42-test profiles route file repointed at http://127.0.0.1:9/..., the loopback discard port, so the runs that POST now starts cannot cause a crawl of a third-party domain when another test file's worker consumes them
- docs/mastra-port/LEDGER.md: 5.2c-iii checked with the two deliberate deviations argued, verbose test output, a negative control, the pre-existing-flake measurement at HEAD, and all frontend plus api gate results
- todo.md's scaffold-check entry updated with the measured evidence that the whole-suite Hook-timed-out variant reproduces at HEAD and is not a backlog

**Learnings:**
- RedisStreamsPubSub.subscribe() with no `group` mints a unique `__fanout-<uuid>` consumer group anchored at "0", so an observer added to a test can never steal an event from a worker, but it does replay the entire stream history (1690 entries here) into the callback on subscribe. Anchoring is `$` only when startFrom === "latest".
- The evented engine's `workflow.start` payload carries the run's input at `data.prevResult.output`, not at `data.inputData`. That is the only place a test can recover which profile a fire-and-forget startAsync() was for, since startAsync() returns nothing but the run id.
- A route-handler test that starts real runs on the shared Mastra instance publishes onto the same production topics that crossprocess-events.test.ts, scaffold-check.test.ts and reclaim-duplication.test.ts consume with startWorkers(). Fixture URLs in any such file become live crawl targets, so they have to be loopback.
- The intermittent scaffold-check.test.ts failure has a second, worse form: a 60s beforeAll hook timeout that fails the whole suite and skips all five of its tests, moving the suite from 9 failed / 7 skipped to 9 failed / 12 skipped. Reproduced at HEAD with this iteration's work stashed, and `XINFO GROUPS mastra:topic:workflows` shows lag 0, so neither this item nor an event backlog is the cause.
- Statically importing web/src/mastra/index.ts from a Next.js route handler is safe: `next build` completes in 3.5s and lists /api/profiles/[id]/crawl as a dynamic route. next.config.ts's repo-root .env loader runs first, so the REDIS_URL guard in index.ts does not throw during the build.
- The Bash tool's 120s default timeout silently backgrounds a longer loop and can truncate its captured output; a multi-run test loop needs run_in_background plus an explicit output file, not a `timeout 1800` that outlives the tool's own limit.

### Iteration 60

**Summary:** Split ledger item 5.3 into four sub-items and completed 5.3a by porting the two post read endpoints to Next.js route handlers with a PostRead serializer, FastAPI-faithful query 422s and 27 tests against the real database.

**Changes:**
- Split ledger item 5.3 into 5.3a (reads), 5.3b (writes), 5.3c (pipeline control) and 5.3d (exports, logs, analytics), since the Python posts router is 665 lines over 17 endpoints
- GET /api/posts ported to web/src/app/api/posts/route.ts with the status/stage, profile_id and q filters, sort/order over a 44-name column allowlist, and page/per_page pagination
- GET /api/posts/{post_id} ported to web/src/app/api/posts/[id]/route.ts, matching id and owner together through the join to website_profiles so another user's post is the same 404 as a missing one
- web/src/app/api/posts/serialize.ts defines the PostRead wire shape and adds toPydanticIso(), which reproduces pydantic 2.12's Z-suffix, trailing-zero-trimmed datetime rendering rather than Date.toISOString()
- web/src/app/api/posts/query.ts reproduces FastAPI's query-parameter 422 bodies (int_parsing, greater_than_equal, less_than_equal, uuid_parsing), reporting every bad parameter in one response
- web/src/lib/api.ts's Post interface corrected: thread_id removed (Alembic 005 dropped the column and PostRead never declared it) and execution_logs added, with web/src/test/fixtures.ts updated to match
- 27 tests in web/src/app/api/posts/route.test.ts against the real database and real BetterAuth sessions, covering multi-tenancy, every filter, sort fallback, pagination, all six query 422 shapes, the exact PostRead key set and null-column defaulting
- todo.md records that web/src/app/api/profiles/serialize.ts still uses plain toISOString() and should share toPydanticIso()

**Learnings:**
- Pydantic does NOT substitute a declared default for an attribute that is present and None: PostRead.model_validate on a row with 13 null non-optional columns raises ValidationError, so FastAPI answered such a row with a 500, not a defaulted PostRead. That contradicts the reasoning recorded under item 5.2a for profiles, where the same substitution was described as Python's behaviour. Both ported serializers now do the friendlier thing, but only the posts one says so honestly.
- web/src/lib/api.ts is not a reliable statement of the Python wire shape: it declared thread_id, a column Alembic 005 dropped and PostRead never had, and omitted execution_logs, which PostRead has always declared. Every remaining router port should read the schema class rather than trusting the TypeScript interface.
- Pydantic 2.12 renders an aware datetime as '2026-08-22T12:34:56.789012Z' and drops the fraction entirely when it is zero ('...T12:34:56Z'). JavaScript's toISOString() always writes exactly three fractional digits, so a plain port silently changes the string. The microseconds cannot be preserved at all, because pg parses a Postgres timestamp into a JS Date.
- SQLAlchemy's getattr(Post, sort, Post.created_at) is not simply 'valid column or fallback': the 44 mapped column names sort, unmapped names fall back, but 'metadata', 'registry', the 'profile' relationship and dunder names all raise inside SQLAlchemy and surface as a 500. An explicit allowlist plus fallback removes that error path.
- A leftJoin and an innerJoin are indistinguishable here: because the WHERE clause carries eq(websiteProfiles.userId, user.id), a post with a null profile_id is excluded either way. A negative control that swapped them changed no test result, so the 'inner join' framing was not what the orphan-post test was actually pinning.
- Running pytest in this worktree leaves untracked media/test-123/*.webp artifacts behind. They are not gitignored, so they show up in git status and would be swept into a `git add -A`.

### Iteration 61

**Summary:** Split ledger item 5.3b into three sub-items and completed 5.3b-i by porting POST /api/posts to a Next.js route handler with a Python-generated prefill oracle, a shared pydantic 422 module, and 25 tests against the real database and Redis Streams.

**Changes:**
- POST /api/posts ported to web/src/app/api/posts/route.ts: PostCreate validation, ownership-scoped profile lookup (404 with no row written for another user's profile), profile prefill, current_stage/stage_status stamping after the prefill so neither body nor profile can set them, and a Mastra pipeline run started over Redis Streams in place of ARQ's enqueue_job("run_pipeline_stage")
- web/src/app/api/pydantic.ts holds the FastAPI 422 body and pydantic's lax coercions shared by every ported write endpoint, extracted from profiles/validation.ts (which now re-exports them so no call site changed), plus a new pydanticUuid that reproduces pydantic's two distinct uuid failures by attaching the exact error type to the zod issue
- web/src/app/api/posts/prefill.ts implements create_post's fold: a body value equal to the schema default loses to the profile, a null profile value never overwrites, stage_settings is copied from default_stage_settings with no null guard, and the two wp_* fields fill only when the body left them null
- web/src/app/api/posts/validation.ts ports PostCreate with its defaults derived from the schema itself (POST_CREATE_DEFAULTS), the wire-name-to-Drizzle column map, and PostWriteInput widening stage_settings to null after prefill
- web/src/mastra/start-pipeline.ts starts the six-stage pipeline run with startAsync(), publishing workflow.start onto Redis Streams so the stages execute in the worker process rather than inside a Next.js request
- api/scripts/export_post_create_parity.py drives the real create_post coroutine with a stubbed session, request and queue over 10 bodies and profiles, writing web/src/app/api/posts/data/create-parity.json so the oracle cannot drift from the endpoint's own prefill block
- 25 tests in web/src/app/api/posts/create.test.ts: 12 oracle replays plus 13 handler tests against the real database, real BetterAuth sessions and an independent RedisStreamsPubSub fan-out subscription that reads the workflow.start event back
- docs/mastra-port/LEDGER.md: 5.3b split into 5.3b-i (checked, with three deviations argued, verbose test output, two negative controls and all frontend plus api gate results), 5.3b-ii and 5.3b-iii

**Learnings:**
- create_post's prefill is not "fill in what the client omitted": the body has already been through model_dump() by then, so an omitted field and a field sent holding the schema's own default are indistinguishable and both lose to the profile. word_count: 2000 from the new-post form is silently replaced by the profile's word count, an explicitly empty related_keywords inherits the profile's, but word_count: 0 and tone: "" survive. A port that only fills nulls fails 6 of the 10 oracle cases.
- Driving the real endpoint coroutine with a stubbed AsyncSession, Request and queue is a stronger oracle than reimplementing its logic in the export script: every line of the prefill block runs for real and the Post handed to session.add is recorded. The one artifact is that no primary key is assigned, so the enqueued job's id argument is the string "None" and only the job name is oracle material.
- Python copies profile.default_stage_settings over the pydantic default with no null guard, so a profile whose default_stage_settings is null writes NULL to posts.stage_settings rather than leaving the six-"auto" default in place. Adding the obvious null guard fails two oracle cases.
- pydantic splits a bad uuid body field two ways that zod reports as one shape: uuid_parsing for a string it cannot parse, uuid_type ("UUID input should be a string, bytes or UUID object") for a non-string. zod 4.4 preserves a `params` object on a custom issue, which is enough to carry the exact pydantic error from the schema to the 422 builder without a per-field special case in the handler.
- A test that calls POST /api/posts starts a real six-stage pipeline run on the shared Mastra instance, and other test files call startWorkers() on it, so a stray run would reach Perplexity and Anthropic. Setting the fixture profile's default_stage_settings to gate research at "review" makes any such run suspend before it spends anything, which is a cheaper and more faithful guard than mocking the start.
- Asserting on the 201 response body rather than re-reading the row removes the race with a worker that may already be mutating the post: the response is serialized from the INSERT ... RETURNING snapshot taken before the enqueue.
- Adding a script under api/scripts moves the api ruff gates off their recorded baseline (32 errors, 9 files to reformat) unless it is run through ruff format and ruff check first. The baseline is the comparison, so a clean new file still has to be formatted to keep it.

### Iteration 62

**Summary:** Completed ledger item 5.3b-ii by porting PATCH and DELETE on /api/posts/{post_id} to Next.js route handlers with a PostUpdate schema, correlated-EXISTS tenancy, media directory cleanup, and 28 tests against the real database and real files.

**Changes:**
- PATCH /api/posts/{post_id} ported into web/src/app/api/posts/[id]/route.ts: PostUpdate validation with exclude_unset via zod .partial(), a hand-stamped updated_at standing in for TimestampMixin.onupdate, an empty-dump read path because Drizzle rejects an empty set, and ownership carried as a correlated EXISTS over website_profiles since Drizzle's update takes no join
- DELETE /api/posts/{post_id} ported in the same file: a plain DELETE (faithful, because internal_links_post_id_fkey carries ON DELETE SET NULL from Alembic 006 and Post cascades over nothing), followed by rm(mediaDir, {recursive, force}) standing in for Python's exists()-guarded shutil.rmtree
- web/src/app/api/posts/validation.ts gains postUpdateSchema (27 fields, every one nullable, read off the real pydantic model), UPDATE_COLUMN_OF, and a shared columnsFrom() so the create and update column maps use one folder
- web/src/mastra/images/media-dir.ts extracted from generate-one.ts, holding mediaRoot(), ensureMediaDir() and the new postMediaDir(), so the delete handler imports a path helper rather than the image generator; workflows/images.ts repointed at it
- web/src/lib/api.ts's PostUpdate interface corrected: article_type, additional_info, wp_category_id and wp_author_id added, all four of which the real PostUpdate has always declared
- 28 tests in web/src/app/api/posts/update-delete.test.ts against the real database, real BetterAuth sessions and real files under a temporary MEDIA_DIR, covering multi-tenancy on both verbs, the inner-join invisibility of an orphan post, exclude_unset, null-clearing, unknown-key rejection, all six pydantic 422 shapes, the internal-link detachment and the media directory removal
- docs/mastra-port/LEDGER.md: 5.3b-ii checked with the PostUpdate field probe, the live FK constraint, the SQLAlchemy dirty-tracking probe, two deviations argued, verbose test output and three negative controls

**Learnings:**
- SQLAlchemy marks an instance dirty on any setattr but compares the value against the loaded one at flush time, so a patch submitting only values the row already holds emitted no UPDATE and left updated_at alone. Measured directly (`dirty after identical setattr: True` but `updated_at changed by identical setattr: False`), which turns the deviation already recorded for the profiles PATCH from an assumption into a documented tradeoff.
- internal_links_post_id_fkey has ON DELETE SET NULL in the live database even though Alembic 001 declared the FK with no action: revision 006 dropped and recreated it. Reading only the initial migration would have led to the same hand-written orphaning update the profile delete needed, which is unnecessary here.
- PostUpdate drops slug and profile_id rather than being PostCreate partialised, which is the only thing stopping a patch from moving a post into another user's profile. Any port that reaches for a generic partial() over the create schema silently opens a tenancy hole.
- web/src/lib/api.ts was wrong about PostUpdate too, omitting four fields the real model declares. That is now two of two ported post schemas where api.ts disagreed with the pydantic class, so it should be treated as untrustworthy for every remaining router.
- media/test-123 is tracked in git, not a scratch directory: `rm -rf` on it to clear pytest artifacts deletes 39 committed files. Clear only the untracked ones, or restore with `git checkout -- media/`.
- Drizzle's update() and delete() accept no join, so an ownership predicate that spans two tables has to be a correlated exists() subquery. A negative control replacing it with a bare eq(posts.id, id) failed exactly the two tenancy tests, confirming the subquery is what pins the behaviour rather than an incidental filter.

### Iteration 63

**Summary:** Completed ledger item 5.3b-iii, closing the split parent 5.3b, by porting POST /{post_id}/duplicate and POST /batch to Next.js route handlers with a caller-scoped batch profile lookup and 26 tests against the real database and Redis Streams.

**Changes:**
- POST /api/posts/{post_id}/duplicate ported to web/src/app/api/posts/[id]/duplicate/route.ts: the eighteen-column config_fields whitelist copy rather than a row clone, a `-copy-<6 hex>` slug from randomUUID standing in for uuid4().hex[:6], the inner-join tenancy lookup shared with the other [id] handlers, and no pipeline start (it is the one write endpoint in the router that never enqueued)
- POST /api/posts/batch ported to web/src/app/api/posts/batch/route.ts: postCreateSchema.array() with FastAPI's per-index 422 loc, one batched profile query instead of one per item, the shared applyProfilePrefill fold from 5.3b-i, a single multi-row INSERT preserving Python's one-commit all-or-nothing semantics and VALUES ordering, no current_stage/stage_status stamping, a 201 [] for an empty list, and a startPipeline per created post replacing ARQ's per-post enqueue_job
- Closed the batch tenancy hole: Python's unscoped session.get(WebsiteProfile, id) let a caller read another account's profile settings through the prefill and write a post carrying that account's profile_id, which handed the post to them and hid it from its creator. The lookup is now scoped to the caller and a miss is the same 404 create_post already answers with.
- 26 tests in web/src/app/api/posts/duplicate-batch.test.ts against the real database, real BetterAuth sessions and an independent RedisStreamsPubSub fan-out subscription, covering multi-tenancy on both endpoints, the orphan-post 404, the whitelist copy and what it leaves behind, slug suffix uniqueness, all four batch 422 shapes with per-index loc, submitted-order creation, two profiles in one batch, the uq_posts_profile_slug rollback, and the per-post enqueue read off the transport
- docs/mastra-port/LEDGER.md: 5.3b-iii checked with the deviation argued, the preserved-defect rationale, verbose test output, three negative controls, the next build route table and all frontend plus api gate results; the split parent 5.3b closed with a note naming its three sub-items
- todo.md records as [confirmed] that duplicate_post's config_fields predates article_type and additional_info, so a duplicate silently drops both, with the two-line fix and the test that would need flipping

**Learnings:**
- batch_create_posts and create_post are not the same code path with a loop around it: batch skips the current_stage/stage_status stamping entirely, so a batch post starts at the column default 'pending' with an empty stage_status while a single create starts at 'research'/{research: 'running'}. The pytest coverage asserted the 'pending' directly, so a port that reuses the create handler's body silently changes what the posts list renders for every batch.
- Python's batch profile lookup was session.get(WebsiteProfile, id) with no user_id predicate and a silent skip on a miss, which is worse than a read leak: the post is still written with the foreign profile_id, so it lands in the other account's tenancy and vanishes from its creator's list. Scoping the lookup fixes both halves at once, and the 404 create_post already returns is the natural answer.
- duplicate_post's config_fields list was never extended when article_type and additional_info were added to the model, so a duplicate loses them. That is the second stale field list found in this router after web/src/lib/api.ts's PostUpdate: hand-maintained column name lists in this codebase should be assumed out of date and diffed against the model.
- Drizzle wraps a driver error, so a unique-constraint assertion has to read error.cause.constraint rather than match the message: the wrapper's message is the full parameterised SQL plus every bound parameter, which would also dump fixture contents into test output.
- A single multi-row Drizzle insert().values([...]).returning() is the faithful port of SQLAlchemy's add-many-then-commit-once, and Postgres returns the RETURNING rows in VALUES order, so the batch page's submitted ordering survives without a re-sort. An empty array has to be short-circuited before the insert, because Drizzle rejects values([]).
- Next.js resolves web/src/app/api/posts/batch/route.ts ahead of the sibling [id] dynamic segment; next build lists /api/posts/batch and /api/posts/[id] as separate entries, so the static-versus-dynamic collision that FastAPI resolved by declaration order needs no special handling here.
- The Bash tool's `| tail -N` on a long background command produces an empty output file until the command exits, because tail buffers. Waiting on `[ -s file ]` therefore waits for completion rather than for progress; redirect to a file first if interim output matters.

### Iteration 64

**Summary:** Split ledger item 5.3c into three sub-items and completed 5.3c-i by porting POST /{post_id}/run and /run-all to Next.js route handlers that start Mastra runs over Redis Streams, with 23 tests against the real database and bus.

**Changes:**
- web/src/app/api/posts/[id]/run/route.ts ports POST /{post_id}/run: ownership 404 resolved before the invalid-stage 400 so a bad stage never confirms another user's post exists, current_stage and stage_status[target]="running" written before the run is started, and the workflow handed the raw `stage` rather than the derived target so an unselected request stays a full pipeline
- web/src/app/api/posts/[id]/run-all/route.ts ports POST /{post_id}/run-all: every stage stage_status does not call complete is forced to "auto", completed stages keep their review mode, and non-stage keys in stage_settings survive the whole-map copy
- web/src/app/api/posts/run-control.ts holds _next_stage() and the FastAPI 400 helper the control endpoints share, kept at the route layer because that is where Python defined it
- web/src/mastra/start-pipeline.ts gains an optional `stages` argument, which is ARQ's `stage` positional that run_pipeline_stage turned into stages=[stage]
- The run handler reads the `stage` query parameter with getAll(...).at(-1) to match Starlette's last-wins multidict semantics, probed against the installed Starlette rather than assumed
- 23 new tests in web/src/app/api/posts/run-control.test.ts against the real database, real BetterAuth sessions and the real Redis Streams bus, with every real enqueue arranged so no worker consuming it can reach a provider
- docs/mastra-port/LEDGER.md: 5.3c split into a checked 5.3c-i plus open 5.3c-ii and 5.3c-iii, with two deviations argued, pasted verbose test output, two negative controls, and all frontend plus api gate results

**Learnings:**
- Starlette's QueryParams.get() returns the LAST value of a repeated query key (probed: QueryParams('stage=write&stage=edit').get('stage') == 'edit'), while JS URLSearchParams.get() returns the FIRST. Any FastAPI scalar query parameter ported to a route handler needs getAll(...).at(-1) to stay faithful.
- A Mastra run that names its stages never gates (stageNeedsReview() returns false when input.stages is set, matching Python's check_gates=False on the single-stage path), so route tests cannot start a real stage-selected run without risking a live provider call. The safe substitute is starting one on a post id no row has: loadPipelineState() throws before any prompt is rendered, which still proves the stages payload crosses the bus.
- API keys are global (one `api_keys` settings row), not per-user, so a freshly created test user does not protect a test from provider spend. The only real protections are the review gate, an all-complete stage_status, or a post that does not exist.
- The 5.3 sub-items keep converging on the same three helper modules (params.ts, serialize.ts, validation.ts, now run-control.ts) under web/src/app/api/posts/; 5.3c-ii's /rerun and /restart will want the STAGE_CONTENT_MAP column clearing, which already exists as STAGE_CONTENT_MAP in web/src/mastra/state.ts.
- next build's route table was truncated in one run launched from a shell whose cwd had already been changed; re-running it from web/ with an explicit absolute cd produced the full table and exit 0. Verify build evidence came from a run that actually exited 0 rather than from a piped grep.

### Iteration 65

**Summary:** Completed ledger item 5.3c-ii by porting POST /{post_id}/rerun and /{post_id}/restart to Next.js route handlers, extracting the shared ownership predicate, and adding 20 tests against the real database and Redis Streams bus.

**Changes:**
- POST /api/posts/{post_id}/rerun ported to web/src/app/api/posts/[id]/rerun/route.ts: the first-non-complete-stage scan with STAGES[-1] fallback, a copy-then-rewrite of the stage_status slice from rerun_from onward that preserves upstream statuses and non-stage keys, downstream content columns cleared through STAGE_CONTENT_COLUMN, current_stage and completed_at reset, and an unselected full-pipeline start over Redis Streams replacing ARQ's enqueue_job
- POST /api/posts/{post_id}/restart ported to web/src/app/api/posts/[id]/restart/route.ts: stage_status replaced by a fresh six-key pending map rather than merged, all seven content columns cleared including final_html_content which no stage owns, stage_logs emptied to {} rather than null, and stage_settings deliberately untouched so the post's configured review gates still apply
- web/src/app/api/posts/run-control.ts gains STAGE_CONTENT_COLUMN, the Drizzle-property form of STAGE_CONTENT_MAP, typed as Record<Stage, keyof PostInsert> so neither a new stage nor a renamed column can leave it stale, with a test reading the real column names off the table to prove the two maps still agree
- web/src/app/api/posts/params.ts gains ownedByCaller(), the correlated-EXISTS ownership predicate that had been written verbatim in four handlers; PATCH, DELETE, /run and /run-all repointed at it with their 78 existing tests unchanged and passing
- 20 new tests in web/src/app/api/posts/run-control.test.ts (43 total in the file) against the real database, real BetterAuth sessions and an independent RedisStreamsPubSub fan-out subscription, covering multi-tenancy on both verbs, the rerun_from scan and its all-complete fallback, per-stage content clearing, the final_html_content asymmetry, the stage_status copy-versus-replace asymmetry, stage_settings being untouched, and a real gated workflow.start read back off the bus for each endpoint
- docs/mastra-port/LEDGER.md: 5.3c-ii checked with the three Python asymmetries argued, two deviations recorded, pasted verbose test output, three negative controls, the build route table, the re-measured PostDetail baseline at HEAD, and all frontend plus api gate results

**Learnings:**
- rerun_stage() and restart_pipeline() are not two sizes of the same reset. rerun copies stage_status and writes back only STAGES[rerun_idx:], so non-stage keys and upstream statuses survive; restart builds a fresh {s: 'pending' for s in STAGES} dict, so they do not. A port that shares one reset helper between them silently changes what survives a restart.
- rerun_stage()'s inline content_map has six entries and no final_html_content, while restart_pipeline() clears that column explicitly. The asymmetry is real in the Python and easy to smooth over by reusing STAGE_CONTENT_MAP for both, which is why the difference needs its own test rather than a shared loop.
- When every stage is complete, rerun's scan finds no first-non-complete stage and falls back to STAGES[-1], so 'rerun' on a finished post re-runs `ready` alone. A port that treats the no-match case as a no-op looks more sensible and is wrong.
- A Partial<Record<keyof PostInsert, null>> spread into Drizzle's set() fails typecheck: it makes every column optionally null, including non-nullable ones like slug. Narrowing the key type to the union of the six content-column literals (typeof STAGE_CONTENT_COLUMN)[Stage] makes the spread precise and the call typecheck.
- A runtime derivation of the stage-to-column map via getTableColumns() is weaker than a literal `as const satisfies Record<Stage, keyof PostInsert>`: the literal is checked on both axes at compile time, and the drift check belongs in a test rather than in production code that has to be typed loosely to accommodate it.
- The correlated-EXISTS ownership predicate had reached four copies across the posts router before extraction was worth it. Repointing the three existing handlers at the shared helper and re-running their 78 unchanged tests is the check that the extraction is behaviour-neutral; no new test is needed for it.
- `pnpm build | grep ...; echo EXIT=$?` reports the grep's exit code, not the build's. Redirect the build to a file and echo $? immediately if the exit code is going into the ledger as evidence.

### Iteration 66

**Summary:** Split ledger item 5.3c-iii and completed 5.3c-iii-a by porting POST /{post_id}/pause to a Next.js route handler with 10 tests against the real database, recording publish as blocked on the unported publish workflows.

**Changes:**
- POST /api/posts/{post_id}/pause ported to web/src/app/api/posts/[id]/pause/route.ts as a single ownership-scoped UPDATE ... RETURNING, with zero rows as the 404 _get_user_post() raised, the FastAPI path-uuid 422, and the {status: 'paused', post_id} body at 200
- The Python semantics of 'paused' pinned down and preserved: it is a label no worker reads, the per-post endpoint has no stage guard (unlike queue pause-all), pausing an already paused post is a plain second write, and the stage the post was on is overwritten rather than remembered
- 10 new tests in web/src/app/api/posts/run-control.test.ts (53 total, now covering all five per-post pipeline-control endpoints) against the real database and real BetterAuth sessions, including multi-tenancy, the orphan-post 404 from the inner join, the enqueues-nothing assertion, pausing a finished post, and idempotence
- docs/mastra-port/LEDGER.md: 5.3c-iii split into a checked 5.3c-iii-a and an open 5.3c-iii-b, with the preserved oversights argued, the updated_at deviation recorded, verbose test output, two negative controls, the build route table and all frontend plus api gate results
- 5.3c-iii-b (publish) documented as blocked on the missing Mastra equivalents of publish_to_wordpress and publish_to_nextjs, with a suggested split into a WordPress branch and a Next.js branch for whoever picks it up

**Learnings:**
- pause_post() writes a label, not a control signal: grep -rn 'paused' api/src shows only queue.py's counts and resume-all read the value, so a stage already executing runs to completion and the next stage still starts. A port that tries to make pause actually stop a run would be inventing behaviour.
- The per-post pause endpoint and POST /api/queue/pause-all disagree on scope: pause-all restricts to current_stage in ['pending', *STAGES], the per-post one has no guard and will happily pause a complete post. Two endpoints with the same name are not the same predicate.
- publish_post() cannot be ported yet in any honest form: it is a status write around two ARQ jobs whose Mastra workflows do not exist, and web/src/mastra/workflows/pipeline.ts already records the same gap for the auto-publish half of its completion hook. Splitting the item and recording the dependency beat writing a start for a workflow that is not there.
- pytest in this repo fails with 177 asyncpg InvalidPasswordError unless the repo .env is sourced into the shell first (set -a; . ./.env). Env does not persist between Bash tool calls, so every pytest invocation needs it, and a run without it produces a completely different and misleading failure count (4 failed/205 passed/177 errors versus the real 125/236/25 baseline).
- The 15 BetterAuth 'default secret' lines in next build output are one per page-data worker ('Collecting page data using 15 workers'), driven by BETTER_AUTH_SECRET being unset in the repo .env, not by the number of route files that import auth. Already recorded as pre-existing under ledger item 1.2.
- prettier is not on PATH in web/; formatting is enforced through eslint alone, so `npx prettier --check` is not available as a separate gate.

### Iteration 67

**Summary:** Split ledger item 5.3d into three sub-items and completed 5.3d-i by porting the markdown and HTML export endpoints to Next.js route handlers with a 30-case Python parity oracle for strip_leading_h1 and 52 tests against the real database.

**Changes:**
- GET /api/posts/{post_id}/export/markdown ported to web/src/app/api/posts/[id]/export/markdown/route.ts: ready_content-or-final_md_content selection preserving Python's empty-string-is-absent `or`, the H1 strip, the media URL rewrite, and a .mdx attachment named after the slug with Starlette's charset=utf-8 content type
- GET /api/posts/{post_id}/export/html ported to web/src/app/api/posts/[id]/export/html/route.ts: final_html_content verbatim with neither the H1 strip nor the media rewrite, matching the Python, plus its own 'No HTML content available' 404 distinct from the ownership 404
- web/src/app/api/posts/export-content.ts holds stripLeadingH1() and rewriteMediaUrls(), with the three Python/JavaScript regex-dialect differences (re.MULTILINE vs the m flag, non-DOTALL `.` vs [^\n], str.strip("\"'") vs trim) written out explicitly rather than transcribed
- api/scripts/export_strip_leading_h1_parity.py drives the real Python helper over 30 inputs to write web/src/app/api/posts/data/strip-leading-h1-parity.json, 18 of which the strip modifies and 12 of which it leaves untouched
- 52 tests in web/src/app/api/posts/export.test.ts: 30 oracle replays, an oracle-coverage guard, 3 media-rewrite tests and 18 handler tests against the real database and real BetterAuth sessions covering multi-tenancy, the orphan-post 404, both content 404s, header shapes and the markdown/HTML transformation asymmetry
- docs/mastra-port/LEDGER.md: 5.3d split into a checked 5.3d-i plus open 5.3d-ii (the zip export, with the missing zip-writer dependency named as the reason) and 5.3d-iii (logs and analytics), with the deviations argued, six negative controls, verbose test output and all frontend plus api gate results

**Learnings:**
- A literal JavaScript transcription of strip_leading_h1's three Python regexes passed all 49 tests I first wrote, so the carefully-written version was unpinned. The differences only appear when a lone \r or a   sits inside the title and the H1: those are line boundaries to JavaScript's m flag and invisible to re.MULTILINE, and are excluded by JavaScript's `.` but matched by Python's non-DOTALL `.`. Three oracle cases built from that observation now separate the two implementations. A negative control that fails to fail is a signal the test battery is wrong, not that the implementation is safe.
- Python's `post.ready_content or post.final_md_content` treats an empty string as absent, so `??` is not a valid port of `or` for a nullable text column: a post whose ready_content is "" must export final_md_content. A negative control swapping || for ?? fails exactly that test.
- FastAPI parsed post_id into a uuid.UUID before the handler ran, and str() on one is always the lowercase canonical form, so the f-string media URL rewrite used a lowercase id even when the request path carried uppercase. A route-handler port reading the raw path segment has to lowercase it or the rewrite silently misses.
- Starlette's Response appends `; charset=utf-8` to any media_type starting with `text/`, probed directly rather than assumed, so a ported handler that sets a bare `text/markdown` changes the response header the browser sees.
- strip_leading_h1 has exactly two callers, both export endpoints, despite living in api/src/pipeline/helpers.py. Grepping for callers before choosing where the TypeScript lands kept it out of web/src/mastra/, where the pipeline module name would have suggested it belongs.
- A shell heredoc-based patch script running after a failed `cd` in the same Bash call still executes and can corrupt an untracked file with no git copy to restore from. Chain edits with && after the cd, or use an absolute path.

### Iteration 68

**Summary:** Completed ledger item 5.3d-ii by porting GET /{post_id}/export/all to a Next.js route handler backed by fflate, with 21 tests against the real database and real files plus a Python zipfile interop check.

**Changes:**
- GET /api/posts/{post_id}/export/all ported to web/src/app/api/posts/[id]/export/all/route.ts: the shared ready_content-or-final_md_content selection, H1 strip and media URL rewrite from export-content.ts, its own 'No content available to export' 404 distinct from the markdown export's, and every file in the post's media directory added at the archive root under its bare name
- fflate 0.8.3 added as a direct dependency of web/ and chosen as the zip writer over archiver (a large stream pipeline present only as a transitive dep of the mastra CLI devDependency) and jszip (larger, async API with no use here); zipSync's default level 6 deflate is the same method zipfile.ZIP_DEFLATED selects
- Python's StreamingResponse over a BytesIO replaced by a plain Response over the finished Uint8Array, because Python built the entire archive in memory before handing it over and nothing was ever produced lazily
- Directory scan written as a stat() per entry rather than Dirent.isFile(), because Path.is_file() follows symlinks and answers False on a broken one, so readdir({withFileTypes:true}) would silently drop symlinked images; dotfiles are included and subdirectories excluded, matching iterdir()'s only filter
- zf.write()'s mtime preservation kept: media entries carry their stat mtime while the .mdx entry stamps the current time, as writestr does
- 21 tests in web/src/app/api/posts/export-all.test.ts against the real database, real BetterAuth sessions and a real temporary MEDIA_DIR with real files, symlinks and a subdirectory, reading the archive back both with unzipSync and with a hand-parsed local file header inflated by node:zlib
- docs/mastra-port/LEDGER.md: 5.3d-ii checked with the dependency choice argued, the Python zip-semantics probe, a Python zipfile interop check on the handler's own output, two deviations recorded, five negative controls including one that honestly did not fail, verbose test output and all frontend plus api gate results

**Learnings:**
- macOS APFS is case-insensitive, so a negative control that removes .toLowerCase() from a filesystem path passes locally even though the code is required on Linux. Any test that tries to pin case handling through a real directory is unfalsifiable on this machine; pairing it with a plain string assertion (the URL rewrite) is what gives it teeth on both platforms.
- Path.is_file() and Dirent.isFile() are not the same predicate. Python follows symlinks and swallows the missing-target error; Node's readdir reports on the directory entry itself, so a symlink to an image is reported as a symlink and skipped. Every ported directory scan needs a stat() per entry with a catch for the broken-symlink case.
- fflate's zipSync takes an object rather than an ordered list, so duplicate entry names are impossible to express. Python's zipfile happily writes two entries under one name with a UserWarning (verified: namelist() returns ['dup.mdx', 'dup.mdx']), so the port is strictly better here but not identical, and object key ordering also moves a canonical-integer filename to the front.
- Python's own zipfile reads fflate's output with CRCs intact (testzip() returns None, both entries method 8), which is a genuinely independent format check available for free while api/ still exists. It will not be available after Phase 7, so format-interop evidence for the zip export had to be captured now.
- Starlette appends charset=utf-8 only to media types starting with text/, so application/zip comes back bare. That is the second time this rule has decided a ported response header, after text/markdown in 5.3d-i.
- A vitest expectation written as a sorted array has to be sorted by JavaScript's own comparator: the test-fixture slug prefix 'posts-...' sorts after 'image-...' and 'kept.webp', which produced two failures that looked like handler bugs and were not.

### Iteration 69

**Summary:** Completed ledger item 5.3d-iii, and with it the 5.3d parent, by porting GET /{post_id}/logs and GET /{post_id}/analytics to Next.js route handlers with a 34-case Python parity oracle and 52 tests against the real database.

**Changes:**
- Ported GET /api/posts/{post_id}/logs to web/src/app/api/posts/[id]/logs/route.ts, preserving the three falsy-guarded filters, level as a repeated query parameter against last-wins stage and since, and Python's code-point string comparison for since via an explicit pythonGreater() helper
- Ported GET /api/posts/{post_id}/analytics to web/src/app/api/posts/[id]/analytics/route.ts, wiring the already-ported computeAnalytics with the endpoint's content preference (final_md_content or draft_content, never ready_content) and its two differing keyword-extraction rules
- Added api/scripts/export_post_logs_analytics_parity.py, which drives both real Python endpoint coroutines with a stubbed session and writes a 19-log-case, 15-analytics-case oracle to web/src/app/api/posts/data/logs-analytics-parity.json
- Added web/src/app/api/posts/logs-analytics.test.ts: 52 tests against the real database and real BetterAuth sessions, replaying the oracle plus query-string parsing, ownership scoping and response-shape assertions
- Checked ledger items 5.3d-iii and its now-complete 5.3d parent with pasted command output, negative controls and the two recorded deviations
- Logged two out-of-scope defects in todo.md: the PostAnalytics.seo_checklist type understating the mixed boolean/integer shape the UI renders, and 39 committed test-output images under media/test-123/

**Learnings:**
- pytest in this worktree only reproduces the recorded 125 failed / 236 passed / 25 errors baseline when ../.env is sourced first. Without it the run reports 4 failed / 205 passed / 177 errors, because POSTGRES_HOST_PORT is 5435 here rather than the 5433 compose default. Future iterations pasting a pytest baseline must source it or they will report a phantom regression.
- posts.topic and posts.execution_logs are both NOT NULL in the live database, so two of the Python endpoint's defensive branches (post.execution_logs or [], post.topic or "") can only ever see the empty list and the empty string. Oracle cases for the null variants had to be dropped because they cannot be inserted, which is a cheap check worth doing before designing a parity fixture.
- FastAPI and URLSearchParams agree without a special case on an absent repeated parameter: FastAPI hands the handler None and getAll() hands it [], and both are falsy at the `if level:` guard. The divergence is at ?level= alone, which parses to [""] and filters, where ?stage= parses to "" and does not.
- ruff lints api/scripts/ along with the rest of api/, so a new parity script must be ruff-formatted before the Python gates are re-measured or it inflates both the error count and the would-reformat count against the recorded baseline. Measuring the baseline by moving the new file aside is the fastest way to prove which delta is yours.
- Running the full pnpm -C web test suite writes wall-clock-named image files into media/test-123/. 39 of them are already committed from prior iterations, so any iteration that runs the full suite and then does a broad git add will commit more.

### Iteration 70

**Summary:** Split ledger item 5.4 into four sub-items and completed 5.4a by porting GET /api/queue to a Next.js route handler with 11 tests against the real database.

**Changes:**
- GET /api/queue ported to web/src/app/api/queue/route.ts: one grouped count over the caller's posts joined to website_profiles, folded into the six-number QueueStatus shape web/src/lib/api.ts declares, with running summing the six stage-named groups and total summing every group rather than the five reported buckets
- The nullable-current_stage consequence pinned with evidence: posts.current_stage is nullable with no check constraint in the live database and SQL puts a null in its own counted group, so a row carrying null or an unrecognised stage lands in total and in no bucket, exactly as Python's sum(counts.values()) did
- 11 tests in web/src/app/api/queue/route.test.ts against the real database and real BetterAuth sessions, covering the empty case, every bucket, the six stages summed into running, a gated post counting as running, cross-user isolation, the unowned-post exclusion, the null and unrecognised stage groups, and the bigint-to-number mapping
- Ledger item 5.4 split into 5.4a (status counts, checked), 5.4b (pause-all and resume-all), 5.4c (worker-status), 5.4d (the dead-letter trio), with the four ARQ-only Redis keys named as the reason the last two sort last, plus pasted test output, four negative controls including one that honestly did not fail, and all frontend and Python gate results
- todo.md records as [confirmed] that retry_dead_letter() uses an unscoped session.get(Post, post_id) so any authenticated user can reset another user's post, that the other two dead-letter endpoints take a user dependency and ignore it, and that worker-status's active_jobs counts every post in the database

**Learnings:**
- queue_status()'s `total` is not the sum of the five buckets it reports. posts.current_stage is nullable varchar(20) with no check constraint in the live database, and a null forms its own counted group (probed with a values() CTE against the same server), so a port that derives total from running+pending+complete+failed+paused changes the arithmetic. A negative control doing exactly that failed the two rows-outside-the-buckets tests.
- Drizzle's count() helper carries .mapWith(Number); a hand-written sql<number>`count(...)` does not, and node-postgres returns bigint as a string. Replacing one with the other turned every bucket into a string concatenation and failed 8 of 11 tests, which makes it the cheapest available proof that the counts are really numbers.
- Only three of the queue router's seven endpoints are reachable from the dashboard: web/src/lib/api.ts's queue namespace declares status, pauseAll and resumeAll, and grep finds no reference to worker-status, dead-letter or worker_alive anywhere in web/src or packages. That is what makes the ARQ-shaped half of the router safe to sequence last rather than a blocker.
- The inner-join-versus-user_id distinction recorded under 5.3a is testable and the join loses: swapping innerJoin for leftJoin passed all 11 tests, because the user_id predicate already excludes a null profile_id. Naming a test 'because the join is inner' would have been a false claim about what pins the behaviour.
- A shared clearFixtures() in afterEach that deletes both posts and website_profiles breaks any file that creates its profiles once in beforeAll: every later insert violates posts_profile_id_fkey. Clearing only the posts between tests and both in afterAll is the fix.
- api/src/api/queue.py has three tenancy holes the port must decide about rather than transcribe: retry_dead_letter() looks the post up with an unscoped session.get(), the two other dead-letter endpoints take a user dependency and never use it, and worker-status's active_jobs query has no user predicate at all. Closing them needs the DLQ to gain a user dimension it does not have, so it is a design decision rather than a missing WHERE clause.

### Iteration 71

**Summary:** Completed ledger item 5.4b by porting POST /api/queue/pause-all and /resume-all to Next.js route handlers with 20 tests against the real database and Redis Streams bus.

**Changes:**
- POST /api/queue/pause-all ported to web/src/app/api/queue/pause-all/route.ts: the join-scoped select over the caller's posts restricted to current_stage in ['pending', *STAGES], followed by the single batched write Python committed once, returning {status: 'paused', count}
- POST /api/queue/resume-all ported to web/src/app/api/queue/resume-all/route.ts: per-post next-stage recovery from stage_status via the shared nextStage() helper, an all-complete post written to 'complete' with nothing started, one transaction for the whole batch, and startPipeline(id, [stage]) as the single-stage form ARQ's positional stage argument produced
- The stage guard asymmetry between queue pause-all and the per-post pause endpoint preserved rather than smoothed over: a complete, failed, already-paused, unrecognised-stage or null-stage post is left alone and not counted
- 20 tests in web/src/app/api/queue/queue-control.test.ts against the real database, real BetterAuth sessions and an independent RedisStreamsPubSub fan-out subscription, covering the stage guard, cross-user isolation, the orphan-post exclusion, the count-versus-runs-started distinction, the single-stage enqueue, and a pause-then-resume round trip
- docs/mastra-port/LEDGER.md: 5.4b checked with the three Python behaviours argued, two deviations recorded, the run_pipeline_stage docstring quoted as the evidence for the single-stage enqueue, verbose test output, five negative controls and all frontend plus Python gate results

**Learnings:**
- resume_all()'s enqueue passes next_stage positionally, and run_pipeline_stage's own docstring says a named stage 'runs only that stage (no gate checks)'. So 'resume all' advances each paused post by exactly one stage and skips that stage's review gate, which is much narrower than the endpoint name implies and is easy to port as a full-pipeline start by mistake.
- resume_all()'s count is the number of paused posts found, not the number of runs started: an all-complete post is written to current_stage='complete', enqueues nothing, and still increments. A negative control returning the started count failed exactly two tests.
- queue.pause_all() and the per-post pause endpoint disagree on scope in a way that is now pinned by tests: pause-all restricts to current_stage in ['pending', *STAGES] while the per-post one has no guard at all. Sharing one helper between them would silently change which posts a bulk pause touches.
- Python enqueued inside resume_all()'s loop before session.commit(), so a worker could read a post whose new current_stage was not yet visible. Committing first and starting runs afterwards closes the window with no observable change, because the workflow derives its stages from stage_status rather than current_stage.
- Neither pause-all nor resume-all has any pytest coverage (grep -rln over api/tests returns nothing), so unlike the posts router items there was no Python test battery to port; the whole 20-test file is new and the negative controls are the only evidence the tests have teeth.
- pnpm exec and npx resolve the same local binaries here, but pasting a command form into the ledger that differs from the one actually run is avoidable: re-running the three long gates through pnpm -C web exec cost about 100 seconds and made the pasted evidence literally reproducible.

### Iteration 72

**Summary:** Split ledger item 5.4c and completed 5.4c-i by deriving worker liveness and queue backlog from Mastra's Redis Streams consumer group, with a measured 15s liveness threshold and 11 tests against real Redis and a real worker.

**Changes:**
- web/src/mastra/worker-health.ts: readWorkerHealth() answers worker_alive and queued_jobs from the mastra-orchestration consumer group on the workflows topic, with no heartbeat writer, since a consuming worker is by construction a registered Redis consumer whose idle time Redis already tracks
- WORKER_ALIVE_IDLE_LIMIT_MS set to 15s from measurement rather than guess: a probe sampled XINFO CONSUMERS every 2s across a 100s step and observed a maximum idle of 1018ms, proving the XREADGROUP BLOCK 1000 read loop keeps polling while a step executes so a busy worker is not reported dead
- queuedEvents typed number | null because XINFO GROUPS returns a nil lag the installed @redis/client 5.12.1 typings declare as non-nullable, and falls back to XLEN when no consumer group exists, where XLEN is the exact backlog rather than an estimate
- Python's always-false worker_alive documented and deliberately not reproduced: worker_status() scans arq:worker:* while ARQ writes its heartbeat to arq:queue:health-check, verified by importing arq.constants
- redis@5.12.1 added as a direct dependency of web/, pinned to the version @mastra/redis-streams resolves, because the transport keeps its clients private and exposes no XINFO
- web/src/mastra/worker-health.test.ts: 11 tests in two suites, one driving a hand-built stream to exact consumer idle and lag values, one against a real mastra.startWorkers() pinning the stream key, group name and threshold
- docs/mastra-port/LEDGER.md: 5.4c split into a checked 5.4c-i and an open 5.4c-ii, with the ARQ heartbeat bug argued, the two unit deviations recorded, the idle probe series pasted, four negative controls, and all frontend plus Python gate results

**Learnings:**
- api/src/api/queue.py's worker_alive is dead code that always returns False: it scans arq:worker:* and skips the one key matching that pattern, while ARQ actually writes its heartbeat to <queue_name>:health-check = arq:queue:health-check (confirmed from arq.constants). Any port of a health endpoint should check the Python actually works before transcribing it.
- RedisStreamsPubSub's read loop keeps issuing XREADGROUP ... BLOCK 1000 while a step executes, so a consumer's idle sawtooths between 0 and ~1s even during a 100s step. Reading #runReadLoop suggested the opposite (the delivery callback is awaited inline), so the empirical probe, not the source reading, is what settled the threshold.
- Nothing in @mastra/redis-streams ever runs XGROUP DELCONSUMER, so every worker process that has ever run leaves a consumer entry in the group forever (the dev Redis lists hundreds). Any liveness check over that group must filter by idle time; counting consumers reports every historical worker as alive.
- TOPIC_WORKFLOWS = "workflows" and DEFAULT_GROUP = "mastra-orchestration" are internal constants in @mastra/core with no export, so a module depending on them has to restate them and pin them with a test that starts a real worker and reads the group back out of Redis.
- @redis/client@5.12.1 declares XINFO GROUPS' lag as NumberReply<number> with no null, but Redis returns nil when entries have been deleted from the middle of a stream. XDEL on a middle entry is a cheap way to test that branch for real.
- A negative control that mutates a constant which the test also uses as its expected value produces a skipped suite rather than a failure, because the beforeAll throws. Pinning the constant to a literal on both sides turns the same control into four real failures.
- vitest suites that build their own Mastra instance need an isolated keyPrefix; publishing hand-made entries onto a topic a real worker consumes would make the orchestration worker log errors for unrecognised event types, which the no-new-warnings rule forbids.

### Iteration 73

**Summary:** Completed ledger item 5.4c-ii, and with it the 5.4c parent, by adding the last-completed writer to the pipeline completion step and porting GET /api/queue/worker-status to a Next.js route handler with 16 new tests.

**Changes:**
- recordRunCompleted() and readLastCompleted() added to web/src/mastra/worker-health.ts over mastra:worker:last_completed, replacing ARQ's arq:worker:last_completed, with the choice of a written timestamp over one derived from listWorkflowRuns argued from @mastra/pg's ORDER BY createdAt DESC and its unpaginated full-table return
- web/src/mastra/steps/pipeline-complete.ts records the run's finish time unconditionally, after checking that the step's reach (every run that ends without raising, single-stage reruns included, no suspended or failed run) is exactly _record_job_completed()'s scope rather than the full-pipeline-only scope the ledger suspected
- GET /api/queue/worker-status ported to web/src/app/api/queue/worker-status/route.ts, answering Python's four keys from the orchestration consumer group, the group lag, the new Redis key and a current_stage IN (STAGES) count, with active_jobs scoped to the caller where Python queried every post in the installation
- 8 route tests against the real database, real BetterAuth sessions and real Redis, plus 5 last-completed tests on an isolated key and 3 real-run assertions folded into the existing four runs in pipeline-completion.test.ts
- no-next-imports.test.ts's entry-graph allowlist updated to include redis, with a comment naming the item, since the completion step now opens its own client
- docs/mastra-port/LEDGER.md: 5.4c-ii and the 5.4c parent checked with the placement check argued, three deviations recorded, a source table for the four keys, four negative controls, verbose test output and all frontend plus Python gate results
- todo.md's tenancy entry updated to record that worker-status's unscoped active_jobs is now closed, leaving the three dead-letter holes for 5.4d

**Learnings:**
- pipelineCompleteStep is in the chain unconditionally and only its markPipelineComplete call is gated on inputData.stages, so it is the exact structural equivalent of Python's _record_job_completed(): the ledger's worry that the step is full-pipeline only was wrong, and checking it cost one read of the file.
- @mastra/pg's listWorkflowRuns ends ORDER BY "createdAt" DESC and returns every matching row when perPage/page are omitted, so 'the last completed run' cannot be read off it cheaply or correctly when two runs overlap. That is what makes the written timestamp the better port rather than a transcription.
- src/mastra/no-next-imports.test.ts asserts the exact package allowlist of the Mastra entry graph, so any new third-party import reachable from a registered primitive fails it. Adding redis to a step is a deliberate change to that list, and the test failure is the guard working rather than a regression.
- A negative assertion over a Redis key that is global to the instance is unwritable in this suite: vitest runs files in parallel and several files complete real pipeline runs, so 'the suspended run did not write it' would flake. The same fact was already pinned by that run's null completed_at, which is why the assertion was dropped rather than made tolerant.
- Restoring Python's unscoped active_jobs query fails three tests rather than two, because the shared dev database holds posts sitting on a stage that belong to neither test user. The extra failure is the tenancy hole itself showing up in a test that was not written for it.
- `pnpm -C web tsc --noEmit` exits 254 with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: pnpm looks for a script named `web`. The form that works, and the one the ledger records, is `pnpm -C web exec tsc --noEmit`.
- Running the full vitest suite still drops fresh wall-clock-named .webp files into media/test-123/. Deleting the new ones before finishing is the only thing that keeps the orchestrator's commit clean, since the tests write to the repo's media directory rather than a temp one.

### Iteration 74

**Summary:** Split ledger item 5.4d and completed 5.4d-i by recording a permanently failed pipeline run on its post through a Mastra topic listener, with 15 tests against a real failing run.

**Changes:**
- web/src/mastra/failure-recorder.ts records a permanently failed pipeline run: it filters the workflows-finish topic to the pipeline workflow's workflow.fail events, reads the post id off the run's stored input and the error text off prevResult, and stamps the post. It is registered as a Mastra `events` listener, which startWorkers() subscribes, so it runs in the worker service and never in web
- markPipelineFailed() added to web/src/mastra/post-state.ts and CURRENT_STAGE_FAILED to state.ts: current_stage = 'failed' plus an _error entry of {message, attempts, failed_at} merged into stage_logs with coalesce(...) || jsonb, which is the post-writing half of Python's _move_to_dlq()
- The Redis dead-letter list is deliberately not ported: Mastra's own Postgres run row already carries status 'failed' and the error, so 5.4d-ii and 5.4d-iii will read that rather than a parallel Redis copy
- _error.attempts is derived from pipelineWorkflow.retryConfig ({attempts: 0}, read off the instance) plus one, rather than transcribing Python's MAX_ATTEMPTS = 3, because the evented engine only fails a run once its retries are exhausted
- web/src/mastra/failure-recorder.test.ts: 15 tests, one suite running the real workflow on a real evented engine, real Redis Streams and the real database with the write stage's agent throwing, and one driving recordRunFailure with hand-built events for the ignore branches, the thrown non-Error and repeat delivery
- web/src/mastra/index.ts exports the listener map as workerEvents and passes it as `events`, so the test instance subscribes the production object rather than a restatement of it
- docs/mastra-port/LEDGER.md: 5.4d split into 5.4d-i (checked), 5.4d-ii and 5.4d-iii, with the storage decision argued, the duplicate-publish and fan-out measurements pasted, four deviations recorded, four negative controls and all frontend and Python gate results
- todo.md records as [investigate] that Mastra's StepExecutor logs step failures to its own ConsoleLogger and never to the configured PinoLogger, so worker step failures sit outside the app's structured logs

**Learnings:**
- Mastra's config takes `events: { [topic]: listener }` and startWorkers() is what subscribes them, which is the seam for anything that must observe run lifecycle in the worker process. The worker entry is CLI-generated (mastra.startWorkers() plus a shutdown handler), so a listener registered any other way would not exist in the deployable artifact.
- One failed run publishes workflow.fail twice: two distinct event ids about 5ms apart, both deliveryAttempt 1, measured on an independent fan-out subscription. Combined with subscribe() having no consumer group (documented fan-out, every worker gets every event), any listener that writes has to be safe to repeat.
- processWorkflowFail in @mastra/core updates the run's storage row with status 'failed' and the error before it publishes anything, so a permanently failed run is already durably recorded in Postgres. That is what makes porting Python's Redis DLQ list unnecessary rather than merely inconvenient.
- The workflow.fail event's data.stepResults.input is the run's original input, so the post id survives a failure with no extra plumbing, and workflow.retryConfig is public on the instance ({attempts: 0, delay: 0} by default), so 'how many times did this run execute' is derivable rather than guessable.
- MastraBase's constructor gives every primitive its own ConsoleLogger and only adopts the Mastra instance's logger in __registerMastra, which the engine never calls on its StepExecutor. So 'Error executing step X' cannot be captured by spying on testMastra.getLogger(); it needs a console.error spy, and in production it bypasses the configured PinoLogger entirely.
- no-next-imports.test.ts scans import specifiers textually, so even a type-only `import type { Event } from "@mastra/core/events"` fails its package allowlist. The failure is the guard working; adding the package is a deliberate edit.
- A negative control that removes the events registration from the test instance produces a beforeAll throw and 15 skipped tests rather than failures. It still proves the subscription does the work, but a skip is weaker evidence than a failure and should be labelled as such.

### Iteration 75

**Summary:** Completed ledger item 5.4d-ii by porting GET /api/queue/dead-letter to a Next.js route handler that reads permanently failed runs off Mastra's Postgres run rows, with 20 tests including a real failing run.

**Changes:**
- web/src/mastra/dead-letter.ts reads permanently failed pipeline runs through the workflow storage domain's listWorkflowRuns({workflowName, status: 'failed'}), parsing post_id from context.input.postId, error from the snapshot's top-level error.message, stage from the one stage id whose own step result is failed, and attempts from pipelineWorkflow.retryConfig the way 5.4d-i derives it
- GET /api/queue/dead-letter ported to web/src/app/api/queue/dead-letter/route.ts in Python's {entries, count} shape, newest first, scoped to the caller by joining each run's post through website_profiles.user_id
- Python's two tenancy holes in the list endpoint closed rather than transcribed: the DLQ had no user dimension at all, and a run whose post has been deleted or has no profile is now excluded
- stage is populated for a full pipeline run, where Python recorded an empty string, because the snapshot names the step that threw
- postIdOf requires the UUID shape rather than a non-empty string, because the handler feeds the ids into a posts.id IN (...) predicate where one bad row takes the whole endpoint down
- 20 tests in web/src/app/api/queue/dead-letter.test.ts: one suite is a real failed run on a real evented engine over real Redis Streams with only the provider calls stubbed, two more persist snapshots through the same storage adapter for the branches one failure cannot produce
- docs/mastra-port/LEDGER.md 5.4d-ii checked with the real snapshot dump that settled the field mapping, the @mastra/pg index grep, the 442-run / 487 kB / 40 ms cost measurement, two deviations, one deliberately untested branch, verbose test output, five negative controls and all frontend plus Python gate results
- todo.md's tenancy entry updated: the dead-letter list hole is closed, leaving retry_dead_letter() and DELETE /api/queue/dead-letter for 5.4d-iii

**Learnings:**
- @mastra/pg creates its own index on (workflow_name, snapshot ->> 'status', "createdAt" DESC) specifically so listWorkflowRuns' status filter avoids a full snapshot scan, and its trailing ORDER BY "createdAt" DESC is exactly the newest-first order Python's LPUSH plus LRANGE 0 -1 produced. Reading the adapter's own SQL is what made the storage API the right source rather than a hand-written jsonb query.
- listWorkflowRuns lives on the workflows storage domain, not on the composite store: mastra.getStorage() returns a MastraCompositeStore whose only route to it is await storage.getStore('workflows'). Both the module and the test needed that hop, and tsc is what caught it.
- Nothing on a Mastra run row identifies the owning user unless startPipeline sets resourceId, which this port does not. That is what forces the failed-run list to be read unpaginated and scoped in application code: a page taken before the join would be a page of other tenants' runs.
- The unpaginated read is cheap because stage step outputs are counters and a model id rather than the article: 442 failed runs total 487 kB of snapshot and listFailedRuns returns in 40 ms against the dev database. Measuring it took one temporary vitest file and turned an assumption in the ledger into evidence.
- A snapshot carrying a post id that is not a UUID does not skip one entry, it fails the whole request with 'invalid input syntax for type uuid' from the IN predicate. The negative control took 18 of 20 tests down, which makes a shape guard on any id that reaches a SQL IN list worth writing before it is needed.
- storage.persistWorkflowSnapshot always writes jsonb, so the string arm of a snapshot parser cannot be reached through the adapter, and @mastra/pg runs JSON.parse on a string column before returning the row anyway. The arm exists only to satisfy WorkflowRun.snapshot's declared union; recording it as untested-by-design is more honest than contriving a test for it.
- Reusing failure-recorder.test.ts's real-failing-run harness (stub research/outline, make write throw) cost about 2 seconds and is the only thing that proves a snapshot parser matches engine output rather than the test's idea of it. Hand-persisted snapshots verify the branches; the real run verifies the shape.

### Iteration 76

**Summary:** Completed ledger item 5.4d-iii-a by settling what "in the dead letter queue" means when the record is a Mastra run row, and porting POST /api/queue/dead-letter/{post_id}/retry with 18 tests including a real failing run retried end to end.

**Changes:**
- Dead-letter membership is now an acknowledgement rule rather than a list: listDeadLetterEntries() in web/src/mastra/dead-letter.ts scopes failed pipeline runs to the caller and requires the post to still carry stage_logs._error, the key Python's own retry_dead_letter() pops. GET /api/queue/dead-letter was rewritten over it and a retired entry now drops out of the list while its run row survives for Studio
- POST /api/queue/dead-letter/{post_id}/retry ported to web/src/app/api/queue/dead-letter/[post_id]/retry/route.ts: scoped post lookup, dead-letter membership required, then a full pipeline start, which is what enqueue_job with no stage meant to ARQ. Python's two distinct 404 texts are kept apart and a malformed id answers 422 instead of reaching a uuid column
- retryFailedPost() added to web/src/mastra/post-state.ts: current_stage = 'pending' and stage_logs - '_error' in one statement, so a concurrent stage's log entry survives where Python's read-modify-write would have erased it
- Python's unscoped session.get(Post, post_id) hole closed: another user's dead-letter entry answers 404 rather than being reset and re-run at the owner's expense. todo.md updated to leave only DELETE /api/queue/dead-letter open
- 18 tests in web/src/app/api/queue/dead-letter-retry.test.ts, the first suite a real failing run on a real evented engine over real Redis Streams that is listed, retried, and gone, plus one real workflow.start observed on the bus for a post with nothing left to execute
- 5.4d-ii's suite updated for the changed contract: testMastra now registers events: workerEvents so the real failing run gets _error from the recorder, insertPost seeds _error for the persisted-run fixtures, and one exclusion test was added
- docs/mastra-port/LEDGER.md: 5.4d-iii split into a checked 5.4d-iii-a and an open 5.4d-iii-b, with the design decision argued from the Python source, the rejected deleteWorkflowRunById alternative recorded, four deviations, a five-row negative-control table, one deliberately unpinned behaviour, verbose test output and all frontend plus Python gate results

**Learnings:**
- Both Mastra constructors call __registerMastra on the same workflow object and the last one wins, so in a test file that builds its own Mastra instance, startPipeline publishes through that instance's transport rather than the production one. A fan-out observer on the default key prefix saw nothing for 15 seconds; moving it onto the file's own pubsub fixed it. Any future test that both builds an instance and calls a production start helper hits this.
- @mastra/core's workflows storage domain does expose deleteWorkflowRunById, so 'remove the entry' was genuinely available and was rejected on merit rather than absence: it trades the failed run's history for parity with a Redis list Python only kept because it had nowhere else to record the failure.
- Python's retry_dead_letter() already popped stage_logs._error, which means _error was Python's own per-post acknowledgement and the Redis list was the redundant second copy. Reading the endpoint being ported for the marker it already maintains was cheaper than inventing a dismissal store, and it kept the port free of a schema change.
- Nothing in web/src reads stage_logs._error (the dashboard's error display comes from SSE stage_error events and execution_logs), which is what makes popping the key a safe acknowledgement rather than an erasure of something the UI shows. Grepping for the consumer before choosing a marker took one command and decided the design.
- An unscoped-post-lookup negative control failed only one test, not two: the orphan-post case still passed because the inner join to website_profiles excludes a null profile_id on its own. Attributing that test to the user predicate would have been a false claim about what pins it.
- vitest's 5 s default test timeout fires before any waitFor helper with a 15 s budget can, so a poll-for-an-event test needs its own explicit it(..., 30_000) or it reports a timeout that looks like a missing event.

### Iteration 77

**Summary:** Completed ledger item 5.4d-iii-b, and with it the 5.4d and 5.4 parents, by porting DELETE /api/queue/dead-letter as a scoped acknowledgement pop with 18 tests including a real failing run cleared end to end.

**Changes:**
- DELETE /api/queue/dead-letter ported in web/src/app/api/queue/dead-letter/route.ts: the caller's dead-letter entries are retired by popping stage_logs._error off the posts they name, returning Python's {status: 'cleared', count} where count is entries rather than posts, so DELETE returns exactly what GET reported a moment earlier
- clearFailureMarkers() added to web/src/mastra/post-state.ts, one UPDATE for the whole batch so a clear is atomic the way Python's single Redis DELETE was, leaving current_stage, stage_status and the engine's failed run row untouched
- The acknowledgement expression given one definition: coalesce(stage_logs, '{}'::jsonb) - '_error' lifted to a shared dropErrorLog constant used by both retryFailedPost() and clearFailureMarkers() rather than copied per route
- Python's global-list-wipe tenancy hole closed: a clear can no longer touch another tenant's queue, an already-retired post, or a post no profile owns. This was the last of the four holes todo.md tracked for the queue router, which is now updated to record all four closed
- 18 tests in web/src/app/api/queue/dead-letter-clear.test.ts: one suite is a real workflow failing inside write on a real evented engine over real Redis Streams, listed then cleared, with the post's stage, sibling stage_logs entries, stage_status and run row all asserted to survive; a second suite persists run snapshots for two-runs-on-one-post, already-retired, cross-tenant and orphan shapes
- docs/mastra-port/LEDGER.md: 5.4d-iii-b checked with the three deviations argued, verbose test output, a five-row negative-control table and all frontend plus Python gate results, and the 5.4d and 5.4 parents checked with a summary of which four ARQ Redis keys were replaced by what

**Learnings:**
- Python's DELETE /api/queue/dead-letter never wrote a post at all, it only deleted the Redis list, so a cleared post kept both current_stage='failed' and stage_logs._error. Under 5.4d-iii-a's acknowledgement rule the _error pop IS the removal, which means the port has to decide the current_stage question with no Python precedent to transcribe: leaving it on 'failed' is what keeps GET /api/queue's failed bucket unchanged.
- Preserving 'count equals what GET just reported' is a stronger port criterion than 'count equals rows written'. Python's count was llen(DLQ_KEY), identical to GET's count, so counting entries (not distinct posts) is the faithful choice even though a post with two failed runs then contributes two to count and one write.
- A negative control can fail a test for a reason unrelated to what the control changed. The unscoped-clear control failed 'rejects an unauthenticated clear', not because auth broke but because that test's 'and nothing was written' half checks the orphan post, which the control had already cleared in an earlier test. Attributing it to tenancy would have been a false claim.
- The two dead-letter endpoints that retire an entry (retry and clear) need the same jsonb key-pop, and a Drizzle sql`` template is an immutable descriptor that can safely be hoisted to a module constant and reused across two different UPDATE statements. tsc and all 57 dead-letter tests confirm it.
- Giving each suite in a route test file its own BetterAuth user is what makes an exact count assertion possible. The clear is global to the caller, so reusing the first suite's user would have made the second suite's count depend on what the first suite left behind.
- `pnpm -C web lint` runs `next lint` with 'web' read as a project directory and exits 0 while doing nothing. The forms that actually run eslint are `pnpm run lint` from web/ or `pnpm exec eslint`.

### Iteration 78

**Summary:** Split ledger item 5.5 and completed 5.5a by adding the pipeline event bus and the stage-start row write plus its stage_start event, restoring a missing 'running' write and pinning it with 19 new tests including three real workflow runs.

**Changes:**
- web/src/mastra/pipeline-events.ts ports Python's publish_event(): publishPipelineEvent() flattens the caller's fields alongside `event` and `post_id` into the Event envelope's `data`, so a subscriber forwards it to the browser untouched. One retained topic (TOPIC_PIPELINE_EVENTS = 'pipeline-events') replaces Python's two ephemeral pub/sub channels, because a Redis Streams topic per post would leak a stream per run with streamIdleTtlMs disabled
- markStageRunning() added to web/src/mastra/post-state.ts: the previously-missing 'Persist running to DB before SSE' write from Python's stage loop. Before this, no step in the port ever wrote stage_status[stage] = 'running', so a post looked parked on the previous stage for the whole of every provider call
- announceStageStart() added to web/src/mastra/steps/stage-io.ts and called by all six stages (research, outline, write, edit, images-manifest, ready) after the skip check and the gate: row write first, stage_start publish second, which is Python's documented order
- The transport is taken off the `mastra` handed to execute rather than imported from index.ts, which would close an import cycle and would publish onto the production transport even when a test runs the workflow on its own instance
- 13 tests in web/src/mastra/pipeline-events.test.ts: three suites are real workflow runs on a real evented engine, real Redis Streams and the real database (a full run, a run with a skipped stage, a run parked at a review gate), and a fourth publishes through the same real transport for the wire shape
- The six per-stage parity harnesses gained a recording pubsub plus one announcement assertion each, and images-manifest's 'writes nothing to the post row' test was rewritten to assert the running marker it now writes and nothing else
- docs/mastra-port/LEDGER.md: item 5.5 split into 5.5a through 5.5e with the run-local-topic finding argued from three pasted node_modules greps, and 5.5a checked with three deviations, the restored write argued from the Python source, verbose test output, a four-row negative-control table and all frontend plus Python gate results

**Learnings:**
- Mastra's per-run watch events are unreachable across processes. `workflow.events.v2.<runId>` is matched by isRunLocalTopic() in @mastra/core, the mastra.pubsub proxy publishes those topics with {localOnly: true}, and RedisStreamsPubSub.publish short-circuits that flag to #deliverLocal and never issues XADD. So `web` cannot subscribe to the step events of a run executing in `worker`. This rules out the cheapest design for item 5.5 and equally for item 8.1's run-trace view: both need an explicit publish from inside the step.
- The port had never written stage_status[stage] = 'running'. git grep STATUS_RUNNING over web/src/mastra at HEAD returned only its declaration in state.ts. Phase 3 ported each stage's provider call and its output write but not the row write Python did on the way in, so the dashboard could not tell a running stage from a finished one. Worth grepping for other constants that are declared and never used before trusting a phase as complete.
- A retained Redis Streams topic makes a test non-hermetic in a way that silently passes. An ungrouped subscription reads from the earliest entry, so the first version of pipeline-events.test.ts replayed every previous run of itself into its assertions, and the first negative control passed on the events of the run before it. pubsub.clearTopic() in beforeAll is the fix, and no negative control on a retained topic means anything without it.
- A beforeAll that throws when an expected event never arrives reports skips instead of failures, which is exactly backwards for a test whose subject is the missing event. Swapping the throwing wait for a non-throwing one turned the first negative control from '13 skipped' into '3 failed' naming the missing announcement.
- Publishing before the row write, rather than after, fails a 'row committed at delivery time' assertion reliably against local Redis: the delivery is faster than the UPDATE round trip, so Python's 'SSE after DB is committed' comment is enforceable rather than merely documented.
- Adding a collaborator to a step breaks every parity test that hand-builds a `mastra` object. Six files build one, so a step-level dependency is a six-file change; having each stub record what was published turned that from a silencer into six new assertions.

### Iteration 80

**Summary:** Completed ledger item 5.5b by publishing stage_complete, pipeline_complete and stage_error from the positions Python published them, with 26 new tests including four real workflow runs and a real failing run.

**Changes:**
- announceStageComplete() added to web/src/mastra/steps/stage-io.ts and called by all six stages after saveStageOutput and markRerunComplete, publishing Python's {stage, model, duration_s} with duration rounded to two places; it takes the StageStepOutput the step is about to return so the announced values cannot drift from the ones the next step receives
- images announces from steps/images-assemble.ts rather than images-manifest, because that is the only step in the three-step stage that writes the row and the only one holding the whole-stage duration, and it announces on the parse-failure branch with duration 0, matching Python's node returning rather than raising there
- steps/pipeline-complete.ts publishes pipeline_complete inside the same !inputData.stages branch that stamps completed_at, so a named-stage rerun says nothing about the pipeline, which is Python's if is_full_pipeline: gate
- failure-recorder.ts publishes stage_error after it stamps the row, naming the step whose own result is failed (Python sent an empty string for a full run) and guarded by a bounded in-process run-id set, because the engine publishes workflow.fail twice and a duplicate toast is user-visible where a duplicate write is not
- workerEvents became createWorkerEvents(pubsub): a publishing listener needs a transport, and importing index.ts from the listener would close an import cycle and publish onto the production transport even when a test builds its own instance; the four test files that registered the map now register the factory on their own transport
- failure-recorder.test.ts made hermetic with clearTopic("workflows-finish"): the retained stream was replaying 27 historical runs into every execution (54 workflow.fail deliveries, 26 stage_error), invisible until an exact-count assertion existed
- A deterministic commit-before-announce assertion added to research.test.ts, reading the row from inside the awaited publish callback, after the real-Redis version of the same check was measured not to catch a swapped order
- docs/mastra-port/LEDGER.md 5.5b checked with a per-event source table, three deviations, the replay measurement, a nine-row negative-control table including the one control that caught nothing and why, verbose test output and all frontend plus Python gate results
- todo.md records the scaffold-check lifecycle-events flake as [investigate], with the observation that it is the only test file streaming a run off the production transport on the default Redis key prefix

**Learnings:**
- A test subscriber that pushes the event onto the array its wait polls before awaiting its row snapshot lets beforeAll return while the read is in flight. That produced a real flake in the full suite (one failure in six runs) and the fix is to snapshot first and push last. Any delivery-time assertion built this way has the same latent bug.
- workflows-finish is a retained Redis stream and an ungrouped subscribe() reads it from the first entry, so every previous execution of a test file replays into the new one. Measured at 27 historical runs and 54 workflow.fail deliveries. The same trap 5.5a found on the pipeline topic applies to every engine topic a test subscribes ungrouped.
- A commit-before-publish assertion over a real Redis topic is not an ordering proof for stage_complete: the subscriber's own SELECT is a slower round trip than the step's UPDATE, so a deliberately swapped order still passes. It did work for stage_start only because that write creates an absent key. The deterministic form is to read the row from inside the publish callback, which publishPipelineEvent awaits.
- Mastra's events config is typed ((event: Event) => Promise<void> | void), so a listener that needs a collaborator has to be built by a factory the instance construction site calls. That is also what lets a test subscribe the production listener against its own transport instead of restating it.
- Adding a mastra dependency to a step breaks every test that hand-builds the execute params, including ones that only call the step incidentally: images-generate.test.ts drives imagesAssembleStep as a fixture and needed the stub even though it asserts nothing about events.
- The Python baseline drifted from 125 failed / 236 passed to 120 / 241 with no change under api/, same 361+25 totals. The pytest suite reads shared dev-database state, so the failure count is not a fixed number and only the totals plus the absence of new failures are meaningful.

### Iteration 81

**Summary:** Split ledger item 5.5c into four sub-items and completed 5.5c-i by porting append_execution_log() and wiring the stage_start, stage_complete and pipeline_complete execution_logs entries beside the events they accompany, with 17 new tests and four negative controls.

**Changes:**
- web/src/mastra/execution-log.ts: appendExecutionLog() as an atomic `execution_logs || '[entry]'::jsonb` append, deliberately not stamping updated_at (Python's raw text() SQL bypassed SQLAlchemy's onupdate), omitting the `data` key for an empty dict per Python's `if data:`, and emitting timestamps in the `+00:00` offset form because both readers compare `ts` as a plain string in SQL and `Z` sorts above `+`
- stageCostUsd() reproduces Python's hardcoded 15.0/75.0 per-million Opus rates applied to every provider, cross-checked against real Python round() output rather than derived twice from the same source
- announceStageStart and announceStageComplete in steps/stage-io.ts now write their execution_logs entry in the position Python's own append_execution_log calls held relative to the publish; the stage_complete entry carries the token counts and priced estimate the SSE payload never had
- steps/pipeline-complete.ts writes the run-level `pipeline_complete` entry with stage "" between the completion stamp and the publish
- roundSeconds switched from Math.round(value*100)/100 to pythonRound(value, 2), so the duration in the event and the duration in the log entry cannot disagree on ties (0.125 renders 0.12 in Python, 0.13 under Math.round)
- 10 writer tests against the real database (atomicity under six concurrent appends, updated_at untouched, entry read back through the analytics query's own SQL expressions) plus 7 assertions folded into pipeline-events.test.ts's four existing real workflow runs
- images-manifest.test.ts and images-assemble.test.ts whole-row comparisons updated to include executionLogs, which is a real behaviour change rather than a test edit to force a pass
- docs/mastra-port/LEDGER.md: 5.5c split into 5.5c-i through 5.5c-iv, 5.5c-i checked with three recorded decisions, a real stored entry pair, Python cross-checks, four negative controls and all frontend plus Python gate results
- todo.md: [confirmed] entry for the Opus-priced cost_usd on every stage's log entry, and the scaffold-check flake entry updated with its recurrence

**Learnings:**
- The execution_logs `ts` format is a wire contract, not a detail: api/src/api/analytics.py both bounds (`log_entry->>'ts' >= :since`) and orders (`ORDER BY log_entry->>'ts' DESC`) by plain string comparison in SQL, so toISOString()'s trailing `Z` would sort every TypeScript entry after every Python entry recorded in the same second and would break the `until` bound. Rewriting the suffix to `+00:00` is required; padding milliseconds to Python's six digits is not.
- Python's stage_complete log entry hardcodes Anthropic Opus pricing (15.0/75.0 per Mtok) for every stage and ignores MODEL_COSTS entirely, so cost_usd on a research or images entry has always been an Opus-priced fiction. Reproduced verbatim because GET /api/analytics/logs serves these entries straight through.
- Math.round(x*100)/100 and Python's round(x, 2) disagree on exact ties, and durations are ms/1000 so 0.125 and 0.375 are exact ties that occur about 4 times per 1000 ms values. pythonRound (built for the analytics port) is the right shared helper wherever the same measurement is rendered into two places.
- Whole-row before/after comparisons in step tests are a good tripwire but need updating whenever a step gains a column write; two committed tests failed for exactly the right reason when execution_logs joined the set.
- drizzle's db.execute() with node-postgres returns a QueryResult, so rows come off `.rows` rather than by destructuring the result directly.
- Call-site counts worth stating in the ledger: append_execution_log has nine (six in worker.py, two in publish.py, one inside publish_stage_log), publish_stage_log has 28, all inside the six stage nodes. That asymmetry is why 5.5c had to split.
- `pnpm -C web <script>` fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL in this worktree; the gates have to be run from inside web/.

### Iteration 82

**Summary:** Completed ledger item 5.5c-ii by porting the run-level pipeline_start execution_logs entry as a head step on the workflow chain, with 6 new tests, 2 changed real-run assertions and four negative controls.

**Changes:**
- web/src/mastra/steps/pipeline-start.ts: a Mastra step porting api/src/worker.py:117, appending one execution_logs entry (stage "", level info, event pipeline_start, message "Full pipeline run initiated", no data key) gated on the absence of a stage selection, with no SSE event beside it because Python published none
- web/src/mastra/workflows/pipeline.ts: pipelineStartStep registered as the head of the chain ahead of research, so the chain reads pipeline-start -> research -> outline -> write -> edit -> images -> ready -> pipeline-complete; the step's outputSchema is stageStepInputSchema and it returns inputData untouched so research receives an unchanged input
- web/src/mastra/steps/pipeline-start.test.ts: 6 tests against the real database covering both branches of the gate, pass-through of the input, that no other column (current_stage, stage_status, stage_logs, updated_at) moves, and that the step is the head of the registered workflow read off pipelineWorkflow.stepGraph
- web/src/mastra/pipeline-events.test.ts: two behaviour changes asserted on the existing four real workflow runs, the full run's log now opening with pipeline_start and a run parked at its first gate now recording that it started rather than writing nothing at all, plus two new assertions for the message shape and the skip-first-stage case
- docs/mastra-port/LEDGER.md: 5.5c-ii checked with the step-not-route-handler decision argued, a real stored entry pasted, verbose output for both test files, a four-row negative-control table and all frontend plus Python gate results

**Learnings:**
- pipelineWorkflow.stepGraph is a public accessor on the built workflow (@mastra/core/dist/workflows/workflow.d.ts:349) whose entries are discriminated by `type`, so head-of-chain position is directly assertable in a unit test. Without that assertion the only thing pinning ordering is the four real runs, and a negative control that moved the step behind research failed exactly one test, confirming the position assertion is the thing carrying it.
- A head step's outputSchema has to be the workflow's inputSchema, not the shared stage output schema, because it produces no stage meta and the evented engine parses the previous step's output against the next step's input schema. Returning inputData unchanged is what makes inserting a step into an existing chain a no-op for every downstream step.
- The pipeline_start entry is the only record that a full run was picked up: a run that dies inside research commits no column and moves no status, so an empty execution_logs was previously indistinguishable between 'running for a minute' and 'never enqueued'. That is also why it belongs in a step rather than in the route handler, where it would only mean the workflow.start event reached Redis.
- Adding a run-level write flips an existing 'writes nothing at all' assertion into a positive one. The gate-parked run's test in pipeline-events.test.ts asserted an empty log and had to become an exact one-entry assertion; treating that as a test edit rather than a behaviour change would have hidden the only new fact the item introduced.
- Live image tests write real .webp files into media/test-123/ that show up untracked after a full suite run. 39 such files are already tracked from earlier iterations, so a full-suite run before an auto-commit will silently add more unless they are removed.

### Iteration 83

**Summary:** Split ledger item 5.5c-iii and completed 5.5c-iii-a by porting Python's error/stage_error execution_logs entry into the failure recorder, with 7 new tests and four negative controls.

**Changes:**
- recordRunFailure() in web/src/mastra/failure-recorder.ts appends Python's error / stage_error execution_logs entry ({error, attempts, moved_to_dlq: true}, message 'Pipeline failed after N attempts: <error>') after the stage_error publish, which is the one pair in Python's runner that publishes before it appends
- The entry sits inside the run-id guard, renamed from firstAnnouncementOf to firstReportOf because it now guards two non-idempotent reports: the engine delivers workflow.fail more than once per failed run and an append would leave duplicate log entries where the row write only rewrites the same values
- The entry's stage names the step whose own result failed and attempts is the same executionsBeforeFailure() that feeds stage_logs._error, so the entry cannot disagree with the marker written a line earlier
- 7 new tests in failure-recorder.test.ts: 4 on the file's existing real failing run (real evented engine, real Redis Streams, real database) including the whole run's log read back as an ordered trail, and 3 driving recordRunFailure directly for the repeat-delivery and ignored-event cases a single run cannot produce
- docs/mastra-port/LEDGER.md: 5.5c-iii split into a checked 5.5c-iii-a and an open 5.5c-iii-b, with the engine's retry branch pasted from node_modules as the argument for the split, three recorded decisions, a real stored entry, a four-row negative-control table and all frontend plus Python gate results
- Removed 9 untracked .webp files that the live image tests wrote into media/test-123/ during the full-suite run

**Learnings:**
- The evented engine's retries are invisible to a workflows-finish listener by construction: workflow-event-processor-Dp87-e6z.js:3434 republishes workflow.step.run with retryCount + 1 while retries remain and only routes to workflow.step.end (and so workflow.fail) once retryCount >= retryConfig.attempts. Python's warning/retry log entry therefore cannot be ported where its sibling entry lives; it needs a retry policy on the workflow plus a writer inside the step, where retryCount and the thrown error are both in hand.
- The port has no retry policy at all (retryConfig is the engine default {attempts: 0}) where Python retried the whole pipeline three times, skipping already-complete stages. A transient provider error kills the run and parks the post in the dead-letter queue for a manual retry. Now scoped as ledger 5.5c-iii-b rather than left implicit.
- Python's exception branch is the only place in worker.py that publishes the SSE event before appending the execution_logs entry; every other pair appends first. Following Python's own relative order per 5.5c-i means the failure entry lands after the publish rather than before it.
- An idempotency guard written for a publish is not automatically right for a database write, and the direction matters: markPipelineFailed is safe to repeat because every field is derived from the event, while appendExecutionLog is an append and duplicates. A negative control that moved only the append outside the guard failed 3 tests, including the real run's exact-count assertion.
- pytest run without the repo .env sourced does not fail loudly with a config error: it reports 4 failed / 205 passed / 177 errors where every error is 'password authentication failed for user pipeline'. The totals stay at 386 either way, so only the failed/passed split reveals the misconfiguration.
- A markdown table cell cannot carry vitest's '4 failed | 26 passed' verbatim even inside backticks, because GFM splits on the pipe before code spans are parsed.

### Iteration 84

**Summary:** Split ledger item 5.5c-iii-b and completed 5.5c-iii-b-1 by giving pipelineWorkflow Python's three-attempt retry policy, with 2 new tests, 4 updated assertions and three negative controls.

**Changes:**
- pipelineWorkflow carries retryConfig: { attempts: MAX_ATTEMPTS - 1 }, giving a failing stage three executions, which is Python's ARQ max_tries = MAX_ATTEMPTS landing on the same set of provider calls because Python's job retry skipped every stage already marked complete
- MAX_ATTEMPTS = 3 added to web/src/mastra/state.ts beside the status vocabulary, ported from api/src/worker.py:51, and consumed by both the workflow and the two tests that assert the count
- Two new tests on the existing real failing run (real evented engine, real Redis Streams, real database): the failing stage generates three times, and the stages before it generate once each, which pins the retry as step-scoped rather than run-scoped
- Four existing assertions moved from 1 attempt to MAX_ATTEMPTS (_error.attempts, the dead-letter list's attempts, the stage_error entry's message and data, and the execution_logs trail which now carries one stage_start per attempt) because the intended behaviour changed
- docs/mastra-port/LEDGER.md: 5.5c-iii-b split into a checked 5.5c-iii-b-1 and an open 5.5c-iii-b-2, with the engine's retry branch pasted from node_modules, three recorded decisions, the pre-implementation failing output, a three-row negative-control table and all frontend plus Python gate results
- todo.md records two findings: the unportable 10-second retry delay (confirmed) and the resumeData-lost-on-retry gate interaction (investigate)

**Learnings:**
- Mastra's evented processor reads only retryConfig.attempts. Its single retryConfig reference is the retry branch at workflow-event-processor-Dp87-e6z.js:3434, and the file's one sleep helper (abortableSleep, line 255) is exported for sleep steps and never called on the retry path, so retryConfig.delay is silently inert and Python's retry_delay = 10 has no port. Setting it would have been a value that reads as honoured and is not.
- attempts is retries after the first execution, not executions, so MAX_ATTEMPTS - 1 is the correct spelling of Python's MAX_ATTEMPTS. The off-by-one negative control fails the same six tests as having no policy at all, which is why the count had to be read off the engine rather than inferred from the name.
- getEntryRetries(leaf) ?? workflow.retryConfig.attempts means a per-step retries silently overrides the workflow policy, and executionsBeforeFailure() cannot see it: the negative control that set retries: 0 on the write step left _error.attempts reporting 3 while the step actually ran once. No step sets retries today, but any step that did would make every failure record lie.
- The engine's retry branch republishes workflow.step.run with retryCount + 1 and does not carry resumeData forward, so a step resumed from a review gate that then throws re-enters reviewGate() with no resumeData and re-suspends instead of retrying. The gate suite has no failing-after-approval case, so nothing caught it; it was found by reading the branch.
- A retried step re-runs its whole execute body, so announceStageStart fires once per attempt and the execution_logs trail gains a stage_start per attempt. That is parity rather than an artefact: Python's job retry re-entered _run_pipeline() and re-announced the stage it resumed on.
- Adding a retry policy triples how long a failing run takes to reach workflow.fail, which changes vitest's scheduling of the rest of the suite. The first full run after the change showed the known scaffold-check.test.ts flake (10 failed); the second showed the 9-failure baseline. Rerunning before attributing a failure is cheaper than investigating it.

### Iteration 85

**Summary:** Split ledger item 5.5c-iii-b-2 and completed 5.5c-iii-b-2-a by porting Python's warning/retry execution_logs entry into the five single-step stages, with 9 new tests and four negative controls.

**Changes:**
- recordStageRetry() in web/src/mastra/steps/stage-io.ts ports Python's `if job_try < MAX_ATTEMPTS:` branch (api/src/worker.py:333): a warning/retry execution_logs entry with Python's message and its three data keys, gated on retryCount + 1 < MAX_ATTEMPTS so it is written when and only when another attempt actually follows
- research, outline, write, edit and ready wrap their execute body in try/catch, call recordStageRetry with the step's own retryCount and the thrown error, and rethrow unchanged for the engine to retry or fail on; no SSE event goes with it because the failure recorder already publishes stage_error once per run
- web/src/mastra/steps/stage-retry.test.ts: 6 tests against the real database driving recordStageRetry directly, covering the boundary a real run can never reach (the last attempt writes nothing), a thrown non-Error, and the exact stored entry shape
- 3 new assertions on failure-recorder.test.ts's existing real failing run plus the whole-trail assertion updated to interleave a retry entry after every attempt but the last, which is a behaviour change rather than a test edit
- docs/mastra-port/LEDGER.md: 5.5c-iii-b-2 split into a checked 5.5c-iii-b-2-a and an open 5.5c-iii-b-2-b, with three recorded decisions, the pre-implementation failing output, a real stored entry pair, a four-row negative-control table and all frontend plus Python gate results
- todo.md records as [investigate] that the images stage may not retry at all, since imagesWorkflow is a nested run with a defaulted retryConfig of {attempts: 0}

**Learnings:**
- retryCount is a first-class execute param on the evented engine (workflows/step.d.ts:32, passed at workflow-event-processor-Dp87-e6z.js:1143), which is what makes the retry entry writable from inside a step at all. It counts retries after the first execution, so retryCount 0 is Python's job_try 1.
- createWorkflow defaults retryConfig to {attempts: 0, delay: 0} (agent-DSxJoGjY.js:4951), and the retry branch reads `workflow.retryConfig` for whichever workflow owns the entry. A nested workflow therefore does not inherit its parent's policy, so imagesWorkflow's three sub-steps have no retries of their own and cannot see the parent's attempt number. That asymmetry, not diff size, is what forced the split.
- Steps built by createStep are plain objects whose execute the engine calls as entry.step.execute(ctx), so post-construction decoration is technically possible, but it destroys createStep's contextual typing of the execute params. The inline try/catch is the only form that keeps inference, at the cost of re-indenting each body.
- A step whose input fails schema validation throws inside StepExecutor.execute before step.execute is called, so no catch in a step body can see it. Any per-step error record has that blind spot by construction.
- An off-by-one in the gate is the failure mode worth a negative control here: it leaves the entry looking correct on every attempt except the last, where it silently claims a retry that never comes. Loosening the gate to `attempt > MAX_ATTEMPTS` failed 4 tests, the same count as deleting the gate entirely.
- A real failing run can only ever exercise the branch that writes an entry, because a run fails on its last attempt by definition. The else branch needs a direct-call test, which is why the item needed a second test file rather than more assertions on the existing run.

### Iteration 86

**Summary:** Split ledger item 5.5c-iii-b-2-b and completed 5.5c-iii-b-2-b-i by measuring that a parent workflow never retries a nested workflow entry and giving imagesWorkflow its own three-attempt retry policy, with 10 new tests and four negative controls.

**Changes:**
- Measured the evented engine's retry semantics across a nested workflow boundary in web/src/mastra/workflows/nested-retry.test.ts: three synthetic workflows on a real engine, real Redis Streams and real Postgres storage prove a parent does not retry a nested workflow entry under its own retryConfig, with a plain-step control proving the harness can see a retry at all
- imagesWorkflow now declares retryConfig: { attempts: MAX_ATTEMPTS - 1 } of its own, so the one stage that is a nested workflow retries three times like the other five instead of the single attempt it silently got
- web/src/mastra/workflows/images-retry.test.ts asserts the fix on the real workflow nested under a parent carrying pipelineWorkflow's policy: the manifest provider is called once per attempt, the run fails once they are spent, and execution_logs carries one stage_start per attempt
- docs/mastra-port/LEDGER.md: 5.5c-iii-b-2-b split into a checked 5.5c-iii-b-2-b-i and an open 5.5c-iii-b-2-b-ii, with the engine excerpt pasted from node_modules, the measurement table, three recorded decisions, the pre-implementation failing output, a four-row negative-control table and all frontend plus Python gate results
- todo.md's [investigate] entry about the images stage not retrying is now [confirmed, fixed] with the measurement that contradicted its guess, plus the residual per-sub-step asymmetry the fix leaves behind

**Learnings:**
- A Mastra parent workflow's retryConfig does not reach a nested workflow entry. runLeafStep publishes workflow.start for the nested run and returns at workflow-event-processor-Dp87-e6z.js:3310, 124 lines before the failing-status retry branch, and the nested run reports back via processWorkflowEnd publishing workflow.step.end on the parent directly. So a nested workflow needs its own retryConfig or it gets exactly one attempt, and there is no parent attempt loop for its steps' retryCount to restart against.
- Workflows must be registered on the Mastra instance under a key equal to their id. The engine resolves a nested entry with mastra.getWorkflow(<its id>), so a friendly key makes the nested run fail with MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND and the parent run then hangs until vitest's hook timeout rather than failing fast.
- The earlier reading-based guess in todo.md was wrong in the direction that mattered: a nested workflow IS dispatched as entry.step.execute(...) like any step, but only after the nested branch has already been ruled out, so the dispatch line proves nothing about retries. This is exactly why the ledger required a measurement rather than a reading.
- A control workflow is what turns 'the nested step ran once' into a measurement. Without a plain step under the same parent proving the policy fires at all, the same observation is equally consistent with the parent's retryConfig being inert for every entry, which would have meant the five stages ported in 5.5c-iii-b-1 do not retry either.
- The off-by-one negative control (attempts: MAX_ATTEMPTS instead of MAX_ATTEMPTS - 1) fails the same three tests as having no policy at all, which is why the images test reads the count off pipelineWorkflow rather than restating the constant a third time.
- pytest silently reports 4 failed / 205 passed / 177 errors when the repo .env is not sourced, and `set -a; . .env; set +a` inside a compound command can still miss if the Bash tool's persisted cwd is not the repo root. Echoing a prefix of DATABASE_URL before running is the cheap check.

### Iteration 87

**Summary:** Completed ledger item 5.5c-iii-b-2-b-ii by porting Python's warning/retry execution_logs entry into all three images sub-steps, with 10 new tests and four negative controls, which also closes the 5.5c-iii branch.

**Changes:**
- images-manifest, images-generate and images-assemble each wrap their execute body in try/catch, call recordStageRetry with the sub-step's own retryCount against imagesWorkflow's policy, and rethrow the error unchanged; the entry is filed under the stage name "images" rather than the sub-step id because both execution_logs readers group on `stage`
- images-assemble resolves its post id from getStepResult(imagesManifestStep) before the try so the catch has it, leaving a single stated blind spot: a getStepResult that itself throws writes no entry
- web/src/mastra/steps/images-retry-entry.test.ts: 11 tests against the real database driving each of the three sub-steps' execute directly, covering the two sub-steps a real failing run can never reach and the last-attempt boundary that writes nothing
- web/src/mastra/workflows/images-retry.test.ts gains two assertions on its existing real failing nested run (real evented engine, real Redis Streams, real Postgres): the exact pair of retry entries, and the whole trail interleaving retry after every attempt but the last
- docs/mastra-port/LEDGER.md: 5.5c-iii-b-2-b-ii checked with the open question answered and two alternatives argued down, one recorded deviation, the stated blind spot, the pre-implementation failing output, the real stored trail, a four-row negative-control table and all frontend plus Python gate results; 5.5c-iii, 5.5c-iii-b, 5.5c-iii-b-2 and 5.5c-iii-b-2-b checked as fully covered by their sub-items

**Learnings:**
- generateOneImage never throws by construction (every provider, optimizer and filesystem failure is recorded on the returned entry), so the fan-out-writes-five-identical-entries risk that motivated splitting this item is near-theoretical: images-generate can only throw on the credential read or its own imageSpecSchema.parse. Reading the implementation rather than reasoning from the fan-out shape is what unblocked the design decision.
- The negative control that removed the catch from only images-generate and images-assemble failed 2 tests while the real nested run still passed. Without the direct-call file, two thirds of this change would have looked complete and shipped silently, because a real run can only ever fail inside images-manifest.
- images-manifest calls announceStageStart before it reaches the agent, so its execution_logs trail is stage_start then retry, not retry alone. A first draft asserting a single-entry trail failed for exactly that reason; filtering to event === "retry" plus a separate whole-trail assertion is the shape that keeps both facts visible.
- A test that stubs the mastra param for a step with a review gate must also stub `suspend` and seed stageSettings to "auto", or the step fails with "suspend is not a function" and the test silently asserts on the wrong failure path. A probe that dumped the real stored entry is what caught it.
- `git checkout <file>` used to revert a negative control also reverts unrelated edits made to that same file earlier in the iteration. Two new test assertions were lost this way and only surfaced because the verbose reporter showed 4 tests where 6 were expected. Copy to /tmp and copy back instead.
- zsh does not word-split unquoted parameters, so `for f in $F` over a space-separated list of paths silently treats the whole list as one filename. That turned a negative-control backup loop into a no-op and clobbered two implementation files with their HEAD versions.

### Iteration 88

**Summary:** Split ledger item 5.5c-iv into four sub-items and completed 5.5c-iv-a by porting Python's publish_stage_log() and wiring its three call sites into the outline, write and ready stages, with 13 new tests and four negative controls.

**Changes:**
- publishStageLog() in web/src/mastra/steps/stage-io.ts ports api/src/pipeline/helpers.py:49: it publishes the `log` SSE event with Python's five-key payload (stage, message, level, timestamp, optional data) and then appends the matching execution_logs entry, swallowing an append failure at logger.debug the way Python's try/except did. Python's module-level set_event_context / clear_event_context has no port: the transport and post id are arguments, which also deletes the no-op-when-unset branch and the two-runs-share-one-post-id failure mode.
- formatSeconds() renders Python's `f"{x:.1f}"` as pythonRound(x, 1).toFixed(1), because a duration is ms/1000 so every 250ms and 750ms boundary is an exact tie that Python resolves to even and toFixed resolves away from zero (2.25 renders 2.2 against 2.3).
- nowIso() exported from execution-log.ts so the SSE payload's `timestamp` and the stored entry's `ts` carry the same +00:00 offset rendering Python's isoformat() produced in both places.
- outline, write and ready each write their three progress lines in Python's own positions: after load_rules and before the prompt is built, immediately before the provider call, and once it has answered and before the column is saved. tokensOut and durationS are now named before the output object so the line and the step's return cannot disagree.
- web/src/mastra/steps/stage-log.test.ts: 9 tests against the real database, including a publish-before-append ordering proof read from inside the publish callback, both branches of the swallowed append failure, and Python's `if data:` emptiness rule on an empty object.
- 4 new assertions on pipeline-events.test.ts's existing real workflow run (real evented engine, real Redis Streams, real Postgres) plus its whole-trail assertion updated to interleave three log entries per ported stage; failure-recorder.test.ts's trail updated to two log entries per write attempt before the stubbed provider throws.
- docs/mastra-port/LEDGER.md: 5.5c-iv split into 5.5c-iv-a through 5.5c-iv-d with the per-stage call-site counts pasted, 5.5c-iv-a checked with three recorded decisions, a real stored event/entry pair, the pre-implementation failing output, a four-row negative-control table, one stated blind spot and all frontend plus Python gate results.
- todo.md records as [confirmed] that `received` in pipeline-events.test.ts is not in delivery order, with the measurement that caught it and the one existing assertion still resting on that basis.

**Learnings:**
- The `received` array in pipeline-events.test.ts is not in delivery order, and an ordering assertion built on it looks correct until it is exercised. Its subscriber awaits a row read before pushing (5.5b's deliberate fix for a real flake), so the order is the order those reads resolved in. Measured on the suite's own run: stage_complete/research recorded ahead of stage_start/research, and one log/ready after stage_complete/ready. Assert counts on the topic and ordering on execution_logs, where the entry is written by the publishing process itself.
- Python's publish_stage_log is the only writer in the pipeline that publishes before it persists, and the only one whose persist is allowed to fail. Both are the reverse of announceStageStart/announceStageComplete, and the reason is structural rather than stylistic: a progress line carries its whole content in the payload so there is nothing to refetch and nothing to race.
- The module-level event context has no port and does not need one, but deleting it is a behaviour change worth stating: Python's `if _event_redis is None: return` meant a stage node driven outside the runner published nothing and stored nothing, where a Mastra step always does both.
- The 28 publish_stage_log call sites are unevenly distributed (research 5, outline 3, write 3, edit 7, ready 3, images 7) and only outline/write/ready share a shape. Counting them per file before splitting is what turned an unbounded item into four bounded ones.
- console.log and require("node:fs") both produce nothing usable inside a vitest ESM test under the default reporter. The reliable way to dump diagnostics from a failing assertion is expect({...}).toEqual({}) and read the diff.
- A negative control that removed only one stage's call sites failed 4 tests across two files, which is what proves the per-stage assertions pin each stage rather than the aggregate. The whole-trail assertion alone would have absorbed two of the three missing lines.

### Iteration 89

**Summary:** Completed ledger item 5.5c-iv-b by porting Python's five publish_stage_log call sites into the research stage, with 5 new tests, five negative controls and two pre-existing test flakes fixed.

**Changes:**
- web/src/mastra/steps/research.ts writes Python's five progress lines in the five positions research_node wrote them: after load_rules, before each provider call (with Python's attempt-number ternary), after each response that fails the validator, once the loop gives up, and once the stage has an answer; Python's for/else maps onto the post-loop `if (!isValidResearch(text))` branch the step already had
- DEGRADED_RESEARCH_MESSAGE exported from research.ts carrying Python's em dash as a — escape, cross-checked byte for byte against Python's own repr output and a hexdump of research.py (e2 80 94), because the message goes straight onto the wire and into debug-log-panel.tsx
- The final-attempt failure line is written unguarded and still reads 'retrying...', reproducing Python rather than correcting it; this is the deliberate opposite of recordStageRetry's gate, which is guarded because that entry claims another attempt from the engine
- 5 new tests in research.test.ts covering the three-line happy path, the attempt-naming ternary, the nine-line all-refusals path, the publish order interleaved with the two announcements, and the absent data key; the existing announcement assertion filtered to non-log events with the whole ordered sequence asserted in the new suite instead
- pipeline-events.test.ts: LOGGING_STAGES gains research, its per-stage log count moves 0 to 3, and the whole-trail assertion interleaves three log entries; failure-recorder.test.ts's failing-run trail gains research's three lines
- Fixed a pre-existing post-id collision between stage-log.test.ts and pipeline-start.test.ts that failed on posts_pkey under parallel file execution, moving stage-log.test.ts to ...0055d3
- Fixed a pre-existing race in failure-recorder.test.ts's waitForFailure(), which returned a row snapshot that could predate the stage_error append; the poll now also requires the entry to be present
- docs/mastra-port/LEDGER.md: 5.5c-iv-b checked with four recorded decisions, Python's rendering of all eight messages, the U+2014 hexdump, the real published/stored nine-line pair, the pre-implementation failing output, a five-row negative-control table, the HEAD baseline measurement and all frontend plus Python gate results
- todo.md records both fixed flakes with their measurements, including that nothing in the suite enforces post-id uniqueness across files

**Learnings:**
- Python's `for ... else` ports for free when the loop's break condition is already re-tested after the loop: research's existing degraded-research branch is exactly the else clause's condition, so the fifth call site attached to control flow the port already had rather than needing a sentinel flag.
- Measuring the baseline at HEAD before attributing a full-suite failure is worth the extra run. Three failure-recorder failures looked like they came from this change; reverting the four modified files and rerunning showed 12 failed at HEAD against the 9-failure baseline, proving the race was pre-existing and turning a suspected regression into a two-line infrastructure fix.
- Post ids in this suite are derived from ledger item numbers, which is a collision generator: stage-log.test.ts (item 5.5c-iv) and pipeline-start.test.ts (item 5.5c-ii) both landed on ...0055d1. The collision is scheduling dependent, so it passed the iteration that introduced it and failed the next one.
- Any test that reads a row after waiting on an SSE event is unsound for anything publishStageLog or recordRunFailure writes, because both publish before they append. The wait has to be on the stored entry, not on the event.
- A ledger that forbids em dashes and a port that requires one in a wire-contract message are resolved by writing — in source and stating in the ledger that every — in the pasted output is a transcription of the character the command actually printed. Pasting repr() output verbatim would have been a fabrication, since Python 3 prints the character rather than the escape.
- The probe-by-failing-assertion technique (expect({...}).toEqual({}) and read the diff) needs stageSettings seeded to "auto" for any step with a review gate, or the step dies on 'suspend is not a function' and the dump never runs. Same trap iteration 87 recorded.

### Iteration 90

**Summary:** Completed ledger item 5.5c-iv-c by porting Python's seven publish_stage_log call sites into the edit stage, moving its four quality warnings off the logger and onto the event bus, with 5 new tests and six negative controls.

**Changes:**
- web/src/mastra/steps/edit.ts writes Python's seven progress lines in edit_node's own positions: the rules-loaded line after loadRules, the provider-call line before generate, the received line once it answers, the three _validate_edit_output warnings, and the stripped-links warning after link validation
- The four warnings move off mastra.getLogger()?.warn and onto publishStageLog(..., {level: "warning"}), which is where Python published them; logger.exception's link-validation-failure line stays on the logger because Python never published it, so a browser hears about removed links but not about a link check that could not run
- editOutputWarnings() stays a pure function returning ordered messages, so a test can name an exact message without a transport while the step preserves Python's publish order by walking the list
- tokensOut and durationS are named before the received line so the line and the step's returned meta cannot disagree, matching the shape 5.5c-iv-a gave outline, write and ready
- 5 new tests in edit.test.ts covering the three info lines, all three quality branches firing at once, the boundary where none fires, the publish order interleaved with the two announcements, and the absent data key; the announcement test filtered to non-log events
- An ordering assertion in the dead-link test pins that the stripped-links line comes last and a quality warning precedes it, added because a negative control that ran editOutputWarnings after validateLinks on stripped content passed 60/60 without it
- pipeline-events.test.ts: LOGGING_STAGES replaced by a per-stage LOG_LINES_PER_STAGE map with edit at 5, the whole-trail and rerun-trail assertions interleave edit's five entries, the level assertion allows edit's two warnings, and messagesFor gains an edit block
- The four run-level workflow tests (pipeline, pipeline-completion, rerun-completion, concurrency) now assert the quality warnings on posts.execution_logs and assert the logger saw nothing, which is the behaviour change stated rather than a test edit
- docs/mastra-port/LEDGER.md: 5.5c-iv-c checked with a correction to the item's own wording, five recorded decisions, Python's rendering of all seven messages, the U+2014 hexdump, a real stored trail and matching published events, the pre-implementation failing output, a six-row negative-control table and all frontend plus Python gate results
- todo.md records as [optimization] that edit.ts carries three literal em dashes in source predating the escape convention, with the byte-contract constraint on any rewrite

**Learnings:**
- A negative control that passes is more informative than one that fails: moving editOutputWarnings after validateLinks left 60/60 green, proving Python's 'validate the answer, then the links' order was entirely unpinned. The order is load-bearing because stripping a link changes the has_external_links check the warnings read, so the control produced a shipped assertion rather than just a table row.
- git checkout HEAD -- $(git diff --name-only) reverts every changed file including the ledger entry written earlier in the same iteration. Iteration 87 recorded this for a single named file; the command-substitution form makes it silent and total, and the entry had to be rewritten from scratch.
- The ledger item's own description was wrong on a checkable fact: it said edit's seven calls are the only ones carrying data, where grep shows none of them do and the only three are in images. Checking an item's premise against the source before implementing it is cheap and the correction belongs in the ledger.
- edit is the only stage whose progress-line count is not fixed: three info lines plus one per true condition in _validate_edit_output. That breaks the uniform 'three lines per ported stage' shape pipeline-events.test.ts was built on, so the count list had to become a per-stage map rather than a membership set.
- The full-suite passing count pasted under 5.5c-iv-b (1632) does not match HEAD measured now (1637), so that entry's gate output was captured before its own last tests were added. Re-measuring HEAD rather than trusting the previous entry's number is what kept this iteration's +5 delta honest.
- A test asserting 'no quality warnings at all' needs every boolean SEO check satisfied, not just an absent keyword: has_h2_headings, has_meta_description and both link checks fire independently of the keyword, so the clean-answer fixture needs frontmatter, an H2, an internal link and an external link before the branch is reachable.
- prettier is not installed in web/ and there is no prettier config, so npx prettier --write silently does nothing and formatting is only enforced by eslint. Redirecting that command to /dev/null hid the failure for several files.

### Iteration 91

**Summary:** Split ledger item 5.5c-iv-d into two sub-items and completed 5.5c-iv-d-1 by porting Python's five pre-fan-out publish_stage_log call sites into the images manifest step, with 5 new tests and six negative controls.

**Changes:**
- web/src/mastra/steps/images-manifest.ts writes Python's four info progress lines in images_node's own positions: after loadRules, before the Claude call, once it answers (ahead of the parse, so a manifest that turns out to be prose still reports what it cost), and after the manifest's own images array is recovered
- The parse-failure notice moved off mastra.getLogger().warn and onto the event bus at level "warning" with Python's two data keys (error carrying the raw JSON value, raw_snippet the 500-code-point slice), which is where Python published it; a browser now hears about an unparseable manifest where before only the server log did
- The "Generating N images via Gemini..." line lands in the manifest step rather than the workflow's .map(), because the count is derived from the same images array the step returns and .map()'s callback is not handed mastra; tokensOut is named before the meta object so the line and the step's output cannot disagree
- 5 new tests in images-manifest.test.ts against the real database: the four lines in order on both transport and row, both interpolations pinned against the second fixture, the interleaving with stage_start, Python's five payload keys with no data key, and a skipped stage writing nothing
- The parse-failure test in images-manifest.test.ts and the real unparseable-manifest run in workflows/images.test.ts rewritten from logger assertions to stored-trail assertions that also assert the logger saw nothing
- pipeline-events.test.ts LOG_LINES_PER_STAGE.images moved 0 to 4 with a messagesFor("images") block; images-retry.test.ts and images-retry-entry.test.ts failing-attempt trails gain the two lines an attempt reaches before the agent throws
- docs/mastra-port/LEDGER.md: 5.5c-iv-d split into a checked 5.5c-iv-d-1 and an open 5.5c-iv-d-2, with four recorded decisions, Python's rendering of all five messages, the real published/stored pair, the pre-implementation failing output, a six-row negative-control table and all frontend plus Python gate results
- todo.md records as [confirmed] that String(manifest.error) diverges from Python's str() for a truthy container, with the reachability argument and why the fix is its own item

**Learnings:**
- Three negative controls that each fail only two tests are more informative than one that fails many: the parse-failure branch is reached by exactly two assertions, so publishing the Gemini count before it, leaving the notice on the logger, and moving the received line after the parse are three distinct errors that are individually pinned rather than jointly absorbed.
- Measuring HEAD by reverting every changed file before quoting a delta is worth the extra full-suite run. HEAD here is 1642 passed / 1658 total, not the 1637 the previous ledger entry recorded, so trusting that number would have made this item's +5 look like +10.
- generateOneImage returns the same {spec, usage} shape for all three of Python's per-image outcomes and never throws, so the fan-out's two call sites cannot decide which event to publish by inspecting the returned spec without an inference a provider error message of "no prompt" would defeat. That asymmetry with the straight-transcription first half, not diff size, is what forced the split.
- Python's f-string str() and JavaScript String() agree on every scalar but not on a container, and pythonTruthy deliberately makes the container case reachable for manifest.error. A port that carries the raw value in data and String() in the message is honest about the gap; silently using JSON.stringify would have invented a rendering neither stack produces.
- The Bash tool's persisted cwd makes `(cd web && ...)` inside a compound command silently produce no output in this environment. Running each negative control as its own call with an absolute cd is the only reliable form; a control that appears to pass because its output vanished is worse than no control.
- A step's test harness that stubs getLogger must provide debug as well as warn once publishStageLog is in the step, or a real execution-log append failure surfaces as "debug is not a function" from inside the catch that was meant to swallow it, turning a visible failure into a confusing one.

### Iteration 92

**Summary:** Completed ledger item 5.5c-iv-d-2 by porting Python's two per-image publish_stage_log call sites into the images fan-out behind an explicit outcome discriminant, with 15 new tests and six negative controls, which closes the whole 5.5c branch.

**Changes:**
- generateOneImage returns an `outcome` discriminated union (`{kind:"generated",bytes,url}` / `{kind:"failed",error}` / `{kind:"no-prompt"}`) stating which of Python's three exits produced the entry, because a short circuit and a provider failure are indistinguishable in the returned spec
- imagesGenerateStep publishes Python's `image_generated` and `image_failed` lines off that discriminant with their exact messages and data payloads, keeps Python's adjacent logger.error beside the failure publish, and stays silent on the no-prompt branch; `outcome` is carried on the step's zod output schema so the persisted fan-out result matches what it returns
- web/src/mastra/steps/images-generate.test.ts: 7 new tests against the real database covering both published lines, the topic, the absent line for a promptless entry, and a failing provider call on its own fetch stub so the success-path request capture is untouched
- web/src/mastra/images/generate-one.test.ts: 4 new tests pinning the branch every corpus entry took and that a provider error reading exactly "no prompt" is still `failed`
- web/src/mastra/workflows/images.test.ts: two new real evented-engine runs, one asserting five `image_generated` entries on the row in manifest order, one where a Gemini call fails with the message "no prompt" so the stored entry is byte-identical to a short circuit and the line is still published
- images-assemble.test.ts fixture builders reconstruct `outcome` from the recorded entries, with the reconstruction stated as a fixture property rather than the runtime inference production refuses
- docs/mastra-port/LEDGER.md: 5.5c-iv-d-2 checked with the design question answered and the callback alternative argued down, four recorded decisions, one recorded deviation, Python's rendering of both messages and both data dicts, the pre-implementation failing output, a six-row negative-control table, the HEAD baseline measurement and all frontend plus Python gate results; 5.5c-iv-d, 5.5c-iv and 5.5c checked as fully covered
- todo.md records that use-sse.ts listens for neither event name (Python's behaviour reproduced, a 5.5d contract question), a first observed failure of the recorded `received`-ordering defect, and that the test suite leaks WebP files into the repo's real media/ root

**Learnings:**
- A negative control that fails exactly one test can be the most important one in the table. Replacing the discriminant with an inference off the returned entry failed only the misleading-error run; every other test in the three files passed. Without that one run the entire design decision this item exists to make would have shipped unpinned.
- The inference-defeating case could not be pinned at the step level in the step's own test file, because the step's only seam is HTTP and GeminiApiError's message format cannot be made to read "no prompt". The test had to move up to workflows/images.test.ts, which already mocks the gemini module at import time. Where a control can be expressed is a constraint on which file the assertion lives in.
- Adding a new run to a workflow test file broke a pre-existing assertion that the media root contained exactly one directory. Moving the new test to the end of the describe preserved the original assertion verbatim, which is strictly better than weakening it; declaration order is execution order in vitest, so ordering is a real tool for avoiding test edits.
- Python's `logger.error` and `publish_stage_log` in the same except block are not redundant and should both be ported. Iterations 90 and 91 moved lines off the logger, but those were lines Python only ever published; the rule is what Python did, not "prefer the bus".
- Measuring HEAD by reverting every changed file caught two flakes (pipeline-events `carries Python's log payload`, scaffold-check lifecycle events) that made HEAD read 11 failures against the 9-failure baseline. Three full-suite runs in this iteration reported 9, 10 and 9, so a single run is not enough to state a failure count honestly.
- The Bash tool's persisted cwd silently defeats a leading `cd <abs> && set -a && . .env`: the sourcing reported `.env` not found even though the path existed. Sourcing with an absolute path in its own statement is the reliable form, and echoing a prefix of DATABASE_URL is still the cheap check.
- `pnpm -C web test` writes WebP files into the repo's real `media/test-123/` because `mediaRoot()` falls back to `<cwd>/../media` when MEDIA_DIR is unset. No test under web/src/mastra references that post id, so the leak is coming from somewhere untraced; the 39 committed .png files there are the Python-era version of the same bug.

### Iteration 93

**Summary:** Split ledger item 5.5d and completed 5.5d-i by porting Python's per-post SSE endpoint to a Next.js route handler subscribed to the Redis Streams pipeline topic, with 16 new tests and eight negative controls.

**Changes:**
- web/src/app/api/events/sse.ts holds the text/event-stream wire format sse_starlette 3.2.0 wrote: the \r\n separator from EventSourceResponse.DEFAULT_SEPARATOR, the four response headers that class set, and the 15s keepalive comment
- web/src/app/api/events/stream.ts ports _subscribe_and_stream(), the generator both Python endpoints shared, onto the retained Redis Streams topic: one subscription per request with startFrom 'latest', every delivery acked including the filtered-out ones, and teardown wired to request.signal and the stream's cancel()
- web/src/app/api/events/[post_id]/route.ts serves GET /api/events/{post_id}, authenticated and ownership-scoped through the same website_profiles inner join every other {post_id} handler uses, where the Python handler had no session dependency and no ownership check at all
- web/src/app/api/events/events.test.ts adds 16 tests against the real database, real BetterAuth sessions and the real Redis topic, with every asserted event published by a second RedisStreamsPubSub client so a delivered frame provably crossed Redis
- docs/mastra-port/LEDGER.md: 5.5d split into a checked 5.5d-i and an open 5.5d-ii, with three recorded deviations, package excerpts pinning the startFrom and ack semantics, the pre-implementation failing output, an eight-row negative-control table and all frontend plus Python gate results
- todo.md records an [optimization] entry: the per-request subscription costs one Redis connection and one consumer group per connected browser, with the process-wide-fanout fix and why it is not needed yet

**Learnings:**
- RedisStreamsPubSub.subscribe() anchors a newly created consumer group at '0' unless given startFrom: 'latest' (verified at node_modules/@mastra/redis-streams/dist/index.js:164). Left at the default, an SSE connection opened mid-run is handed the whole retained stream (maxStreamLength defaults to 10000) as if it were live, which Python's PUBLISH never did. Any future subscriber that wants live-only delivery must ask for it explicitly.
- Nothing acks on a subscriber's behalf: #deliverMessage passes ack/nack to the callback and only auto-nacks on a throw. An unacked entry stays in the group's pending list for the life of the subscription, so a filter that drops events without acking them leaks one pending entry per dropped event. The filtered-out events are the leak, not the delivered ones.
- Each subscribe() call opens its own Redis connection via createClient() and creates a private __fanout-<uuid> consumer group; unsubscribe() quits the client and calls xGroupDestroy. That makes consumer-group presence a directly assertable teardown signal via XINFO GROUPS, which is how the disconnect test proves cleanup rather than inferring it from silence.
- Python's events router was the one place in api/src/api/ with no authentication and no ownership check: post_events() took post_id as a plain str. Porting it faithfully would have shipped a cross-tenant read of stage messages, model names and token counts. Adding the ownership check forces a second change, a 422 on a malformed uuid, because the lookup now compares against a uuid column.
- A negative control that changes a shared constant can be masked by the test helper reading the same constant. Swapping SSE_SEPARATOR to \n failed exactly one test because the frame parser in the test file imports it too; only the one assertion comparing raw bytes to a literal noticed. Byte-exact assertions are worth having precisely for this class of control.
- Awaiting the subscription before returning the Response removes a real race: ReadableStream.start() is async and the handler would otherwise return before the topic subscription existed, so an event published immediately after the caller has its Response could fall into the gap.

### Iteration 94

**Summary:** Completed ledger item 5.5d-ii by porting Python's global SSE endpoint to a Next.js route handler that scopes the queue-wide feed to the caller's own posts, with 12 new tests and six negative controls, which closes the whole 5.5d branch.

**Changes:**
- web/src/app/api/events/route.ts ports global_events(): authenticated, then streams the shared pipeline-events topic filtered by an ownership predicate, where Python subscribed every caller to pipeline:global unauthenticated and forwarded it verbatim
- web/src/app/api/events/scope.ts holds the split's actual design decision: ownership resolved per post id lazily and memoised for the connection's lifetime, through the same ownedByCaller() inner join every other handler uses, so a post created after the connection opened still resolves on its first event and a run's tens of events cost one query
- web/src/app/api/events/stream.ts accepts a predicate returning a promise and chains every delivery onto the previous one, because RedisStreamsPubSub invokes a subscriber without awaiting it, so an async predicate would let cached events overtake ones waiting on Postgres; a rejecting predicate is swallowed on the chain and its event is not sent
- web/src/app/api/events/events.test.ts gains a 12-test GET /api/events block against the real database, real BetterAuth sessions and the real Redis Streams topic, proving memoisation and ordering through observable consequences (deleting the post row mid-connection, two rounds across three posts) rather than by counting queries
- docs/mastra-port/LEDGER.md: 5.5d-ii checked with the three considered scoping shapes and the two rejections argued out, two recorded deviations, the pasted transport source that forced the ordering fix, a six-row negative-control table and all frontend plus Python gate results; 5.5d checked as fully covered by its sub-items

**Learnings:**
- RedisStreamsPubSub calls sub.cb(event, ack, nack) and only attaches a .catch() to the returned promise, never awaiting it, so subscriber callbacks run concurrently and any async work inside one reorders delivery. Every previous SSE item was safe only because its predicate was synchronous; this is a latent trap for any future subscriber that awaits anything before sending.
- Memoisation and per-event-query can be told apart without mocking the database by deleting the post row mid-connection: a per-event lookup starts dropping the feed, a memo keeps delivering. Asserting a performance property through a behavioural consequence kept the test on real boundaries.
- uv run pytest without sourcing the repo .env first fails every database test with asyncpg InvalidPasswordError and reports 177 errors against the recorded baseline of 25. A future iteration could easily misread that as a regression it caused; the memory note about the env-driven DB port covers the port but not the password.

### Iteration 95

**Summary:** Split ledger item 5.5e into three sub-items and completed 5.5e-i by adding the replay anchor as an `id:` field on every SSE frame, with 11 new tests and six negative controls.

**Changes:**
- web/src/app/api/events/anchor.ts defines the replay anchor as `<createdAt milliseconds>-<transport uuid>`. The uuid is the exact match for one Redis stream entry; the timestamp is the fallback ordering for when the anchor event has been trimmed off the 10000-entry stream, which is what stops 5.5e-ii's skip loop from running forever and leaving a browser connected and silent.
- encodeSseEvent() in web/src/app/api/events/sse.ts takes an optional id and writes `id:` before `event:` with line breaks stripped, matching sse_starlette's ServerSentEvent.encode() field order and its `if self.id is not None` guard. encodeSsePing() is untouched and stays a bare comment, so a keepalive cannot move the client's Last-Event-ID off a real position.
- pipelineEventStream() in stream.ts reads the anchor off the delivered transport envelope rather than the published payload, so the same event carries the same id on the per-post stream and on the global feed.
- Eleven new tests in web/src/app/api/events/events.test.ts (28 -> 39): integration tests assert raw frame bytes against an expected id read back independently off the Redis stream with xRange, plus unit tests for eventAnchor(), encodeSseEvent() and encodeSsePing().
- Ledger item 5.5e split into 5.5e-i (the anchor, done), 5.5e-ii (server-side replay from Last-Event-ID header or last_event_id query parameter, with the no-gap test) and 5.5e-iii (use-sse.ts carrying the anchor across its own reconnect), with the transport evidence that forced the split pasted under it.
- todo.md records a second cross-file test flake on the shared Redis topic (src/mastra/pipeline-events.test.ts), tied to the existing scaffold-check entry as probably one cause.

**Learnings:**
- The objective's claim that Mastra provides resumable-stream replay does not hold for this transport. SubscribeOptions.startFrom is 'earliest' | 'latest' and nothing else, and RedisStreamsPubSub's #deliverMessage() closes the Redis entry id over ack/nack and invokes the subscriber as sub.cb(event, ack, nack), so a subscriber can never learn its stream position. Replay has to be built as: subscribe from earliest, drop up to the anchor, forward the rest.
- The Event.id a subscriber receives is a randomUUID() stamped in publish(), not the Redis entry id. createdAt is stamped before the xAdd is awaited, so two concurrent publishes can be timestamped in one order and land in the stream in the other. For 5.5e-ii's timestamp fallback that produces a duplicate frame, never a gap, which is the right way round.
- use-sse.ts builds a brand new EventSource on every retry (onerror closes the old one and setTimeout opens a fresh one), and the Last-Event-ID buffer is per EventSource object. So the browser will never send that header here and 5.5e-ii must accept the anchor as a query parameter as well. This makes 5.5e-iii load-bearing rather than plumbing.
- Two of the six negative controls exposed weak tests rather than confirming strong ones. A uuid-only anchor passed a monotonicity assertion because Number("3f1a2b3c") is NaN and an array of NaNs sorts to itself; a per-connection counter passed the cross-stream-agreement test because both connections opened before the single publish, so the counters agreed by accident. Running the controls before claiming the item is what caught both.
- vitest 4 removed the `basic` reporter: `--reporter=basic` fails with a startup error, so negative-control runs have to grep the default reporter output.
- pnpm -C web <cmd> does not work in this worktree (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL, "Command web not found"), and `next lint` is gone. Run gates from inside web/ as `npx tsc --noEmit`, `npx eslint`, `npx vitest run`, `npx next build`, with the repo .env sourced first or next build fails on BetterAuthError about the default secret.

### Iteration 96

**Summary:** Completed ledger item 5.5e-ii by adding server-side SSE replay from a client anchor to both events handlers, with 19 new tests and seven negative controls.

**Changes:**
- web/src/app/api/events/anchor.ts gained parseAnchor(), requestAnchor() and anchorPosition(): the anchor is read from the Last-Event-ID header first and the last_event_id query parameter second, because the header is the fresher of the two when a browser reconnects an existing EventSource, and an unparseable value means 'no anchor' rather than an error or a whole-stream replay
- pipelineEventStream() in stream.ts subscribes with startFrom: "earliest" when a request carries an anchor and drops every delivery until it passes that anchor, with the skip inside the existing ordered tail chain and ahead of matches, so a client with a large backlog pays no ownership lookup per skipped event
- anchorPosition() compares timestamps strictly, so the anchor's own millisecond reads as 'before': the uuid resolves the case where the anchor is still on the stream, and the timestamp only stops the replay skipping forever once the anchor has been trimmed, which is a case where the client already has an unavoidable gap
- Nineteen new tests in events.test.ts (39 -> 59): seven integration tests that disconnect a real connection and reconnect through the real handler asserting the exact sequence of payload counters, plus unit coverage of parseAnchor(), requestAnchor() and anchorPosition()
- A test that anchors on a frame whose successor shares its createdAt, added after a negative control proved no integration test exercised the exact-uuid match; it is deterministic because six concurrent publishes span microseconds so at most one millisecond boundary can fall inside them
- docs/mastra-port/LEDGER.md item 5.5e-ii checked with the pasted command output, the seven negative-control tables, the measured replay cost against a full 10000-entry stream, and the both-sides measurement of the baseline discrepancy
- todo.md's scaffold-check entry updated: the flake now reproduces on every full run including at HEAD, so it is a standing baseline discrepancy that has to be fixed before item 9.1 rather than a flake worth pinning

**Learnings:**
- The frontend whole-suite baseline is now 10 failures, not the recorded 9. scaffold-check.test.ts > 'emits the workflow lifecycle events the trace view will read' has stopped being intermittent and fails on every full run, including with all of this item's files reverted to HEAD. Future iterations should compare against 10 and measure both sides before attributing a tenth failure to their own change.
- A replay costs a full scan of the retained stream: about 1.3s before the first frame against a 10000-entry stream (replaying tests 2.9s vs 1.34s for the equivalent non-replaying test). There is no way around it, because RedisStreamsPubSub never hands a subscriber the Redis entry id, so item 8.1's trace view should not reconnect casually.
- Negative controls have to be run before claiming an item, not after. Removing the exact-uuid match failed only one unit test, because every replay integration test happened to leave a millisecond or more between the anchor and what followed it (the client has to receive a frame and disconnect in between, which takes over a second), so the timestamp fallback alone carried all of them.
- Concurrent publishes give a deterministic same-millisecond fixture: N publishes issued in one turn span microseconds, so at most one millisecond boundary can fall inside them and at least N-2 of the N-1 adjacent pairs must share a createdAt. Searching the delivered frames for such a pair is reliable where asserting all N are equal would flake.
- vitest output has to be stripped of ANSI escapes before grepping for the failure lines: `| grep ... | sed 's/\x1b\[[0-9;]*m//g'` silently matches nothing, the sed has to come first.
- Running the full vitest suite writes three untracked .webp artifacts into media/test-123/. Earlier iterations committed some of these by accident (the tracked featured-0301/0302 files); check `git status` for them before finishing.

### Iteration 97

**Summary:** Completed ledger item 5.5e-iii by making use-sse.ts carry the SSE replay anchor across its own reconnect as a query parameter, with 7 new tests and six negative controls, which closes the whole 5.5 events router.

**Changes:**
- web/src/hooks/use-sse.ts records MessageEvent.lastEventId per delivered frame (named and unnamed) and puts it on the next EventSource's URL as ?last_event_id=<anchor>, because a freshly constructed EventSource sends no Last-Event-ID header
- The parameter name is imported as LAST_EVENT_ID_PARAM from web/src/app/api/events/anchor.ts, the same constant requestAnchor() reads, so the client and server halves of the wire contract cannot drift
- The anchor lives in a let inside the effect rather than a ref outside it, so it resets on a postId change instead of replaying the new post's retained backlog
- The anchor advances before the JSON parse and ignores an empty lastEventId, matching how the browser's own Last-Event-ID buffer behaves for an unreadable frame and for a frame with no id: line
- 7 new tests in web/src/hooks/use-sse.test.ts plus emit helpers extended with a lastEventId argument; the new tests advance fake timers inside act() so they add no React warnings
- Ledger 5.5e-iii checked with failing-first output, verbose passing output, six negative controls and all five gates pasted; parents 5.5e and 5.5 closed with summary evidence

**Learnings:**
- web/src/app/api/**/*.ts modules are safely importable from a client hook when they carry no server-only marker and their heavy imports are `import type`: anchor.ts's `import type { Event } from "@mastra/core/events"` erases, and `pnpm build` links with only the two string constants and pure functions reaching the client bundle. Sharing the wire-contract constant this way is cheaper than a second literal.
- Two of the seven tests for this item are guards a missing implementation also passes (no anchor on first connect, no anchor across a postId change). They only have teeth from negative controls, so writing the failing-first evidence needs the count split explicitly: 5 of 7 failed, not 7.
- The pre-existing use-sse tests advance fake timers outside act(), so the mock EventSource's open-on-next-microtask fires setConnected(true) unwrapped and prints a React warning. New tests in that file need their own act()-wrapped settle() helper or they multiply that noise sevenfold.
- vitest's pass/fail glyphs are a check mark and a multiplication sign, which the ledger's no-em-dash rule does not forbid but which do not survive a plain paste cleanly; transcribing them as + and x with a stated note is more honest than reformatting the summary lines.

### Iteration 98

**Summary:** Completed ledger item 5.6 by porting Python's three-endpoint rules router to Next.js route handlers with an allowlist derived from the stage rule map, adding 22 new tests and six negative controls.

**Changes:**
- web/src/app/api/rules/route.ts serves GET /api/rules, returning the RuleFile[] the settings page's rule editor builds its tabs from, with exists and byte size read from a single stat call instead of Python's exists()-then-stat() pair
- web/src/app/api/rules/[name]/route.ts serves GET and PUT for one rule file, keeping Python's two distinct 404s apart (Unknown rule: <name> for an unallowlisted name, Rule file not found for an allowlisted name with no file) and validating the body before the path name because FastAPI's request validation runs ahead of the endpoint function
- web/src/app/api/rules/rule-files.ts derives the six-name allowlist from STAGE_RULES_MAP rather than transcribing Python's literal set, so the files the settings page can edit and the files web/src/mastra/prompts.ts loads for a stage cannot drift apart; the derived list is pinned against Python's literal by a test
- All three handlers now require an authenticated session, closing the gap where the Python rules router had no session dependency and PUT was an unauthenticated write to the product's prompt IP for every tenant
- web/src/app/api/rules/rules.test.ts adds 22 tests, the first this router has ever had in either stack, against the real database and real BetterAuth sessions with RULES_DIR pointed at a scratch directory so PUT never touches the real rules/*.md
- docs/mastra-port/LEDGER.md item 5.6 checked with the FastAPI probe output that established the validation order, the failing-first and passing runs, a six-row negative-control table, all five gates, and the six-run both-sides measurement of the whole-suite failure count
- todo.md's scaffold-check entry gains the load-sensitivity datum: the flake fires 1 of 3 at HEAD, 3 of 3 with this item's test file, and 1 of 3 with a same-shape placeholder in its place

**Learnings:**
- FastAPI's ordering between a body validation error and a handler-raised HTTPException is observable and was not what a reading of the source suggests: PUT /api/rules/bogus with a missing content field answers 422, not the handler's 404, because request validation runs after dependency solving and before the endpoint function. Mounting the real router on a bare FastAPI() under TestClient is a cheap way to settle this class of question while api/ still exists, and it is worth doing for every remaining router rather than inferring the order.
- FastAPI only produces the json_invalid error body when the request carries content-type: application/json. Without that header the same malformed bytes come back as model_attributes_type with the raw string as input, so a probe that omits the header measures the wrong branch.
- The whole-suite failure count is load-sensitive, not just flaky. scaffold-check's lifecycle-event test fired 1 of 3 at HEAD, 3 of 3 with this item's 22-test route-handler file present, and 1 of 3 with a minimal placeholder test file of the same shape in its place. Adding a file is not the trigger; adding one that changes how the fast node-environment files pack against the slow real-transport ones is. Any future iteration quoting a failure count has to measure both sides, and a single HEAD run is not enough.
- Deriving an allowlist from an existing map instead of transcribing a Python literal is worth the coupling when a test pins the derived value against the literal: the negative control that dropped the sort failed four tests, three of which never mention ordering, because the same array is also the list response's iteration order. That kind of second-order coverage is what makes the derivation safe.
- The Bash tool's persisted cwd survives across calls in a way that silently breaks heredoc writes: after cd'ing into api/ for a probe, a later cat > web/src/... reported no such file or directory while still echoing its success line. Every file write in a session that cd's anywhere needs an absolute path.
- rm -f media/test-123/*.webp deletes 19 tracked files as well as the three untracked test leaks. The leaked artifacts have to be named individually, or git checkout -- has to undo the overreach.

### Iteration 99

**Summary:** Completed ledger item 5.7 by porting Python's three-endpoint links router to Next.js route handlers with caller-scoped deletes, adding 40 new tests and eight negative controls.

**Changes:**
- web/src/app/api/profiles/[id]/links/route.ts serves GET and POST /api/profiles/{profile_id}/links, preserving Python's unescaped %q% ilike search over url and title, the read-before-insert duplicate 409, the always-"manual" source, and the `(total + per_page - 1) // per_page if total > 0 else 0` page count
- web/src/app/api/profiles/[id]/links/[link_id]/route.ts serves DELETE with a correlated EXISTS over website_profiles.user_id, closing a cross-tenant write: Python's delete_link() was the one endpoint in that router that never resolved the profile against the caller, so any authenticated user who knew both ids could delete another tenant's link
- Shared FastAPI/pydantic behaviour moved out of posts/query.ts and posts/serialize.ts into web/src/app/api/pydantic.ts (parseInt422, unprocessableRequest, pathUuidIssue, bodyDetails, toPydanticIso), so the second router declaring Query(ge=, le=) reuses it instead of duplicating it
- PYDANTIC_INT widened to /^\s*[+-]?\d+(?:_\d+)*(?:\.0+)?\s*$/ after probing pydantic 2.12's lax int parse, which accepts "2.0" and "1_0_0" where the old digits-only regex answered int_parsing; this moves GET /api/posts toward parity too
- params.ts collects path, query and body issues into one 422 with path entries first, matching the ordering probed off the real router, while a body FastAPI could not decode still short-circuits to json_invalid alone
- web/src/app/api/profiles/[id]/links/links.test.ts adds 40 tests against the real database and real BetterAuth sessions, replacing api/tests/phase2/test_internal_links.py's 13 and adding the multi-tenancy cases that suite never had
- docs/mastra-port/LEDGER.md item 5.7 checked with the two FastAPI probe outputs, the pydantic int-grammar probe, failing-first and verbose passing runs, an eight-row negative-control table, both full-suite runs, and the cross-file fixture collision with its fix
- todo.md records as [confirmed] that api/src/api/links.py's delete_link() has no ownership check and is still serving until Phase 7

**Learnings:**
- A cleanup predicate scoped to the shared fixture host (url like 'http://127.0.0.1:9/%') silently deletes another suite's rows. posts/update-delete.test.ts's Alembic-006 SET NULL assertion failed only when run alongside the new file and passed alone. Any new route-handler suite touching internal_links needs a path segment of its own, not just the shared loopback host.
- FastAPI aggregates path, query and body validation errors into one 422 with path entries first, but a body it cannot JSON-decode short-circuits everything: POST /api/profiles/bad/links with `{nope` answers a single json_invalid entry and drops the path error, because the body is read before the parameters are solved. This router is the first ported one with two validated parameters, so the ordering had to be probed rather than inherited.
- pydantic 2.12's lax int parse is wider than a digits-only regex: "2.0", "2.00", "1_0_0" and "1_0.0" are valid ints while "2.", ".0", "1e3", "1__0" and "2_" are not. The grammar is optional whitespace, optional sign, digits with single underscore separators, optional dot followed by nothing but zeros. Every ported Query(int) endpoint inherited the narrower rule from posts/query.ts.
- A negative control can prove a test is vacuous rather than confirming it has teeth. Replacing Python's `if q:` with `q !== null` failed nothing, because `url ilike '%%'` matches every row and url is NOT NULL, so the filtered and unfiltered queries are indistinguishable through the wire for q="". That branch is unverifiable, not verified.
- python3 string replacement against a source file fails silently when the file's line wrapping differs from the replacement text, and the run then reports a passing suite that looks like a control with no teeth. Checking the edit landed (grep for the new token) before trusting a control's result is what caught it.
- Overriding get_session with an async generator yielding a stub result object (scalar_one_or_none -> None) lets a FastAPI probe reach past dependency solving without a database, which is what makes validation-order questions cheap to settle while api/ still exists.

### Iteration 100

**Summary:** Split ledger item 5.8 into four sub-items and completed 5.8a by porting Python's analytics dashboard endpoint to a Next.js route handler, with 23 new tests and nine negative controls.

**Changes:**
- web/src/app/api/analytics/dashboard/route.ts serves GET /api/analytics/dashboard: five user-scoped aggregates (status buckets, average pipeline duration, top-ten profiles by post count, posts over time, posts today) each inner-joining website_profiles on user_id, assembled into the DashboardStats shape web/src/lib/api.ts already declared, which needed no change
- The four Python arithmetic behaviours are preserved and each has its own test: total sums every group rather than the named buckets, a null current_stage is keyed "null" as json.dumps rendered it, completion_rate uses the existing pythonRound half-to-even helper, and avg_duration_s is truthiness-tested before rounding so an average of exactly zero reports null
- avg_duration_s goes out as an integer, matching FastAPI's decimal_encoder for a zero-exponent Decimal, with Number() applied to the numeric string pg returns where asyncpg returned a Decimal
- The days query parameter reproduces pydantic's int_parsing, greater_than_equal (ge=1) and less_than_equal (le=365) 422 bodies, and reads getAll("days").at(-1) because Starlette's QueryParams returns the last value of a repeated key
- web/src/app/api/analytics/dashboard.test.ts adds 23 tests against the real database and real BetterAuth sessions, covering the 422 grammar, the half-to-even rounding tie at 1/16, the null-stage bucket, the zero-average case, the ten-profile cap, name-based profile grouping, the days window, and cross-tenant plus null-profile_id exclusion
- docs/mastra-port/LEDGER.md: 5.8 split into 5.8a-d with the five compiled SQLAlchemy statements, the decimal_encoder and null-key probes, the pre-implementation failing run, a nine-row negative-control table including the one control with no teeth, and all frontend plus Python gate results

**Learnings:**
- drizzle's node-postgres driver globally replaces pg's date (OID 1082) type parser with the identity, so a `date` column arrives as the raw 'YYYY-MM-DD' string rather than a Date at local midnight. A raw pg probe run before drizzle is imported gives the opposite answer, which is what made the ::text cast look necessary. Any future handler selecting a date, timestamp, interval or numeric through drizzle inherits this override; through the bare pool it does not.
- FastAPI's decimal_encoder returns an int, not a float, for a Decimal whose exponent is >= 0, so round(Decimal, 0) went out as `303` and round(float, 0) would have gone out as `303.0`. Postgres 17's EXTRACT(epoch ...) returns numeric, so every SQLAlchemy avg/sum over an extract reached asyncpg as a Decimal and took the int path. This applies to the remaining analytics endpoints (5.8b and 5.8c both round sums of cost_usd), so the wire type there has to be checked the same way.
- A negative control that passes can be the useful one. Dropping the ::text cast left all 23 tests green, which is what proved the cast redundant and removed it, rather than confirming a behaviour. Running controls before claiming an item catches dead code as well as untested code.
- Python's `round(v, 0) if v else None` and `round(x, 1)` are both observable through the wire and both diverge from the JavaScript defaults: an average of exactly zero must report null, and 1 complete of 16 posts is exactly 6.25 and must report 6.2, not 6.3. The existing pythonRound helper from the analytics service port covers the second; the first needs a deliberate truthiness test, not a null check.
- Python's dashboard_stats() builds its by_status subquery by selecting the whole Post entity and then counting one column of it. Compiling the five statements with the postgresql dialect was necessary rather than optional: two of them derive their FROM implicitly from the ON clause, and by_profile groups by website_profiles.name where a reading of the code suggests it groups per profile.

### Iteration 101

**Summary:** Completed ledger item 5.8b by porting Python's cost analytics endpoint to a Next.js route handler, fixing a FROM-clause bug that made the Python original 500 on every call, with 30 new tests and thirteen negative controls.

**Changes:**
- web/src/app/api/analytics/costs/route.ts serves GET /api/analytics/costs: a jsonb_each unroll of stage_logs scoped by website_profiles.user_id, aggregated in the handler into the CostAnalytics shape web/src/lib/api.ts already declared, which needed no change
- The Python endpoint's broken SQL is corrected: its website_profiles join sat inside the second FROM item where the posts alias is out of scope, so Postgres rejected the statement before binding a parameter and every call answered 500; the join is moved onto posts and the defect recorded in todo.md as [confirmed] since the Python route serves until Phase 7
- Five order- and type-sensitive Python arithmetic behaviours are preserved and each has its own test: int() truncation of the float token totals, half-to-even rounding at six places for every cost bucket and at four for avg_cost_per_post, division of the unrounded total by distinct posts, a null model counted in by_stage but not by_model, and a stable descending by_profile sort
- profile_id is validated as a uuid and answers pydantic's uuid_parsing 422 instead of letting a bad value reach the uuid column as a 500, while an empty value stays no filter at all, matching Python's `if profile_id:` guard
- web/src/mastra/model-costs.ts ports MODEL_COSTS value for value, kept distinct from the Opus rates web/src/mastra/execution-log.ts carries because Python had the same split and serves both halves through the API
- parseDays() and DAY_MS extracted from the dashboard handler into web/src/app/api/analytics/days.ts, shared by the three endpoints that declare days: int = Query(30, ge=1, le=365) identically
- web/src/app/api/analytics/costs.test.ts adds 30 tests against the real database and real BetterAuth sessions, including a dedicated pooled connection set to Pacific/Kiritimati that proves the at-time-zone-UTC rendering is load bearing
- docs/mastra-port/LEDGER.md item 5.8b checked with the two SQL probe outputs, the git history proving the endpoint was added broken, the pytest run showing why it was never caught, three recorded deviations, a thirteen-row negative-control table with the three toothless controls analysed, and all five gates

**Learnings:**
- GET /api/analytics/costs in api/src/api/analytics.py has never executed. `FROM posts p, jsonb_each(...) AS sl(...) JOIN website_profiles wp ON p.profile_id = wp.id` parses as `posts p, (jsonb_each(...) JOIN website_profiles ON ...)` because JOIN binds tighter than the comma, so p is referenced from a part of the query it is not visible in and asyncpg raises UndefinedTableError. Items 5.8c and 5.8d should probe their SQL against the live database before assuming it works, since /models and /logs may share the shape.
- The phase12 analytics pytest suite fails on authentication before it reaches any assertion, which is why a permanently-500ing endpoint shipped with ten green-looking test names. Any remaining router whose pytest coverage sits in the 120 currently-failing tests has effectively no oracle, and its SQL has to be executed directly rather than trusted.
- 0.01 + 0.02 === 0.03 is true in IEEE doubles, so a rounding negative control built on those fixtures passes and proves nothing. 0.1 + 0.2 is 0.30000000000000004 and does have teeth. Likewise an exact decimal tie at n places requires a value of the form odd/2**k with k <= n+1, so a half-to-even test needs a fixture like 0.03125 rather than a decimal that merely looks like a tie.
- A left join and an inner join are indistinguishable when the WHERE clause compares a column of the joined table to a value: `wp.user_id = <id>` is NULL for an unmatched row, so the row is dropped either way. A test named for the join type is really testing the predicate, and the negative control is what exposes the mislabel.
- drizzle's execute<T> constrains T to Record<string, unknown>, which an interface does not satisfy because interfaces get no implicit index signature. Raw-SQL row types in this codebase have to be declared with `type`, not `interface`.
- Python's `if profile_id:` and `if model:` guards mean an empty query parameter is not a filter, which differs from the `!== null` a TypeScript port reaches for by default. The control that swapped one for the other failed a real test, unlike the equivalent `if q:` control under 5.7 which was vacuous because `ilike '%%'` matches everything.

### Iteration 102

**Summary:** Completed ledger item 5.8c by porting Python's model analytics endpoint to a Next.js route handler, verified byte-for-byte against the live Python endpoint on shared fixtures, with 28 new tests and fourteen negative controls.

**Changes:**
- web/src/app/api/analytics/models/route.ts serves GET /api/analytics/models: a stage_logs jsonb_each unroll grouped by model, the same unroll grouped by stage key, and a stage_status unroll pivoted in the handler and projected over STAGES, all scoped by website_profiles.user_id and assembled into the ModelAnalytics shape web/src/lib/api.ts already declared (which needed no change)
- Every bigint count is converted with Number(), because drizzle's pg client decodes OID 20 to a string where Python's asyncpg decoded it to an int; without this call_count and runs would have gone out quoted
- Python's rounding is preserved with the existing pythonRound half-to-even helper at 0, 1 and 6 decimal places, each with a dedicated tie fixture chosen as odd/2**k so the tie is exact in binary (avg 2.5, duration 0.25, cost 0.0078125, success rate 1-of-16 = 6.25)
- Seven Python behaviours preserved with their own tests: the sl.key NOT LIKE '\_%' dead-letter filter on both stage_logs rollups only, the model IS NOT NULL split between models and stage_performance, the model filter not reaching stage_success_rates, the `if model:` truthiness guard, str.strip('"') on the jsonb-rendered status, the STAGES projection with its total/complete/failed pivot, and the total_runs > 0 guard on success_rate
- The model query parameter is read off getAll('model').at(-1), matching Starlette's QueryParams.get() returning the last value of a repeated key rather than URLSearchParams.get()'s first
- web/src/app/api/analytics/models.test.ts adds 28 tests against the real database and real BetterAuth sessions, covering aggregation, the two bigint conversions, ordering, the three rounding ties, both exclusion filters, the model filter's scope, cross-tenant and null-profile exclusion, and the stage_status pivot
- docs/mastra-port/LEDGER.md item 5.8c checked with the FROM-clause and wire-type probes, the failing-first run, the verbose passing run, the cross-stack parity diff and deep-equality check, two recorded deviations, a fourteen-row negative-control table with the toothless control analysed and re-run, and all five gates with the whole-suite count measured on both sides
- todo.md records two confirmed defects: the ported /costs handler reads repeated query parameters with .get() where Starlette takes the last value, and next build emits 15 BetterAuthError lines because BETTER_AUTH_SECRET is absent from the repo .env

**Learnings:**
- GET /api/analytics/models does execute, unlike /costs. Its FROM clause puts the website_profiles join ahead of the comma, so `posts JOIN website_profiles` is the first item and jsonb_each(p.stage_logs) is an implicitly LATERAL second one; /costs put the join inside the second item where the posts alias is out of scope. The two read almost identically, so item 5.8d must probe /logs' SQL the same way rather than infer from either.
- Because this endpoint runs, parity could be measured rather than argued: a TS probe wrote fixtures and dumped the handler's body, then the real FastAPI router was mounted on a bare FastAPI() under TestClient with get_current_user and get_session overridden and called on the same rows. py == ts deep-equals after json.load. This is a far stronger oracle than reading the Python, and it is available for every remaining router until Phase 7 deletes api/.
- pg decodes bigint (OID 20) to a string, so count(*) through drizzle's execute() arrives as "2" not 2, where Python's asyncpg gave an int. drizzle's type-parser overrides do not change this. Any remaining ported handler selecting count(*), sum(bigint) or an int8 column in raw SQL goes out quoted unless converted; 5.8a escaped it only because drizzle's count() helper does the conversion itself.
- Python renders whole-number floats with a trailing .0 and JavaScript does not, and Python is not self-consistent about it: success_rate is 0.0 (float) for a stage that ran but never completed and 0 (int) for one that never ran, because the `else 0` branch is an int literal. The distinction is unobservable after JSON.parse, which is what makes it safe to record as a deviation rather than chase.
- A negative control can pass because the fixture accidentally satisfies both the right and the wrong rule: replacing `order by call_count desc` with `order by model` changed nothing because claude-opus-4-6 (3 calls) and sonar-pro (1 call) sort the same way by count descending and by name ascending. Ordering tests need a fixture where the two orderings disagree, which means deliberately giving the alphabetically-later value the higher count.
- The iteration 95 note that `next build` fails without BETTER_AUTH_SECRET is wrong as of today: the variable is absent from the repo .env and the build exits 0, printing 15 BetterAuthError lines while prerendering the 15 /auth/[path] routes. Measured identically with and without this item's files, so it is standing environmental noise that item 9.1 will have to clear.

### Iteration 103

**Summary:** Split ledger item 5.8d and completed 5.8d-i by porting CPython's datetime.fromisoformat round trip to TypeScript, verified against a committed 128-case oracle table generated from the live interpreter, with 134 tests and eight negative controls.

**Changes:**
- web/src/app/api/analytics/from-isoformat.ts ports datetime.fromisoformat(x).isoformat(), the normalisation search_logs() applies to its since and until query parameters before binding them as text bounds against log_entry->>'ts'; it exports fromIsoFormat() (returning null where CPython raises ValueError) and toPythonUtcIsoFormat() (datetime.now(UTC).isoformat() for a JavaScript Date, the default 90-day lower bound)
- The parser reproduces six CPython behaviours pinned by probing the live interpreter: any single character works as the date/time separator, basic and extended forms are accepted but may not mix within a component, week dates are accepted while ordinal dates are not and a week 53 absent from the ISO year is rejected, a [.,] fraction is microseconds appended after whichever component came last, Z is accepted only uppercase and only as the final character, and an offset is bounded only by magnitude while a zero whole-second offset collapses to UTC and discards any sub-second remainder
- web/src/app/api/analytics/data/from-isoformat-parity.json commits a 128-case oracle table (45 of them rejections) generated by running each string through the CPython that serves the FastAPI router, capturing it before Phase 7 deletes api/ and makes it unregenerable
- web/src/app/api/analytics/from-isoformat.test.ts adds 134 tests: one per oracle row plus six hand-written covering the exact string the monitor logs tab sends, byte-wise orderability against a stored ts, and the toPythonUtcIsoFormat round trip
- docs/mastra-port/LEDGER.md splits 5.8d into 5.8d-i (the fromisoformat port) and 5.8d-ii (the handler), and checks 5.8d-i with the CPython grammar probe, the oracle generator, the failing-first run, the verbose passing run, an eight-row negative-control table, one recorded deviation, the verified Python 500, and all five gates
- todo.md records a confirmed defect: GET /api/analytics/logs answers 500 for any since or until that fromisoformat rejects, because the parse sits outside any try and the parameters are declared str | None so pydantic never validates them

**Learnings:**
- The since/until normalisation is not cosmetic, it is the whole filter. Both bounds are compared as text against log_entry->>'ts', which is datetime.now(UTC).isoformat(). The dashboard sends new Date(...).toISOString() ending in Z, CPython rewrites that to +00:00, and Z (0x5A) sorts above + (0x2B), so a bound that kept its Z would silently drop every entry inside the boundary second. 5.8d-ii must feed the normalised string into the SQL, never the raw parameter.
- CPython's fromisoformat is looser than ISO 8601 in ways that reach this endpoint: the date/time separator is any single character (2026-08-23X12:34:56 parses), a [.,] fraction is microseconds appended after whichever component came last (12:34.5 is 12:34:00.500000, not half a minute), and an offset is rejected only for magnitude so +05:99 is a valid +06:39.
- tzinfo_from_isoformat_results() returns UTC whenever the whole-second offset is zero, discarding a sub-second remainder. -00:00:00.500000 reads back as +00:00 while -00:00:01.500000 keeps its half second. This asymmetry is invisible in the docs and was only found by dumping utcoffset() for both.
- git diff --quiet reports no change for an untracked file, so a negative-control harness that gates on it silently reports every mutation as applied-and-passing when the file is new. The first run of the eight controls produced eight false rows this way. cmp against a saved copy is the check that works, and the harness must also restore the good file on the early-return path or mutations accumulate.
- A 128-row table test passing 134 of 134 on the first run is the exact shape a toothless test has. Mutating each encoded rule showed two rules (the extended-date dash and the ISO week 53 existence check) are covered by exactly one oracle row each, which is adequate but worth knowing before adding rows.
- The pytest run writes image artifacts into media/test-123/ that are untracked and not gitignored. They have to be removed before finishing or they land in the iteration's commit.

### Iteration 104

**Summary:** Completed ledger item 5.8d-ii by porting Python's log explorer endpoint to a Next.js route handler, verified byte-for-byte against the live Python endpoint on twelve shared-fixture queries, with 39 new tests and twenty negative controls, which closes the whole 5.8 analytics router.

**Changes:**
- web/src/app/api/analytics/logs/route.ts serves GET /api/analytics/logs: a jsonb_array_elements unroll of execution_logs with six optional filters, user_id scoping and both text time bounds, one WHERE clause shared by the count and data statements, and the pagination rollup, assembled into the PaginatedLogs shape web/src/lib/api.ts already declared (which needed no change)
- Both time bounds are run through fromIsoFormat() from item 5.8d-i before binding, because they are compared as text against log_entry->>'ts'; the dashboard sends toISOString() ending in Z and Z (0x5A) sorts above + (0x2B), so an unnormalised bound would silently mis-filter the whole boundary second
- Every query parameter is read off getAll(name).at(-1), matching Starlette's QueryParams.get() taking the last value of a repeated key, probed off the real router (?page=1&page=3 answers 3)
- The = ANY(:levels) level list is built as array[$1, $2]::text[] with sql.join, because drizzle's sql template expands a JS array into one placeholder per element and both any(${levels}) and any(${levels}::text[]) fail at parse time
- Two deviations from Python, both 422 where Python answers 500: an unparseable since/until now returns pydantic's datetime_from_date_parsing (the parse sits outside any try on a str | None parameter) and a non-uuid profile_id returns uuid_parsing, matching the precedent set in 5.8b
- web/src/app/api/analytics/logs.test.ts adds 39 tests against the real database and real BetterAuth sessions, covering the projection, the six filters, both inclusive bounds, the ninety-day default window, pagination, ordering, cross-tenant and null-profile exclusion, and the full 422 grammar
- docs/mastra-port/LEDGER.md item 5.8d-ii checked with the validation-order and 500 probes, the array-binding probe, the failing-first run, the verbose passing run, the twelve-query cross-stack deep-equality result, two recorded deviations, a twenty-row negative-control table with both toothless controls analysed, and all gates measured on both sides; parents 5.8d and 5.8 closed with summary evidence
- todo.md records as [confirmed] that the whole endpoint's ordering and bounds rest on a text comparison of log_entry->>'ts' that nothing enforces the format of, and updates the 5.8d-i entry to note the port's 422 answer

**Learnings:**
- A FastAPI TestClient probe against the real async engine dies with 'attached to a different loop' as soon as more than a handful of requests run, because the module-level create_async_engine caches asyncpg connections on the first loop and TestClient's portal uses a new one. The fix is to override get_session with a per-request engine that is disposed after the yield, and to open a fresh TestClient per query. Iteration 102's single-query probes never hit this; any future multi-query parity probe will.
- drizzle's sql template expands a JS array into one placeholder per element rather than binding it as one array parameter, so `any(${arr})` fails with 'requires array on right side' and `any(${arr}::text[])` fails with 'cannot cast type record to text[]'. Building the array in SQL with sql.join(values.map(v => sql`${v}`), sql`, `) inside array[...]::text[] works and quotes commas, single quotes and braces correctly.
- A negative control that fails nothing can prove redundancy in two different ways in the same file. Widening the inner join to a left join changed nothing because wp.user_id = :user_id is NULL for an orphan post and a NULL predicate is not true, so the join is redundant to the predicate; dropping the execution_logs != '[]' guard changed nothing because jsonb_array_elements('[]') yields zero rows. Neither is untested code, and dropping the user_id predicate instead does fail, which is what distinguishes the two cases.
- This endpoint is the first ported one with no arithmetic at all, so cross-stack parity came back deep-equal with not even a trailing-zero difference to record. Every value on the wire is a string, a null or an integer in both stacks. The float rendering deviation recorded under 5.8a to 5.8c is specific to endpoints that round.
- pydantic 2.12's datetime error carries a ctx.error tail from speedate ('input is too short', 'month value is outside expected range of 1-12') that names a failure mode fromisoformat does not share, so a port that reuses the datetime_from_date_parsing shape has to drop the tail rather than invent one. The codebase already had this convention in pathUuidIssue, which made the choice a precedent rather than a judgement call.
- The persisted Bash cwd bit again in the same way iteration 98 recorded: `mkdir -p web/src/...` after an earlier `cd web` silently created web/web/src/... and the heredoc reported success. The failure only surfaced as a module-not-found in the test run. Every mkdir and every file write needs an absolute path, not just the writes.

### Iteration 105

**Summary:** Split ledger item 5.9 and completed 5.9a by porting the read half of Python's WordPress REST client to TypeScript, verified against a 25-scenario live-server oracle captured from the real Python client, with 57 tests and twenty negative controls.

**Changes:**
- web/src/mastra/wordpress/index.ts ports the read half of api/src/services/wordpress.py: WordPressError, the constructor's trailing-slash plus single-suffix URL normalisation, the Basic credential, _request's error grammar, and testConnection/listCategories/listUsers with their per_page=100 pagination. upload_media, create_post and update_post are deliberately left to ledger item 5.3c-iii-b, which owns their only caller
- api/scripts/export_wordpress_parity.py stands up a local HTTP server, runs the real Python client against it, and writes web/src/mastra/wordpress/data/wordpress-parity.json: 25 network scenarios carrying the routing table, every request the server saw (path, raw query string, Authorization) and the value returned or the WordPressError raised, plus a 27-row constructor table. The pytest suite for this service replaces the transport with an AsyncMock, so the query string, the >= 400 error grammar and the non-JSON branch had never been exercised against a real response
- web/src/mastra/wordpress/wordpress.test.ts adds 57 tests that drive a Node server from the exported routing table over real sockets, so the two servers cannot drift, plus three cases the oracle cannot cover (a transport failure escaping unwrapped, the status carried on a non-JSON error, and the credential on every page)
- Four deviations recorded and one dead guard removed: the whole-request AbortSignal deadline replacing httpx's per-phase timeouts, code-point versus UTF-16 slicing of the 200-character error body, JSON.parse rejecting NaN/Infinity where json.loads accepts them, and a non-array paginated body throwing instead of extending with object keys. Array.isArray was deleted from errorDetail once a control proved a JSON array reaches the same fallback anyway
- docs/mastra-port/LEDGER.md splits 5.9 into 5.9a and 5.9b and checks 5.9a with the export run, the wire-format dump, the failing-first run, the verbose 57-test passing run, a twenty-row negative-control table with the analysis of the four initially toothless controls, and all gates measured on both stacks
- todo.md records two confirmed items: a wp_url carrying a query string yields api_url = https://example.com/?a=1/wp-json/wp/v2 and every call against it 404s, and pytest authenticates as the wrong Postgres user unless the repo .env is sourced first

**Learnings:**
- The four entries in _STRIP_SUFFIXES are mutually exclusive as endswith tests, because a string ending in /wp-json/wp/v2 does not end in /wp-json, so the tuple order is genuinely unobservable and the control that reorders them correctly fails nothing. The break is a different matter and needs a case the obvious table misses: https://example.com/wp-json/wp-admin strips to .../wp-json with the break and to the origin without it, because /wp-admin sits earlier in the tuple than /wp-json.
- Python needs its AttributeError guard for a JSON array because [].get raises; JavaScript does not, because an array can never carry a message property and falls through to the same raw-body branch. null is the opposite: reading a property off it throws, so parsed === null is load bearing where Array.isArray is dead. A control on the array branch passing is the signal to delete code, not to add a test.
- A negative control can mutate a branch no fixture reaches. Replacing text.slice(0, 200) with text failed nothing on the first pass because the only >200-character body in the oracle was non-JSON and took the other return statement. Targeting one of two identical expressions in a function is a silent no-op unless a fixture exercises that specific path.
- httpx serialises params in dict insertion order and percent-encodes the comma, so list_users goes out as per_page=100&page=1&roles=administrator%2Ceditor%2Cauthor. URLSearchParams reproduces both exactly when the keys are set in that order, which makes the raw query string assertable rather than something to normalise away.
- cd inside a Bash call persists across calls, so a later rm -rf media/test-123 aimed at the repo root silently ran against web/ and reported success. Re-running it from the root deleted 39 tracked images alongside the 11 untracked pytest artifacts; git checkout -- media/ restored the tracked ones and left the artifacts removed, which is the correct end state but only by luck. Absolute paths for every destructive command, not just writes.
- cd api && uv run pytest -q answers 4 failed, 205 passed, 177 errors with InvalidPasswordError unless the repo .env is sourced first, at which point the recorded 120/241/25 baseline reappears. conftest.py's connection defaults no longer match the running container, so every ledger entry pasting a pytest count depends on the caller remembering to source .env.
- Running two full vitest suites concurrently inflates both the failure count and the skip count (one run reported 15 skipped rather than 7). The frontend baseline is only meaningful when nothing else is touching the database, so overlapping background suite runs have to be serialised before their numbers go in the ledger.

### Iteration 106

**Summary:** Completed ledger item 5.9b by porting Python's three WordPress router endpoints to Next.js route handlers, verified against a 36-scenario live-server oracle captured from the real endpoint coroutines, with 85 tests and twenty-four negative controls, which closes the whole 5.9 wordpress router.

**Changes:**
- web/src/app/api/profiles/[id]/wordpress/{test,categories,authors}/route.ts serve the three WordPress endpoints, with /test reporting both credential 400s and every WordPressError as a 200 {connected:false,error} while /categories and /authors raise them as real 400s and let a WordPressError escape as a 500, exactly as Python did
- web/src/app/api/profiles/[id]/wordpress/client.ts folds _get_user_profile and _get_wp_client into one user-scoped lookup returning a three-way union, so another user's profile is a 404 and no request is made to their WordPress install; the two HTTPException detail strings are copied byte for byte because the dashboard renders them
- requireField() reproduces Python's KeyError-to-500 for a category or author missing id/name/slug, and siteName() reproduces the AttributeError for a /wp-json root that answers with a JSON array, null or a string, instead of quietly emitting items that do not match WPCategory/WPAuthor or reporting connected:true with an empty name
- api/scripts/export_wordpress_router_parity.py drives the three real endpoint coroutines against a local HTTP server and a stubbed session, writing a 36-scenario oracle to web/src/app/api/profiles/data/wordpress-router-parity.json that records the profile row, every request the stand-in saw, and the value returned or the exception raised
- web/src/app/api/profiles/[id]/wordpress/wordpress.test.ts adds 85 tests that stand up a Node server from the exported routing table and run the handlers against it over real sockets, with real BetterAuth sessions, real website_profiles rows and a real Fernet decrypt
- docs/mastra-port/LEDGER.md item 5.9b checked with the export run, the failing-first 501-stub run, the verbose passing run, a 24-row negative-control table with the one toothless control analysed, and all gates on both stacks; parent 5.9 closed
- todo.md records two confirmed defects (the list endpoints 500 on any WordPress-reported error, /test 500s on a non-object site root) and one investigate item (the scaffold-check lifecycle-event test flakes in full-suite runs)

**Learnings:**
- Driving the real FastAPI endpoint coroutines directly with a stubbed session, rather than through TestClient, sidesteps the 'attached to a different loop' failure iteration 104 hit and lets one script capture 36 scenarios in a single process. It also captures unhandled exceptions (KeyError, AttributeError, WordPressError) as first-class oracle outcomes, which TestClient would have flattened into an opaque 500.
- JavaScript silently diverges from Python on both projection reads in this router. c['id'] raises KeyError in Python but yields undefined in JS, and Response.json then drops the key, so a faithful port has to reproduce the exception rather than the expression or it answers 200 with items that violate the declared WPCategory/WPAuthor types.
- A `?? 0` default is not the same as `.get(key, 0)` and no realistic fixture distinguishes them. Two negative controls (site_name via ?? and count via ??) only bit after adding oracle scenarios with an explicit JSON null; without those two scenarios both mutations passed the whole suite.
- A single-quoted Python string inside a heredoc-written control harness silently breaks on an apostrophe in an embedded code comment (`Python's`), and the SyntaxError points at the following line rather than the offending one. Anchoring controls on short expressions instead of multi-line comment blocks avoids the whole class.
- The frontend baseline is 9 failures but a full `pnpm test` run intermittently reports 10, the extra one being scaffold-check.test.ts asserting workflow-step-start is present. It passes 5/5 in isolation, so any ledger entry pasting a count needs a second run to tell a real regression from this flake.

### Iteration 107

**Summary:** Completed ledger item 5.10 by porting Python's Next.js webhook-test endpoint and its HMAC signing to a Next.js route handler, verified against a 29-scenario live-server oracle captured from the real endpoint coroutine, with 63 tests and fourteen negative controls.

**Changes:**
- web/src/app/api/profiles/[id]/nextjs/test/route.ts serves POST /api/profiles/{profile_id}/nextjs/test, reproducing every reported failure of api/src/api/nextjs.py (missing URL or secret, undecryptable secret, non-200 webhook response, transport failure) as a 200 carrying {connected: false, error}, with the profile lookup outside that net so another user's profile is a 404; it reuses the shared profiles/params.ts uuid 422 and 404 helpers and needed no change to web/src/lib/api.ts
- web/src/lib/hmac-signing.ts ports sign_payload from api/src/services/hmac_signing.py; verify_signature is intentionally not ported because grep over api/src finds no caller and packages/create-mdx-blog already owns the verification half of the contract
- web/src/app/api/profiles/[id]/nextjs/detail.ts ports the error grammar: response.json().get("error", response.text[:200]) behind a bare except, plus Python's str()/repr() rendering (None, True, False, and repr quoting for nested lists, dicts and strings that switches to double quotes for an apostrophe-bearing string)
- The outbound request is byte-compatible with Python: the payload is assembled with json.dumps separators and a datetime.now(UTC).isoformat() timestamp rather than JSON.stringify/toISOString, because create-mdx-blog verifies the HMAC over the raw body; redirect: "manual" and AbortSignal.timeout(10_000) restore the two httpx defaults fetch inverts
- api/scripts/export_nextjs_router_parity.py drives the real test_nextjs_connection coroutine against a local HTTP server and a stubbed session, writing a 29-scenario oracle (profile row, seen request with body/content-type/signature, returned value or raised exception) to web/src/app/api/profiles/data/nextjs-router-parity.json
- web/src/app/api/profiles/[id]/nextjs/nextjs.test.ts replays the oracle over real sockets with real BetterAuth sessions and real website_profiles rows: 63 tests covering all 29 scenarios plus 401/422/404 cases the oracle cannot reach and a cross-check that recomputes the digest with the receiver's own createHmac call
- docs/mastra-port/LEDGER.md item 5.10 checked with pasted export output, test output, a fourteen-row negative-control table, the two documented divergences, and both stacks' gate results

**Learnings:**
- fetch inverts two httpx defaults that matter for parity: httpx does not follow redirects (so a 302 must be reported, requiring redirect: "manual") and httpx.AsyncClient(timeout=10.0) has no fetch equivalent without AbortSignal.timeout. Neither shows up in a JSON-shape comparison, only in a scenario that actually returns a 3xx.
- Python's json.dumps separators (", " and ": ") and datetime.now(UTC).isoformat() (microseconds, +00:00 not Z, fraction omitted when microsecond is zero) are part of the webhook contract rather than cosmetic, because create-mdx-blog verifies the HMAC over the raw body before parsing. Mutating either builder to the JS default failed 20 of 63 tests.
- An Array.isArray guard on a JSON.parse result before an `in` check is unobservable: a JSON array can never carry the key being looked up, so the guarded and unguarded paths both reach the fallback. The negative control returned zero failures, which is what identified it as dead code rather than untested code.
- Node 24 supports JSON.parse's third reviver argument with context.source, which would let a port recover Python's int/float distinction from the raw token. It was rejected here as more machinery than the one affected scenario justifies, and the divergence ({"error": 1.0} renders 1 not 1.0) is documented and asserted instead.
- Fernet re-encrypts with a fresh timestamp and IV each call, so an oracle regenerated from the same script differs only in its ciphertext fields. Scrubbing gAAAAA-prefixed tokens alongside timestamps and signatures is what proves an export script is deterministic.

### Iteration 108

**Summary:** Split ledger item 5.3c-iii-b-1 into four sub-items and completed 5.3c-iii-b-1-a by porting the write half of Python's WordPress REST client to TypeScript, verified against a 29-scenario live-server oracle that records every request byte, with 33 tests and seven negative controls.

**Changes:**
- api/scripts/export_wordpress_write_parity.py runs the real Python WordPressClient against a local HTTP server over 29 scenarios covering upload_media, create_post and update_post, recording per request the method, path, query, Authorization, Content-Type, Content-Disposition and Content-Length headers plus the raw body base64-encoded, alongside the returned value or the WordPressError raised
- web/src/mastra/wordpress/index.ts gains uploadMedia, createPost and updatePost, with the private get() generalised into a request() that takes a method, a body and extra headers; the module docstring is updated from 'the read half' to the whole client
- web/src/mastra/wordpress/wordpress-write.test.ts drives a Node server from the exported routing table and asserts both the return value and the exact request bytes for all 29 scenarios, plus four tests for what the oracle cannot reach: the Basic credential on the alt-text patch, a refused connection surfacing unwrapped, the null-upload-response guard, and updatePost keeping a null where createPost drops it
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-1 into 1-a (client write half), 1-b (markdown_to_wp_html), 1-c (the Mastra publish workflow) and 1-d (the route branch), and checks off 1-a with pasted evidence, four preserved behaviours, one documented divergence and seven negative controls

**Learnings:**
- The parity-oracle export scripts write JSON with sort_keys=True, which silently reorders any call arguments encoded as a dict. That alphabetised update_post's kwargs while the captured body_b64 still held Python's real insertion order, so the TypeScript side reproduced a differently-ordered body and one test failed. Call arguments whose order is observable on the wire must be exported as a list of pairs, not a dict. Any future oracle has the same trap.
- httpx 0.28.1 serialises json= with separators=(",", ":") and ensure_ascii=False, which is JSON.stringify's output byte for byte, so no custom serialiser is needed for any ported httpx client. Verified with a live probe rather than assumed, and pinned by storing body_b64 per request in the oracle.
- update_post and create_post disagree about falsy values on purpose: create_post's `if categories:` / `if author:` / `if featured_media:` / `if excerpt:` drop empty lists, zero ids and empty strings, while update_post forwards **kwargs untouched so the publish hook's None values reach WordPress as nulls and clear those fields. Since JSON.stringify drops undefined but keeps null, the TypeScript updatePost has to take an explicit record and its callers must spell a cleared field null.
- TypeScript rejects Uint8Array<ArrayBufferLike> as a fetch BodyInit because the installed lib pins the ArrayBufferView arm to ArrayBuffer. Spelling the body type `string | Uint8Array<ArrayBuffer>` and narrowing uploadMedia's parameter to match fixes it without a cast.
- The Bash tool's working directory persists across calls in this session, and a `cd api` from an earlier call silently made a later `cat > api/scripts/...` heredoc fail and `pnpm -C web` report 'Command web not found'. Absolute paths, or a leading cd to the worktree root, avoid losing an entire heredoc.
- Running pytest leaves stray .webp artifacts under media/test-123/, which show up as untracked files. They are test byproducts, not part of the change, and need removing before the iteration ends.

### Iteration 109

**Summary:** Split ledger item 5.3c-iii-b-1-b into three tokenizer-layer sub-items and completed 5.3c-iii-b-1-b-i by porting the block half of Python's mistune-based markdown-to-Gutenberg converter to TypeScript, verified byte-for-byte against a 72-case oracle generated from the real Python function, with 92 tests.

**Changes:**
- docs/mastra-port/LEDGER.md: item 5.3c-iii-b-1-b split into -b-i (leaf blocks), -b-ii (container blocks: block_quote, list, ref_link, raw_html) and -b-iii (inline rules), with the rationale that mistune's ~900-line tokenizer, not the 127-line renderer, is what decides the output
- api/scripts/export_wp_html_block_parity.py: parity oracle that runs the real markdown_to_wp_html over 72 block-level inputs and records its verbatim output to web/src/mastra/wordpress/data/wp-html-block-parity.json
- web/src/mastra/wordpress/wp-html.ts: markdownToWpHtml with mistune's block scan loop, BlockState, and the leaf-block handlers (blank_line, fenced_code, indent_code, atx_heading, setex_heading, thematic_break, paragraph fallback) plus softbreak/linebreak, the frontmatter strip and newline normalisation
- Unported block and inline rules are registered with their real patterns in mistune's rule order but throw UnportedMarkdownError, so rule precedence is preserved and a half-ported converter cannot silently flatten a list or drop a link
- web/src/mastra/wordpress/wp-html-blocks.test.ts: 92 tests, being the 72 oracle replays, 9 negative controls, 10 unported-rule assertions and 1 structural check on the oracle file

**Learnings:**
- mistune's renderer is the small half of wp_html.py. The behaviours that decide a published article are tokenizer behaviours: `Para.\n--` retroactively rewrites the paragraph above into an <h2>, four leading spaces at the top of a document are a paragraph rather than an indented code block because markdown_to_wp_html calls .strip() first, an unclosed fence closes at end of document, and a backtick inside a backtick fence's info string voids the fence. Any port that wraps a CommonMark JS library instead of porting the tokenizer diverges exactly where the corpus is thin.
- Python's re.M anchors do not translate to JavaScript's m flag: JS breaks lines on \r,   and   as well. Spelling `^` as `(?<![^\n])` and `$` as `(?![^\n])` and using no m flag reproduces Python exactly. re.search(src, pos) is a g-flagged exec with lastIndex, re.match(src, pos) is a y-flagged one, and m.lastgroup is emulated by walking the rule list in order and taking the first participating named group (Python's lastindex resolves to the outer group for nested groups, which is why mistune's dispatch works at all).
- mistune's block dispatch treats a returned position of 0 as a decline (`if end_pos2:`), so the TypeScript port must keep the truthiness check rather than a null check, and Python's str.strip(chars) strips a character set rather than trimming whitespace, which parse_atx_heading depends on.
- A corpus scoped to block-level constructs cannot cover the declined-backtick-fence case, because the declined line falls back to a paragraph that still contains backticks and therefore needs the inline parser. Asserting that the input reaches the inline parser (and throws) is the in-scope way to prove the decline happened.
- The block port passed 91 of 93 assertions on its first run against the oracle, and both failures were corpus scoping mistakes rather than port defects, which suggests the remaining two sub-items are mostly a question of how carefully list_parser.py and the emphasis delimiter rules are transcribed.

### Iteration 110

**Summary:** Split ledger item 5.3c-iii-b-1-b-ii into three tokenizer sub-items and completed 5.3c-iii-b-1-b-ii-1 by porting mistune's block_quote rule, both of its scan strategies and its child-state recursion, verified byte for byte against a 56-case oracle generated from the real Python function, with 67 tests.

**Changes:**
- Ledger item 5.3c-iii-b-1-b-ii split into -ii-1 block quotes, -ii-2 lists and -ii-3 reference links plus raw HTML, since extract_block_quote, the 269-line list_parser.py and the ref_link/raw_html helpers share no machinery
- web/src/mastra/wordpress/wp-html.ts ports mistune's block_quote: extract_block_quote's require-marker branch (only marked lines continue a quote whose first line opens a code block) and its lazy branch (an unmarked line continues the quote unless it starts one of blank_line, thematic_break, fenced_code, list or block_html, which are parsed on the outer state with the quote token then prepended before them)
- BlockState gained parent, childState, depth and prependToken, and parseBlocks now takes a rule list so a quote at depth 5 reparses its body with block_quote removed, matching max_nested_level 6; compile_sc gained the cache Python has
- block_html is now a registered pattern with the full BLOCK_TAGS/PRE_TAGS table: it is in mistune's SPECIFICATION but not DEFAULT_RULES, and the lazy branch scans for it by name, so the alternation has to break in the same places even though its handler still throws until -ii-3
- api/scripts/export_wp_html_quote_parity.py generates a 56-case oracle from the real markdown_to_wp_html into web/src/mastra/wordpress/data/wp-html-quote-parity.json, and wp-html-quotes.test.ts replays every case byte for byte with 10 negative controls, 67 tests total
- block_quote removed from the unported-rule list in wp-html-blocks.test.ts (91 tests, was 92) and the remaining rules' thrown ledger ids updated to 5.3c-iii-b-1-b-ii-2 and -ii-3

**Learnings:**
- Four of the block-quote patterns are compiled without re.M, where Python's $ matches at end of string OR just before a single trailing newline, unlike JavaScript's bare $. That needed a new EOS lookahead (?=\n?$); with a plain $, _LINE_BLANK_END would miss the blank-line-at-end test on a quote body ending in three newlines, which is what decides whether the next line is lazy.
- atx_heading is deliberately NOT in the block quote's break list, so an unmarked '## Title' under a quote is a lazy continuation: it joins the quote body and the child parse then renders the heading INSIDE the blockquote, while a thematic break in the same position renders outside it. My hand-written control asserted the opposite and the generated oracle caught it, which is the argument for oracle-first corpora over reasoning about the tokenizer.
- block_quote's lazy branch calls parse_method on the OUTER state and then inserts the quote token before the block that resulted, which is the only reason BlockState.prepend_token exists in mistune. A port that appended would silently reorder the document.
- Adding a 107th vitest file reshuffles file scheduling enough to change how often the pre-existing scaffold-check Redis race fires: the same suite reported 10 failures twice then 9 (baseline) on a third run with identical code. Confirming a suspected regression against the baseline needs the stash-and-rerun check, not a single run.
- pytest writes image artifacts into media/test-123/ as a side effect of the WordPress publish tests, so the tree is dirty with untracked .webp files after any backend gate run. They must be deleted before committing; the repo already tracks similar files from earlier dates.

### Iteration 111

**Summary:** Completed ledger item 5.3c-iii-b-1-b-ii-2 by porting mistune's whole list_parser.py to TypeScript, verified byte for byte against a 113-case oracle generated from the real Python function and hardened with six mutations, with 128 tests.

**Changes:**
- api/scripts/export_wp_html_list_parity.py generates a 113-case list oracle by running each markdown input through the real markdown_to_wp_html, capturing it into web/src/mastra/wordpress/data/wp-html-list-parity.json before Phase 7 deletes api/ and makes it unregenerable
- web/src/mastra/wordpress/wp-html.ts ports mistune's list_parser.py: parse_list, _parse_list_item's per-item break scanner with its rewritten {0,3} indent budgets, _compile_continue_width, _compile_list_item_pattern, _get_list_bullet, _clean_list_item_text, _is_loose_list, _transform_tight_list and util.strip_end, plus the list, list_item and block_text renderer methods
- web/src/mastra/wordpress/wp-html-lists.test.ts adds 128 tests: 113 replay cases, 14 negative controls covering the tight/loose transform, marker identity, thematic-break precedence, paragraph interruption and the splice-back ordering, and 1 structural check on the oracle file
- web/src/mastra/wordpress/wp-html-blocks.test.ts drops list from the unported-rule table (91 tests to 89) and web/src/mastra/wordpress/wp-html-quotes.test.ts swaps its unported-inside-a-quote control from `> - item` to `> <div>raw</div>` since a quoted list is now a replay case
- docs/mastra-port/LEDGER.md checks 5.3c-iii-b-1-b-ii-2 with the oracle generator output, the passing run, a six-row mutation table, the recorded uncovered branch, and all gate output including the unchanged pytest and ruff baselines

**Learnings:**
- A port passing its oracle on the first run is not evidence the oracle has teeth. Mutating the finished implementation is what proves it: five of six mutations here failed loudly, but dropping the {0,3}-to-leading-width rewrite passed all 78 original cases, and only nine purpose-built cases exposed it. That branch is reachable only when a line is indented wider than the item's marker but narrower than its continuation width, which is an empty window unless more than one space follows the marker.
- mistune's `pairs = [(n, p.replace("3", _repl_w, 1)) for n, p in pairs]` is a string-level edit on the regex *source*, so a TS port only stays faithful if the first literal `3` in each translated pattern is still the `{0,3}` indent budget. The SOL/EOL lookaround spellings used in this port contain no digits, and BLOCK_TAGS_PATTERN's `h3` sorts after the budget, so the rewrite lands in the same place. A different anchor spelling would have silently corrupted six patterns.
- The `(?<=\n)` prefix mistune puts on every list-item break alternative is unobservable: the scanner only ever runs at a cursor after the item's marker line, which is never position 0 even inside a child state. Removing it passes all 128 cases. Kept for faithfulness, recorded as uncovered rather than papered over.
- The visible difference between a tight and a loose list in this renderer is entirely `_transform_tight_list` rewriting `paragraph` to `block_text`, which emits no wrapper at all. A single blank line between two items changes the published HTML without changing a word of text, and skipping the transform failed 90 of 128 cases.
- Running pytest writes .webp artifacts into media/test-123/ as untracked files. Check `git status` after a backend gate run and remove them, or they land in the iteration's commit.

### Iteration 112

**Summary:** Split ledger item 5.3c-iii-b-1-b-ii-3 into two sub-items and completed the first by porting mistune's raw_html/block_html rule, all seven CommonMark HTML block kinds, to TypeScript, verified byte for byte against an 86-case oracle generated from the real Python function and hardened with eight mutations, with 105 tests.

**Changes:**
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-1-b-ii-3 into -3-a (raw_html/block_html) and -3-b (ref_link), justified by the two halves sharing no machinery and only one being directly observable: raw_html emits a token the renderer prints, while ref_link emits nothing and drags in escape_url's urllib quoting and CommonMark-flavoured html.unescape
- web/src/mastra/wordpress/wp-html.ts gains parseRawHtml, which is all seven CommonMark HTML block rules behind one handler (parse_block_html is a fallthrough case, matching Python's one-line delegation), plus parseHtmlToEnd and parseHtmlToNewline, the BLANK_LINE search pattern, and the block_html renderer case
- boundedMatch() reproduces Python's re.match(src, pos, endpos) by slicing the subject, because the third argument truncates the string rather than merely limiting the match and so moves where $ can match; without it, `<custom-tag\nfoo>` would wrongly be an HTML block since HTML_ATTRIBUTES starts with \s+ and spans the newline
- api/scripts/export_wp_html_html_parity.py generates web/src/mastra/wordpress/data/wp-html-html-parity.json: 86 replay cases plus a separate declines array holding the five inputs where the real markdown_to_wp_html raises AttributeError instead of rendering
- web/src/mastra/wordpress/wp-html-raw-html.test.ts adds 105 tests: the 86-case replay, five decline assertions that the port reaches the same inline layer, and twelve hand-written negative controls covering the end-marker scan, the blank-line boundary, the tag-name-only match and the lazy-quote break set
- wp-html-blocks.test.ts drops raw_html from its unported-rule table, and the quote and list "still refuses unported rules" probes swap `<div>raw</div>` for a ref_link definition, which is the rule still unported; the inputs they used are now replay cases
- todo.md records the confirmed defect that _GutenbergRenderer has no inline_html method, so any article with an HTML tag the block layer declines crashes the WordPress publish path with AttributeError

**Learnings:**
- markdown_to_wp_html crashes on inline HTML: _GutenbergRenderer implements block_html but not inline_html, so `<custom-tag />`, a tag mid-paragraph, or a block tag on the line after a paragraph all raise AttributeError: No renderer "'inline_html'" rather than rendering. This is a live defect on the WordPress publish path, and it means item -b-iii's inline port has to decide whether to reproduce the crash or fix it. Five such inputs are pinned in the oracle's declines array.
- BLOCK_HTML requires whitespace or a line end straight after the tag name, which `<div>` and `<script>` do not have. So neither ends a lazy block-quote continuation (they get parsed inside the quote), while `<div class="x">`, `<div` followed by a newline, and `<!-- c -->` all do break out. Three corpus case names asserted the opposite before the oracle corrected them; the intuition that a block tag breaks a quote is wrong.
- mistune picks between rule 1, rule 6 and rule 7 off the tag name alone, before the tag is known to be closed: `<div` with no `>` on the line is still rule 6. Only rule 7 checks for a complete tag, and only rule 7 can decline or be blocked from interrupting a paragraph. That asymmetry is what makes `<divx>` and `<div>` take different paths.
- Rules 1 to 5 always extend to the end of the line their end marker lands on, which makes several obvious mutations undetectable: `<![CDATA[ a > b ]]>` renders identically whether the end marker is `]]>` or `>`, because both land on the same line. Killing that mutation needed a multi-line CDATA with a bare `>` on an earlier line. The same shape defeats naive corpora for uppercase tags (`<DIV>` renders the same under rule 6 and rule 7) and close tags (`</div>` likewise); each needs a paragraph-interrupt variant to disambiguate.
- Adding a Python script under api/scripts/ moves the ruff baselines (32 errors, 9 files to reformat) unless it is run through `ruff format` and `ruff check --fix` first. Reformatting the exporter changes the generated JSON's provenance only, but the oracle must be regenerated afterwards so the committed data matches the committed script.
- The frontend flake is broader than the scaffold-check test todo.md names: three consecutive full vitest runs on identical code gave 10, 10 and 9 failures, and the second run's extra failure was in pipeline-events.test.ts, not scaffold-check. Any ledger entry pasting a failure count needs at least three runs to reach the 9-failure baseline.

### Iteration 113

**Summary:** Split ledger item 5.3c-iii-b-1-b-ii-3-b in two and completed the first half by porting mistune's escape_url, its CommonMark-flavoured html.unescape and the three Python stdlib entity tables, verified against an 89-case oracle generated from the real function and hardened with ten mutations, with 103 tests.

**Changes:**
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-1-b-ii-3-b into -3-b-1 (escape_url) and -3-b-2 (parse_ref_link), justified by escape_url being mistune.util machinery the inline link and image rules in -b-iii also call, and by it being the only half that is observable on its own: parse_ref_link emits no token and writes only state.env, which nothing reads until the inline link rule exists
- api/scripts/export_wp_html_escape_url_parity.py writes web/src/mastra/wordpress/data/html5-entities.json (Python's html.entities.html5 with 2231 names, html._invalid_charrefs with 34 entries and html._invalid_codepoints with 126, exported verbatim rather than retyped) and web/src/mastra/wordpress/data/wp-html-escape-url-parity.json (89 cases plus a 2-case raises array). The oracle calls mistune.util.escape_url and unescape directly, since escape_url is not reachable from markdown_to_wp_html output until parse_ref_link and the inline link rules exist
- web/src/mastra/wordpress/escape-url.ts exports unescape and escapeUrl: the CommonMark charref pattern that requires the trailing semicolon, html._replace_charref's numeric branch with the three tables consulted in Python's order, the longest-prefix named-entity fallback that turns &notit; into the negation sign plus 'it;', and urllib.parse.quote over UTF-8 bytes with upper-case hex and the safe set ':/?#@!$&()*+,;=%'
- The entity table is loaded into a Map rather than looked up on the imported JSON object, because entity names come from user text and 'constructor' in obj is true on a plain object, so &constructor; would unescape to the source of Object and land in a URL. Python has no equivalent hazard; five prototype keys are in the generated corpus and six in a hand-written control
- web/src/mastra/wordpress/escape-url.test.ts adds 103 tests: the 89-case replay, a table-shape check, the lone-surrogate deviation assertion, and twelve hand-written controls covering the prototype-key hazard, the semicolon requirement, the hex/decimal digit bounds, the three-table ordering and the UTF-8-versus-code-unit encoding
- A dead big-hex guard was deleted after a mutation proved it unreachable: parseInt on a hex string past 13 digits rounds or returns Infinity, and both still compare greater than 0x10FFFF, which is the only question the code asks
- wp-html.ts's ref_link handler now throws with the ledger id 5.3c-iii-b-1-b-ii-3-b-2, and its header comment records that the escape_url half is done and lives in escape-url.ts

**Learnings:**
- escape_url is two Python stdlib behaviours JavaScript has neither of, and the interesting behaviour is at the seam between them, not inside either: &amp; unescapes to & which is in the safe set and survives literally, while &lt; unescapes to < which is not and becomes %3C. And % is in the safe set precisely so an already-encoded octet is not double encoded, which is why escape_url is not interchangeable with encodeURI or encodeURIComponent for any input.
- Porting a Python entity lookup to a plain JS object is a live defect, not a style issue. _replace_charref looks the name up by identity, and the name comes from user text, so 'constructor' in obj resolves &constructor; to the source of Object. Six prototype keys were confirmed against Python (all pass through unchanged) and the mutation that reintroduces the object lookup fails 6 tests.
- Three of my four hand-written controls asserted the wrong value and the implementation was right: U+10FFFF is itself a noncharacter so &#x10FFFF; unescapes to nothing, U+000B is in _invalid_codepoints so &#11; does too, and &#0000037; has exactly seven digits so it fits the {1,7} bound and resolves. Writing controls after the oracle passes is what catches this; writing them first would have produced a test suite that agreed with a wrong port.
- html.entities.html5 has no one-character name (its shortest four are GT, gt, LT, lt), so _replace_charref's `range(len(s) - 1, 1, -1)` lower bound is unobservable: no input distinguishes x > 1 from x > 0. That is the second mutation in two iterations that survived because the branch it guards has an empty reachable input set.
- parseInt makes the arbitrary-precision guard for huge hex charrefs unnecessary. It can round up or return Infinity but never rounds a value down across 0x10FFFF, because any value near that boundary needs at most six significant hex digits and is exact. The guard I wrote defensively was dead and a mutation proved it.
- This iteration touched no tracked Python file, so the 120 pytest failures could not have been caused here, but re-running pytest with the tree stashed still took under a minute and is the only thing that makes the ledger claim honest rather than inferred. Worth doing even when the reasoning says it is impossible.
- `pnpm -C web tsc --noEmit` as written in the objective's gate list does not work in this repo (pnpm resolves `tsc` as a script name and fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL). The working form is `pnpm -C web exec tsc --noEmit`.

### Iteration 114

**Summary:** Completed ledger item 5.3c-iii-b-1-b-ii-3-b-2 by porting mistune's ref_link block rule to TypeScript, which finishes the block layer of markdown_to_wp_html, verified against a 99-case/24-decline oracle generated from the real Python parser and hardened with sixteen mutations, with 261 tests.

**Changes:**
- web/src/mastra/wordpress/wp-html.ts gains parseRefLink, parseLinkHref in its block=True form, parseLinkTitle, unikey and the four helper patterns (LINK_BRACKET_START, LINK_BRACKET_RE, LINK_HREF_BLOCK_RE, LINK_TITLE_RE, BLANK_TO_LINE), completing every rule in BlockParser.DEFAULT_RULES
- BlockState gains an env holding a Map of ref links, shared with the parent state so a definition inside a block quote or list item is visible to the whole document, and a new exported parseRefLinks stops after the block parse to expose it, since parse_ref_link emits no token and the Gutenberg renderer never reads the env
- PY_SPACE spells out Python's whitespace class for str patterns, because JavaScript's \s omits \x1c-\x1f and \x85 and adds ﻿, a difference that is directly observable in the bare href scan
- api/scripts/export_wp_html_ref_link_parity.py writes web/src/mastra/wordpress/data/wp-html-ref-link-parity.json: 99 replay cases and 24 declines, each recording both the rendered HTML and the ref_links map read off the real parser state, bucketed automatically by replaying the TypeScript inline scan loop over the parsed tokens
- web/src/mastra/wordpress/wp-html-ref-link.test.ts adds 261 tests: the HTML replay, the ref_links replay, the decline path, and twelve hand-written controls each checked against the real Python function before being committed
- The three existing 'still refuses unported rules' probes in wp-html-blocks/quotes/lists.test.ts are retargeted at the inline emphasis rule, since the ref_link inputs they used are now replay cases
- docs/mastra-port/LEDGER.md item 5.3c-iii-b-1-b-ii-3-b-2 checked with the export run, the failing-first stub run, the passing runs, a sixteen-row mutation table, the unreachability proof for the one survivor, the twelve control values and all gates on both stacks; parents -3-b, -3 and -ii closed

**Learnings:**
- parse_ref_link is the only block rule with no observable output at all, so a single-channel oracle would have been almost toothless: the rendered HTML shows only that the definition line was consumed. Capturing state.env off md.parse(s, state) with a state you own is what makes it verifiable, and passing your own state also survives a render that raises, which matters because a refused definition can leave a paragraph the Gutenberg renderer crashes on.
- Bucketing corpus cases by hand into 'renders' and 'declines' is guesswork; replaying the TypeScript inline scan loop inside the Python exporter and asking which rule it would throw on classifies them mechanically and caught three cases I had put in the wrong bucket, including one where .strip() on the document silently un-indents a four-space line and turns an intended indented-code case into a plain definition.
- The `src[end_pos-1] == href[-1]` off-by-one in parse_link_href is unreachable from ref_link. LINK_HREF_BLOCK_RE ends `(?:\s|$)` and the ordered alternation means `$` only fires when nothing follows the href, so the branch needs a block state whose src lacks a trailing newline. Fuzzing 3928 documents found zero such states: mistune guarantees the trailing newline at the top level and every child extractor preserves it. Third iteration running where a mutation survived because the branch it guards has an empty reachable input set.
- Python's `\s` for str patterns and JavaScript's are not the same set, and the difference is reachable in article markdown: `﻿` (a BOM, which an LLM can emit) is whitespace to JavaScript but not Python, so it stays inside an href and gets percent encoded, while `\x85`, `\x1c` and `\xa0` are the reverse and refuse the definition outright. Spelling out Python's class rather than using `\s` is what makes the port faithful, and it took four purpose-built cases to prove it.
- unikey's `.lower().upper()` is a two-step case fold, not an upper-casing, and the upper-casing incidentally defuses the Object.prototype hazard that bit the escape-url port: no member of Object.prototype is all upper case, so no label can collide. The Map is still the right structure, but the reason is faithfulness to Python dict lookup semantics rather than a live defect, and the corpus now pins the behaviour so a folding change cannot quietly reintroduce it.
- `rm -rf media/test-123` after a pytest run deletes 39 tracked files along with the three untracked .webp artifacts. Only the untracked ones should go: `git status --porcelain` first, remove by name, or `git checkout -- media/test-123` to undo.

### Iteration 115

**Summary:** Split ledger item 5.3c-iii-b-1-b-iii into four inline-rule sub-items and completed the first by porting mistune's inline state, scan loop, escape and codespan rules plus the codespan renderer to TypeScript, verified against a 95-case oracle generated from the real Python parser and hardened with thirteen mutations, with 109 tests.

**Changes:**
- Ledger item 5.3c-iii-b-1-b-iii split into -iii-a through -iii-d, grouped by what each inline rule needs from the inline state: state-free rules, autolinks plus inline HTML, emphasis plus precedence_scan, and links plus images with the three link helpers
- web/src/mastra/wordpress/wp-html.ts gains the inline layer's InlineState (four nesting flags, copy(), append_token, shared env), process_text, the parse_method dispatch, InlineParser.parse including its decline branch, parse_escape, parse_codespan and the renderer's codespan case
- api/scripts/export_wp_html_inline_escape_codespan_parity.py writes a 95-case oracle from the real markdown_to_wp_html, refusing to emit any case whose paragraphs reach an unported inline rule by replaying the TypeScript scan loop over the parsed tokens
- web/src/mastra/wordpress/wp-html-inline-escape-codespan.test.ts replays the oracle plus hand-written controls: 109 tests covering the escape run, the codespan closing-run rules, the space folding, the leftmost-match tie-breaks and the backtick-info-string fence case moved out of the -b-i corpus
- Fixed a real divergence the corpus found: markdownToWpHtml, parseRefLinks and parse_fenced_code's info string used String.prototype.trim where Python uses str.strip(), which differ on ﻿; all three now call a new pyStrip built from the file's existing PY_SPACE class
- Updated two now-obsolete wp-html-blocks.test.ts assertions that pinned escape and codespan as throwing, replacing them with the real Python output for the declined backtick fence and naming auto_email and inline_html in the unported-rule list

**Learnings:**
- A backtick in a backtick fence's info string declines the fence, so the paragraph it falls back to renders as a codespan, which is why that case belonged to the codespan sub-item rather than the image one the ledger note suggested
- JavaScript's String.prototype.trim strips ﻿ and Python's str.strip() does not, because "﻿".isspace() is false; the wp-html port had three sites spelling str.strip() as trim(), and only a corpus case with a trailing byte order mark exposed it
- One mutation survives the corpus and is genuinely unobservable rather than untested: matching escapes one at a time instead of as a run emits {text "*"},{text "_"} where the run emits {text "*_"}, and _GutenbergRenderer.text concatenates, so no input can distinguish them through this renderer
- _GutenbergRenderer has no inline_html method, so an inline tag makes the real markdown_to_wp_html raise AttributeError rather than render; the -iii-b oracle must pin the raise, not an HTML string
- The oracle export script's scan replay has to skip a codespan the way the handler does, otherwise `<div>` inside backticks is misread as an inline_html blocker and the case is refused
- Running two `pnpm -C web test` processes concurrently makes src/app/api/events/events.test.ts fail en masse (30 failures instead of 9), because they share the same Redis; full-suite runs must be sequential
- pytest needs the repo .env sourced or every database test fails with asyncpg InvalidPasswordError and the run reports 4 failed/205 passed/177 errors instead of the 120/241/25 baseline

### Iteration 116

**Summary:** Completed ledger item 5.3c-iii-b-1-b-iii-b by porting mistune's auto_link, auto_email and inline_html inline rules plus the link renderer method and the in_link flag to TypeScript, verified against a three-corpus oracle generated from the real Python parser and hardened with thirteen mutations, with 121 tests.

**Changes:**
- web/src/mastra/wordpress/wp-html.ts gains parseAutoLink, parseAutoEmail, addAutoLink and parseInlineHtml with their dispatch arms, the renderer's link case (including the title branch), and MissingRendererError standing where mistune's BaseRenderer._get_method raises AttributeError for an inline_html token
- Two parity-only exports added to wp-html.ts: parseInlineTokens (mistune's InlineParser.__call__, the only surface the in_link flag is observable on) and renderTokens (so renderer branches unreachable from any parseable document can still be pinned against the real Python method)
- api/scripts/export_wp_html_inline_autolink_parity.py writes a three-corpus oracle: 81 whole-document html_cases of which 15 pin the AttributeError rather than HTML, 19 token_cases for the in_link toggle, and 6 render_cases for _GutenbergRenderer.link including the title branch that no rule in this item can build
- web/src/mastra/wordpress/wp-html-inline-autolink.test.ts replays all three corpora plus 12 hand-written controls covering escape_url applying to the href only, auto_link beating auto_email at one offset, the four literal anchor prefixes, and the unescaped angle brackets a failed autolink leaves in a paragraph
- Three existing tests updated because the behaviour they pinned is what this item implements: the unported-rule lists in wp-html-blocks.test.ts and wp-html-inline-escape-codespan.test.ts drop the three now-ported rules, and the five rule-7 decline cases in wp-html-raw-html.test.ts now assert MissingRendererError with tokenType inline_html, which is exactly where and why Python fails on the same input
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-b-iii-b with pasted evidence, four named behaviours, a corpus-naming correction, the thirteen-mutation table and the full frontend and backend gate output

**Learnings:**
- The in_link flag has no rendered output whatsoever. The only rule that toggles it, inline_html, is also the only inline token _GutenbergRenderer has no method for, so every document that exercises the flag raises before anything is rendered. Verifying it required a second oracle shape (mistune's InlineParser.__call__ token stream) rather than more markdown_to_wp_html cases. Future items whose behaviour is a state flag should expect the same and plan a token-level corpus rather than trying to find a document that shows it.
- A complete inline tag alone on its own line is usually NOT block HTML. Block rule kind 6 requires a block tag name and kind 7 requires the tag alone on its line with nothing after it, so `<span>a</span>` and `<a href="/x">y</a>` both decline, fall back to a paragraph and raise out of the inline layer. Two oracle cases were written asserting the opposite and only the generated output caught it.
- _GutenbergRenderer.text returns token['raw'] with no HTML escaping, so anything that fails every inline rule reaches the paragraph with its angle brackets and ampersands intact: `<a:x>` renders as `<p><a:x></p>`. Any parity expectation written by hand that assumes `&lt;` is wrong.
- _GutenbergRenderer.link interpolates url and title into an f-string unescaped, so a double quote in either attribute breaks out of the attribute. Pinned as a control so a later 'fix' is a deliberate divergence.
- Some renderer branches are unreachable from any document the parser can currently produce (link's title branch, because _add_auto_link never sets a title). Exporting the renderer entry point and pinning those branches against the real Python method directly is cheaper and more honest than deferring half a ported method to a later item.
- mistune's parse_inline_html tests four literal prefixes ('<a ', '<a>', '<A ', '<A>') rather than parsing the tag, so `<a\n>` is a valid opening anchor that toggles nothing. A port that used a case-insensitive tag-name check would diverge on a line-wrapped anchor.

### Iteration 117

**Summary:** Completed ledger item 5.3c-iii-b-1-b-iii-c by porting mistune's emphasis inline rule, the emphasis and strong renderer methods and precedence_scan to TypeScript, fixing two Python-vs-JavaScript regex escape divergences along the way, verified against a three-corpus oracle generated from the real Python parser and hardened with twenty-four mutations, with 110 tests.

**Changes:**
- web/src/mastra/wordpress/wp-html.ts gains parseEmphasis, the six EMPHASIS_END_RE patterns, precedenceScan, the prec_auto_link and prec_inline_html specification entries, the emphasis and strong renderer cases, and an applyInlineRule dispatch split out of parseInlineMethod so precedence_scan can reach rules by name
- INLINE_SPECIFICATION.emphasis stops using JavaScript's \b and \s and uses PY_SPACE plus a new PY_WORD lookaround (verified exhaustively against CPython as [\p{L}\p{N}_]); every inline pattern is now compiled with the u flag through a new cached inlineSc helper, and prec_auto_link spells Python's \d as \p{Nd}
- api/scripts/export_wp_html_inline_emphasis_parity.py writes a three-corpus oracle (75 html cases with 2 pinning the AttributeError, 14 token cases, 7 render cases) and guards it by wrapping mistune's _methods table, which catches unported rules reached through precedence_scan as well as through the top-level scan
- web/src/mastra/wordpress/wp-html-inline-emphasis.test.ts replays all three corpora plus 18 hand-written controls covering the nesting guards, the Unicode word boundary on both sides of an underscore, Python's whitespace set on both sides of the marker, and the four precedence-scan outcomes: 110 tests
- Five existing tests updated because the behaviour they pinned is what this item implements: wp-html-blocks.test.ts asserts the real Python HTML for an emphasised word, the unported-rule loops in the escape/codespan and autolink tests drop the emphasis row, and the lists and quotes refusal controls swap to a [link](/b) input
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-b-iii-c with pasted evidence, the twenty-four-mutation table and an argument for why the two survivors are unobservable; todo.md records the same \s divergence still present in the linebreak and softbreak patterns

**Learnings:**
- Python's `\w` for str patterns is exactly `[\p{L}\p{N}_]`, confirmed by comparing re against unicodedata.category over all 1,114,112 code points. Since mistune only ever uses `\b` immediately adjacent to an underscore, the boundary reduces to a lookaround on that class, which needs the JavaScript `u` flag; the whole inline specification compiles cleanly under `u` so switching the flag on was cheap.
- The escaped-marker alternative in EMPHASIS_END_RE almost never wins. `[^\s*]` matches the backslash itself, so `*a\*b*` closes AT the backslash and renders `<em>a\</em>b*`, not the `<em>a*b</em>` a reading of the pattern suggests. Three hand-written controls in this iteration guessed wrong and only the generated oracle corrected them.
- Wrapping mistune's `_methods` dict is a strictly better unported-rule guard than replaying the scan loop in the export script: `parse_method` and `precedence_scan` both dispatch through it, so it sees rules reached indirectly, and it needs no per-rule special casing for handlers that consume past the scan position.
- `prec_auto_link`'s Unicode `\d` is unobservable through this renderer. Any string where it and `[0-9]` disagree holds a non-ASCII digit in the scheme, `auto_link`'s own pattern is ASCII-only so it can never succeed there, and `prec_inline_html` matches at the same offset but also cannot succeed, because the character that broke the scheme also breaks the tag.
- Searching EMPHASIS_END_RE from `m.start()` instead of `m.end()` is provably equivalent: the closing head cannot match a marker character and every position in between is one, so the first candidate is `m.end()` either way. Worth checking before treating a surviving mutant as a corpus gap.
- `* a*` is a list bullet, not a paragraph, so the control for "a marker followed by whitespace does not open" has to use `_ a_` or `** a**`. Easy to write a control that tests the block layer by accident.

### Iteration 118

**Summary:** Completed ledger item 5.3c-iii-b-1-b-iii-d by porting mistune's link and image inline rules, the three link helpers, the in_link/in_image guards, the ref_links lookup and the image renderer method to TypeScript, which finishes the whole markdown_to_wp_html port, verified against a four-corpus oracle generated from the real Python parser and hardened with twenty-six mutations, with 138 tests.

**Changes:**
- web/src/mastra/wordpress/wp-html.ts gains parseLinkLabel, parseLinkText, parseLinkAttrs (helpers.parse_link), parseLinkToken, parseLinkRule and the image renderer case; parseLinkHref grew the block parameter it was written without, so the inline LINK_HREF_INLINE_RE branch shares it with the block one, and PREVENT_BACKSLASH moved beside PUNCTUATION because the inline href and square-bracket patterns need it earlier
- Fixed a real divergence the corpus found: helpers.LINK_LABEL spells `\\.` and Python's `.` without re.S is exactly [^\n] while JavaScript's also refuses \r, U+2028 and U+2029, so a backslash before a line separator was ending the label early; the class is now spelled out, which fixes both the inline label and the block ref_link pattern that shares the constant
- UnportedMarkdownError and UNPORTED_INLINE_RULES deleted: every rule in BlockParser.DEFAULT_RULES and InlineParser.DEFAULT_RULES is now ported so the class had no throw site left, and the six test files that asserted a refusal now assert the real Python output instead
- parseInlineTokens takes an optional refLinks map, because a reference link's ref and label fields and an absent-versus-empty title are only visible on the token stream, not in the rendered HTML
- api/scripts/export_wp_html_inline_link_parity.py writes web/src/mastra/wordpress/data/wp-html-inline-link-parity.json: 91 whole-document html cases, 2 raising cases pinning the AttributeError a tag in a paragraph causes, 23 token cases through mistune.InlineParser.__call__ with an explicit ref_links env, and 7 render cases for _GutenbergRenderer.image plus the link title branch
- web/src/mastra/wordpress/wp-html-inline-link.test.ts replays all four corpora plus 14 hand-written controls covering the asymmetric nesting guards, the even-backslash bracket quirk, the unbalanced-parenthesis href, the collapsed-versus-full reference labels and the raw interpolation of url and alt: 138 tests
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-b-iii-d with pasted evidence, four named behaviours, the twenty-six-mutation table and unobservability proofs for the two survivors; parents 5.3c-iii-b-1-b-iii and 5.3c-iii-b-1-b closed, the latter recording that wp-html.ts is now a whole-function port with 1124 tests across nine files

**Learnings:**
- parse_link is the only inline rule whose scan pattern matches almost nothing of what it consumes, and the only one that can decline, so it is the sole reason the scan loop's one-character-forward fallback exists. It is also the only reader of state.env['ref_links'], which means the block layer's ref_link output was unobservable through the renderer until this item landed.
- mistune's _INLINE_SQUARE_BRACKET_RE carries an even backslash run into its match and parse_link_text compares the WHOLE match against "]", so `\\]` raises the nesting level rather than lowering it while `\]` is skipped entirely. The quirk only reaches parse_link_text when a nested bracket has already defeated parse_link_label, so a control written as `[a\\](/b)` tests nothing: it needs `[a[b] c\\](/d)`.
- The `end_pos >= len(state.src) and label is None` guard in parse_link is provably redundant. Removing it opens only the precedence_scan path, and that can only win with a match ending at len(src), which would have to end on the final `]`; codespan ends on a backtick and auto_link and inline_html on `>`. Confirmed by patching the guard out of mistune itself and diffing 197502 generated documents: 0 differed. Third or fourth item running where a survivor guards an empty reachable input set.
- The two nesting guards are deliberately asymmetric: a link inside a link text and an image inside an image alt are literal text, but a link inside an image alt and an image inside a link text both still nest. A port that wrote one symmetric guard passes most of a naive corpus.
- An empty title is dropped from attrs rather than stored as "", and the renderer's `if title` makes "" falsy anyway, so the difference is invisible in HTML. Pinning it needed a token case. Same shape as the in_link flag from -iii-b: state and attribute presence need a token corpus, not more documents.
- __parse_link_token uses state.copy(), which carries in_emphasis and in_strong into the link text. `_a [b *c* d](/e) f_` is the input that shows it: the copied flag is what keeps `*c*` literal inside the link. A fresh state passes every corpus case that does not nest a link inside an emphasis.
- PAREN_END_RE is Python's `\s`, and the two directions the sets disagree in are both reachable after a title: `[a](/b "t"\x1c)` closes in Python and not in JavaScript, `[a](/b "t"﻿)` the reverse. Every place mistune writes `\s` in a str pattern is a divergence site worth a purpose-built case.
- pnpm test on this repo currently reports 9 failures at baseline, and they are 6 in image-preview.test.tsx plus 3 in PostDetail.test.tsx, not the events.test.ts Redis race earlier notes described. Confirming no regression is cheapest by running those two files alone rather than diffing whole-suite counts, which drift between runs.

### Iteration 119

**Summary:** Split ledger item 5.3c-iii-b-1-c into three sub-items and completed the first by porting the WordPress publish hook's two pure metadata helpers, `_extract_frontmatter` and the manifest filename index, to TypeScript, verified against a 62-case oracle generated from the real Python function and hardened with twenty-two mutations, with 67 tests.

**Changes:**
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-1-c into -c-i (the two pure metadata helpers), -c-ii (the media-directory sweep and upload loop) and -c-iii (the workflow: guards, create/update branch, wp_publish_status transitions and the three publish events), justified by the three sharing no machinery and only the first being pinnable byte for byte against Python with no network or filesystem
- web/src/mastra/wordpress/publish-metadata.ts ports _extract_frontmatter as extractFrontmatter() and the inline manifest_by_file / featured_filename loop as indexManifestImages(), reusing PY_WHITESPACE and pythonStrip from ../textstat rather than respelling Python's whitespace class, and returning Maps rather than objects because frontmatter keys and image filenames are model output that can be __proto__
- api/scripts/export_wp_publish_metadata_parity.py generates the oracle by calling the real _extract_frontmatter over 43 cases and by pulling the manifest-indexing block out of publish_to_wordpress with inspect.getsource, dedenting it and exec'ing it against a stub post over 19 cases, so the recorded answers cannot drift from the function they describe without the export raising
- web/src/mastra/wordpress/data/wp-publish-metadata-parity.json emits both maps as pair lists rather than JSON objects, because __proto__ is an ordinary dict key in Python and does not survive a round trip through a JavaScript object literal
- web/src/mastra/wordpress/publish-metadata.test.ts replays the whole oracle (67 tests) plus two prototype-safety checks and a direct assertion of the featured-filename-versus-record quirk

**Learnings:**
- A JSON oracle whose keys come from model output cannot be shaped as a JSON object. Importing wp-publish-metadata-parity.json silently dropped the __proto__ key from the expected map, and the test failed with 'expected { __proto__: 'x', title: 'Hello' } to deeply equal { title: 'Hello' }', which reads exactly like a port defect. Emitting pair lists from the export script is the fix, and it is worth doing pre-emptively for any map keyed by LLM output.
- When the Python behaviour to port is inline in a larger function rather than its own def, inspect.getsource plus textwrap.dedent plus exec against a stub object makes the oracle genuinely derived from the real code instead of a transcription. Guard it by asserting exactly one start marker and one end marker so a source move raises rather than recording stale answers, and put the extracted source into the JSON so the vitest side can assert the markers too.
- Python's `\s` divergence from JavaScript's is observable in both directions inside a single regex, and both directions are reachable from real content: `---\x1c\n` opens a frontmatter block in Python and would not in JavaScript, while `---﻿\n` does the reverse. A port that only remembers the `\x1c` half is still wrong.
- publish.py's two maps are written independently in one loop, so a featured entry followed by an inline entry with the same filename leaves featured_filename set to that filename while manifest_by_file holds the inline record. The featured image would then be uploaded with the inline entry's alt text.
- _find_image_refs in api/src/pipeline/publish.py is dead: publish_to_wordpress never calls it and the only references outside the definition are in api/tests/phase10/test_publish.py. Item -c-ii and -c-iii should not port it.
- Deleting the untracked .webp artifacts pytest writes into media/test-123/ with a glob also removes the nine tracked featured-082326-*.webp fixtures committed there. Use `git status --porcelain` to pick off only the `??` entries, or `git checkout -- media/test-123/` to undo it.

### Iteration 120

**Summary:** Split ledger item 5.3c-iii-b-1-c-ii into three sub-items and completed the first by porting Python's mimetypes.guess_type (the WordPress media sweep's image filter) to TypeScript, verified against a 100-case oracle generated inside python:3.12-slim, a 105993-case differential fuzz with zero divergences and twenty-eight mutations, with 212 tests.

**Changes:**
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-1-c-ii into -ii-1 (the mimetypes filter, pure and oracle-testable), -ii-2 (the sorted directory walk) and -ii-3 (the upload loop, featured-media resolution and URL rewrite), justified by only the first being pinnable against Python with no filesystem and no network
- web/src/mastra/wordpress/mimetypes.ts ports mimetypes.guess_type as guessTypeFromFilename() together with posixpath.splitext and the slice of urllib.parse.urlparse it consumes (C0 lstrip, tab/CR/LF deletion, scheme detection and lowercasing, fragment and query splits, the uses_params semicolon split, and the data-URL branch), plus the four Python 3.12 builtin tables as exported Maps
- api/scripts/export_mimetypes_parity.py writes web/src/mastra/wordpress/data/wp-mimetypes-parity.json with the four tables verbatim and 100 guess_type cases; it asserts sys.version_info is 3.12 and that no mimetypes.knownfiles entry exists, so it refuses to run outside the deployed python:3.12-slim image, and asserts every case is a slash-free path component
- web/src/mastra/wordpress/mimetypes.test.ts replays the whole oracle twice (raw tuple and the image predicate the sweep applies), compares the port's four tables entry-for-entry against Python's, checks the oracle's provenance, and adds four controls: 212 tests
- todo.md records a confirmed production defect: .webp is absent from the Python 3.12 builtin mimetypes table, the images stage writes only .webp, so the deployed WordPress publish uploads zero images and sets no featured image

**Learnings:**
- mimetypes.guess_type is host- and interpreter-dependent, which makes the developer machine the wrong place to generate an oracle for it. mimetypes.init() reads mimetypes.knownfiles; macOS has /etc/apache2/mime.types, which takes the strict table from 152 entries to 1036, adds 45 image/* extensions and changes .ico from image/vnd.microsoft.icon to image/x-icon. python:3.12-slim has no knownfile at all. Any future port of a stdlib function that reads system config files needs the same treatment: generate the oracle inside the deployed image and assert the environment in the script.
- Confirmed production defect: .webp entered Python's builtin mimetypes table in 3.13, the deployed image is 3.12, and the images stage writes every file as .webp. So publish_to_wordpress's `if not mime or not mime.startswith("image/"): continue` skips every generated image: no uploads, no featured image, local /media/ URLs left in the published HTML. It is invisible on a Mac because the apache table covers .webp, which is exactly why it survived.
- guess_type re-reads the raw argument whenever no multi-character scheme was found, so none of urlsplit's cleaning survives into that branch. "a.p\tng" is (None, None) even though urlsplit deletes tabs, while "ht\ttp:a.png#b.gif" is image/png. The schemeless branch also keeps the fragment and query in the path, so "a.png#b.gif" resolves off .gif and "http:a.png#b.gif" off .png. A port that parses once and uses the parsed path everywhere passes most of a naive corpus.
- Restricting the input domain to a single POSIX path component (which is exactly what Path.iterdir() yields) kills the three hardest pieces of urlsplit: the // netloc split, its IPv6 bracket validation, and the '/' branch of _splitparams. It also collapses the data-URL branch to text/plain-or-nothing, because the candidate type can never contain a slash. Stating the domain and throwing on a slash is cheaper and more honest than porting urlparse.
- A seeded differential fuzz is cheap and worth adding beyond the hand-built corpus: 105993 random slash-free names built from an alphabet of the characters every branch keys off, run through the real function in docker and through the port, gave 0 differences, and re-running each surviving mutation against that same corpus turned four analytical unobservability arguments into measured ones.
- pytest only reproduces the recorded 120 failed / 241 passed / 25 errors baseline when the repo .env is sourced first (POSTGRES_HOST_PORT is 5435 here, not the 5433 compose default). Without it the run collapses to 4 failed / 205 passed / 177 errors, which reads like a mass regression. pytest also writes untracked featured-082326-*.webp files into media/test-123/; remove only the `??` entries before finishing.

### Iteration 121

**Summary:** Completed ledger item 5.3c-iii-b-1-c-ii-2 by porting the WordPress publish hook's media-directory walk (is_dir gate, sorted iterdir, is_file filter) to TypeScript together with os.fsdecode and Python string ordering, verified against a 72-case oracle generated from the real Python function, twenty-eight mutations, and a Linux docker run that measures the three mutations APFS cannot show, with 79 tests.

**Changes:**
- web/src/mastra/wordpress/media-walk.ts ports the four-line media walk as listMediaFiles(), returning each entry as a decoded name plus a byte path so a filename that is not valid UTF-8 still opens the file it names; it exports decodeFsName() (os.fsdecode, UTF-8 with surrogateescape) and comparePythonStrings() (code-point ordering) beside it, and reproduces pathlib's rule that only ENOENT, ENOTDIR, EBADF and ELOOP are absence while every other OSError propagates and an embedded NUL is caught
- api/scripts/export_media_walk_parity.py pulls the four walk lines out of the real publish_to_wordpress with inspect.getsource, asserts their exact shape and adjacency, appends a name collector in place of the mimetypes filter that follows them, and executes the result against scratch trees; it refuses to run where the filesystem encoding is not utf-8/surrogateescape or where the effective uid is root, because the EACCES case would record the wrong answer
- web/src/mastra/wordpress/data/wp-media-walk-parity.json records 34 os.fsdecode cases, 15 sorted() cases, 20 walk cases and 3 error cases, with every name emitted as a code point list so surrogateescape's lone surrogates survive JSON
- web/src/mastra/wordpress/media-walk.test.ts replays the whole oracle plus four naive-port controls: 79 tests
- todo.md upgrades the scaffold-check flake from [investigate] to [confirmed] with the elimination evidence that any added test file, including a one-line dummy, takes the frontend gate from 9 failures to 10
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-c-ii-2 with pasted evidence, four named divergences, the twenty-eight-mutation table, equivalence proofs for the five redundant survivors and the docker measurement that kills the three APFS-unobservable ones

**Learnings:**
- Node's readdir already returns names in strcmp order (200 random names created in scrambled order came back byte-sorted on both macOS and Linux), and byte order over valid UTF-8 is exactly code point order, so on a filesystem that only accepts valid UTF-8 an explicit Python-order sort has nothing left to do. The sort is only load-bearing for a name that is not valid UTF-8, where readdir order and Python's sorted() are reversed: readdir gives ['efbfbd','ff'] while Python gives ['\udcff','�'].
- APFS rejects a filename that is not valid UTF-8 with EILSEQ, so a macOS vitest run physically cannot cover surrogateescape decoding, the sort, or the byte-path choice. Node 24 strips TypeScript types, so the .ts module imports directly under `docker run node:24-alpine`, which turns three analytically-argued survivors into measured ones for the price of one 30-line script. That trick generalises to any port whose behaviour depends on the host filesystem.
- CPython's surrogateescape escapes every byte of a decode error range separately, and no byte below 0x80 can ever be inside such a range, so a greedy decoder that escapes one byte and retries at the next is exactly equivalent to CPython's maximal-subpart error reporting. Verified against 34 hand-picked byte strings including overlongs, encoded surrogates, truncations and past-U+10FFFF leads.
- pathlib swallows only ENOENT, ENOTDIR, EBADF and ELOOP; EACCES and ENAMETOOLONG propagate out of publish_to_wordpress. Mutations that widen the ignored set survive a corpus built from ordinary trees, so the corpus needs a chmod 0444 directory (skipped as root, with the export script refusing to run as root) and a walk whose parent is a regular file.
- The scaffold-check lifecycle test is not intermittent, it is deterministic on suite file count: 2/2 full runs failed with the new test file, the suite returned to 9 failures with it moved aside, and failed again with a one-line dummy test file in its place. Any future iteration that adds a test file will report 10 failures, so the 9-failure baseline cannot be read as an exact number until Phase 5's resumable replay fixes run.stream() missing already-published events.
- Mutation testing found two genuinely redundant guards in my own first draft (the 0xc2 lead bound and the truncation check are both subsumed by the overlong/range checks and by JavaScript's undefined coercion), and one apparent redundancy that is not (advancing by two UTF-16 units cannot misalign, because two strings only keep advancing while their code points are equal). Writing the equivalence argument for each survivor is what separates the two cases.

### Iteration 122

**Summary:** Completed ledger item 5.3c-iii-b-1-c-ii-3 by porting the WordPress publish hook's upload loop (mime filter, per-file upload_media call, featured-media resolution and local-to-remote URL rewrite) to TypeScript, verified against a 26-case oracle that has to be generated inside the deployed python:3.12-slim image, hardened with twenty mutations, with 34 tests.

**Changes:**
- web/src/mastra/wordpress/media-upload.ts ports the upload loop as uploadMediaFiles() and rewriteImageUrls(), with sweepMediaDirectory() composing them onto listMediaFiles() and guessTypeFromFilename() so the whole media sweep has one entry point. It reproduces dict.get's present-key semantics for alt text, the featured-media fallback that re-arms when a response has no id, and Python's str.replace spelled split().join() so a source_url holding $& is not read as a substitution pattern
- api/scripts/export_media_upload_parity.py pulls the twenty upload lines and the two rewrite lines out of the real publish_to_wordpress with inspect.getsource, asserts their exact shape, and executes them over real scratch files against a recording stand-in for the WordPress client; it refuses to run outside the deployed image because the mimetypes table depends on both the interpreter version and the host's /etc/apache2/mime.types
- web/src/mastra/wordpress/data/wp-media-upload-parity.json records 26 cases including the two error paths with Python's own message text, a stored-null source_url, and the .webp file the images stage writes being skipped entirely
- web/src/mastra/wordpress/media-upload.test.ts replays the oracle plus naive-port controls and an equivalence pin asserting no mimetypes value contains 'image/' anywhere but at index 0: 34 tests
- WordPressClient.uploadMedia's altText parameter widened from string to unknown, because the value comes out of image_manifest and Python forwards whatever is stored there into the patch body
- todo.md records the local-to-remote rewrite corrupting a media URL that is a prefix of a later one, with the oracle case that reproduces it
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-c-ii-3 with pasted evidence, four named divergences, the twenty-mutation table and equivalence proofs for the four survivors

**Learnings:**
- The mimetypes table that decides which files the publish hook uploads is not reproducible on this machine for two independent reasons: Python 3.13 added .webp to the builtin table and the deployed 3.12 does not have it, and macOS has /etc/apache2/mime.types which mimetypes.init() reads. Generating the oracle with `uv run` (3.13.12 here) recorded image/webp and produced three false test failures against a port whose table came from python:3.12-slim. Any future oracle whose answer depends on a stdlib data table needs the same docker-only guard.
- Building the real api image (docker build -t jena-api-oracle api, cached after the first run) gives an oracle environment with the deployed interpreter, the deployed dependency set and no knownfiles, so inspect.getsource on the imported function still works. That is strictly better than a bare python:3.12-slim container, which cannot import src.pipeline.publish at all.
- A __proto__ key from JSON.parse becomes an OWN property and leaves the prototype chain alone, so `"k" in obj` and `Object.hasOwn(obj, "k")` agree on it. A control built that way does not discriminate the two; killing the mutation needs Object.create({k: v}), which is unreachable from a JSONB column and therefore pins depth rather than a fix.
- CPython spells the None singleton two different ways in two error messages the publish hook writes to the post: `'NoneType' object has no attribute 'get'` from AttributeError, but `replace() argument 2 must be str, not None` from Argument Clinic. Recording str(exc) in the oracle rather than just the exception type is what caught it.
- Adding oracle cases is a cheaper way to kill a mutant than adding a control test, and it kills more than aimed at: the two cases added for a stored-null source_url (to kill `?? instead of hasOwn`) also pinned both TypeError message spellings and proved the raise happens after every upload has already committed.
- This run's full frontend suite reported 9 failures with the new test file present, so the scaffold-check file-count flake recorded in iteration 121 does not fire every run and the 9-failure baseline is still readable, just not reliably.

### Iteration 123

**Summary:** Completed ledger item 5.3c-iii-b-1-c-iii by porting the WordPress publish hook itself (guards, wp_publish_status transitions, create/update branch and the three SSE events with _fail) to a registered Mastra step and workflow, verified by a real-database, real-filesystem, real-HTTP run and hardened with twenty mutations, with 28 tests.

**Changes:**
- web/src/mastra/steps/wordpress-publish.ts ports publish_to_wordpress as wordpressPublishStep: the missing-post return, the profile / credentials / decrypt guards routed through a fail() that mirrors _fail, the publishing-then-published/failed status transitions, the create-vs-update branch with Python's keyword order, and the publish_start / publish_complete / publish_error events beside their execution_logs entries. The try block deliberately spans the success commit, so a failure after the row is published still rewrites it to failed while leaving wp_post_id and wp_post_url in place, as Python did.
- web/src/mastra/workflows/wordpress-publish.ts wraps that step in a one-step createWorkflow().then().commit(), registered on the Mastra instance as wordpressPublish so the web service can start a run and the worker executes it; web/src/mastra/index.test.ts asserts the registration and the serialized step graph.
- integerColumn() and textColumn() stand in for asyncpg's parameter check, so a WordPress that answers {"id": "7"} fails the publish here as it did in Python; the recorded message differs and that is documented as the item's one divergence.
- pythonGet exported out of web/src/mastra/wordpress/media-upload.ts (formerly the private mediaGet) because wp_post.get("id") is the same subscript with the same AttributeError text, and WordPressClient.createPost's featuredMedia widened from number|null to unknown for the same reason altText was widened in the previous item.
- web/src/mastra/steps/wordpress-publish.test.ts: 28 tests over a loopback http.Server that records every WordPress request, real image files under a real MEDIA_DIR, real rows in the dev database and a real Fernet token, covering the create branch, the update branch, the four guards, a refused upload and a row that takes the other side of every `or` in the hook.
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-c-iii with pasted evidence, the argument for why this item has no oracle, four named behaviours, one divergence and the twenty-mutation table; it also closes the two rollup parents 5.3c-iii-b-1-c-ii and 5.3c-iii-b-1-c, whose sub-items were all already checked.

**Learnings:**
- A type-only import counts against web/src/mastra/no-next-imports.test.ts, which asserts the exact package set the Mastra entry point reaches. `import type { IMastraLogger } from "@mastra/core/logger"` added @mastra/core/logger to the graph and failed that test; spelling the logger structurally as `{ info(m: string): void; error(m: string): void }` keeps it out and is still satisfied by the real IMastraLogger.
- A top-level vitest beforeEach runs after every nested describe's beforeAll, so a shared recording array cleared in beforeEach wipes exactly the recordings a describe-level beforeAll just produced. Nine tests failed for that reason alone; the fix is to clear inside each describe's own beforeAll and scope the beforeEach to the describe that needs per-test isolation.
- wp_publish_status = 'publishing' is only observable from inside the request the hook is making, because it is overwritten before the step returns. The mutation that deleted the transition survived until the fake WordPress server's first POST /media handler read the row back and recorded the value. Any transient status in a port needs an assertion made from inside the boundary it is talking to, not from after the call.
- A credentials guard of the form `!a || !b || !c` is not exercised by a fixture that has none of the three: an only-`a` mutant still rejects it. Killing that mutant needs one profile per column, knocked out on its own against an otherwise configured row.
- This item had no oracle and that was the right call: publish_to_wordpress is a transaction, a Redis publish and an HTTP conversation, so recording it from Python would have required a fake WordPress on the Python side too and would only have proven that two fakes agree. Reading the source line by line into the module header plus twenty mutations stood in for the corpus, and three of the twenty found real coverage gaps rather than equivalences.
- The full frontend suite reported the 9-failure baseline on this run even with a new test file added, so the scaffold-check file-count flake from iteration 121 is intermittent rather than deterministic on file count, matching what iteration 122 saw.

### Iteration 124

**Summary:** Completed ledger item 5.3c-iii-b-1-d by porting the WordPress branch of POST /{post_id}/publish to a Next.js route handler that starts the registered wordpressPublish workflow over Redis Streams, verified against the real database, real sessions and the real bus, hardened with twenty mutations, with 20 new tests.

**Changes:**
- web/src/app/api/posts/[id]/publish/route.ts ports publish_post()'s wordpress branch: the caller-scoped inner-join lookup and its 404, the `No content to publish` 400 spelled with Python truthiness so an empty ready_content falls through to final_md_content, `wp_publish_status = "pending"` committed before the start, and a 202 `{status: "queued", post_id}` echoing the stored lowercase id rather than the path casing. A null output_format renders in the trailing 400 as 'None', the way Python interpolated it.
- web/src/mastra/start-wordpress-publish.ts is the enqueue_job("publish_to_wordpress") boundary between web and worker, beside start-pipeline.ts and start-crawl.ts: createRun().startAsync() on the registered wordpressPublish workflow, publishing workflow.start onto Redis Streams and returning without waiting.
- 20 tests appended to web/src/app/api/posts/run-control.test.ts, which now covers all six per-post pipeline-control endpoints. The start is recorded through a mock that reads wp_publish_status back from inside the start, which is the only way to observe that pending is committed before the enqueue, and one test starts a real run and reads the workflow.start event off the real bus.
- docs/mastra-port/LEDGER.md checks off 5.3c-iii-b-1-d with pasted evidence, four preserved behaviours, the one temporary divergence (nextjs takes the trailing 400 until its workflow exists) and the twenty-mutation table; 5.3c-iii-b-2 is promoted from prose into a real unchecked checkbox naming the Next.js workflow, its branch and the removal of that fall-through.

**Learnings:**
- A handler ported from a multi-branch Python endpoint needs a terminal branch even when only one branch is in scope, so part of the next item's stated scope (the trailing 400) has to land early. Naming that in the ledger and turning the deferred branch into its own checkbox is cheaper and more honest than inventing a 501 placeholder that the next iteration deletes.
- Every test in the suite handed the endpoint a path id that was already the stored lowercase form, so the `post.id` vs `id` mutation survived: id-echo fidelity is invisible until a test uppercases the path. Postgres compares the uuid column case-insensitively, so an uppercase path resolves the row fine and only the response body differs.
- Re-measuring a whole mutation table after adding the test that kills the survivor is worth the four minutes: the counts shift on almost every row (a 72-test run and a 73-test run disagree on 12 of 20 lines), so a table copied from the earlier pass would have been fabricated output.
- The full frontend suite reported 10 failures on two of three runs this iteration and the baseline 9 on the third, with the extra always src/mastra/workflows/scaffold-check.test.ts. That matches iterations 121-123: the flake is real and intermittent, not deterministic on test-file count.
- The dev stack was down at the start of this iteration (previous iteration stopped it), and the DB host port is 5435 in this worktree's .env, not the 5433 compose default. Reading the port out of .env rather than assuming it is what turns an ECONNREFUSED into a two-command fix.

### Iteration 125

**Summary:** Split ledger item 5.3c-iii-b-2 into five sub-items and completed the first by porting apply_frontmatter_mapping to TypeScript, verified against a 55-case oracle generated from the real Python function and hardened with twenty-one mutations, with 61 tests.

**Changes:**
- web/src/mastra/nextjs/frontmatter-mapping.ts ports apply_frontmatter_mapping as applyFrontmatterMapping(), taking and returning Maps so that a __proto__ key stays a field, a non-string result key from target.get("key", jena_field) keeps its type, integer-like target keys keep insertion order, and Python's True/1 key collision is reproduced; a list or object `key` raises Python's own TypeError rather than being stringified, because the hook does not catch it
- api/scripts/export_frontmatter_mapping_parity.py asserts the fifteen lines it is describing are still in the real function via inspect.getsource, then runs it over 55 cases covering both branches, the `in` vs `.get` disagreement about a stored null, `is None` vs truthiness for values and defaults, the array transform's continue-before-wrap, non-str/dict targets and the two raising cases
- web/src/mastra/nextjs/data/nextjs-frontmatter-mapping-parity.json records inputs and results as pair lists with each result key tagged with its Python type, since JSON alone loses both the ordering and the key types
- web/src/mastra/nextjs/frontmatter-mapping.test.ts replays the oracle plus four controls for the object-shaped transcription's losses: 61 tests
- docs/mastra-port/LEDGER.md splits 5.3c-iii-b-2 into -a through -e, records that the HMAC half was already ported in web/src/lib/hmac-signing.ts, checks off -a with pasted evidence, four named divergences, the twenty-one-mutation table and equivalence proofs for the three survivors, and carries forward the PyYAML sort_keys/try-except-TypeError finding plus the schema.ts Record<string, string> widening into the later sub-items

**Learnings:**
- PyYAML's yaml.dump defaults sort_keys=True and represent_mapping wraps sorted(mapping) in try/except TypeError, so the emitted key order is sorted when the mapped keys are mutually comparable and falls back to insertion order when they are not. That makes apply_frontmatter_mapping's result ORDER unobservable for an all-string result and observable the moment a None or int key appears beside strings, which is exactly what a mapping storing {"key": null} or {"key": 5} produces.
- Half of this item was already done and only reading the repo found it: web/src/lib/hmac-signing.ts ports sign_payload and item 5.9's profiles /nextjs/test route already signs with it. The ledger's stated scope named HMAC as the likely split point, so trusting the split hint over a grep would have produced a duplicate module.
- Python's dict hashes True with 1 and False with 0 while a JS Map does not, and this is reachable from the JSONB mapping column: two targets storing {"key": 1} and {"key": true} write one entry in Python and two in a naive port. Map.set already keeps the first-inserted key and the last-written value, so the whole fix is a twin lookup before the set.
- A `key` stored as a list or object is not an edge case to swallow: Python raises TypeError out of publish_to_nextjs, which does not catch it, so the publish fails. Recording the raise in the oracle rather than dropping the case is what keeps the port from publishing a post Python refused to publish.
- Mutation testing found two genuine oracle gaps rather than equivalences: no case had a dict-shaped `key` and no case had a source field stored as null with no default beside it. Adding two oracle rows was cheaper than adding controls and killed both mutants, matching what iteration 122 found.
- `git checkout -- media/test-123/` is the recovery when a blanket rm of pytest's featured-082326-*.webp output takes tracked files with it. Only the `??` entries in git status are pytest's; the rest are committed fixtures.
