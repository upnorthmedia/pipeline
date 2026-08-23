# Phase 5 evidence

Moved out of `LEDGER.md` on 2026-08-23 to cut the context
re-read every iteration. Verbatim, nothing edited.


## 5.1a


  Item 5.1 is split, because the router is two unrelated halves: the settings
  collection, and the API-key endpoints with their live per-provider validation
  calls. The first half also carries the foundation every later router needs, so
  it is done first and on its own.

  **The blocker found first: the BetterAuth tables did not exist.** Alembic 010
  adds the `user_id` columns and says in a comment that BetterAuth creates its own
  tables separately; nothing in this repo ever ran that step.

  ```
  $ docker compose exec -T db psql -U pipeline -d content_pipeline -c "\dt" | grep auth_
  (no output)
  ```

  So every authenticated handler would have 401d against a missing table, which is
  also one root of the Phase 0 pytest baseline's `assert 401 == 201` cluster.
  `@better-auth/cli` is not the fix: its newest published version is 1.4.22 while
  the installed core is 1.5.4.

  ```
  $ npx -y @better-auth/cli@1.5.4 generate --config src/lib/auth.ts -y
  npm error notarget No matching version found for @better-auth/cli@1.5.4.
  ```

  `web/scripts/auth-migrate.mts` uses `getMigrations()` from the installed
  package instead, so the DDL always matches `node_modules` and the field
  mappings in `src/lib/auth.ts`:

  ```
  $ cd web && node --env-file=../.env scripts/auth-migrate.mts
  tables to create: auth_users, auth_sessions, auth_accounts, auth_verifications
  columns to add:   (none)

  create table "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null, "stripeCustomerId" text);

  create table "auth_sessions" ("id" text not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" text not null references "auth_users" ("id") on delete cascade);

  create table "auth_accounts" ("id" text not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "auth_users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

  create table "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

  create index "auth_sessions_user_id_idx" on "auth_sessions" ("user_id");

  create index "auth_accounts_user_id_idx" on "auth_accounts" ("user_id");

  create index "auth_verifications_identifier_idx" on "auth_verifications" ("identifier");
  re-run with --apply to execute

  $ cd web && node --env-file=../.env scripts/auth-migrate.mts --apply
  tables to create: auth_users, auth_sessions, auth_accounts, auth_verifications
  columns to add:   (none)
  applied

  $ docker compose exec -T db psql -U pipeline -d content_pipeline -c "\dt" | grep auth_
   public | auth_accounts                     | table | pipeline
   public | auth_sessions                     | table | pipeline
   public | auth_users                        | table | pipeline
   public | auth_verifications                | table | pipeline
  ```

  This is not a schema change the port invented: the column set matches the
  read-only models in `api/src/models/auth.py`, which pytest already creates
  through `Base.metadata.create_all`, and the parity check in
  `src/db/schema-parity.ts` already excludes `auth_*` from Alembic ownership.

  **What was built**

  | File | Role |
  | --- | --- |
  | `web/scripts/auth-migrate.mts` | creates the BetterAuth tables from the installed package's own migration planner; `pnpm auth:migrate` prints, `--apply` runs |
  | `web/src/lib/request-auth.ts` | `getRequestUser()` and `unauthorized()`, replacing `get_current_user()` for every Phase 5 handler |
  | `web/src/app/api/settings/route.ts` | `GET` and `PATCH /api/settings` |
  | `web/src/test/session.ts` | mints real `auth_users` + `auth_sessions` rows and a correctly signed cookie for handler tests |

  Four decisions worth recording:

  1. **`auth.api.getSession()`, not a hand-rolled session lookup.** Python read the
     cookie, split the signature off and queried `auth_sessions` itself. BetterAuth
     owns the session format here, so the port asks it: it verifies the signature,
     knows the `__Secure-` prefix, and refreshes `expires_at`. The negative-control
     table below shows the signature check is real, which the Python version never had.
  2. **Handlers take a Web `Request` and return a Web `Response`, not `next/server`
     types.** That is what lets the tests call `GET`/`PATCH` directly with no server
     running, and it keeps the handlers importable from the worker side later.
  3. **Sessions in tests are inserted, not signed up for.** `auth.api.signUpEmail()`
     would fire the Stripe plugin's `createCustomerOnSignUp` on every test user, an
     outbound call to Stripe per test. The rows written are the same rows BetterAuth
     writes, and the cookie is signed with the live instance's own secret via
     `makeSignature()` from `better-auth/crypto`, so `getSession()` validates it
     exactly as it would a browser's.
  4. **`PATCH` stores the request value verbatim.** `settings.update()` in `api.ts`
     sends `{"<key>": {"value": {...}}}` and Python persisted the wrapper object as
     the row value. Unwrapping it would be a nicer API and would silently change the
     meaning of every row already stored.

  **The one behaviour deliberately kept broken:** `settings.key` is the entire
  primary key (010 indexed `user_id` but left it out of the key), so two users
  cannot both hold one key. Patching a key another user owns raises a unique
  violation in both stacks. Fixing it needs a primary-key change, which section 8
  forbids as part of the port. Logged in `todo.md` and asserted as-is, because the
  alternative failure (dropping the `user_id` filter) is a silent cross-tenant
  overwrite.

  **Two environment defects this item had to fix to work at all**

  `next dev` never loaded the repo-root `.env`, because Next only reads `.env*`
  inside `web/`. Until now that did not matter: the dashboard got all its data from
  the Python API over HTTP. The first real request proved it:

  ```
  ERROR [Better Auth]: INTERNAL_SERVER_ERROR error: database "cody" does not exist
      at async getRequestUser (src/lib/request-auth.ts:29:19)
   GET /api/settings 500 in 37ms
  ```

  `next.config.ts` now loads `../.env` the way `vitest.config.ts` already did,
  without overriding anything already in the environment.

  `src/middleware.ts` matched `/api/settings` and redirected unauthenticated
  requests to the sign-in page, so an expired session would have reached
  `request()` in `api.ts` as a 307 to an HTML page and thrown a JSON parse error
  instead of `ApiError(401)`. The matcher now excludes `api` as a whole. It only
  ever checked that a cookie was present, so it was not what protected these
  routes; `getRequestUser()` is.

  **Live HTTP smoke test**, against `next dev` with a real signed cookie, proving
  route registration, the middleware fix and both handlers end to end:

  ```
  $ curl -s -o /dev/stdout -w "%{http_code}\n" http://localhost:3000/api/settings
  {"detail":"Not authenticated"}
  401
  $ curl -s -X PATCH -H "content-type: application/json" -H "cookie: better-auth.session_token=$C" \
      -d '{"http_smoke":{"value":{"ok":true}}}' http://localhost:3000/api/settings
  [{"key":"http_smoke","value":{"value":{"ok":true}},"updated_at":"2026-08-22T15:29:03.651Z"}]
  200
  $ curl -s -H "cookie: better-auth.session_token=$C" http://localhost:3000/api/settings
  [{"key":"http_smoke","value":{"value":{"ok":true}},"updated_at":"2026-08-22T15:29:03.651Z"}]
  200
  $ curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/settings
  307 http://localhost:3000/auth/sign-in
  ```

  The smoke user and its row were deleted afterwards (`leftover_settings 0`,
  `leftover_users 0`).

  **Tests**

  ```
  $ cd web && pnpm exec vitest run src/lib/request-auth.test.ts src/app/api/settings/route.test.ts
   ✓ src/lib/request-auth.test.ts (6 tests) 36ms
   ✓ src/app/api/settings/route.test.ts (12 tests) 70ms

   Test Files  2 passed (2)
        Tests  18 passed (18)
  ```

  `route.test.ts` is the TypeScript replacement for `api/tests/phase4/test_settings.py`.
  All four of its cases are carried over (`lists nothing`, `creates rows`, `updates an
  existing row`, `lists a row it just wrote`), plus the four multi-tenancy and three
  malformed-body cases that suite never had. The pytest file is left in place until
  Phase 7 deletes `api/`; its four cases fail there today with 401, since its fixtures
  never build a session, and that is part of the Phase 0 baseline.

  **Negative controls.** Each mutation was applied, the suite run, then reverted:

  | Mutation | Result |
  | --- | --- |
  | drop `where user_id = $1` from the `GET` query | 6 failed, 6 passed |
  | drop `user_id` from the `PATCH` existence lookup | 1 failed (`refuses to write over a key another user already owns`) |

  The second control is the point of that test: without the filter, one user's
  `PATCH` silently overwrites another user's row instead of failing.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0
  $ cd web && pnpm lint
  lint exit=0
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.5s
  Route (app)
  ├ ƒ /api/settings
  $ cd web && pnpm test
  Test Files  2 failed | 58 passed (60)
       Tests  9 failed | 858 passed | 7 skipped (874)
  ```

  The 9 failures are the Phase 0 baseline, in the same two files. Totals moved by
  exactly this item's 18 tests. Two corrections to the recorded baseline, both
  measured with this iteration's test files moved aside:

  ```
  $ cd web && pnpm test          # with src/lib/request-auth.test.ts and
                                 # src/app/api/settings/route.test.ts moved out
  Test Files  3 failed | 55 passed (58)
       Tests  10 failed | 839 passed | 7 skipped (856)
  ```

  1. The skip count is **7**, not the 8 every earlier entry recorded. The eighth was
     `gemini.test.ts > live smoke > the configured model id resolves against the live
     API`, gated on `GEMINI_API_KEY`, which is now present in `.env` and passes. It
     unskips with or without this iteration's changes.
  2. The suite is **flaky between 9 and 10 failures**. The tenth is
     `images.test.ts > resolves its model from the encrypted key in the settings
     table`, which fails with `anthropic API key not configured` when it races another
     agent test file over the single shared global `api_keys` settings row. It passes
     alone. Pre-existing and logged in `todo.md`; not caused by this item.

  `api/` was not touched. Its gates are unchanged from 4.7c-i:

  ```
  $ cd api && TEST_DATABASE_URL=... uv run pytest -q
  125 failed, 236 passed, 25 errors in 12.89s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  **Not covered by this item**, carried into 5.1b: the three API-key endpoints
  (`GET /api/settings/api-keys`, `GET /api/settings/api-keys/{provider}/reveal`,
  `PUT /api/settings/api-keys`), the write half of `api_keys.py`
  (`save_api_keys`, `save_validation_results`, `get_masked_keys`, `reveal_api_key`)
  and the live provider validation in `api_key_validator.py`. `/settings` is the
  page that consumes those, and it consumes nothing from 5.1a: no dashboard code
  calls `settings.list()` or `settings.update()` today.

  `NEXT_PUBLIC_API_URL` still points the dashboard at the Python API on :8055. It
  flips to same-origin once Phase 5 finishes, not per router, since one base URL
  serves every namespace in `api.ts`.

## 5.1b-i


  `web/src/mastra/api-keys.ts` already owned the `api_keys` settings row for the
  agents (item 3.1b), so the masking and reveal half went there rather than into a
  second module with a second copy of `PROVIDERS` and `API_KEYS_SETTING_KEY`. It
  gained `getValidationResults()` (Python's `_load_validation`), `getMaskedKeys()`
  and `revealApiKey()`. The two handlers are thin: auth, the loopback gate, and
  `Response.json`.

  Contract, unchanged: `GET /api/settings/api-keys` returns
  `Record<string, ApiKeyStatus>` and the reveal returns `{provider, key}`, both as
  declared for `apiKeys.get()` and `apiKeys.reveal()` in `web/src/lib/api.ts`.

  **Deviation, deliberate, on the reveal endpoint's loopback gate.** Python gated
  it on `request.client.host in ("127.0.0.1", "::1", "localhost")`, the raw TCP
  peer address uvicorn saw. A Next.js route handler has no access to the socket
  (`NextRequest.ip` was removed in Next 15), so the peer address is not
  recoverable. Rebuilding the check on `x-forwarded-for` would be strictly weaker
  than what it replaces, because that header is attacker-controlled, so the port
  fails closed instead: the request must name a loopback `Host` **and** carry no
  `forwarded`, `x-forwarded-for`, `x-forwarded-host` or `x-real-ip` header at all.
  Behind any proxy, including Railway's edge, a forwarding header is present and
  the reveal 403s; against `next dev` on the developer's own machine the browser
  sends `Host: localhost:3000` and no forwarding header, which is exactly the case
  Python allowed. An attacker cannot strip a header a trusted proxy adds.

  Two further behaviours differ from Python and are intentional:

  1. `get_masked_keys()` swallowed a decrypt failure with a warning and reported
     the provider as unconfigured. The TS path throws, matching the reasoning
     already recorded for `getApiKeys()` in item 3.1b: a rotated
     `WP_ENCRYPTION_KEY` must not masquerade as "no key configured" on the very
     page whose job is to tell you whether the key is there.
  2. `source` can only ever be `"db"` or `"none"`. `"env"` stays in the union
     because `ApiKeyStatus` in `web/src/lib/api.ts` declares it, but no code path
     in either stack produces it; keys moved out of the environment into the
     `api_keys` row before this port started.

  The `api_keys` row is global (`settings.key` is the primary key and
  `save_api_keys()` never set `user_id`), so unlike the collection endpoints in
  5.1a there is nothing to scope by user. The session is still required. Making
  the row per user would be a schema change, which section 8 forbids.

  **Fixed on the way through:** the `todo.md` entry about `pnpm -C web test`
  flaking between 9 and 10 failures. Eight test files swap that one global row for
  a fixture encrypted under their own throwaway `WP_ENCRYPTION_KEY`, and vitest
  runs them in parallel processes against one database, so a restore landed while
  a sibling was mid-assertion. This item's own route test hit it on its first full
  run (11 failures, two of them mine). `web/src/test/api-keys-row.ts` serialises
  exactly those eight files on a Postgres session advisory lock. Turning off file
  parallelism suite-wide would have been the blunt alternative; the lock costs
  nothing measurable (79.43s with, 79.58s without).

  New tests, both against the real database and, for the handlers, a real
  BetterAuth session:

  ```
  $ pnpm -C web exec vitest run --reporter=verbose src/app/api/settings/api-keys/route.test.ts
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys > 401s without a session 3ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys > returns one ApiKeyStatus per provider, keyed by provider 10ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys > never returns a plaintext key 2ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > 401s without a session, before the loopback gate 0ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > 403s a request that carries a proxy forwarding header 5ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > 403s a request whose Host is not loopback 1ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > allows 127.0.0.1 and [::1] as well as localhost 4ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > 404s a provider name it does not know 1ms
   ✓ src/app/api/settings/api-keys/route.test.ts > GET /api/settings/api-keys/{provider}/reveal > returns the plaintext key for a loopback request, or 404 when unset 4ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
  ```

  ```
  $ pnpm -C web exec vitest run src/app/api/settings/api-keys/route.test.ts src/mastra/api-keys.test.ts
   ✓ src/mastra/api-keys.test.ts (16 tests) 48ms
   ✓ src/app/api/settings/api-keys/route.test.ts (9 tests) 70ms

   Test Files  2 passed (2)
        Tests  25 passed (25)
  ```

  `src/mastra/api-keys.test.ts` went from 6 tests to 16. The ten new ones cover
  `getValidationResults` (missing row, boolean coercion, unknown providers
  dropped), `getMaskedKeys` (no row, last-four hint, the sub-four-character
  `...***` branch, no plaintext anywhere in the payload, the validation result
  carried onto a configured provider and withheld from an unconfigured one) and
  `revealApiKey` (configured, unset, unknown provider). They live there rather
  than beside the handlers because that file already owns the shared row.
  `test_get_masked_keys_configured` and
  `test_get_masked_keys_never_returns_actual_key` from
  `api/tests/phase11/test_api_keys_service.py` are both covered; so are
  `test_get_api_keys_empty` and `test_get_api_keys_never_returns_plaintext` from
  `api/tests/phase11/test_api_keys.py`. No pytest file was deleted.

  Frontend gates:

  ```
  $ pnpm -C web tsc --noEmit
  (no output, exit 0)
  $ pnpm -C web lint
  (no output, exit 0)
  $ pnpm -C web build
  ✓ Compiled successfully in 2.8s
  Route (app)
  ├ ƒ /api/settings
  ├ ƒ /api/settings/api-keys
  ├ ƒ /api/settings/api-keys/[provider]/reveal
  $ pnpm -C web test
       Tests  9 failed | 877 passed | 7 skipped (893)
   Duration  79.43s
  ```

  The failure count is **9**, down from the 10 recorded at 5.1a, and it is now
  deterministic: three consecutive full runs all reported `9 failed | 877 passed |
  7 skipped (893)`. The nine are the six pre-existing `image-preview.test.tsx`
  failures and three pre-existing `PostDetail.test.tsx` failures. The tenth was
  the `api_keys` row race, which the advisory lock removes.

  `api/` was not touched (`git status --short` lists nothing under `api/`). Its
  gates, run with the repo `.env` rather than a hand-typed connection string:

  ```
  $ cd api && set -a && . ../.env && set +a && uv run pytest -q
  125 failed, 236 passed, 25 errors in 13.38s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  Unchanged from the 4.7c-i baseline. Note for later iterations: the Python test
  database is on **port 5435** with the password from `.env`, not the 5433 the
  memory file records; sourcing `.env` is the only reliable way to run pytest here,
  and a wrong connection string produces 177 collection errors that look like a
  regression but are `InvalidPasswordError`.

  **Not covered by this item**, carried into 5.1b-ii: `PUT /api/settings/api-keys`,
  `save_api_keys()`, `save_validation_results()` and the live per-provider
  validation in `api_key_validator.py`. Until that lands, nothing writes
  `api_keys_validation`, so `valid` is `null` for every provider on the ported
  endpoint.

## 5.1b-ii


  `PUT /api/settings/api-keys` now lives in `web/src/app/api/settings/api-keys/route.ts`
  alongside the `GET` from 5.1b-i. `saveApiKeys()` and `saveValidationResults()`
  joined `web/src/mastra/api-keys.ts`, and the three validators moved to a new
  `web/src/mastra/api-key-validator.ts`. `web/src/lib/api.ts` was not touched:
  `apiKeys.update()` already declared `PUT /api/settings/api-keys` returning
  `Record<string, ApiKeyStatus>`, and that is exactly what the handler returns.

  **Provider endpoints, verified live rather than recalled.** Python reached
  the three providers through the `anthropic`, `httpx` and `google-genai`
  packages; none of the three is a `web/` dependency, so the port uses `fetch`.
  Every URL, header name and failure shape below was confirmed by calling the
  real endpoint on 2026-08-22, with a deliberately invalid key where no key is
  held. No credential appears in the commands or the output.

  ```
  $ curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages \
      -H "content-type: application/json" -H "x-api-key: sk-ant-not-a-real-key" \
      -H "anthropic-version: 2023-06-01" \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,
           "messages":[{"role":"user","content":"hi"}]}'
  401
  {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}

  $ curl -s -o /dev/null -w "%{http_code}\n" https://api.perplexity.ai/chat/completions \
      -H "content-type: application/json" -H "Authorization: Bearer pplx-not-a-real-key" \
      -d '{"model":"sonar","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
  401
  {"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}

  $ curl -s -w "%{http_code}\n" -H "x-goog-api-key: $GEMINI_API_KEY" \
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
  200
  {"models":[{"name":"models/gemini-2.5-flash","version":"001", ... }]}

  $ curl -s -w "%{http_code}\n" -H "x-goog-api-key: AIzaNotARealKey" \
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
  400
  {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",
   "status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID", ...}]}}
  ```

  Two things that fall out of that and are encoded in the port: Google answers a
  bad key with a **400**, not a 401, which is why Python matched on the message
  (`"401" in err or "API_KEY_INVALID" in err or "PERMISSION_DENIED" in err`) and
  why the TS validator matches the same three markers against the body rather
  than switching on the status. And the Gemini probe is the models **list**, a
  metadata-only call, so it stays green on the zero-quota key this environment
  holds where a generation probe would not.

  **Model IDs.** `claude-haiku-4-5-20251001` (Anthropic probe) and `sonar`
  (Perplexity probe) are carried over verbatim from
  `api/src/services/api_key_validator.py`. Neither is a stage model and neither
  is a choice made here; verifying and possibly upgrading the six stage models
  is item 6.1. The Anthropic ID could not be confirmed against a live 200 because
  this environment holds no Anthropic key, and a 401 short-circuits before the
  model name is looked at. Recorded as a gap rather than papered over.

  **Three intentional deviations from Python, all argued:**

  1. *One 15s timeout for all three validators.* Python bounded only the
     Perplexity call at 15s and let the Anthropic SDK's 600s default and the
     `google-genai` default stand. The three run sequentially inside a `PUT` a
     human is waiting on, so a wedged provider could park that request for ten
     minutes. The shared bound turns a hang into a reportable error string.
  2. *The jsonb merge moved into SQL.* `save_api_keys()` and
     `save_validation_results()` both read the row, merged in memory and wrote it
     back, losing a concurrent write to a different provider. `mergeSettingsValue()`
     does `insert ... on conflict do update set value = settings.value ||
     excluded.value`, which is the same shallow-merge semantics (right side wins
     per key, absent keys preserved) in one statement. Covered by the
     `keeps both writes when two providers are saved concurrently` test.
  3. *A `{"detail": ...}` 422 rather than FastAPI's validation-error array.* This
     matches the other ported handlers in this router and the shape
     `web/src/lib/api.ts` surfaces on `ApiError`.

  Behaviour deliberately preserved, because it looks like a bug and is not: a key
  is stored **even when the provider rejects it**. The common cause is a good key
  and a momentarily unreachable provider, and discarding the input would make
  that unrecoverable from the settings page. The failure is reported through
  `valid: false` instead. Also preserved: a provider submitted as an empty string
  is neither validated nor cleared, which is what lets the settings form submit
  masked fields the user did not retype.

  **Live smoke.** `api-key-validator.test.ts` ends with a `describe.skipIf(!process.env.GEMINI_API_KEY)`
  block that calls the real Gemini endpoint with the real credential and with a
  malformed one. It ran (not skipped) in the run below. There is no Anthropic or
  Perplexity live smoke because this environment holds no key for either; the
  recorded 401 bodies above are replayed by the stubbed-transport tests instead.

  ```
  $ cd web && pnpm exec vitest run src/mastra/api-key-validator.test.ts --reporter=verbose
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > sends the one-token probe the Python validator sent 
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > reports a 401 as the actionable 'Invalid API key'
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > passes any other provider error through with its message
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > falls back to the status when the error body carries no message
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > reports a transport failure rather than throwing
   ✓ src/mastra/api-key-validator.test.ts > validateAnthropic > rejects an empty key without calling the provider
   ✓ src/mastra/api-key-validator.test.ts > validatePerplexity > sends the one-token completion the Python validator sent
   ✓ src/mastra/api-key-validator.test.ts > validatePerplexity > reports a 401 as 'Invalid API key'
   ✓ src/mastra/api-key-validator.test.ts > validatePerplexity > reports any other status by number, as Python did
   ✓ src/mastra/api-key-validator.test.ts > validatePerplexity > rejects an empty key without calling the provider
   ✓ src/mastra/api-key-validator.test.ts > validateGemini > lists models, the metadata-only probe that costs no tokens
   ✓ src/mastra/api-key-validator.test.ts > validateGemini > reads a bad key out of Google's 400, which is not a 401
   ✓ src/mastra/api-key-validator.test.ts > validateGemini > treats PERMISSION_DENIED as a bad key too
   ✓ src/mastra/api-key-validator.test.ts > validateGemini > passes a quota failure through instead of blaming the key
   ✓ src/mastra/api-key-validator.test.ts > validateGemini > rejects an empty key without calling the provider
   ✓ src/mastra/api-key-validator.test.ts > validateKeys > validates every supplied provider and reports each verdict
   ✓ src/mastra/api-key-validator.test.ts > validateKeys > skips empty and absent providers entirely
   ✓ src/mastra/api-key-validator.test.ts > live provider smoke > validates a real Gemini key against the real endpoint 134ms
   ✓ src/mastra/api-key-validator.test.ts > live provider smoke > rejects a malformed key against the real endpoint 60ms

   Test Files  1 passed (1)
        Tests  19 passed (19)
  ```

  Ten service tests, ported from `test_save_and_load_round_trip`,
  `test_save_empty_key_not_stored` and `test_save_upserts_existing` in
  `api/tests/phase11/test_api_keys_service.py`, against the real database:

  ```
  $ cd web && pnpm exec vitest run src/mastra/api-keys.test.ts --reporter=verbose
   ✓ saveApiKeys > stores ciphertext, not the key, and reads back the plaintext 3ms
   ✓ saveApiKeys > does not store an empty key 2ms
   ✓ saveApiKeys > upserts the row rather than inserting a second one 2ms
   ✓ saveApiKeys > leaves providers absent from the call untouched 2ms
   ✓ saveApiKeys > keeps both writes when two providers are saved concurrently 6ms
   ✓ saveApiKeys > writes nothing at all when every supplied key is empty 1ms
   ✓ saveValidationResults > persists a verdict that a later read returns 2ms
   ✓ saveValidationResults > merges into existing results instead of replacing them 2ms
   ✓ saveValidationResults > overwrites a provider's earlier verdict 2ms
   ✓ saveValidationResults > writes nothing when there is nothing to record 1ms

   Test Files  1 passed (1)
        Tests  26 passed (26)
  ```

  Nine route tests, ported from `test_put_api_keys_saves_and_validates`,
  `test_put_api_keys_encrypted_at_rest`, `test_put_api_keys_partial_update` and
  `test_put_api_keys_validation_failure` in `api/tests/phase11/test_api_keys.py`.
  Python patched `validate_keys` out; these stub the HTTP transport instead, so
  the real validator runs inside the real handler over a real BetterAuth session
  and a real database, and anything that is not a provider URL falls through to
  the real `fetch`:

  ```
  $ cd web && pnpm exec vitest run src/app/api/settings/api-keys/route.test.ts --reporter=verbose
   ✓ PUT /api/settings/api-keys > 401s without a session 1ms
   ✓ PUT /api/settings/api-keys > 422s a body that is not an object of provider strings 10ms
   ✓ PUT /api/settings/api-keys > stores the key and reports the provider's verdict 9ms
   ✓ PUT /api/settings/api-keys > stores the key encrypted, never in plaintext 9ms
   ✓ PUT /api/settings/api-keys > leaves the providers the body did not name alone 9ms
   ✓ PUT /api/settings/api-keys > still stores a key the provider rejected, and says it is invalid 14ms
   ✓ PUT /api/settings/api-keys > persists the verdict so a later GET reports it without re-validating 15ms
   ✓ PUT /api/settings/api-keys > neither validates nor clears a provider submitted as an empty string 6ms
   ✓ PUT /api/settings/api-keys > never returns a plaintext key 8ms

   Test Files  1 passed (1)
        Tests  18 passed (18)
  ```

  **A leak the first full run caught.** In isolation all three files passed, but
  the full suite then reported 10 failures instead of 9: the new PUT tests write
  `settings.api_keys_validation`, and `route.test.ts` only ever saved and restored
  `settings.api_keys`. The leftover row made 5.1b-i's `valid: null` assertion see
  `valid: true` on the next run. Fixed by saving, clearing and restoring both rows
  in that file's `beforeAll`/`afterAll`, the same way `src/mastra/api-keys.test.ts`
  already did. Worth recording: on a shared database, a test that writes a row it
  does not restore fails a *different* test on a *later* run, which reads as flake.

  Frontend gates, all four, after the fix. The failure count is back at the
  recorded baseline of **9** (six `image-preview.test.tsx`, three
  `PostDetail.test.tsx`, all pre-existing), and the pass count rose by exactly the
  38 tests this item added (877 -> 915):

  ```
  $ cd web && pnpm exec tsc --noEmit ; echo "EXIT=$?"
  EXIT=0
  $ cd web && pnpm lint ; echo "EXIT=$?"
  EXIT=0
  $ cd web && pnpm test
   Test Files  2 failed | 60 passed (62)
        Tests  9 failed | 915 passed | 7 skipped (931)
     Duration  78.88s
  $ cd web && pnpm build ; echo "EXIT=$?"
  EXIT=0
  ```

  `api/` was not touched (`git status --short api/` is empty). Its gates are
  unchanged from the 4.7c-i baseline:

  ```
  $ cd api && set -a && . ../.env && set +a && uv run pytest -q
  125 failed, 236 passed, 25 errors in 13.18s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  With this, item 5.1 (`settings`) is complete: `GET`/`PATCH /api/settings`
  (5.1a), the two API-key read endpoints (5.1b-i) and the API-key write endpoint
  with live validation (5.1b-ii) are all ported.

Item 5.2 (`profiles`) was split into 5.2a, 5.2b and 5.2c, because the router is
six endpoints across three distinct concerns: two plain reads, three writes that
have to encrypt `wp_app_password` and `nextjs_webhook_secret` before they touch
the row, and a crawl trigger whose only real content is
enqueuing `crawl_profile_sitemap`, an ARQ job with no TypeScript equivalent yet.

## 5.2a


  `web/src/app/api/profiles/serialize.ts` holds the one thing both handlers and
  all three write handlers in 5.2b will share: `ProfileRead` as a wire shape.
  Two columns on the row are deliberately not in it, `wp_app_password` and
  `nextjs_webhook_secret`, both ciphertext. FastAPI dropped them because
  `ProfileRead` in `api/src/models/schemas.py` never declared them, and a test
  asserts the exact key set so the port cannot start returning them by
  accident.

  Null handling follows Pydantic rather than the column defaults, which is a
  real difference in one place. `ProfileBase.default_stage_settings` defaults to
  a six-key all-`"auto"` map, but Alembic's server default for the column is a
  five-key all-`"review"` map, so a null column reached the dashboard as the
  six-key map and that is what is reproduced. Non-optional fields (`tone`,
  `word_count`, `output_format`, the three JSONB string lists, `sitemap_urls`,
  `crawl_status`) take their Pydantic default when null; optional ones keep the
  null, which is why `wp_default_status` stays null rather than becoming
  `"publish"`.

  `GET /api/profiles/{profile_id}` also rebuilds the path-parameter validation
  FastAPI got for free from `profile_id: uuid.UUID`: a malformed id is a 422
  with `type`/`loc`/`msg`/`input`, not a 500 from Postgres refusing the
  comparison. `ctx` and `url` are not reproduced and nothing in
  `web/src/lib/api.ts` reads them.

  Scoping matches `_get_user_profile()`: the id and `user_id` are matched
  together and a miss on either is the same 404, so another user's profile is
  indistinguishable from one that does not exist.

  ```
  $ cd web && pnpm vitest run src/app/api/profiles/route.test.ts --reporter=verbose
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > 401s without a session 3ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > lists nothing for a user with no profiles 12ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > orders newest first, matching created_at desc 5ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > never returns another user's profile 3ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > returns exactly the ProfileRead fields, without the two ciphertext columns 3ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles > substitutes the ProfileRead defaults for null columns 3ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles/[id] > 401s without a session 1ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles/[id] > returns the profile by id 2ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles/[id] > 404s for an id that does not exist 2ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles/[id] > 404s for another user's profile rather than revealing it exists 2ms
   ✓ src/app/api/profiles/route.test.ts > GET /api/profiles/[id] > 422s on a malformed uuid instead of letting Postgres raise 2ms
   Test Files  1 passed (1)
        Tests  11 passed (11)
     Duration  603ms
  ```

  Negative control, because a scoping test that passes on unscoped code proves
  nothing. With `.where(eq(websiteProfiles.userId, user.id))` deleted from the
  list handler and nothing else changed:

  ```
  $ cd web && pnpm vitest run src/app/api/profiles/route.test.ts
       ✓ 401s without a session 3ms
       ✓ lists nothing for a user with no profiles 14ms
       ✓ orders newest first, matching created_at desc 6ms
       × never returns another user's profile 7ms
       ✓ returns exactly the ProfileRead fields, without the two ciphertext columns 3ms
       ✓ substitutes the ProfileRead defaults for null columns 3ms
       ✓ 401s without a session 1ms
       ✓ returns the profile by id 3ms
       ✓ 404s for an id that does not exist 3ms
       ✓ 404s for another user's profile rather than revealing it exists 3ms
       ✓ 422s on a malformed uuid instead of letting Postgres raise 2ms
        Tests  1 failed | 10 passed (11)
  ```

  The filter was restored before the gates below were run.

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit ; echo "TSC_EXIT=$?"
  TSC_EXIT=0
  $ cd web && pnpm lint ; echo "LINT_EXIT=$?"
  LINT_EXIT=0
  $ cd web && pnpm test
   Test Files  2 failed | 61 passed (63)
        Tests  9 failed | 926 passed | 7 skipped (942)
     Duration  79.02s
  $ cd web && pnpm build >/dev/null 2>&1 ; echo "BUILD_EXIT=$?"
  BUILD_EXIT=0
  ```

  The 9 failures are the same Phase 0 baseline set (6 in `image-preview.test.tsx`
  plus the 3 recorded alongside them); the suite went from 915 passing to 926,
  which is the 11 added here. `next build` registers both handlers as dynamic:

  ```
  ├ ƒ /api/profiles
  ├ ƒ /api/profiles/[id]
  ```

  `api/` was not touched (`git status --short api/` is empty), so its gates are
  unchanged from the 5.1b-ii record.

  **Not covered by this item**, carried into 5.2b and 5.2c: `POST /api/profiles`,
  `PATCH /api/profiles/{profile_id}`, `DELETE /api/profiles/{profile_id}` (5.2b),
  and `POST /api/profiles/{profile_id}/crawl` plus the `crawl_profile_sitemap`
  job it enqueues (5.2c). `NEXT_PUBLIC_API_URL` still points the dashboard at the
  Python API on :8055 and flips to same-origin once Phase 5 finishes, not per
  router.

## 5.2b


  `POST` landed in `web/src/app/api/profiles/route.ts`, `PATCH` and `DELETE` in
  `web/src/app/api/profiles/[id]/route.ts`, over two new shared modules:
  `validation.ts` (the `ProfileCreate`/`ProfileUpdate` port and FastAPI's 422
  body) and `secrets.ts` (the two encrypted columns). All three scope by the
  session user, and the session user is also the only source of `user_id` on a
  create.

  **Two Python behaviours that a naive port gets wrong, both settled by probing
  the real thing rather than by reading it.**

  *1. `DELETE` is not a `DELETE`.* `session.delete(profile)` cascades over the
  two relationships on `WebsiteProfile` first: `links` carries
  `cascade="all, delete-orphan"`, and `posts` carries no delete cascade, so
  SQLAlchemy disassociates the posts by nulling `posts.profile_id`. A throwaway
  test against the real ORM and the real test database, run and then removed:

  ```
  $ cd api && uv run pytest tests/phase2/test_tmp_delete_parity.py -q -s
  PROBE posts=1 post.profile_id=[None] links=0
  .
  1 passed in 0.11s
  ```

  This matters because `posts_profile_id_fkey` has no `ON DELETE` action, so a
  plain `DELETE FROM website_profiles` would have raised a foreign key violation
  on any profile with posts, which is every profile that has ever been used. The
  handler nulls the posts inside the same transaction, after settling ownership
  so that a request for someone else's profile cannot touch that owner's posts.
  `internal_links_profile_id_fkey` does have `ON DELETE CASCADE`, so those rows
  need no help.

  *2. pydantic's 422 body, and its lax integer coercion.* Read straight off the
  real `ProfileCreate`, with the `url` key stripped:

  ```
  $ cd api && uv run python -c "...ProfileCreate(**payload) for five payloads..."
  [{"type": "missing", "loc": ["name"], "msg": "Field required", "input": {"website_url": "https://example.com"}}]
  [{"type": "int_parsing", "loc": ["word_count"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "lots"}]
  [{"type": "list_type", "loc": ["related_keywords"], "msg": "Input should be a valid list", "input": "no"}]
  [{"type": "dict_type", "loc": ["nextjs_frontmatter_map"], "msg": "Input should be a valid dictionary", "input": 5}]
  [{"type": "string_type", "loc": ["name"], "msg": "Input should be a valid string", "input": 5}]
  [{"type": "int_type", "loc": ["word_count"], "msg": "Input should be a valid integer", "input": null}]
  [{"type": "int_type", "loc": ["word_count"], "msg": "Input should be a valid integer", "input": [1]}]
  OK 2500   # word_count=" 2500 "
  OK 2500   # word_count=2500.0
  ```

  Three things fall out of that. `missing` reports the **containing object** as
  its `input`, not the absent value. A string that is not an integer is
  `int_parsing`, with a longer message, while a wrong type is `int_type`, so the
  two cannot be collapsed. And lax mode really does coerce `" 2500 "`, so the
  port coerces an integral string too rather than narrowing to JSON numbers.

  **Discrepancy with the installed types.** `z.core.$ZodIssue` declares `input`,
  but zod 4.4 strips it when it finalises the issues it hangs off `ZodError`:
  only `code`, `expected`, `path` and `message` survive. The first attempt read
  `issue.input`, got `undefined` for a wrong-typed field, and mislabelled it
  `missing`. `unprocessableBody()` now walks the value out of the raw body by
  `issue.path` instead, which is also what makes the `missing` case able to
  report its parent.

  Other decisions, each stated in a comment at the point it applies:

  - `POST` writes the full `model_dump()` of `ProfileCreate`, so pydantic's
    defaults are materialised rather than the column's. The two disagree for
    `output_format` ("markdown" against the column's "both") and
    `default_stage_settings` (six `"auto"` stages against the column's five
    `"review"` ones), and pydantic's is what the Python stack wrote.
  - `PATCH` reproduces `exclude_unset=True` through zod's `.partial()`: an
    absent key is absent from the parse output and never reaches the `set`,
    while a key sent as `null` clears the column. An empty body takes a read
    path, because Drizzle rejects an empty `set` where SQLAlchemy simply
    flushed nothing.
  - `updated_at` is stamped by hand, standing in for
    `TimestampMixin.onupdate`. One accepted difference: SQLAlchemy skipped the
    UPDATE entirely when every submitted value already equalled the stored one,
    leaving `updated_at` alone, whereas this issues it and bumps the timestamp.
    Attribute level dirty tracking is not worth reproducing for a timestamp no
    caller branches on.
  - Both write paths encrypt on truthiness, not on presence, exactly as Python
    did, so a `null` or an empty string is written through rather than becoming
    a Fernet token over nothing.

  Thirty one new tests, all against the real database and real BetterAuth
  sessions:

  ```
  $ pnpm -C web vitest run src/app/api/profiles/route.test.ts --reporter=verbose
   ✓ POST /api/profiles > 401s without a session
   ✓ POST /api/profiles > creates the profile and returns it with a 201
   ✓ POST /api/profiles > fills in the ProfileCreate defaults for a minimal body
   ✓ POST /api/profiles > owns the row by the session user, not by anything in the body
   ✓ POST /api/profiles > 422s when name is missing
   ✓ POST /api/profiles > 422s when website_url is missing
   ✓ POST /api/profiles > 422s with pydantic's own error type and message on a bad integer
   ✓ POST /api/profiles > 422s with int_type, not int_parsing, when the integer is the wrong type
   ✓ POST /api/profiles > 422s with list_type and dict_type for the collection fields
   ✓ POST /api/profiles > coerces an integral string the way pydantic's lax mode did
   ✓ POST /api/profiles > 422s on a body that is not JSON
   ✓ POST /api/profiles > drops unknown fields instead of rejecting them
   ✓ POST /api/profiles > stores the two credential fields encrypted and never echoes them
   ✓ POST /api/profiles > writes an empty credential through rather than encrypting nothing
   ✓ PATCH /api/profiles/[id] > 401s without a session
   ✓ PATCH /api/profiles/[id] > updates the submitted fields and preserves the rest
   ✓ PATCH /api/profiles/[id] > clears a column when the key is sent as null
   ✓ PATCH /api/profiles/[id] > leaves a column alone when its key is absent, matching exclude_unset
   ✓ PATCH /api/profiles/[id] > returns the row untouched for an empty body
   ✓ PATCH /api/profiles/[id] > re-encrypts a credential on update
   ✓ PATCH /api/profiles/[id] > clears a credential sent as null without encrypting it
   ✓ PATCH /api/profiles/[id] > accepts the save payload the profile detail page sends
   ✓ PATCH /api/profiles/[id] > 404s for an id that does not exist
   ✓ PATCH /api/profiles/[id] > 404s for another user's profile and leaves it unchanged
   ✓ PATCH /api/profiles/[id] > 422s on a malformed uuid
   ✓ DELETE /api/profiles/[id] > 401s without a session
   ✓ DELETE /api/profiles/[id] > deletes the profile and returns 204 with no body
   ✓ DELETE /api/profiles/[id] > orphans the profile's posts and deletes its internal links
   ✓ DELETE /api/profiles/[id] > 404s for an id that does not exist
   ✓ DELETE /api/profiles/[id] > 404s for another user's profile and leaves their posts attached
   ✓ DELETE /api/profiles/[id] > 422s on a malformed uuid
   Test Files  1 passed (1)
        Tests  42 passed (42)
  ```

  The last of those replays the exact `data` object
  `web/src/app/profiles/[id]/page.tsx` sends on save, explicit nulls and all, so
  the contract the dashboard actually depends on is asserted rather than
  inferred.

  Gates:

  ```
  $ pnpm -C web tsc --noEmit
  (no output, exit 0)

  $ pnpm -C web lint
  > eslint
  (no output, exit 0)

  $ pnpm -C web test
   Test Files  2 failed | 61 passed (63)
        Tests  9 failed | 957 passed | 7 skipped (973)

  $ pnpm -C web build
  ├ ƒ /api/profiles
  ├ ƒ /api/profiles/[id]
  (exit 0)
  ```

  The 9 failures are the same two files as the Phase 0 baseline
  (`PostDetail.test.tsx` and `image-preview.test.tsx`), still 9, still the
  ceiling. Passing went from 926 to 957, which is the 31 added here.

  `api/` was not touched (`git status --short api/` is empty; the delete probe
  above was removed again), so its gates are unchanged from the 5.1b-ii record.

  **Not covered by this item**, carried into 5.2c: the `crawl_profile_sitemap`
  job that `POST` enqueued on success. Python wrapped that enqueue in a bare
  `except` so a dead queue still returned a 201, meaning the response is
  identical either way and only the follow-up crawl is missing until 5.2c wires
  up the mechanism.
Item 5.2c was split into 5.2c-i, 5.2c-ii and 5.2c-iii. The route handler is
eight lines of Python; everything behind it is not. `crawl_profile_sitemap`
stands on `api/src/services/sitemap.py`, 225 lines of XML parsing, robots.txt
discovery and recursive index following that has no TypeScript equivalent, and
it then upserts into `internal_links` and moves the profile's crawl columns. The
three pieces are separately verifiable, so they are separate items.

## 5.2c-i


  `web/src/mastra/sitemap/index.ts` ports `parse_sitemap_xml`,
  `parse_robots_txt`, `discover_sitemaps`, `fetch_and_parse_sitemap` and
  `crawl_sitemap`. It sits beside the other ported services in `src/mastra/`
  (`links/`, `analytics/`, `textstat/`) and imports nothing from `next/*`, so
  the worker can load it.

  **The new dependency is `fast-xml-parser` 5.11.0.** Node has no XML parser and
  the alternatives were hand-rolling one over a regex (fragile against CDATA,
  entities and attributes) or pulling in a DOM. `fast-xml-parser` is zero-dep
  and ships its own types. Two of its behaviours had to be worked around, both
  recorded in the module header:

  * It does not reject malformed XML the way `lxml` does. `<not valid xml at
    all>>>` parses to `[{ not: [] }]` instead of raising, so the document goes
    through `XMLValidator` first and a rejection is turned into the same
    `SitemapParseError` that `etree.XMLSyntaxError` produced. The message text
    after the `Malformed XML:` prefix is the XML library's own wording, so the
    parity test pins the prefix and the error type, not lxml's sentence.
  * It has no namespace support. `removeNSPrefix` erases prefixes without
    looking at what they are bound to, but `root.findall("sm:url", SITEMAP_NS)`
    matches only children actually bound to `http://www.sitemaps.org/schemas/
    sitemap/0.9`. So the parse runs in `preserveOrder` mode and resolves the
    xmlns declarations in scope itself. This is not academic: a `<urlset>` that
    declares no namespace yields **zero** entries in Python, and the oracle
    below confirms it.

  **Three Python names are deliberately not ported**, all dead:
  `fetch_page_title`, `crawl_sitemap`'s `fetch_titles` flag (the only caller,
  `crawl_profile_sitemap`, passes `False`, and no pytest reaches either) and
  `MAX_URLS_PER_SITEMAP`, which is declared and never read.

  ```
  $ grep -rn "fetch_page_title\|fetch_titles\|MAX_URLS_PER_SITEMAP" api/src api/tests rules web/src
  api/src/worker.py:487:            entries = await crawl_sitemap(profile.website_url, fetch_titles=False)
  api/src/services/sitemap.py:17:MAX_URLS_PER_SITEMAP = 50000
  api/src/services/sitemap.py:169:async def fetch_page_title(url: str, client: httpx.AsyncClient) -> str | None:
  api/src/services/sitemap.py:190:    fetch_titles: bool = False,
  api/src/services/sitemap.py:217:        if fetch_titles:
  api/src/services/sitemap.py:220:                    entry.title = await fetch_page_title(entry.url, client)
  web/src/mastra/sitemap/index.ts:11: * `fetch_page_title` and `crawl_sitemap`'s `fetch_titles` flag (the one caller,
  web/src/mastra/sitemap/index.ts:13: * `MAX_URLS_PER_SITEMAP`, which is declared and never read.
  ```

  `api/tests` is in that search and returns nothing: the only reference outside
  `api/src` is this port's own header comment.

  **The oracle.** `api/scripts/export_sitemap_parity.py` runs the real Python
  service and writes `web/src/mastra/sitemap/data/sitemap-parity.json`. The
  pytest suite for this service mocks `httpx.AsyncClient`; this export does not.
  It stands up a local HTTP server, and each network case is a routing table
  plus one call against it, with the table exported verbatim so the Node server
  in the vitest file is driven by the same data rather than a hand-copied
  translation of it. Every URL is templated back to `{BASE}` so the two runs can
  use different ports. The seven XML fixtures are copied to
  `web/src/mastra/sitemap/data/fixtures/` so the oracle outlives `api/`.

  ```
  $ cd api && uv run python scripts/export_sitemap_parity.py
  local server on http://127.0.0.1:53360
    discover-from-robots-txt: 2 sitemap(s)
    discover-falls-back-to-sitemap-xml: 1 sitemap(s)
    discover-falls-back-to-sitemap-index-xml: 1 sitemap(s)
    discover-finds-nothing: 0 sitemap(s)
    discover-survives-robots-hangup: 1 sitemap(s)
    discover-from-path-keeps-origin: 1 sitemap(s)
    fetch-simple-sitemap: 10 entr(ies)
    fetch-index-recursively: 5 entr(ies)
    fetch-index-stops-at-max-depth: 0 entr(ies)
    fetch-missing-sitemap: 0 entr(ies)
    fetch-server-error: 0 entr(ies)
    fetch-malformed-sitemap: 0 entr(ies)
    fetch-gzipped-sitemap: 10 entr(ies)
    fetch-hangup: 0 entr(ies)
    crawl-full: 10 entr(ies)
    crawl-two-sitemaps-from-robots: 4 entr(ies)
    crawl-no-sitemaps: 0 entr(ies)
    crawl-empty-sitemap: 0 entr(ies)
  wrote web/src/mastra/sitemap/data/sitemap-parity.json: 16 parse cases, 8 robots cases, 18 scenarios; copied 7 fixtures
  ```

  Re-running the export produces a byte-identical file, so the port cannot be
  chasing a moving oracle:

  ```
  $ diff -q /tmp/parity-1.json web/src/mastra/sitemap/data/sitemap-parity.json && echo identical
  identical
  ```

  Two of those eighteen scenarios cover behaviour the pytest mocks never could:
  `discover-survives-robots-hangup` and `fetch-hangup` have the server close the
  socket without answering, and `fetch-gzipped-sitemap` serves gzip over HTTP.

  ```
  $ cd web && pnpm vitest run src/mastra/sitemap
   ✓ src/mastra/sitemap/sitemap.test.ts (42 tests) 41ms
   Test Files  1 passed (1)
        Tests  42 passed (42)
  ```

  **Negative controls.** Two mutations applied to the port and then reverted,
  to prove the oracle discriminates rather than agreeing by construction:

  | mutation | result |
  | --- | --- |
  | `inSitemapNs` always true (drop namespace resolution) | `no-namespace-urlset` and `wrong-namespace-urlset` fail |
  | `gunzipSync(content)` replaced by `content` | `gzipped-simple` fails |

  ```
  $ cd web && pnpm vitest run src/mastra/sitemap   # with both mutations applied
       × matches Python on gzipped-simple 2ms
       × matches Python on no-namespace-urlset 2ms
       × matches Python on wrong-namespace-urlset 0ms
  ```

  (the three failing lines out of the 42, the rest still passing.)

  Gates:

  ```
  $ cd web && pnpm tsc --noEmit
  (no output, exit 0)

  $ pnpm -C web lint
  > eslint
  (no output, exit 0)

  $ cd web && pnpm test
   Test Files  2 failed | 62 passed (64)
        Tests  9 failed | 999 passed | 7 skipped (1015)

  $ cd web && pnpm build
  ✓ Compiled successfully in 3.4s
  (exit 0)
  ```

  Spelled `cd web && pnpm ...` for the same reason as every gate above, recorded
  under item 0.1: `pnpm -C web tsc` fails with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "web" not found` on this pnpm.
  `pnpm -C web lint` and `pnpm -C web build` were both re-confirmed working here
  (exit 0), so the `-C` form does reach the `package.json` scripts; it is only
  the bare binaries like `tsc` that it cannot.

  The 9 failures are the same two files as the Phase 0 baseline
  (`PostDetail.test.tsx` and `image-preview.test.tsx`), still 9, still the
  ceiling. Passing went from 957 to 999, which is the 42 added here.

  ```
  $ cd api && uv run pytest -q     # .env sourced, TEST_DATABASE_URL on :5435
  125 failed, 236 passed, 25 errors in 14.09s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 127 files already formatted
  ```

  All three are the recorded Phase 0 baselines, with one number moved by one:
  `ruff format --check` counts 127 formatted files rather than 126, because the
  export script this item adds is the 127th. `export_sitemap_parity.py` is
  the one file this item adds to `api/`, and it is clean on both:

  ```
  $ cd api && uv run ruff check scripts/export_sitemap_parity.py
  All checks passed!

  $ cd api && uv run ruff format --check scripts/export_sitemap_parity.py
  1 file already formatted
  ```

  **Not covered by this item**, carried into 5.2c-ii: nothing persists yet. This
  module only fetches and parses, and it logs nothing, where Python logged a
  warning per unreachable sitemap and per parse failure. The crawl job is where
  those log lines belong.

## 5.2c-ii


  **Split.** The item carries two independent pieces of work: the job, and the
  scheduler that fires it. They are split into 5.2c-ii-1 (the job) and
  5.2c-ii-2 (the nightly check), and 5.2c-ii is checked when both are.

  **Both are done.** Evidence is under 5.2c-ii-1 and 5.2c-ii-2; this header
  carries none of its own.

## 5.2c-ii-1


  `web/src/mastra/steps/sitemap-crawl.ts` is the step,
  `web/src/mastra/workflows/sitemap-crawl.ts` the one-step workflow that wraps
  it, registered on the instance as `sitemapCrawl`. One step, because the Python
  job was one function; a workflow around it, because a run is the only thing
  the `web` service can hand to the worker, which is what 5.2c-iii needs.

  **The slug oracle.** The job derives `internal_links.slug` with
  `urlparse(entry.url).path.strip("/").split("/")[-1] if path else None`.
  `new URL()` cannot stand in for `urlparse` there: it throws on a relative or
  non-URL `<loc>`, which a malformed sitemap can carry and which `urlparse`
  returns as a path. `web/src/mastra/steps/data/crawl-slug-parity.json` is the
  oracle, 16 cases generated by running that exact expression on the `api/`
  interpreter (CPython 3.13.12), and both halves are asserted, the path as well
  as the slug. It pins three details that are easy to get wrong: percent
  escapes are not decoded (`Post%20One` stays), the fragment is split off
  before the query, and `https://example.com/blog//` yields `blog`, not the
  empty string.

  **Three deliberate deviations from the Python job**, all argued rather than
  assumed:

  1. *Batched upsert instead of a select-then-insert loop.* Python ran one
     `SELECT` and one insert-or-mutate per entry inside one transaction, which
     also meant a sitemap listing the same URL twice took the second entry's
     title only if it had one (SQLAlchemy autoflush made the pending insert
     visible to the next select). `foldEntries` reproduces that as
     "last truthy title wins" and the rows go out in chunks of 500 through
     `ON CONFLICT (profile_id, url) DO UPDATE`. Folding first is not an
     optimisation for its own sake: `ON CONFLICT DO UPDATE` refuses to touch
     the same row twice within one statement, so the duplicate had to be
     resolved before the write either way.
  2. *`coalesce(nullif(excluded.title, ''), internal_links.title)`* rather than
     `excluded.title`, which is `if entry.title: link.title = entry.title`
     verbatim. This matters more than it looks: `crawl_sitemap` never returns a
     title (nothing parses one out of a sitemap), so a naive conflict clause
     would null out every title the links router or the pipeline had written,
     on every nightly re-crawl. The negative control below is exactly that
     mistake.
  3. *A profile whose `website_url` is not a URL is `failed` here, and was
     `complete` in Python.* `urlparse` never raises, so Python built the base
     `://`, failed both requests, caught them inside `discover_sitemaps` and
     recorded a successful crawl of zero links; `new URL()` throws, so the port
     takes the `except` branch. Both write no links, and `website_url` has no
     validation on either stack (`ProfileCreate.website_url` is a bare `str`),
     so this is reachable by typing `example.com` into the profile form.
     `failed` is the more honest of the two statuses and is what the profiles
     page renders, so it is kept rather than papered over.

  Everything else is Python's behaviour unchanged: `crawl_status` goes to
  `crawling` in its own commit before the fetch; links and the terminal status
  commit together in one transaction; `source`, `post_id` and `keywords` are
  never touched on an existing row; `sitemap_urls` is never written (Python's
  `sitemap_urls_seen` was always empty, dead code); a missing profile logs and
  returns; and a crawl failure is *not* a step failure. The last one is load
  bearing on this transport rather than merely faithful: a thrown step is
  redelivered by the reclaim loop, so a site that is down would be re-fetched on
  every redelivery instead of once.

  ```
  $ npx vitest run src/mastra/workflows/sitemap-crawl.test.ts --reporter=verbose
   ✓ a crawl that finds links > reports every entry it fetched and one row per URL 2ms
   ✓ a crawl that finds links > writes one internal_links row per URL, with the Python-derived slug 2ms
   ✓ a crawl that finds links > stamps the rows the way the ARQ job stamped them 2ms
   ✓ a crawl that finds links > moves the profile to complete and stamps last_crawled_at 1ms
   ✓ a crawl that finds links > logs the two lines the Python job logged 0ms
   ✓ a second crawl over the same profile > adds no duplicate rows 1ms
   ✓ a second crawl over the same profile > keeps a title the sitemap does not carry, and everything else it does not own 1ms
   ✓ a second crawl over the same profile > refills a slug that was cleared 1ms
   ✓ a crawl that finds no sitemap > completes with nothing rather than failing 0ms
   ✓ a crawl that finds no sitemap > still marks the profile complete and crawled 2ms
   ✓ a crawl that finds no sitemap > writes no links 1ms
   ✓ a crawl that raises > ends the run successfully and reports the failure in its output 0ms
   ✓ a crawl that raises > marks the profile failed and leaves last_crawled_at alone 1ms
   ✓ a crawl that raises > logs the failure instead of printing a stack trace 0ms
   ✓ a crawl for a profile that is gone > reports it and does nothing else 0ms

   Test Files  1 passed (1)
        Tests  15 passed (15)
     Duration  7.57s
  ```

  Nothing in that file is mocked. The sitemap is served by a `node:http` server
  on a loopback port, the crawl runs on the evented engine through a real
  `RedisStreamsPubSub` (own key prefix, so no other test file's worker can take
  the run), and the rows are read back out of the real database.

  ```
  $ npx vitest run src/mastra/steps/sitemap-crawl.test.ts --reporter=verbose
   Test Files  1 passed (1)
        Tests  38 passed (38)
     Duration  573ms
  ```

  38 = 1 oracle-size guard + 16 path cases + 16 slug cases + 5 fold cases.

  **Negative controls.** Both mistakes the deviations above describe, made on
  purpose and reverted:

  ```
  # title: sql`excluded.title`   (the naive conflict clause)
  FAIL  a second crawl over the same profile > keeps a title the sitemap does not carry
  AssertionError: expected null to be 'Hand written title'
   Test Files  1 failed (1)
        Tests  1 failed | 14 passed (15)

  # urlPath = (url) => new URL(url).pathname
  TypeError: Invalid URL
   Test Files  1 failed (1)
        Tests  7 failed | 33 passed (40)
  ```

  **Two test-harness facts this item cost an hour to learn**, recorded so the
  next handler-plus-workflow item does not repeat them:

  * Importing `web/src/mastra/index.ts` into a file that also *starts a run*
    hangs every run in that file. Registering a workflow on a second `Mastra`
    rebinds it, so the run publishes onto the shared instance's topics while the
    only started worker is listening on the test instance's prefix. The first
    version of this file did exactly that and burned 5 x 60s of hook timeouts
    with no error message. The registration assertion now lives in
    `src/mastra/index.test.ts`, which already owns the shared instance.
  * A test server whose behaviour is switched by a module-level flag is not safe
    on this transport. The `no sitemap` case flipped the flag off, ran, and
    flipped it back; under full-suite load the run's step was redelivered by the
    reclaim loop after the flag was back on, and wrote links the case asserts
    are absent. Two servers, each with one fixed behaviour, removes the
    dependency on when a request arrives. (The crawl itself is idempotent under
    that redelivery, which is why only the flag-dependent assertion failed.)

  `no-next-imports.test.ts`'s package allowlist gains `fast-xml-parser`: the
  registered crawl workflow is what first pulls the sitemap parser into the
  entry point's import graph.

  ```
  $ npx tsc --noEmit                          # exit 0, no output
  $ pnpm -C web lint                          # exit 0, no output
  $ pnpm -C web build                         # exit 0, 15 routes
  $ pnpm -C web test
   Test Files  2 failed | 64 passed (66)
        Tests  9 failed | 1053 passed | 7 skipped (1069)
  ```

  Twice in a row, same numbers. The 9 are the baseline files
  (`PostDetail.test.tsx` 3, `image-preview.test.tsx` 6); passing goes 999 ->
  1053, which is the 53 added here (38 + 15) plus the registration assertion in
  `index.test.ts`. An intermediate run showed a tenth and eleventh failure:
  the `fast-xml-parser` allowlist, fixed here, and one flake in
  `scaffold-check.test.ts` ("expected [ 'workflow-start', ...(5) ] to include
  'workflow-step-start'") that has not recurred in the two runs since the
  registration assertion moved out of a fourth process that touched the shared
  bus. Logged in `todo.md` rather than claimed as fixed.

  `api/` is untouched by this item (`git status` lists no path under `api/`),
  and its gates are unmoved:

  ```
  $ cd api && uv run pytest -q     # .env sourced
  125 failed, 236 passed, 25 errors in 15.27s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 127 files already formatted
  ```

## 5.2c-ii-2


  **Decision: a `recrawl-check` workflow that carries the cron, not a schedule
  on `sitemapCrawl`.** A declared schedule carries one static `inputData`, and
  `sitemapCrawl` needs a different `profileId` per run, so the fan-out has to
  be a step that queries. `web/src/mastra/steps/recrawl-check.ts` is that step
  and `web/src/mastra/workflows/recrawl-check.ts` the one-step workflow that
  declares `schedule: { cron: "0 0 * * *", inputData: {} }`, registered on the
  instance as `recrawlCheck`.

  `startAsync()` is the `enqueue_job` equivalent: it publishes `workflow.start`
  and returns the run id without waiting, so one slow site cannot hold up the
  rest of the nightly sweep. The scheduler only runs where `startWorkers()` was
  called, which the `web` service never does, so the sweep fires in `worker`.

  **The declared schedule really fires against the installed version.** The
  ledger item asked for this to be confirmed rather than assumed. A probe
  workflow with a six-part per-second cron, registered on the test instance
  with `scheduler: { tickIntervalMs: 500 }`, executed its step 755ms after the
  workers started. `@mastra/core` is 1.61.0.

  **Parity oracle.** `api/scripts/export_recrawl_parity.py` copies the
  per-profile branch out of `check_recrawl_schedules` verbatim, runs it on the
  `api/` interpreter against a fixed reference `now`, and writes
  `web/src/mastra/steps/data/recrawl-due-parity.json`. 16 cases: each interval
  one second either side of its threshold, the never-crawled short circuit
  (including with an interval the job does not recognise and with an empty
  one), an unrecognised interval long overdue, and three `last_crawled_at`
  values in the future.

  ```
  $ cd api && uv run python scripts/export_recrawl_parity.py
  wrote 16 cases to /Users/cody/.../web/src/mastra/steps/data/recrawl-due-parity.json
  ```

  **Three behaviours a rewrite would have lost**, all pinned by tests:

  1. `if not profile.last_crawled_at` short-circuits *before* the interval is
     read, so a profile with an interval the job does not recognise and no
     `last_crawled_at` is still crawled. The port keeps that ordering.
  2. `crawl_status != "crawling"` renders `crawl_status <> 'crawling'`, which
     is NULL and therefore false for a NULL `crawl_status`. A profile whose
     status was never set is skipped by both stacks. `ne()` in drizzle renders
     the same SQL, so this is faithful by default; the negative control below
     shows what including NULL would do.
  3. `recrawl_interval` is an unconstrained `varchar(20)`, so the interval
     table is a `Map`, not an object literal. An object literal would resolve
     `constructor` to a function and compare it silently.

  `Math.floor` matches `timedelta.days` (both floor toward negative infinity).
  The two only diverge for a negative delta and every threshold here is
  positive, so both answer "not due" for a `last_crawled_at` in the future.
  Confirmed: swapping `Math.floor` for `Math.trunc` leaves all 19 pure tests
  passing. It stays `Math.floor` for faithfulness, not for an observable
  difference, and the oracle covers the future-dated cases in case a threshold
  ever changes.

  **Test isolation deviation.** The test's `PostgresStore` uses
  `schemaName: "mastra_test_recrawl"` rather than the shared `public` schema,
  and drops it in `afterAll`. `mastra_schedules` is one table for the whole
  database, and a scheduler refuses to fire a schedule whose target workflow it
  does not know, deleting the row after a few consecutive misses. Registering a
  scheduled workflow on the production instance means every test file that
  calls `mastra.startWorkers()` now runs a scheduler over that shared table, so
  it either steals this file's fires through the compare-and-swap or deletes
  the probe row. Measured: on `public` the per-second probe never fired inside
  30s when the whole `src/mastra` suite ran, and fires in about a second on its
  own schema.

  **Installed-types discrepancy.** `createWorkflow` from
  `@mastra/core/workflows/evented` returns `EventedWorkflow`, which declares
  `getScheduleConfigs()`, but `.then().commit()` narrows back to the base
  `Workflow`, which does not. The method exists at runtime (it is what the
  scheduler reads at registration); only the chained type loses it, so
  `index.test.ts` asserts on it through a narrow cast with that noted.

  ```
  $ cd web && ./node_modules/.bin/vitest run --reporter=verbose \
      src/mastra/steps/recrawl-check.test.ts \
      src/mastra/workflows/recrawl-check.test.ts

   ✓ src/mastra/steps/recrawl-check.test.ts > the due decision > has an oracle covering every branch of the Python job 0ms
   ✓ ... > matches check_recrawl_schedules for 'never crawled, weekly' 0ms
   ✓ ... > matches check_recrawl_schedules for 'never crawled, unrecognised interval' 0ms
   ✓ ... > matches check_recrawl_schedules for 'never crawled, empty interval' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, one second short of 7 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, exactly 7 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, 30 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'biweekly, 13 days 23h' 0ms
   ✓ ... > matches check_recrawl_schedules for 'biweekly, exactly 14 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'biweekly, 7 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'monthly, 29 days 23h59m' 0ms
   ✓ ... > matches check_recrawl_schedules for 'monthly, exactly 30 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'monthly, 14 days' 0ms
   ✓ ... > matches check_recrawl_schedules for 'unrecognised interval, long overdue' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, crawled one second in the fut…' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, crawled 400 days in the future' 0ms
   ✓ ... > matches check_recrawl_schedules for 'weekly, crawled at exactly now' 0ms
   ✓ ... > the due decision > reads only its own intervals, not Object.prototype 0ms
   ✓ ... > the due decision > keeps the three intervals the job understood 0ms
   ✓ src/mastra/workflows/recrawl-check.test.ts > the declared cron > persists a schedule row for the re-crawl check 2ms
   ✓ ... > the declared cron > keeps ARQ's cron(hour=0, minute=0) as midnight daily 0ms
   ✓ ... > the declared cron > actually fires a scheduled workflow against the installed version 755ms
   ✓ ... > the profile scan > starts a crawl for the due profile and the never-crawled one only 0ms
   ✓ ... > the profile scan > gives every started run a run id 0ms
   ✓ ... > the profile scan > considers only profiles with an interval and a status that is not crawling 0ms
   ✓ ... > the profile scan > logs the line ARQ logged 0ms
   ✓ ... > the profile scan > leaves the excluded profiles untouched 3ms
   ✓ ... > the profile scan > runs the crawls it started through to completion 1ms
   ✓ ... > the profile scan > advances last_crawled_at past the due threshold 1ms

   Test Files  2 passed (2)
        Tests  29 passed (29)
     Duration  3.24s
  ```

  **Negative controls.** Three, each reverted afterwards.

  Dropping `schedule: { cron: RECRAWL_CHECK_CRON, inputData: {} }` from the
  workflow:

  ```
   FAIL  src/mastra/workflows/recrawl-check.test.ts > the declared cron > persists a schedule row for the re-crawl check
  AssertionError: expected [] to have a length of 1 but got +0
   Tests  1 failed | 9 passed (10)
  ```

  Widening the status filter to `or(isNull(crawlStatus), ne(crawlStatus, "crawling"))`,
  which is the mistake that would silently re-crawl every profile whose status
  was never set:

  ```
   × starts a crawl for the due profile and the never-crawled one only
   × leaves the excluded profiles untouched
   Tests  2 failed | 8 passed (10)
  ```

  Changing the due comparison from `>= days` to `> days`:

  ```
   FAIL  src/mastra/steps/recrawl-check.test.ts > the due decision > matches check_recrawl_schedules for 'monthly, exactly 30 days'
  AssertionError: expected false to be true
   Tests  3 failed | 16 passed (19)
  ```

  **Gates.**

  ```
  $ cd web && ./node_modules/.bin/tsc --noEmit
  (no output, exit 0)

  $ pnpm -C web lint
  (no output, exit 0)

  $ pnpm -C web test
  Test Files  2 failed | 66 passed (68)
       Tests  9 failed | 1083 passed | 7 skipped (1099)
  # the recorded 9-failure baseline: 6 in image-preview.test.tsx and 3 in
  # PostDetail.test.tsx, all pre-existing

  $ pnpm -C web build
  ✓ Compiled successfully
  ```

  `api/` is unchanged except for the new export script, which is why the format
  check now reports one more already-formatted file (127 -> 128):

  ```
  $ cd api && uv run pytest -q     # .env sourced
  125 failed, 236 passed, 25 errors in 15.31s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 128 files already formatted
  ```

  **Side effect worth knowing about.** Registration is what schedules: the
  first `startWorkers()` on the production instance writes the row, so the dev
  database now holds one, which is the behaviour a deploy will have:

  ```
  $ psql "$DATABASE_URL_SYNC" -c "select id, cron, status, target from mastra_schedules"
          id        |   cron    | status |                                target
  ------------------+-----------+--------+----------------------------------------------------------------------
   wf_recrawl-check | 0 0 * * * | active | {"type": "workflow", "inputData": {}, "workflowId": "recrawl-check"}
  ```

  **Not covered by this item.** The scheduler is only started by
  `startWorkers()`, so the nightly sweep is not exercised by any process this
  repo boots outside a test until Phase 7 runs the `worker` service under
  `docker-compose`. The end-to-end evidence that the cron reaches a real worker
  in a real deployment belongs to 7.6.

## 5.2c-iii


  Both callers of ARQ's `enqueue_job("crawl_profile_sitemap", str(profile.id))`
  now go through `web/src/mastra/start-crawl.ts`, which creates a `sitemapCrawl`
  run and calls `startAsync()`. That publishes `workflow.start` onto Redis
  Streams and returns without waiting, so the crawl executes in the `worker`
  process exactly as ARQ's job did, and a slow site never holds a Next.js
  request open.

  New files:

  - `web/src/mastra/start-crawl.ts`: the enqueue, in the Mastra layer rather
    than in a route handler. The nightly sweep deliberately does not use it:
    `recrawl-check` reaches the workflow through the `mastra` handed to its
    `execute`, so the runs it starts belong to the instance it is running on.
  - `web/src/app/api/profiles/[id]/crawl/route.ts`: the 202 endpoint.
  - `web/src/app/api/profiles/params.ts`: the uuid path-parameter 422 and the
    `Profile not found` 404, lifted out of `[id]/route.ts` so the crawl handler
    reuses them instead of copying them.

  **Order of operations, kept verbatim.** Python resolved the profile, set
  `crawl_status = "crawling"` and committed, *then* enqueued. The port collapses
  the resolve and the flip into one `UPDATE ... WHERE id = $1 AND user_id = $2
  RETURNING id`, which is still one unit of work and still writes `crawling`
  before anything is published: the profiles page polls `crawl_status`, so a
  started crawl must never be readable at its old status. Zero rows returned is
  the 404, which keeps another user's profile indistinguishable from a missing
  one and, because the `WHERE` carries the owner, leaves that owner's row
  untouched.

  **The failure branch.** Python's `except Exception as e` rolled the status
  forward to `"failed"`, committed, and raised
  `HTTPException(500, f"Failed to enqueue crawl: {e}")`. Reproduced, message
  prefix included.

  **Auto-enqueue on create.** `POST /api/profiles` ended with the same
  `enqueue_job` wrapped in a bare `except: pass`. That is preserved rather than
  tidied away: the profile row is already written, so reporting anything but the
  201 would leave the client believing the create failed. One deliberate
  addition: the swallowed error is logged through the Mastra logger, because
  Python's version made a queue outage completely invisible.

  **Two small deviations, both argued.**

  1. The 202 body echoes the stored id rather than the raw path segment.
     `str(profile_id)` in Python was the *parsed* `uuid.UUID`, so it came back
     lowercase however the client cased it; the stored id is that same canonical
     form.
  2. `updated_at` is stamped on both writes, because `TimestampMixin.onupdate`
     fired on each of Python's two commits.

  Nothing in `web/src/lib/api.ts` changed: `profiles.crawl()` already declared
  `{ status: string }`, and the response is a superset of that.

  **Tests.** `web/src/app/api/profiles/[id]/crawl/route.test.ts`, 11 tests
  against the real database, real BetterAuth sessions and the real Redis Streams
  bus. "The crawl was enqueued" is asserted from the transport, not from a spy:
  an independent `RedisStreamsPubSub` subscribes to the `workflows` topic with
  no `group` (the library then mints a `__fanout-<uuid>` group, so it can never
  take an event away from a worker) and the test reads the `workflow.start` back
  and matches on `data.prevResult.output.profileId`. No worker runs in this
  file, so nothing executes the run; the crawl itself is covered end to end by
  `src/mastra/workflows/sitemap-crawl.test.ts` under 5.2c-ii-1.

  The one branch that cannot be driven from a real boundary is Python's
  `except`, so `startSitemapCrawl` is wrapped by a `vi.mock` that delegates to
  the real implementation unless a test sets a fault message. Every other test
  in the file goes through the real enqueue.

  ```
  $ pnpm -C web exec vitest run 'src/app/api/profiles/[id]/crawl/route.test.ts' \
      src/app/api/profiles/route.test.ts --reporter=verbose
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > 401s without a session 7ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > 422s on a malformed profile id, the way the uuid path parameter did 11ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > 404s for a profile that does not exist 3ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > 404s for another user's profile and leaves its status alone 3ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > answers 202 with the Python body and flips the row to crawling 15ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > publishes a sitemap-crawl workflow.start carrying the profile id 30ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > re-crawls a profile that already completed 5ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > rolls the status to failed and 500s when the enqueue raises 3ms
   ✓ .../crawl/route.test.ts > POST /api/profiles/{id}/crawl > bumps updated_at, as the ORM commit did 4ms
   ✓ .../crawl/route.test.ts > POST /api/profiles auto-enqueue > starts a crawl for the profile it just created 5ms
   ✓ .../crawl/route.test.ts > POST /api/profiles auto-enqueue > still returns the 201 when the enqueue raises, and logs why 4ms

   Test Files  2 passed (2)
        Tests  53 passed (53)
     Duration  2.01s
  ```

  (The 42 pre-existing `route.test.ts` cases are elided above; all 53 passed.
  The full verbose listing is reproducible with the command shown.)

  **Negative control.** Replacing `await startSitemapCrawl(id)` in the handler
  with `void startSitemapCrawl` (so the route still typechecks but enqueues
  nothing) fails exactly the three tests that depend on the enqueue:

  ```
  $ pnpm -C web exec vitest run 'src/app/api/profiles/[id]/crawl/route.test.ts'
   Test Files  1 failed (1)
        Tests  3 failed | 8 passed (11)
  # publishes a sitemap-crawl workflow.start ... : no workflow.start within 15000ms
  # re-crawls a profile that already completed  : no workflow.start within 15000ms
  # rolls the status to failed and 500s ...     : expected 500, got 202
  ```

  **Fixture URLs changed in `route.test.ts`.** Because `POST /api/profiles` now
  starts a real run, the 14 profiles that file creates would each publish a
  crawl for a plausible-looking domain (`https://testblog.com` and friends).
  Nothing in that file runs a worker, but `crossprocess-events.test.ts`,
  `scaffold-check.test.ts` and `reclaim-duplication.test.ts` all call
  `startWorkers()` on the shared instance and can consume those events while
  running in parallel. A unit test must not be able to cause a crawl of
  somebody else's website, so every fixture `website_url` now points at
  `http://127.0.0.1:9/...`, the discard port on loopback, which refuses
  immediately. Every assertion in that file compares against the echoed value,
  so none of them changed meaning.

  **Pre-existing flake, confirmed not caused by this item.**
  `scaffold-check.test.ts` intermittently fails its whole suite with
  `Hook timed out in 60000ms` in the full run (already logged in `todo.md` as
  `[investigate]` in the 5.2c-ii-1 iteration). It was suspected here because
  this item is what puts extra `workflow.start` traffic on the shared topic, so
  it was measured: with this iteration's work stashed, the suite at HEAD
  reproduced it on the first run.

  ```
  # working tree stashed, so this is HEAD without item 5.2c-iii
  $ pnpm -C web test
   FAIL  src/mastra/workflows/scaffold-check.test.ts [ ... ]
  Error: Hook timed out in 60000ms.
   Test Files  3 failed | 65 passed (68)
        Tests  9 failed | 1078 passed | 12 skipped (1099)
  ```

  The `mastra-orchestration` consumer group on `mastra:topic:workflows` reports
  `lag 0` after a full suite run, so a backlog of crawl events is not the
  mechanism either.

  ```
  $ docker compose exec -T redis redis-cli --no-raw XINFO GROUPS mastra:topic:workflows
     2) "mastra-orchestration"
     4) (integer) 243        # consumers
     6) (integer) 2          # pending
    10) (integer) 1690       # entries-read
    12) (integer) 0          # lag
  ```

  **Not covered by this item.** That a crawl started by the route reaches a
  worker running as a separate service, rather than one started inside a test
  process, is 7.6.

  Frontend gates:

  ```
  $ pnpm -C web exec tsc --noEmit
  $ echo $?
  0

  $ pnpm -C web lint
  $ echo $?
  0

  $ pnpm -C web test
   Test Files  2 failed | 67 passed (69)
        Tests  9 failed | 1094 passed | 7 skipped (1110)
  # the recorded 9-failure baseline: 6 in image-preview.test.tsx and 3 in
  # PostDetail.test.tsx, all pre-existing. Passing count 1083 -> 1094 (+11).

  $ pnpm -C web build
  ✓ Compiled successfully in 3.5s
  ├ ƒ /api/profiles
  ├ ƒ /api/profiles/[id]
  ├ ƒ /api/profiles/[id]/crawl
  $ echo $?
  0
  ```

  `api/` is untouched by this item, and its gates are unchanged:

  ```
  $ cd api && uv run pytest -q     # .env sourced
  125 failed, 236 passed, 25 errors in 13.72s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 128 files already formatted
  ```

## 5.3a


    Ported to `web/src/app/api/posts/route.ts` and
    `web/src/app/api/posts/[id]/route.ts`, with `serialize.ts` (the `PostRead` wire
    shape), `params.ts` (the uuid path parameter and the 404) and `query.ts` (the list
    query string and its 422s).

    **The `PostRead` field set was read off the live schema class, not from
    `web/src/lib/api.ts`, and the two disagreed.** `api.ts` declared `thread_id` and
    omitted `execution_logs`; `PostRead` has never declared `thread_id` (Alembic 005
    dropped the column) and has always declared `execution_logs`. `api.ts` and
    `web/src/test/fixtures.ts` are corrected in this iteration, which is the whole
    blast radius: `grep -rn "thread_id\|execution_logs" web/src/` found no other reader.

    ```
    $ cd api && PYTHONPATH=. uv run python /tmp/probe_postread_b_5_3a.py
    FIELD ORDER: ['slug', 'topic', 'profile_id', 'target_audience', 'niche', 'intent',
     'word_count', 'tone', 'output_format', 'website_url', 'related_keywords',
     'competitor_urls', 'image_style', 'image_brand_colors', 'image_exclude',
     'brand_voice', 'avoid', 'required_mentions', 'article_type', 'additional_info',
     'stage_settings', 'id', 'current_stage', 'stage_status', 'stage_logs',
     'execution_logs', 'priority', 'research_content', 'outline_content',
     'draft_content', 'final_md_content', 'final_html_content', 'image_manifest',
     'ready_content', 'wp_category_id', 'wp_author_id', 'wp_post_id', 'wp_post_url',
     'wp_publish_status', 'nextjs_publish_status', 'nextjs_published_at', 'created_at',
     'updated_at', 'completed_at']
    ```

    That list is asserted verbatim by the "emits exactly PostRead's field set" test.

    **Deviation 1: a null non-optional column returns the pydantic default instead of a
    500.** Pydantic does not substitute a declared default for an attribute that is
    present and `None`; it raises, and FastAPI turned that into a 500. Probed against the
    real `PostRead`, with every attribute set to `None`:

    ```
    $ cd api && PYTHONPATH=. uv run python /tmp/probe_postread_5_3a.py
    RAISED ValidationError
    13 validation errors for PostRead
    word_count
      Input should be a valid integer [type=int_type, input_value=None, input_type=NoneType]
    tone
      Input should be a valid string [type=string_type, input_value=None, input_type=NoneType]
    output_format
      Input should be a valid string [type=string_type, input_value=None, input_type=NoneType]
    related_keywords
      Input should be a valid list [type=list_type, input_value=None, input_type=NoneType]
    ...
    priority
      Input should be a valid integer [type=int_type, input_value=None, input_type=NoneType]
    ```

    Every one of those columns carries a server default, so only a row written with an
    explicit null reaches the branch. `serializePost()` returns the declared default
    (`word_count` 2000, `output_format` `"markdown"`, `stage_settings` the six-key all
    `"auto"` map, `current_stage` `"pending"`, and so on) rather than reproducing a 500.
    `created_at`/`updated_at` are the exception: pydantic required them and there is no
    default to invent, so the null carries through.

    Note the `output_format` disagreement is the same one recorded under 5.2b for
    profiles: `PostBase.output_format` is `"markdown"` while the column's server default
    is `"both"`. The pydantic value is what the dashboard saw.

    **Deviation 2: sort field names that made SQLAlchemy raise now take the fallback.**
    `getattr(Post, sort, Post.created_at)` accepted the 44 mapped column names and fell
    back to `created_at` for anything unmapped, but a few non-column attribute names
    raised inside SQLAlchemy and surfaced as a 500:

    ```
    $ cd api && PYTHONPATH=. uv run python /tmp/probe_sort_5_3a.py
    topic -> OK FROM posts ORDER BY posts.topic DESC
    metadata -> RAISES AttributeError 'MetaData' object has no attribute 'desc'
    profile -> RAISES NotImplementedError <function desc_op at 0x1021340e0>
    bogus -> OK FROM posts ORDER BY posts.created_at DESC
    registry -> RAISES AttributeError 'registry' object has no attribute 'desc'
    __init__ -> RAISES AttributeError 'function' object has no attribute 'desc'
    ```

    `SORT_COLUMNS` in `query.ts` is exactly those 44 column names; everything else,
    including `metadata` and `profile`, takes the `created_at` fallback. That removes an
    error path rather than adding one.

    **Deviation 3: timestamps lose sub-millisecond precision.** Pydantic 2.12 renders an
    aware datetime with a `Z` suffix and trims trailing zeros off the fraction, dropping
    it entirely when zero. `toPydanticIso()` reproduces that format, and the test pins it
    against values pasted from `jsonable_encoder`:

    ```
    "nextjs_published_at": "2026-08-22T12:34:56.789012Z",
    "updated_at": "2026-08-22T12:34:56Z",
    ```

    The microseconds themselves cannot survive: `pg` parses a Postgres timestamp into a
    JS `Date`, which has millisecond resolution, so `...789012Z` reads back as
    `...789Z`. Nothing in the dashboard does more than hand these strings to
    `new Date()`. `web/src/app/api/profiles/serialize.ts` uses a plain `toISOString()`
    and so still emits `.000Z` where pydantic emitted no fraction; logged in `todo.md`
    rather than changed here.

    **Query-string 422s** were probed against a FastAPI app declaring the same `Query()`
    parameters and are reproduced byte for byte apart from `uuid_parsing`'s `ctx.error`,
    which comes from the Rust uuid crate's parser:

    ```
    $ cd api && PYTHONPATH=. uv run python /tmp/probe_query_5_3a.py
    page=0 -> 422 {"detail": [{"type": "greater_than_equal", "loc": ["query", "page"], "msg": "Input should be greater than or equal to 1", "input": "0", "ctx": {"ge": 1}}]}
    per_page=201 -> 422 {"detail": [{"type": "less_than_equal", "loc": ["query", "per_page"], "msg": "Input should be less than or equal to 200", "input": "201", "ctx": {"le": 200}}]}
    per_page=0 -> 422 {"detail": [{"type": "greater_than_equal", "loc": ["query", "per_page"], "msg": "Input should be greater than or equal to 1", "input": "0", "ctx": {"ge": 1}}]}
    page=abc -> 422 {"detail": [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "abc"}]}
    page=1.5 -> 422 {"detail": [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "1.5"}]}
    profile_id=nope -> 422 {"detail": [{"type": "uuid_parsing", "loc": ["query", "profile_id"], "msg": "Input should be a valid UUID, invalid character: ...", "input": "nope", "ctx": {...}}]}
    page= -> 422 {"detail": [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": ""}]}
    per_page=200&page=2 -> 200 {"ok": true}
    ```

    **Multi-tenancy.** Both handlers reproduce `_get_user_post()`: `posts` is joined to
    `website_profiles` and filtered on `website_profiles.user_id`, so another user's post
    is the same `{"detail": "Post not found"}` 404 as a missing one, and a post whose
    `profile_id` is null is invisible to every user. That exclusion follows from the
    `user_id` predicate rather than the join strategy (an unowned row matches no user);
    swapping `innerJoin` for `leftJoin` in a negative control changed nothing, so the
    join is kept inner only to mirror the original.

    27 tests, against the real database and real BetterAuth sessions:

    ```
    $ cd web && npx vitest run src/app/api/posts/route.test.ts   # repo .env sourced
     ✓ src/app/api/posts/route.test.ts (27 tests) 137ms
       ✓ GET /api/posts > rejects an unauthenticated request the way get_current_user did
       ✓ GET /api/posts > returns only posts whose profile belongs to the caller
       ✓ GET /api/posts > hides a post with no profile, which no user_id filter can match
       ✓ GET /api/posts > orders by created_at descending by default
       ✓ GET /api/posts > honours sort and order
       ✓ GET /api/posts > falls back to created_at for an unknown sort field
       ✓ GET /api/posts > filters on current_stage through either status or stage, status winning
       ✓ GET /api/posts > filters by profile_id
       ✓ GET /api/posts > searches topic and slug case-insensitively
       ✓ GET /api/posts > paginates with page and per_page
       ✓ GET /api/posts > answers ?page=0 with FastAPI's 422 body
       ✓ GET /api/posts > answers ?per_page=0 with FastAPI's 422 body
       ✓ GET /api/posts > answers ?per_page=201 with FastAPI's 422 body
       ✓ GET /api/posts > answers ?page=abc with FastAPI's 422 body
       ✓ GET /api/posts > answers ?page=1.5 with FastAPI's 422 body
       ✓ GET /api/posts > answers ?page= with FastAPI's 422 body
       ✓ GET /api/posts > reports every bad query parameter in one 422, as FastAPI did
       ✓ GET /api/posts > rejects a malformed profile_id with a uuid_parsing 422
       ✓ GET /api/posts > accepts per_page at its bounds
       ✓ GET /api/posts/{post_id} > rejects an unauthenticated request
       ✓ GET /api/posts/{post_id} > returns the caller's post
       ✓ GET /api/posts/{post_id} > answers another user's post with the same 404 as a missing one
       ✓ GET /api/posts/{post_id} > rejects a malformed id with a 422 rather than letting Postgres raise
       ✓ PostRead serialization > emits exactly PostRead's field set, in PostRead's order
       ✓ PostRead serialization > substitutes PostRead's declared default for a null non-optional column
       ✓ PostRead serialization > formats timestamps the way pydantic 2.12 does
       ✓ PostRead serialization > carries a stored image_manifest and stage_status through unchanged

     Test Files  1 passed (1)
          Tests  27 passed (27)
    ```

    Negative controls. Flipping the `status || stage` precedence:

    ```
     × filters on current_stage through either status or stage, status winning
    ```

    Breaking the timestamp formatter and pointing `output_format`'s fallback at the
    column default instead of the pydantic one:

    ```
     × substitutes PostRead's declared default for a null non-optional column
     × formats timestamps the way pydantic 2.12 does
          Tests  2 failed | 25 passed (27)
    ```

    Frontend gates:

    ```
    $ cd web && npx tsc --noEmit
    $ echo $?
    0

    $ pnpm -C web lint
    > eslint
    $ echo $?
    0

    $ pnpm -C web test
     Test Files  2 failed | 68 passed (70)
          Tests  9 failed | 1121 passed | 7 skipped (1137)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx, all pre-existing. Passing count 1094 -> 1121 (+27).

    $ pnpm -C web build
    ├ ƒ /api/posts
    ├ ƒ /api/posts/[id]
    $ echo $?
    0
    ```

    `api/` is untouched by this item, and its gates are unchanged:

    ```
    $ cd api && uv run pytest -q     # .env sourced
    125 failed, 236 passed, 25 errors in 13.75s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 128 files already formatted
    ```

## 5.3b-i


      Ported to the `POST` handler in `web/src/app/api/posts/route.ts`, with
      `posts/validation.ts` (the `PostCreate` port and the column mapping),
      `posts/prefill.ts` (the profile fold) and `mastra/start-pipeline.ts` (the
      run start). The 422 machinery and pydantic's lax coercions moved out of
      `profiles/validation.ts` into `web/src/app/api/pydantic.ts`, which both
      routers now share; `profiles/validation.ts` re-exports what its handlers
      import, so no call site changed.

      **The prefill rule is not "fill in what the client omitted".** By the time
      `create_post` runs the fold, the body has already been through
      `model_dump()`, so an omitted field and a field the client sent holding the
      schema's own default value are indistinguishable and both lose to the
      profile. `word_count: 2000` from the new-post form is replaced by the
      profile's word count; `word_count: 0` is not. An explicitly empty
      `related_keywords` inherits the profile's keywords. The two `wp_*` fields
      use the other rule, filling only when the body left them null.

      The oracle is generated by driving the real `create_post` coroutine on the
      Python interpreter with a stubbed session, request and queue, so it cannot
      drift from the endpoint's own prefill block:

      ```
      $ cd api && PYTHONPATH=. uv run python scripts/export_post_create_parity.py
      wrote .../web/src/app/api/posts/data/create-parity.json (10 cases)
      ```

      Three deliberate deviations, each argued rather than assumed:

      1. **A failed run start returns the 201, not a 500.** Python let the
         `enqueue_job` exception escape, so an unreachable queue reported a
         create that had in fact committed. The row is written either way, so
         the 201 is the honest answer; the failure is logged and asserted.
      2. **`uuid_parsing`'s message drops pydantic's `ctx.error` tail**, which
         comes from the Rust uuid crate's parser. This is the same choice
         `posts/params.ts` already made for the path parameter.
      3. **`stage_settings` widens to null after the prefill** (`PostWriteInput`),
         because Python copies `profile.default_stage_settings` over the pydantic
         default with no null guard. A profile that has none clears the post's.

      ```
      $ cd web && npx vitest run src/app/api/posts/create.test.ts --reporter=verbose
       ✓ create_post parity > was generated against the endpoint this port replaces
       ✓ create_post parity > carries the same schema defaults pydantic dumped
       ✓ create_post parity > case 1: no profile: pydantic defaults reach the row untouched
       ✓ create_post parity > case 2: no profile: an explicit body reaches the row untouched
       ✓ create_post parity > case 3: profile fills every unset field
       ✓ create_post parity > case 4: an explicit body beats the profile everywhere
       ✓ create_post parity > case 5: a body holding the schema defaults loses to the profile
       ✓ create_post parity > case 6: a profile of nulls leaves the pydantic defaults in place
       ✓ create_post parity > case 7: a null default_stage_settings is copied over the pydantic default
       ✓ create_post parity > case 8: wp ids fall back to the profile only when the body left them null
       ✓ create_post parity > case 9: a zero word_count is not the default, so it survives
       ✓ create_post parity > case 10: an empty-string tone is not the default, so it survives
       ✓ POST /api/posts > rejects an unauthenticated request the way get_current_user did
       ✓ POST /api/posts > answers a body that is not JSON with FastAPI's json_invalid 422
       ✓ POST /api/posts > answers a missing required field with pydantic's missing 422
       ✓ POST /api/posts > answers an unparseable word_count with pydantic's int_parsing 422
       ✓ POST /api/posts > separates pydantic's two uuid failures for profile_id
       ✓ POST /api/posts > coerces an integral string to an int the way pydantic's lax mode does
       ✓ POST /api/posts > writes the pydantic defaults, not the column defaults, and stamps the first stage
       ✓ POST /api/posts > fills unset fields from the caller's profile and persists them
       ✓ POST /api/posts > lets a body that differs from the schema default beat the profile
       ✓ POST /api/posts > does not read another user's profile, and writes no post when it refuses
       ✓ POST /api/posts > starts the pipeline on the Redis Streams bus
       ✓ POST /api/posts > still returns the 201 when the run cannot be started
       ✓ POST /api/posts > returns a post the ported read endpoint then serves identically

       Test Files  1 passed (1)
            Tests  25 passed (25)
      ```

      The run start is asserted from the transport, not from a spy: an
      independent `RedisStreamsPubSub` fan-out subscription reads the
      `workflow.start` for `pipeline` back off Redis. Fixture profiles gate
      `research` at "review" on purpose. No worker runs in this file, but other
      test files call `startWorkers()` on the shared Mastra instance, and a run
      they picked up would otherwise reach a provider; a gated run suspends
      before it spends anything. The one body that leaves `stage_settings` at the
      all-"auto" default has no gate to stop it, so that single test is the only
      one whose run start is diverted.

      Negative controls. Dropping the default-equality half of the prefill
      condition, so only a null is filled:

      ```
       × case 3: profile fills every unset field
       × case 5: a body holding the schema defaults loses to the profile
       × case 7: a null default_stage_settings is copied over the pydantic default
       × case 8: wp ids fall back to the profile only when the body left them null
       × case 9: a zero word_count is not the default, so it survives
       × case 10: an empty-string tone is not the default, so it survives
       × POST /api/posts > fills unset fields from the caller's profile and persists them
            Tests  7 failed | 18 passed (25)
      ```

      Guarding the `stage_settings` copy against a null profile value:

      ```
       × case 6: a profile of nulls leaves the pydantic defaults in place
       × case 7: a null default_stage_settings is copied over the pydantic default
            Tests  2 failed | 23 passed (25)
      ```

      Frontend gates:

      ```
      $ cd web && npx tsc --noEmit
      $ echo $?
      0

      $ pnpm -C web lint
      > eslint
      lint exit=0

      $ pnpm -C web test
       Test Files  2 failed | 69 passed (71)
            Tests  9 failed | 1146 passed | 7 skipped (1162)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx, all pre-existing. Passing count 1121 -> 1146 (+25).

      $ pnpm -C web build
      ├ ƒ /api/posts
      ├ ƒ /api/posts/[id]
      build exit=0
      ```

      `api/` gains only the export script, and its gates are unchanged:

      ```
      $ cd api && uv run pytest -q     # .env sourced
      125 failed, 236 passed, 25 errors in 15.07s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 129 files already formatted
      ```

## 5.3b-ii


      Both ported into `web/src/app/api/posts/[id]/route.ts`, alongside the `GET`
      from 5.3a. `PostUpdate` and its column map live in
      `web/src/app/api/posts/validation.ts` next to `PostCreate`; the 422 bodies
      come from the shared `web/src/app/api/pydantic.ts` unchanged, so this item
      added no new error-shape code.

      **`PostUpdate` is not `PostCreate` partialised.** It drops `slug` and
      `profile_id`, so a patch can neither rename a post nor move it to another
      user's profile, and it adds the six stage content columns, which is how the
      editor on `posts/[id]` saves. Every one of its 27 fields is `X | None =
      None`, so `null` is legal for the list and dict fields too, where the same
      fields on create are non-nullable with a container default. Read off the
      real model rather than from `web/src/lib/api.ts`, which (as in 5.3a) was
      wrong: its `PostUpdate` omitted `article_type`, `additional_info`,
      `wp_category_id` and `wp_author_id`. Those four are added in this
      iteration; nothing else in `api.ts` changed and no caller sent them.

      ```
      $ cd api && PYTHONPATH=. uv run python /tmp/probe_postupdate_5_3b_ii.py
      == FIELDS ==
      topic: str | None default=None
      target_audience: str | None default=None
      niche: str | None default=None
      intent: str | None default=None
      word_count: int | None default=None
      tone: str | None default=None
      output_format: str | None default=None
      website_url: str | None default=None
      related_keywords: list[str] | None default=None
      competitor_urls: list[str] | None default=None
      image_style: str | None default=None
      image_brand_colors: list[str] | None default=None
      image_exclude: list[str] | None default=None
      brand_voice: str | None default=None
      avoid: str | None default=None
      required_mentions: str | None default=None
      article_type: str | None default=None
      additional_info: str | None default=None
      stage_settings: dict | None default=None
      wp_category_id: int | None default=None
      wp_author_id: int | None default=None
      research_content: str | None default=None
      outline_content: str | None default=None
      draft_content: str | None default=None
      final_md_content: str | None default=None
      final_html_content: str | None default=None
      ready_content: str | None default=None

      == EXCLUDE_UNSET ==
      dump: {'topic': 't', 'niche': None}
      full keys: 27

      == 422 SHAPES ==
      {"word_count": "abc"} -> [{"type": "int_parsing", "loc": ["word_count"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "abc", ...}]
      {"word_count": [1]} -> [{"type": "int_type", "loc": ["word_count"], "msg": "Input should be a valid integer", "input": [1], ...}]
      {"word_count": " 7 "} -> OK {'word_count': 7}
      {"related_keywords": "x"} -> [{"type": "list_type", "loc": ["related_keywords"], "msg": "Input should be a valid list", "input": "x", ...}]
      {"related_keywords": [1]} -> [{"type": "string_type", "loc": ["related_keywords", 0], "msg": "Input should be a valid string", "input": 1, ...}]
      {"stage_settings": []} -> [{"type": "dict_type", "loc": ["stage_settings"], "msg": "Input should be a valid dictionary", "input": [], ...}]
      {"topic": 5} -> [{"type": "string_type", "loc": ["topic"], "msg": "Input should be a valid string", "input": 5, ...}]
      {"topic": null} -> OK {'topic': None}
      ```

      **The delete cascades over nothing, unlike the profile delete.** `Post`
      declares only the many-to-one `profile` relationship, and the one foreign
      key pointing at `posts` is `internal_links.post_id`, which Alembic 006 gave
      `ON DELETE SET NULL`. So a plain `DELETE` is faithful here, where the
      profile port needed a hand-written orphaning update. Probed against the
      real ORM and the real database, and against the live constraint:

      ```
      $ psql "$DATABASE_URL_SYNC" -c "SELECT conname, confdeltype,
        pg_get_constraintdef(oid) FROM pg_constraint WHERE confrelid = 'posts'::regclass;"
                 conname           | confdeltype |                     pg_get_constraintdef
       -----------------------------+-------------+---------------------------------------------------------------
       internal_links_post_id_fkey | n           | FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
      (1 row)

      $ cd api && PYTHONPATH=. uv run python /tmp/probe_patch_delete_5_3b_ii.py
      created_at == updated_at: False
      dirty after identical setattr: True
      updated_at changed by identical setattr: False
      updated_at changed by empty patch: False
      updated_at changed by real patch: True
      links after post delete: [(UUID('638f4c1b-3c74-43b3-8fc4-f690ab4cbb8e'), None)]
      ```

      **Deviation, carried over from `PATCH /api/profiles/{profile_id}` and now
      measured.** `updated_at` is stamped by hand here because
      `TimestampMixin.onupdate` did it in Python. The probe above shows what that
      misses: SQLAlchemy marks the instance dirty on any `setattr` but compares
      the value against the loaded one at flush time, so a patch submitting only
      values the row already holds emitted no UPDATE and left `updated_at` alone.
      Reproducing that needs a deep equality over the jsonb and array columns
      (Python's `dict.__eq__` is key-order-insensitive, `JSON.stringify` is not),
      and its failure mode is skipping a write that should happen, which is worse
      than a timestamp no caller branches on. The empty-body case *is*
      reproduced, because Drizzle rejects an empty `set` and forces the read path
      anyway.

      **Deviation.** `rm(dir, { recursive: true, force: true })` stands in for
      `if media_dir.exists(): shutil.rmtree(media_dir)`. Both are silent when the
      directory was never created and neither swallows a failure to remove one
      that was; `force` only ignores `ENOENT`. `post_id` has already been matched
      against the uuid pattern before it reaches `path.join`, so it cannot escape
      the media root. `mediaRoot()` moved out of
      `web/src/mastra/images/generate-one.ts` into
      `web/src/mastra/images/media-dir.ts` for this: a delete handler reaching
      into the image generator for a path helper read like a mistake, and there
      is only one correct definition of `settings.media_dir`.

      Ownership rides on the update and the delete as a correlated `EXISTS` over
      `website_profiles`, because Drizzle's `update`/`delete` take no join. Same
      predicate as `_get_user_post()`'s inner join, including its consequence
      that a post whose `profile_id` is null is invisible to both verbs.

      28 tests in `web/src/app/api/posts/update-delete.test.ts`, against the real
      database, real BetterAuth sessions and real files under a temporary
      `MEDIA_DIR`:

      ```

       RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > rejects an unauthenticated request the way get_current_user did 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > answers a malformed uuid with FastAPI's path 422 13ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > answers an unknown post with _get_user_post's 404 8ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > answers another user's post with the same 404 and writes nothing 10ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > cannot see a post whose profile_id is null, because the join is inner 7ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > answers a body that is not JSON with FastAPI's json_invalid 422 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > writes only the keys the client sent, which is exclude_unset 6ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > clears a column sent as null, including a list column 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > ignores keys PostUpdate does not declare, so slug and profile_id are immovable 6ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > applies pydantic's lax int coercion to word_count 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"word_count":"abc"} 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"word_count":[1]} 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"related_keywords":"x"} 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"related_keywords":[1]} 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"stage_settings":[]} 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > reproduces pydantic's 422 for {"topic":5} 4ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > returns the row untouched for an empty body, leaving updated_at alone 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > stamps updated_at on a real change, standing in for TimestampMixin.onupdate 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > saves stage content the way the editor on posts/[id] does 5ms
       ✓ src/app/api/posts/update-delete.test.ts > PATCH /api/posts/{post_id} > answers with the full PostRead shape, not just the changed columns 7ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > rejects an unauthenticated request the way get_current_user did 1ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > answers a malformed uuid with FastAPI's path 422 2ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > answers an unknown post with _get_user_post's 404 2ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > answers another user's post with the same 404 and leaves the row in place 5ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > removes the row and answers 204 with no body 5ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > detaches internal links rather than deleting them, per Alembic 006's SET NULL 5ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > removes the post's media directory and nothing beside it 6ms
       ✓ src/app/api/posts/update-delete.test.ts > DELETE /api/posts/{post_id} > succeeds when the post never generated images, matching the exists() guard 4ms

       Test Files  1 passed (1)
            Tests  28 passed (28)
         Start at  13:22:22
         Duration  722ms (transform 55ms, setup 114ms, import 369ms, tests 169ms, environment 0ms)
      ```

      Three negative controls, each reverted:

      ```
      # 1. drop the rm() call from DELETE
      Tests  1 failed | 27 passed (28)
           x removes the post's media directory and nothing beside it

      # 2. replace PATCH's ownership EXISTS with a bare eq(posts.id, id)
      Tests  2 failed | 26 passed (28)
           x answers another user's post with the same 404 and writes nothing
           x cannot see a post whose profile_id is null, because the join is inner

      # 3. point updateToColumns at COLUMN_OF (the create map) instead of UPDATE_COLUMN_OF
      Tests  1 failed | 27 passed (28)
           x saves stage content the way the editor on posts/[id] does
      ```

      Frontend gates, all four green, with the failure count still on its
      recorded 9-failure baseline:

      ```
      $ cd web && ./node_modules/.bin/tsc --noEmit
      tsc exit=0

      $ pnpm -C web lint
      (no output, exit 0)

      $ pnpm -C web test
      Test Files  2 failed | 70 passed (72)
           Tests  9 failed | 1174 passed | 7 skipped (1190)

      $ pnpm -C web build
      Compiled successfully in 3.5s
      |- f /api/posts/[id]
      ```

      The api gates are unchanged from their recorded baseline:

      ```
      $ cd api && uv run pytest -q     # .env sourced
      125 failed, 236 passed, 25 errors in 13.48s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 129 files already formatted
      ```

## 5.3b-iii


      Two handlers, `web/src/app/api/posts/[id]/duplicate/route.ts` and
      `web/src/app/api/posts/batch/route.ts`. Both are static-vs-dynamic
      neighbours of the `[id]` route already ported; `next build` resolves them
      as separate entries, so `POST /api/posts/batch` never reaches `[id]`:

      ```
      $ pnpm -C web build
      ├ ƒ /api/posts
      ├ ƒ /api/posts/[id]
      ├ ƒ /api/posts/[id]/duplicate
      ├ ƒ /api/posts/batch
      ```

      **`duplicate` is a whitelist copy, not a row clone.** `duplicate_post`
      names eighteen configuration columns in `config_fields` and reads only
      those off the original, so the six stage content columns, `image_manifest`,
      `stage_logs`, `execution_logs`, `current_stage`, `stage_status`,
      `priority`, the five WordPress columns and the two Next.js publishing
      columns all fall back to their column defaults. That is what makes the
      duplicate a fresh unrun post. It is also the one write endpoint in the
      router that starts no pipeline run, which is why the copy sits at
      `current_stage: "pending"` until the user runs it. Both facts are asserted.

      **A defect in the original, preserved rather than fixed.**
      `config_fields` predates `article_type` and `additional_info`, so a
      duplicate silently loses them. This is a port, not a bug fix, and what a
      duplicate carries is a product decision, so the behaviour is reproduced and
      pinned by a test that says so. Logged in `todo.md` as `[confirmed]` with
      the two-line fix.

      **`batch` differs from `create_post` in two ways, both deliberate on the
      Python side.** It does not stamp `current_stage`/`stage_status`, so a batch
      post starts at `"pending"` with an empty `stage_status` where a single
      create starts at `"research"`/`{research: "running"}`; the pytest coverage
      asserted that directly (`post["current_stage"] == "pending"`). And an empty
      list is a 201 carrying `[]`. Both are kept.

      All-or-nothing is load-bearing: Python called `session.commit()` once after
      adding every post, so one item violating `uq_posts_profile_slug` rolls the
      whole batch back. A single multi-row INSERT keeps that, and Postgres
      returns RETURNING rows in VALUES order, which is the order
      `web/src/app/posts/batch/page.tsx` submitted. Both are asserted.

      **Deviation: `batch`'s profile lookup is scoped to the caller.** Python
      used `session.get(WebsiteProfile, data.profile_id)`, which is not scoped,
      and skipped the prefill when it came back empty. Two holes follow. Another
      account's profile is read for its niche, tone, brand voice, word count and
      WordPress defaults, so a caller who knows a profile id reads settings that
      are not theirs. Worse, the post is then written carrying that account's
      `profile_id`, which hands the post to them and hides it from its creator,
      since every read handler joins through `website_profiles` to reach
      `user_id`. The objective's Phase 5 rule is explicit that this is a defect
      rather than a follow-up, so the lookup is scoped and a miss is the same
      `404 {"detail": "Profile not found"}` `create_post` already answers with,
      which makes the two create paths agree. The only case that changes for a
      legitimate caller is a `profile_id` that does not exist at all: that was a
      foreign-key 500 before and is a 404 now.

      The prefill itself is `applyProfilePrefill` from item 5.3b-i, unchanged, so
      the ten-case oracle generated from the real `create_post` coroutine still
      covers `batch`'s fold. The one addition here is that a batch naming two
      profiles resolves each item against its own, asserted.

      26 tests in `web/src/app/api/posts/duplicate-batch.test.ts`, against the
      real database, real BetterAuth sessions and the real Redis Streams bus,
      with the batch enqueue read back off an independent fan-out subscription
      rather than a spy:

      ```
       RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > rejects an unauthenticated request 3ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > answers a malformed path uuid with FastAPI's 422 11ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > answers a post that does not exist with a 404 5ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > answers another user's post with the same 404, writing nothing 9ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > answers a post with no profile with a 404, because the join is inner 4ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > copies every configuration field in `config_fields` 7ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > gives the copy a new id and a `-copy-<6 hex>` slug 5ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > mints a different suffix on each call 8ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > leaves stage content, logs and pipeline state behind 5ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > does not copy `article_type` or `additional_info`, which `config_fields` predates 5ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/{post_id}/duplicate > starts no pipeline run, unlike every other create path 507ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > rejects an unauthenticated request 1ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > answers an empty list with a 201 and an empty list 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > answers a body that is not a list with pydantic's `list_type` 3ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > answers invalid JSON with FastAPI's `json_invalid` 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > reports the failing item's index in `loc` 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > reports every failing item in one response 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > creates every post, in the submitted order 3ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > leaves `current_stage` and `stage_status` at their column defaults 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > prefills each item from its profile 4ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > prefills each item from its own profile when a batch names two 4ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > answers another user's profile with a 404 and writes nothing 3ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > answers a profile that does not exist with a 404 2ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > rolls the whole batch back when one item violates the slug constraint 8ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > starts a pipeline run for every created post 43ms
       ✓ src/app/api/posts/duplicate-batch.test.ts > POST /api/posts/batch > scopes the created posts to the caller 8ms
       Test Files  1 passed (1)
            Tests  26 passed (26)
         Start at  13:31:35
         Duration  2.63s (transform 141ms, setup 75ms, import 694ms, tests 1.75s, environment 0ms)
      ```

      Three negative controls, each run against the finished tests:

      ```
      # 1. drop the user_id predicate from batch's profile lookup
      ×  answers another user's profile with a 404 and writes nothing
         Tests  1 failed | 25 passed (26)

      # 2. add articleType/additionalInfo to duplicate's CONFIG_COLUMNS
      ×  does not copy `article_type` or `additional_info`, which `config_fields` predates
         Tests  1 failed | 25 passed (26)

      # 3. stamp currentStage/stageStatus in batch the way create_post does
      ×  leaves `current_stage` and `stage_status` at their column defaults
         Tests  1 failed | 25 passed (26)
      ```

      `web/src/lib/api.ts` needed no change: `posts.duplicate()` already returns
      `Post` and `posts.batchCreate()` already returns `Post[]`, which is what
      both handlers serialize through the shared `PostRead` serializer.

      Frontend gates:

      ```
      $ cd web && ./node_modules/.bin/tsc --noEmit ; echo "exit: $?"
      exit: 0

      $ pnpm -C web lint
      (no output)

      $ pnpm -C web test
       Test Files  2 failed | 71 passed (73)
            Tests  9 failed | 1200 passed | 7 skipped (1216)

      $ pnpm -C web build
      ✓ Compiled successfully
      ```

      1174 -> 1200 passing is exactly the 26 added here; the 9 failures are the
      Phase 0 baseline (6 in `image-preview.test.tsx`, 3 in `scaffold-check`,
      the latter tracked in `todo.md`).

      Backend gates, on their recorded baseline:

      ```
      $ cd api && uv run pytest -q     # .env sourced
      125 failed, 236 passed, 25 errors in 13.71s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 129 files already formatted
      ```

## 5.3c-i


      Ported to `web/src/app/api/posts/[id]/run/route.ts` and
      `web/src/app/api/posts/[id]/run-all/route.ts`, with `run-control.ts` holding
      `_next_stage()` and the 400 helper the control endpoints share.
      `startPipeline()` gains an optional `stages` argument, which is ARQ's `stage`
      positional: `run_pipeline_stage(post_id, stage)` turned it into `stages=[stage]`.

      **`_next_stage()` stays at the route layer.** Python defined it in the router,
      not in `state.py`, and the reason survives the port: it decides which stage name
      the 202 echoes, not which stages the run executes. The run is handed `stage`
      verbatim, so a `/run` with no `stage` starts a full pipeline whose own skip rule
      (`shouldRunStage()` in `mastra/steps/stage-io.ts`) re-derives the same
      first-incomplete stage from the committed row. Pinning the run to the stage the
      response happened to name would be a behaviour change: the row can move between
      the read and the worker picking the event up.

      **Deviation 1: a repeated `?stage=` keeps the last value, not the first.**
      FastAPI read `stage: str | None` through Starlette's `QueryParams`, which is a
      multidict whose `get()` returns the last value of a repeated key.
      `URLSearchParams.get()` returns the first. Probed against the installed
      Starlette rather than assumed:

      ```
      $ cd api && uv run python -c "
      from starlette.datastructures import QueryParams
      q = QueryParams('stage=write&stage=edit')
      print('get:', q.get('stage'))
      print('empty:', QueryParams('stage=').get('stage'))
      "
      get: edit
      empty:
      ```

      The handler therefore reads `searchParams.getAll("stage").at(-1)`. The same probe
      pins the second behaviour the handler reproduces: `?stage=` yields `""`, which is
      falsy in Python, so an empty value behaved as if the parameter were absent.

      **Deviation 2: `/run-all` always issues its UPDATE and bumps `updated_at`.**
      SQLAlchemy compared the new `stage_settings` dict against the loaded one at flush
      time, so a run-all on a post whose six stages are already complete emitted no
      UPDATE. Reproducing that needs a deep equality over a jsonb column whose failure
      mode is skipping a write that should happen. This is the same deviation already
      recorded for `PATCH /api/posts/{post_id}` and `PATCH /api/profiles/{profile_id}`,
      and nothing in `web/src/lib/api.ts` branches on `updated_at`.

      **Not deviations, deliberately preserved.** The 404 is resolved before `stage` is
      validated, so a bad stage on another user's post is a 404 and never confirms the
      post exists. `/run` writes `current_stage` and `stage_status[target] = "running"`
      before the run is started, so the post detail page's poll never sees a started
      run at its old status. `/run-all` guards on `stage_status`, not on the mode, so a
      stage already complete keeps its review setting for the next rerun, and the
      whole-map copy means non-stage keys stored in `stage_settings` survive.

      `web/src/lib/api.ts` needed no change: `posts.run()` already declares
      `{ status: string; stage: string }` and `posts.runAll()` already declares
      `{ status: string; mode: string }`, which is what both handlers return.

      **Every real enqueue in the test file starts a run that cannot reach a
      provider**, because a worker started by another test file shares the bus. The
      `/run` case leaves `stage_settings` gating `research` at `"review"` so the run
      suspends before it spends; the `/run-all` case uses a post whose six stages are
      complete so every stage is skipped; and the stage-selection case starts
      `startPipeline()` on a post id no row has, so the step throws out of
      `loadPipelineState()` before rendering a prompt. The `?stage=` mapping is
      asserted through a recorded no-op start instead, because a named stage skips the
      review gate by design (`stageNeedsReview()`) and starting one for real would put
      a live provider call on the bus.

      ```
      $ cd web && npx vitest run src/app/api/posts/run-control.test.ts --reporter=verbose
       ✓ POST /api/posts/{post_id}/run > rejects an unauthenticated request 3ms
       ✓ POST /api/posts/{post_id}/run > answers a malformed path uuid with FastAPI's 422 15ms
       ✓ POST /api/posts/{post_id}/run > answers a post that does not exist with a 404 5ms
       ✓ POST /api/posts/{post_id}/run > answers another user's post with the same 404, starting nothing 7ms
       ✓ POST /api/posts/{post_id}/run > prefers the 404 over the invalid-stage 400 on another user's post 4ms
       ✓ POST /api/posts/{post_id}/run > answers a stage outside STAGES with a 400 naming it 5ms
       ✓ POST /api/posts/{post_id}/run > answers a fully complete pipeline with a 400, starting nothing 4ms
       ✓ POST /api/posts/{post_id}/run > targets the first stage of a post that has run nothing 6ms
       ✓ POST /api/posts/{post_id}/run > targets the first incomplete stage, preserving the statuses around it 6ms
       ✓ POST /api/posts/{post_id}/run > treats an empty ?stage= as absent, the way a falsy Python string was 5ms
       ✓ POST /api/posts/{post_id}/run > keeps the last value of a repeated ?stage=, as Starlette's QueryParams does 4ms
       ✓ POST /api/posts/{post_id}/run > runs a named stage that is already complete, marking only that stage running 4ms
       ✓ POST /api/posts/{post_id}/run > publishes a real workflow.start for the gated full run 44ms
       ✓ POST /api/posts/{post_id}/run > carries a named stage selection across the bus 29ms
       ✓ POST /api/posts/{post_id}/run-all > rejects an unauthenticated request 1ms
       ✓ POST /api/posts/{post_id}/run-all > answers a malformed path uuid with FastAPI's 422 2ms
       ✓ POST /api/posts/{post_id}/run-all > answers a post that does not exist with a 404 2ms
       ✓ POST /api/posts/{post_id}/run-all > answers another user's post with the same 404, writing nothing 5ms
       ✓ POST /api/posts/{post_id}/run-all > forces every incomplete stage to auto and starts an unselected run 5ms
       ✓ POST /api/posts/{post_id}/run-all > leaves a completed stage's mode alone 5ms
       ✓ POST /api/posts/{post_id}/run-all > preserves stage_settings keys that are not stage names 6ms
       ✓ POST /api/posts/{post_id}/run-all > changes no mode when every stage is complete 5ms
       ✓ POST /api/posts/{post_id}/run-all > publishes a real workflow.start for a post with nothing left to run 32ms
       Test Files  1 passed (1)
            Tests  23 passed (23)
         Duration  2.28s (transform 141ms, setup 116ms, import 856ms, tests 1.23s, environment 0ms)
      ```

      Two negative controls, each run against the finished tests:

      ```
      # 1. read the query parameter with URLSearchParams.get() (first wins)
      ×  keeps the last value of a repeated ?stage=, as Starlette's QueryParams does
         Tests  1 failed | 22 passed (23)

      # 2. drop run-all's stage_status guard and force every stage to "auto"
      ×  leaves a completed stage's mode alone
      ×  changes no mode when every stage is complete
         Tests  2 failed | 21 passed (23)
      ```

      Frontend gates:

      ```
      $ cd web && npx tsc --noEmit ; echo "exit: $?"
      exit: 0

      $ cd web && npx eslint ; echo "exit: $?"
      exit: 0

      $ cd web && npx vitest run
       Test Files  2 failed | 72 passed (74)
            Tests  9 failed | 1223 passed | 7 skipped (1239)

      $ cd web && npx next build ; echo "exit: $?"
      ✓ Compiled successfully in 3.5s
      ├ ƒ /api/posts
      ├ ƒ /api/posts/[id]
      ├ ƒ /api/posts/[id]/duplicate
      ├ ƒ /api/posts/[id]/run
      ├ ƒ /api/posts/[id]/run-all
      ├ ƒ /api/posts/batch
      exit: 0
      ```

      1200 -> 1223 passing is exactly the 23 added here; the 9 failures are the Phase 0
      baseline (6 in `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`). An earlier
      run of the same suite reported 10, the extra one being `scaffold-check.test.ts`'s
      known intermittent, already tracked in `todo.md`; it passes on its own and passed
      on the rerun above.

      `api/` is untouched by this item, and its gates are unchanged:

      ```
      $ cd api && uv run pytest -q     # .env sourced
      125 failed, 236 passed, 25 errors in 14.67s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 129 files already formatted
      ```

## 5.3c-ii


      Ported to `web/src/app/api/posts/[id]/rerun/route.ts` and
      `web/src/app/api/posts/[id]/restart/route.ts`. Both are reset-then-start:
      they rewrite `stage_status`, clear content columns and start a plain full
      pipeline with no stage selection, so the run re-derives where to resume
      from the row the handler just committed.

      The two differ in three ways that are Python's, not incidental, and each
      has a test:

      - `/rerun` copies `stage_status` and rewrites only the slice from
        `rerun_from` onward, so upstream statuses and any non-stage key survive.
        `/restart` *replaces* it with a fresh six-key map, dropping other keys.
      - `/rerun` clears the six columns in its own stage-to-column map, which
        has no entry for `final_html_content`. `/restart` clears that column too.
      - `/rerun` falls back to `STAGES[-1]` when nothing is non-complete, so
        rerunning a finished post re-runs `ready` alone rather than doing
        nothing.

      Neither endpoint touches `stage_settings`, so the post's configured review
      gates still apply to the run they start. That is what makes the two live
      bus tests below safe: the fixture profile gates `research` at `"review"`,
      so the real run each starts suspends at its first stage without reaching a
      provider.

      **`STAGE_CONTENT_COLUMN`** (`run-control.ts`) is the Drizzle-property form
      of `STAGE_CONTENT_MAP`. `rerun_stage()` carried its own inline copy of the
      stage-to-column map rather than importing `STAGE_CONTENT_MAP`; the two
      agreed, and a test asserts the TypeScript pair still do, reading the real
      column names off the table:

      ```
      for (const stage of ALL_STAGES) {
        expect(columns[STAGE_CONTENT_COLUMN[stage]].name).toBe(STAGE_CONTENT_MAP[stage])
      }
      ```

      **Deviation 1: `updated_at` is stamped on every request.** Same tradeoff
      already argued under 5.3b-ii. SQLAlchemy's `onupdate` only fires when a
      flush actually emits an `UPDATE`, and it compares values, so a rerun of a
      post that was already fully pending with null content emitted nothing and
      left `updated_at` alone. The port always writes, so that one case now
      bumps `updated_at`. Nothing in `web/src/lib/api.ts` branches on it.

      **Deviation 2: ownership is a correlated `EXISTS`, extracted.** Drizzle's
      `update()` takes no join, so the `_get_user_post()` restriction rides along
      as a subquery. That predicate now existed in four handlers verbatim, so it
      moved into `params.ts` as `ownedByCaller()` and `PATCH`, `DELETE`, `/run`
      and `/run-all` were repointed at it. Their 78 existing tests are unchanged
      and still pass, which is the check that the extraction is behaviour-neutral.

      ```
      $ pnpm -C web vitest run src/app/api/posts/run-control.test.ts --reporter=verbose
       ✓ src/app/api/posts/run-control.test.ts > STAGE_CONTENT_COLUMN > names the same columns STAGE_CONTENT_MAP does 1ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > rejects an unauthenticated request 1ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > answers a malformed path uuid with FastAPI's 422 2ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > answers a post that does not exist with a 404 2ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > answers another user's post with the same 404, clearing nothing 4ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > reruns from research on a post that has run nothing 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > reruns from the first non-complete stage, leaving the completed ones alone 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > falls back to the last stage when every stage is complete 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > leaves final_html_content alone, since no stage owns that column 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > preserves stage_status keys that are not stage names 4ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > leaves stage_settings untouched 4ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/rerun > publishes a real workflow.start that parks at the gated first stage 37ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > rejects an unauthenticated request 1ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > answers a malformed path uuid with FastAPI's 422 2ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > answers a post that does not exist with a 404 2ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > answers another user's post with the same 404, clearing nothing 4ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > clears every content column, every stage status and the logs 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > replaces stage_status rather than updating it, dropping other keys 5ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > leaves stage_settings untouched, so the configured gates still apply 4ms
       ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/restart > publishes a real workflow.start that parks at the gated first stage 33ms

       Test Files  1 passed (1)
            Tests  43 passed (43)
         Start at  13:59:06
         Duration  2.41s (transform 144ms, setup 116ms, import 822ms, tests 1.34s, environment 0ms)
      ```

      Negative controls, each reverted after measuring:

      ```
      # 1. clear final_html_content in /rerun as well
      Tests  1 failed | 42 passed (43)
        x leaves final_html_content alone, since no stage owns that column

      # 2. fall back to STAGES[0] instead of STAGES[-1] when all stages complete
      Tests  1 failed | 42 passed (43)
        x falls back to the last stage when every stage is complete

      # 3. merge into the existing stage_status in /restart instead of replacing
      Tests  1 failed | 42 passed (43)
        x replaces stage_status rather than updating it, dropping other keys
      ```

      The refactored handlers plus the whole posts router:

      ```
      $ pnpm -C web vitest run src/app/api/posts/
       v src/app/api/posts/update-delete.test.ts (28 tests) 188ms
       v src/app/api/posts/route.test.ts (27 tests) 148ms
       v src/app/api/posts/create.test.ts (25 tests) 173ms
       v src/app/api/posts/run-control.test.ts (43 tests) 684ms
       v src/app/api/posts/duplicate-batch.test.ts (26 tests) 1769ms

       Test Files  5 passed (5)
            Tests  149 passed (149)
      ```

      Gates:

      ```
      $ pnpm -C web tsc --noEmit
      (exit 0, no output)

      $ pnpm -C web lint
      (exit 0, no output)

      $ pnpm -C web test
       Test Files  2 failed | 72 passed (74)
            Tests  9 failed | 1243 passed | 7 skipped (1259)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx, both pre-existing. Confirmed again this iteration by
      # running PostDetail.test.tsx with this work stashed:
      #   $ git stash push -u -m iter65-rerun-restart
      #   $ pnpm -C web vitest run src/app/posts/PostDetail.test.tsx
      #        Tests  3 failed | 12 passed (15)
      # Passing count 1223 -> 1243 (+20).

      $ pnpm -C web build
      BUILD EXIT=0
      v Compiled successfully in 3.4s
      |- f /api/posts/[id]/rerun
      |- f /api/posts/[id]/restart

      $ cd api && uv run pytest -q
      125 failed, 236 passed, 25 errors in 13.19s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 129 files already formatted
      ```

## 5.3c-iii-a


        `web/src/app/api/posts/[id]/pause/route.ts` ports `pause_post()`. It is the
        smallest handler in the router and the only pipeline-control endpoint that
        enqueues nothing: Python read the post through `_get_user_post()`, assigned
        `current_stage = "paused"` and committed.

        What "paused" actually means, read off the Python rather than assumed:

        ```
        $ grep -rn "paused" api/src
        api/src/api/queue.py:43:        "paused": counts.get("paused", 0),
        api/src/api/queue.py:105:        post.current_stage = "paused"
        api/src/api/queue.py:108:    return {"status": "paused", "count": count}
        api/src/api/queue.py:117:    """Resume all paused posts."""
        api/src/api/queue.py:122:        .where(Post.current_stage == "paused")
        api/src/api/posts.py:467:    post.current_stage = "paused"
        api/src/api/posts.py:470:    return {"status": "paused", "post_id": str(post_id)}
        ```

        Nothing in `api/src/worker.py` or `api/src/pipeline/` reads the value, so it is a
        label, not a control signal: a stage already executing runs to completion and the
        next stage still starts. What the flag does is move the post out of the in-flight
        buckets on the posts list and the queue counts, and give `POST /api/queue/resume-all`
        something to find. The port keeps that exactly, including the fact that the stage
        the post was on is overwritten rather than remembered, which is why `resume-all`
        has to recover the next stage from `stage_status`.

        Two behaviours that look like oversights and are preserved:

        - the per-post endpoint has no stage guard, so it will pause a `complete` post,
          while `POST /api/queue/pause-all` restricts itself to `["pending", *STAGES]`;
        - pausing an already paused post is a plain second write, not a 409.

        Deviation, the same one recorded under 5.2b and 5.3b-ii: `updated_at` is
        hand-stamped on every call, where SQLAlchemy's `onupdate` compared the assigned
        value against the loaded one at flush time and emitted no `UPDATE` at all when
        they matched. So pausing an already paused post bumps `updated_at` here and did
        not in Python. Nothing in `web/src/lib/api.ts` sorts or filters on `updated_at`
        for this flow.

        The lookup and the write are one statement, as in the crawl endpoint from
        5.2c-iii: the ownership predicate is `ownedByCaller()` extracted in 5.3c-ii, and
        zero rows returned is the same 404 `_get_user_post()` raised. That keeps the
        inner-join consequence intact, proven by its own test: a post whose `profile_id`
        is null is invisible.

        The ten tests are in `web/src/app/api/posts/run-control.test.ts`, which now covers
        all five per-post pipeline-control endpoints, against the real database and real
        BetterAuth sessions:

        ```
        $ pnpm -C web vitest run src/app/api/posts/run-control.test.ts --reporter=verbose
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > rejects an unauthenticated request 1ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > answers a malformed path uuid with FastAPI's 422 2ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > answers a post that does not exist with a 404 2ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > answers another user's post with the same 404, pausing nothing 4ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > answers a post whose profile_id is null with a 404 3ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > writes current_stage = paused and answers 200 4ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > enqueues nothing, unlike every other pipeline-control endpoint 3ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > overwrites the stage the post was on rather than remembering it 4ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > pauses a finished post too, since the endpoint filters on no stage 4ms
         ✓ src/app/api/posts/run-control.test.ts > POST /api/posts/{post_id}/pause > is idempotent: pausing an already paused post answers 200 again 4ms
         Test Files  1 passed (1)
              Tests  53 passed (53)
           Start at  14:04:49
           Duration  2.50s (transform 189ms, setup 96ms, import 882ms, tests 1.39s, environment 0ms)
        ```

        The 43 tests already in the file are the four other control endpoints from 5.3c-i
        and 5.3c-ii, unchanged.

        Negative controls, each reverted after measuring:

        ```
        # 1. replace ownedByCaller(id, user.id) with eq(posts.id, id)
        Tests  2 failed | 8 passed | 43 skipped (53)
          x answers another user's post with the same 404, pausing nothing
          x answers a post whose profile_id is null with a 404

        # 2. drop the zero-rows 404 and echo the path id back instead
        Tests  3 failed | 7 passed | 43 skipped (53)
          x answers a post that does not exist with a 404
          x answers another user's post with the same 404, pausing nothing
          x answers a post whose profile_id is null with a 404
        ```

        Gates:

        ```
        $ pnpm -C web tsc --noEmit
        TSC EXIT=0
        (no output)

        $ pnpm -C web lint
        LINT EXIT=0
        (no output)

        $ pnpm -C web test
         Test Files  2 failed | 72 passed (74)
              Tests  9 failed | 1253 passed | 7 skipped (1269)
        # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
        # PostDetail.test.tsx, both pre-existing and both re-measured at HEAD in 5.3c-ii.
        # Passing count 1243 -> 1253 (+10).

        $ pnpm -C web build
        BUILD EXIT=0
        v Compiled successfully in 4.3s
        |- f /api/posts/[id]/pause
        # The 15 BetterAuth "default secret" lines are the pre-existing, environment-driven
        # warning recorded under item 1.2: one per page-data worker ("Collecting page data
        # using 15 workers"), and BETTER_AUTH_SECRET is set nowhere in the repo .env.

        $ cd api && uv run pytest -q
        125 failed, 236 passed, 25 errors in 15.39s

        $ cd api && uv run ruff check .
        Found 32 errors.

        $ cd api && uv run ruff format --check .
        9 files would be reformatted, 129 files already formatted
        ```

## 5.3c-iii-b-1-a


          `web/src/mastra/wordpress/index.ts` gains `uploadMedia`, `createPost` and
          `updatePost`, and the private `get()` it had is generalised into a `request()`
          that takes a method, a body and extra headers. 5.9a ported the read half and
          deliberately left these three, because their only caller is
          `api/src/pipeline/publish.py`.

          The oracle is new: `api/scripts/export_wordpress_write_parity.py` runs the real
          Python client against a local HTTP server and records, per scenario, the
          routing table it served, **every byte of every request the server saw**, and
          the value returned or the `WordPressError` raised.
          `web/src/mastra/wordpress/wordpress-write.test.ts` stands up a Node server from
          the same exported table and asserts both halves. Recording request bodies is
          the whole point of this item: everything interesting about these three methods
          is in what goes out, not in what comes back, and
          `api/tests/phase10/test_wordpress_service.py` replaces the transport with an
          `AsyncMock`, so it asserts the arguments httpx *would* have been handed rather
          than the bytes httpx sent.

          ```
          $ cd api && uv run python scripts/export_wordpress_write_parity.py
          local server on http://127.0.0.1:64922
            upload-media-with-alt-text-patches-the-attachment: 2 request(s), returned {"id": 42, "source_url": "https://example.com/wp-content/upl
            upload-media-returns-the-first-response-not-the-patch: 2 request(s), returned {"id": 7, "source_url": "https://x/7.png"}
            upload-media-without-alt-text-sends-one-request: 1 request(s), returned {"id": 9, "source_url": "https://x/9.png"}
            ...
            update-post-forwards-the-publish-hook-kwargs-nulls-included: 1 request(s), returned {"id": 100, "link": "https://example.com/updated/"}
            update-post-with-no-kwargs-sends-an-empty-object: 1 request(s), returned {"id": 101, "link": "https://x/"}
            update-post-404: 1 request(s), raised WordPress API error: Invalid post ID.
            update-post-500-with-no-message-key: 1 request(s), raised WordPress API error: {"code": "internal_error"}
          wrote .../web/src/mastra/wordpress/data/wordpress-write-parity.json (29 scenarios)
          ```

          **httpx 0.28.1 serialises `json=` exactly the way `JSON.stringify` does.** The
          captured bodies are compact (`separators=(",", ":")`) and not ASCII-escaped
          (`ensure_ascii=False`), so `{"title":"A title","content":"<p>Body</p>",...}`
          matches byte for byte and no custom serialiser is needed. That is asserted
          rather than assumed: the oracle stores `body_b64` per request.

          ```
          $ cd api && uv run python -c "import httpx; print(httpx.__version__); \
            print(repr(httpx.Request('POST','http://x/', json={'a':'é','c':None}).content))"
          0.28.1
          b'{"a":"\xc3\xa9","c":null}'
          ```

          Four behaviours the return value cannot show, all preserved:

          - **`upload_media` sends the bytes raw, not as multipart**, under
            `Content-Disposition: attachment; filename="..."` and a `Content-Type` of the
            caller's mime type (default `image/png`). The filename is interpolated with
            no escaping, so `my "best" shot.png` produces a header with unbalanced
            quotes; that is Python's behaviour and the oracle pins it.
          - **The alt-text patch is a second request, gated on two truthiness tests.**
            An empty `alt_text` sends nothing, and so does a response whose `id` is
            missing *or* `0`. `upload_media` returns the upload response, never the
            patch response, so alt text written by the second call is not reflected in
            what the caller sees. A failing patch throws after the upload has already
            committed, leaving an attachment with no alt text on the site; the publish
            workflow's error path has to cope with that.
          - **`create_post` drops falsy optional fields.** `if categories:`, `if author:`,
            `if featured_media:` and `if excerpt:` mean an empty list, an author or
            featured-media id of `0`, and an empty excerpt are all indistinguishable from
            absent, while `title`, `content` and `status` ride along even when empty.
          - **`update_post` forwards its `**kwargs` untouched, nulls included.** The
            publish hook calls it with `author=None`, `featured_media=None` and
            `excerpt=""`, which reach WordPress as `"author":null,"featured_media":null,
            "excerpt":""` and clear those fields, the opposite of what `create_post` does
            with the same values. `JSON.stringify` drops an `undefined` property but
            keeps a `null`, so `updatePost` takes an explicit `Record<string, unknown>`
            of already-wire-shaped keys and its caller must spell a cleared field `null`.

          One divergence, in the guard rather than the behaviour: `media.get("id")` on a
          `null` upload response raises `AttributeError` in Python and `upload_media` does
          not catch it, so the call fails with a non-`WordPressError`. Reading `.id` off
          `null` throws in TypeScript too, so the port guards the lookup and answers the
          `null` body instead. A WordPress install that returns a bare `null` with a
          `2xx` is not reachable through the REST API; the test that covers it exists to
          hold the guard in place, not to claim the branch is real.

          A typing note worth recording: `Uint8Array<ArrayBufferLike>` is not assignable
          to `BodyInit`, whose `ArrayBufferView` arm is pinned to `ArrayBuffer` in the
          installed lib. `request()`'s body is spelled `string | Uint8Array<ArrayBuffer>`
          rather than widened with a cast, and `uploadMedia` takes the same narrower type.

          **A trap in the oracle format, found by a failing test rather than by reading.**
          The export writes JSON with `sort_keys=True`, which silently reordered the
          `update_post` kwargs dict and so reordered the body the TypeScript side
          reproduced, while `body_b64` still held Python's real insertion order. The
          scenario now carries the kwargs as a list of pairs, which survives sorting:

          ```
          - "body_b64": "eyJ0aXRsZSI6IlVwZGF0ZWQiLCJjb250ZW50Ijoi...   (expected, from Python)
          + "body_b64": "eyJhdXRob3IiOm51bGwsImNhdGVnb3JpZXMiOltd...   (received, alphabetical)
           Tests  1 failed | 32 passed (33)
          ```

          Thirty-three tests, twenty-nine of them driven by the oracle, four covering what
          the oracle cannot reach (the credential on the patch request, a refused
          connection, the `null`-body guard, and `updatePost` keeping a null where
          `createPost` drops it):

          ```
          $ pnpm -C web vitest run src/mastra/wordpress/
           v src/mastra/wordpress/wordpress.test.ts (57 tests) 32ms
           v src/mastra/wordpress/wordpress-write.test.ts (33 tests) 34ms
           Test Files  2 passed (2)
                Tests  90 passed (90)
          ```

          Seven negative controls, each reverted after measuring:

          ```
          # 1. presence tests instead of truthiness on altText and id
          Tests  7 failed | 26 passed (33)
            x upload-media-without-alt-text-sends-one-request
            x upload-media-omitting-alt-text-uses-the-empty-default
            x upload-media-omitting-mime-type-uses-the-image-png-default
            x upload-media-jpeg-mime-type
            x upload-media-alt-text-but-id-is-zero
            x upload-media-filename-with-spaces-and-a-quote
            x upload-media-empty-bytes

          # 2. return the patch response instead of the upload response
          Tests  2 failed | 31 passed (33)
            x upload-media-with-alt-text-patches-the-attachment
            x upload-media-returns-the-first-response-not-the-patch

          # 3. presence tests instead of truthiness in createPost
          Tests  3 failed | 30 passed (33)
            x create-post-empty-categories-list-is-dropped
            x create-post-zero-author-and-zero-featured-media-are-dropped
            x create-post-none-author-and-none-featured-media-are-dropped

          # 4. updatePost drops nullish fields, as createPost does
          Tests  2 failed | 31 passed (33)
            x update-post-forwards-the-publish-hook-kwargs-nulls-included
            x keeps a null in an updatePost field where createPost would drop it

          # 5. default mimeType application/octet-stream
          Tests  2 failed | 31 passed (33)
            x upload-media-omitting-alt-text-uses-the-empty-default
            x upload-media-omitting-mime-type-uses-the-image-png-default

          # 6. patch alt text whenever altText is set, ignoring the id
          Tests  3 failed | 30 passed (33)
            x upload-media-alt-text-but-response-carries-no-id
            x upload-media-alt-text-but-id-is-zero
            x treats a null upload response as having no id rather than throwing

          # 7. drop the Content-Disposition header from the upload
          Tests  15 failed | 18 passed (33)
            (every upload_media scenario)
          ```

          Gates:

          ```
          $ pnpm -C web tsc --noEmit
          TSC EXIT=0

          $ pnpm -C web lint
          LINT EXIT=0

          $ pnpm -C web test
           Test Files  3 failed | 102 passed (105)
                Tests  10 failed | 2281 passed | 7 skipped (2298)
          # 10 failed is the recorded state: the Phase 0 baseline of 9 (6 in
          # image-preview.test.tsx, 3 in PostDetail.test.tsx) plus the known
          # scaffold-check.test.ts flake logged in todo.md, which passes in isolation:
          #   $ pnpm -C web vitest run src/mastra/workflows/scaffold-check.test.ts
          #    Test Files  1 passed (1)
          #         Tests  5 passed (5)
          # Passing count 2248 -> 2281 (+33).

          $ pnpm -C web build
          BUILD EXIT=0
          v Compiled successfully in 4.3s
          # No route changed; this item touches only the client and its tests.

          $ cd api && uv run pytest -q        # .env sourced
          120 failed, 241 passed, 25 errors in 15.00s

          $ cd api && uv run ruff check .
          Found 32 errors.

          $ cd api && uv run ruff check scripts/export_wordpress_write_parity.py
          All checks passed!

          $ cd api && uv run ruff format --check .
          9 files would be reformatted, 135 files already formatted

          $ cd api && uv run ruff format --check scripts/export_wordpress_write_parity.py
          1 file already formatted
          ```

## 5.3c-iii-b-1-b-i


            `web/src/mastra/wordpress/wp-html.ts` ports mistune's `BlockParser.parse`
            loop and `BlockState` rather than wrapping a JavaScript markdown library,
            because the behaviours that matter here are all tokenizer behaviours:
            `Para.\n--` rewrites the paragraph above it into an `<h2>`, `    code` at the
            top of a document is a paragraph rather than a code block because the
            function calls `.strip()` first, an unclosed fence still closes at the end of
            the document, and a backtick inside a backtick fence's info string stops the
            fence from being a fence.

            **The patterns for the four unported block rules and the seven unported
            inline rules are registered anyway, in mistune's rule order, and their
            handlers throw `UnportedMarkdownError`.** Rule order is what decides whether
            `- - -` is a thematic break or a list, so a scanner missing those
            alternatives is not the same scanner. Throwing rather than falling through to
            a paragraph means wiring the converter into the publish workflow before
            -b-ii and -b-iii land cannot silently flatten a list or drop a link.

            The oracle is `api/scripts/export_wp_html_block_parity.py`: 72 inputs run
            through the real `markdown_to_wp_html` with its output recorded verbatim into
            `web/src/mastra/wordpress/data/wp-html-block-parity.json`. Nothing in the
            test file is a hand-written expectation.

            ```
            $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_block_parity.py
            wrote 72 cases to /Users/cody/.../web/src/mastra/wordpress/data/wp-html-block-parity.json

            $ cd web && pnpm exec vitest run src/mastra/wordpress/wp-html-blocks.test.ts
             ✓ src/mastra/wordpress/wp-html-blocks.test.ts (92 tests) 5ms
             Test Files  1 passed (1)
                  Tests  92 passed (92)
            ```

            92 tests: the 72 replay cases, 9 negative controls, 10 unported-rule
            assertions (5 block, 5 inline) and 1 structural check on the oracle file
            itself.

            **Regex translation, four differences that would each have shipped a wrong
            article.** Python compiles the block rules with `re.M`, where `^` matches at
            the start of the string or after `\n` and `$` before `\n` or at the end;
            JavaScript's `m` flag also breaks on `\r`, `\u2028` and
            `\u2029`. The anchors
            are spelled `(?<![^\n])` and `(?![^\n])` instead and no `m` flag is used.
            `re.search(src, pos)` is a `g`-flagged `exec` with `lastIndex = pos` and
            `re.match(src, pos)` is a `y`-flagged one, both of which keep looking at the
            whole string for the anchors the way Python does. `m.lastgroup` is emulated
            by walking the rule list in order and taking the first named group that
            participated. And Python's `str.strip(chars)` strips a *set* of characters,
            so `text.strip(string.whitespace)` in `parse_atx_heading` is not `trim()`.

            **One case moved out of this corpus.** A backtick fence whose info string
            holds a backtick is declined, and the line falls back to a paragraph that
            still holds those backticks, which is a codespan. Its rendered form belongs
            to the -b-iii corpus. The decline itself is asserted here, by asserting the
            input reaches the inline parser at all.

            Gates, all from the repo root unless noted:

            ```
            $ cd web && pnpm exec tsc --noEmit
            tsc exit=0

            $ cd web && pnpm lint
            lint exit=0

            $ cd web && pnpm test
             Test Files  2 failed | 104 passed (106)
                  Tests  9 failed | 2374 passed | 7 skipped (2390)

            $ cd web && pnpm build
            ✓ Compiled successfully in 4.5s
            build exit=0

            $ cd api && uv run pytest -q     # .env sourced
            120 failed, 241 passed, 25 errors in 15.09s

            $ cd api && uv run ruff check .
            Found 32 errors.

            $ cd api && uv run ruff format --check .
            9 files would be reformatted, 136 files already formatted

            $ cd api && uv run ruff check scripts/export_wp_html_block_parity.py
            All checks passed!

            $ cd api && uv run ruff format --check scripts/export_wp_html_block_parity.py
            1 file already formatted
            ```

            The 9 frontend failures are the Phase 0 baseline (6 in `image-preview.test.tsx`,
            3 in `PostDetail.test.tsx`). pytest is above its baseline of 125 failed /
            236 passed / 25 errors. ruff's 32 and 9 are the recorded baselines.

## 5.3c-iii-b-1-b-ii


            Closed by -ii-3-b-2. Every rule in `BlockParser.DEFAULT_RULES` is now
            ported; the block layer of `markdown_to_wp_html` is complete and only the
            inline rules (item -b-iii) are left.

## 5.3c-iii-b-1-b-ii-1


              `block_quote` is the first rule in this converter with a body of its own.
              `extract_block_quote` peels the `>` markers off into a fresh source string
              and reparses it in a child `BlockState`, which is what makes a quote nest,
              and it picks between two scan strategies by asking whether the quote's
              *first* line would start a code block:

              * **require-marker.** If `blank_line`, `indent_code` or `fenced_code`
                matches the first line once its marker is stripped, only lines carrying a
                `>` continue the quote. `>     code` followed by an unmarked line ends
                the quote at the code.
              * **lazy.** Otherwise an unmarked line continues the quote, unless it
                starts one of `blank_line`, `thematic_break`, `fenced_code`, `list` or
                `block_html`. Those five are parsed on the **outer** state and the quote
                token is then inserted *before* the block they produced, which is the
                only reason `BlockState.prepend_token` exists.

              The oracle is `api/scripts/export_wp_html_quote_parity.py`: 56 inputs run
              through the real `markdown_to_wp_html` with its output recorded verbatim
              into `web/src/mastra/wordpress/data/wp-html-quote-parity.json`. Nothing in
              the test file is a hand-written expectation.

              ```
              $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_quote_parity.py
              wrote 56 cases to /Users/cody/.../web/src/mastra/wordpress/data/wp-html-quote-parity.json

              $ cd web && pnpm exec vitest run src/mastra/wordpress/wp-html-quotes.test.ts
               ✓ src/mastra/wordpress/wp-html-quotes.test.ts (67 tests) 7ms
               Test Files  1 passed (1)
                    Tests  67 passed (67)
              ```

              67 tests: the 56 replay cases, 10 negative controls, and 1 structural check
              on the oracle file itself.

              **`block_quote` is removed from the unported-rule list in
              `wp-html-blocks.test.ts`** (91 tests there now, was 92), because it is
              ported. `list`, `ref_link` and `raw_html` still throw there; their ledger
              ids in the thrown message are now `5.3c-iii-b-1-b-ii-2` and
              `-ii-3`, which the existing `toContain("5.3c-iii-b-1-b-ii")` assertion
              still satisfies.

              **`block_html` is now a registered pattern.** It is in mistune's
              `SPECIFICATION` but not in `DEFAULT_RULES`, so -b-i had no reason to carry
              it. The lazy branch scans for it by name, so the whole
              `BLOCK_TAGS`/`PRE_TAGS` table had to come across for the alternation to
              break in the same places. Its handler throws until -ii-3.

              **One regex difference this rule introduced.** Four of the block-quote
              patterns are compiled *without* `re.M`, where Python's `$` matches at the
              end of the string **or just before a single trailing newline**. JavaScript's
              bare `$` only matches at the end. That is the new `EOS` lookahead
              (`(?=\n?$)`); using `$` would have made `_LINE_BLANK_END` miss the
              blank-line-at-end test on a quote body ending in `\n\n\n`, which decides
              whether the *next* line is lazy.

              **One hand-written control was wrong, and the oracle said so.** The first
              draft asserted that an unmarked `## Title` under a quote stays literal text
              because `atx_heading` is not in the break list. It does not: the lazy line
              joins the quote's body and the *child* parse then turns it into a heading
              inside the blockquote. The replay case caught it, the control was corrected
              to assert the real distinction (heading inside, thematic break outside), and
              no production code changed.

              Gates, all from the repo root unless noted:

              ```
              $ cd web && pnpm exec tsc --noEmit
              tsc exit=0

              $ cd web && pnpm lint
              lint exit=0

              $ cd web && pnpm test
               Test Files  2 failed | 105 passed (107)
                    Tests  9 failed | 2440 passed | 7 skipped (2456)

              $ cd web && pnpm build
              ✓ Compiled successfully in 4.1s
              build exit=0

              $ cd api && uv run pytest -q     # .env sourced
              120 failed, 241 passed, 25 errors in 15.09s

              $ cd api && uv run ruff check .
              Found 32 errors.

              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 137 files already formatted

              $ cd api && uv run ruff check scripts/export_wp_html_quote_parity.py
              All checks passed!

              $ cd api && uv run ruff format --check scripts/export_wp_html_quote_parity.py
              1 file already formatted
              ```

              The 9 frontend failures are the Phase 0 baseline (6 in
              `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`). Two earlier runs of
              the same suite reported 10, the extra being
              `scaffold-check.test.ts > emits the workflow lifecycle events`, which passes
              in isolation and is the already-logged cross-file race on the shared Redis
              `workflows` topic (`todo.md`, four entries). Adding a 107th test file
              reshuffles vitest's file scheduling, which is enough to change how often it
              lands; it is not caused by anything in this item, and no `wp-html` code
              touches Redis. pytest is above its baseline of 125 failed / 236 passed /
              25 errors. ruff's 32 and 9 are the recorded baselines.

## 5.3c-iii-b-1-b-ii-2


              `list` is the only mistune rule that lives in a module of its own, and
              almost none of it is visible in the renderer's six lines of format string:

              * **The continuation width** comes from the *first* item's text, not from
                the marker. `_compile_continue_width` measures the whitespace run after
                the marker, except that five or more spaces means indented code and only
                one of them counts. Every later line of that item is a continuation only
                if it starts with that many spaces.
              * **A fresh break scanner is compiled per item** out of six other block
                patterns (`thematic_break`, `fenced_code`, `atx_heading`, `block_quote`,
                `block_html`, `list`) plus a `list_item` pattern built around the list's
                own bullet, and when the item's leading width is under three, the *first
                literal `3`* in each of those pattern strings, which is always the
                `{0,3}` indent budget, is rewritten down to that width.
              * **Tightness is decided from the child parse.** A tight list has its item
                bodies rewritten from `paragraph` to `block_text`, which this renderer
                emits with no wrapper at all, so a single blank line between two items
                changes the published HTML without changing a word of the text.
              * **A break inside an item is parsed on the outer state** and the list is
                then spliced back in at the token index it recorded, the list-side twin
                of `prepend_token`.

              The oracle is `api/scripts/export_wp_html_list_parity.py`: 113 inputs run
              through the real `markdown_to_wp_html` with its output recorded verbatim
              into `web/src/mastra/wordpress/data/wp-html-list-parity.json`. Nothing in
              the test file is a hand-written expectation.

              ```
              $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_list_parity.py
              wrote 113 cases to /Users/cody/.../web/src/mastra/wordpress/data/wp-html-list-parity.json

              $ cd web && pnpm exec vitest run src/mastra/wordpress/wp-html-lists.test.ts
               ✓ src/mastra/wordpress/wp-html-lists.test.ts (128 tests) 16ms
               Test Files  1 passed (1)
                    Tests  128 passed (128)
              ```

              128 tests: the 113 replay cases, 14 negative controls, and 1 structural
              check on the oracle file itself.

              **The port passed all 78 of the first corpus's cases on its first run**,
              which is not evidence on its own, so every load-bearing branch was mutated
              against the finished implementation to prove the corpus has teeth. All six
              mutations below were run against the final 113-case corpus:

              | Mutation | Result |
              | --- | --- |
              | `_transform_tight_list` made a no-op | 90 failed \| 38 passed |
              | splice-at-`_tok_index` replaced with append | 11 failed \| 117 passed |
              | `{0,3}`-to-leading-width rewrite dropped | 9 failed \| 119 passed |
              | `strip_end` made a no-op | 7 failed \| 121 passed |
              | five-space rule dropped from `_compile_continue_width` | 4 failed \| 124 passed |
              | the `(?<=\n)` prefix on every break alternative dropped | **128 passed** |

              **The indent-budget mutation passed the first 78-case corpus**, so nine
              cases were added to reach it, which is where the 9 failures above come
              from. The rewrite is only observable for a line indented *wider than the
              marker but narrower than the item's continuation width*, and since the
              continuation width is at least the leading width plus one, that window is
              empty unless more than one space follows the marker. `-   one` (three
              spaces, continuation width four) with a two-space-indented `# Title` under
              it is the smallest input that separates the two budgets.

              **The `(?<=\n)` prefix is provably unobservable and is kept anyway.**
              Removing it from every alternative in the per-item break scanner still
              passes all 128 tests, because the scanner is only ever run at a cursor
              that sits after the item's marker line, which cannot be position 0 even in
              a child state. It is kept because Python has it; the ledger records that
              no test covers it rather than pretending one does.

              **`list` is removed from the unported-rule list in
              `wp-html-blocks.test.ts`** (89 tests there now, was 91); `ref_link` and
              `raw_html` still throw there. The block-quote negative control that used
              `> - item` to prove an unported rule inside a quote still stops the
              converter now reads `> <div>raw</div>`, since a quoted list is a replay
              case in the new file; the assertion's intent is unchanged.

              Gates, all from the repo root unless noted:

              ```
              $ cd web && pnpm exec tsc --noEmit
              tsc exit=0

              $ cd web && pnpm lint
              lint exit=0

              $ cd web && pnpm test
               Test Files  3 failed | 105 passed (108)
                    Tests  10 failed | 2565 passed | 7 skipped (2582)

              $ cd web && pnpm build
              ✓ Compiled successfully
              build exit=0

              $ cd api && uv run pytest -q     # .env sourced
              120 failed, 241 passed, 25 errors in 15.21s

              $ cd api && uv run ruff check .
              Found 32 errors.

              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 138 files already formatted

              $ cd api && uv run ruff check scripts/export_wp_html_list_parity.py
              All checks passed!

              $ cd api && uv run ruff format --check scripts/export_wp_html_list_parity.py
              1 file already formatted
              ```

              9 of the 10 frontend failures are the Phase 0 baseline (6 in
              `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`). The tenth is
              `scaffold-check.test.ts > emits the workflow lifecycle events`, the
              already-logged cross-file race on the shared Redis `workflows` topic
              (`todo.md`, four entries), which passes in isolation:

              ```
              $ cd web && pnpm exec vitest run src/mastra/workflows/scaffold-check.test.ts
               ✓ src/mastra/workflows/scaffold-check.test.ts (5 tests) 2662ms
                    Tests  5 passed (5)
              ```

              Adding a 108th test file reshuffles vitest's file scheduling, which is
              enough to change how often it lands; no `wp-html` code touches Redis.
              pytest is above its baseline of 125 failed / 236 passed / 25 errors, and
              ruff's 32 and 9 are the recorded baselines.

## 5.3c-iii-b-1-b-ii-3


              Split, because these are two independent halves with no shared machinery
              and only one of them is directly observable. `raw_html`/`block_html` emits
              a token the renderer prints, so it can be verified byte for byte on its
              own. `ref_link` emits no token at all: it consumes the definition and
              writes `state.env["ref_links"]`, whose only reader is the inline `link`
              rule in -b-iii, and it drags in `escape_url`, which needs Python's
              `urllib.parse.quote` and mistune's CommonMark-flavoured `html.unescape`.

              Closed by -3-b-2: both halves and both of -3-b's sub-items are done,
              with their evidence under each.

## 5.3c-iii-b-1-b-ii-3-a


                `parseRawHtml` in `web/src/mastra/wordpress/wp-html.ts` is the whole
                rule; `parse_block_html` is a one-line delegation to it in Python and is
                a fallthrough `case` here. The oracle is
                `web/src/mastra/wordpress/data/wp-html-html-parity.json`, 86 replay cases
                and 5 declines generated by
                `api/scripts/export_wp_html_html_parity.py` from the real
                `markdown_to_wp_html`.

                ```
                $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_html_parity.py
                wrote 86 cases and 5 declines to .../web/src/mastra/wordpress/data/wp-html-html-parity.json

                $ cd web && npx vitest run src/mastra/wordpress/
                 ✓ src/mastra/wordpress/wordpress-write.test.ts (33 tests) 34ms
                 ✓ src/mastra/wordpress/wordpress.test.ts (57 tests) 35ms
                 ✓ src/mastra/wordpress/wp-html-blocks.test.ts (88 tests) 6ms
                 ✓ src/mastra/wordpress/wp-html-quotes.test.ts (67 tests) 8ms
                 ✓ src/mastra/wordpress/wp-html-raw-html.test.ts (105 tests) 9ms
                 ✓ src/mastra/wordpress/wp-html-lists.test.ts (128 tests) 17ms
                 Test Files  6 passed (6)
                      Tests  478 passed (478)
                $ echo $?
                0
                ```

                **The rule that fires is decided off the tag name alone, before the tag
                is known to be closed.** Rules 1 (`pre`/`script`/`style`/`textarea`) and
                6 (any other `BLOCK_TAGS` name) match `<div` with no `>` on the line, and
                only rule 7 (everything else) checks for a complete tag. That is why
                `<divx>` and `<div>` take different paths despite looking alike, and why
                lowercasing the name before the table lookup is load-bearing.

                **Rules 1 to 5 cross blank lines; rules 6 and 7 do not.** The first five
                scan for a literal end marker (`</script>`, `-->`, `?>`, `>`, `]]>`) and
                then swallow to the end of the line that marker lands on, so a comment
                containing a blank line stays one block. Rules 6 and 7 stop at the next
                blank line and ignore the closing tag entirely, so a `<div>` block
                whose `</div>` is followed by a blank line and then `After.` keeps
                `</div>` inside the raw text and makes `After.` a paragraph.

                **Rule 7 is the only one that can decline**, and its two probes are
                `re.match(src, pos, endpos)` calls bounded to the current line. Python's
                third argument truncates the subject rather than merely limiting the
                match, which also moves where `$` can match, so `boundedMatch()`
                reproduces it by slicing. Without the bound, `<custom-tag\nfoo>` would be
                an HTML block, because `HTML_ATTRIBUTES` begins with `\s+` and so spans
                the newline.

                **Five inputs have no rendered output to compare, because the real
                function crashes on them.** When rule 7 declines, the line falls through
                to the paragraph fallback, whose inline parse produces an `inline_html`
                token, and `_GutenbergRenderer` has no `inline_html` method:

                ```
                $ cd api && PYTHONPATH=. uv run python -c \
                  "from src.services.wp_html import markdown_to_wp_html; markdown_to_wp_html('<custom-tag />\n')"
                AttributeError: No renderer "'inline_html'"
                ```

                That is recorded in the oracle's `declines` array as the expected
                outcome, and the port is asserted to reach the same layer by throwing
                `UnportedMarkdownError` with rule `inline_html` (the inline rules are
                item -b-iii). It is a real defect in the Python service, not an artefact
                of this corpus, and is logged in `todo.md` rather than fixed here.

                **The oracle was hardened with eight mutations**, each a plausible way to
                get the rule wrong. Two survived the first corpus and three more the
                second, and each survivor drove a new case rather than a weaker
                assertion. Final state, run against
                `wp-html-raw-html.test.ts` alone:

                ```
                unmutated                                 Tests  105 passed (105)
                rule 2 stops at a blank line              Tests  2 failed | 103 passed (105)
                rule 1 (pre tags) removed                 Tests  5 failed | 100 passed (105)
                rule 7 may interrupt a paragraph          Tests  2 failed | 103 passed (105)
                rule 7 open-tag match unbounded           Tests  1 failed | 104 passed (105)
                tag name not lowercased                   Tests  3 failed | 102 passed (105)
                rules 1-5 stop at the marker not the line Tests  30 failed | 75 passed (105)
                rule 5 uses rule 4's end marker           Tests  1 failed | 104 passed (105)
                rule 6 not applied to close tags          Tests  2 failed | 103 passed (105)
                restored                                  Tests  105 passed (105)
                ```

                The cases those forced are worth naming, because each is a place where
                two rules produce identical output on the obvious input: `<DIV>` alone
                renders the same under rule 6 and rule 7, so the corpus needed
                `Before.\n<DIV>` (only rule 6 interrupts a paragraph); `</div>` alone is
                likewise ambiguous, so it needed `Before.\n</div>`; and
                `<![CDATA[ a > b ]]>` is ambiguous because both end markers land on the
                same line, so it needed a CDATA block with a bare `>` on an earlier line.

                **Three existing tests changed**, all of them assertions that `raw_html`
                still throws: `wp-html-blocks.test.ts`'s unported-rule table drops its
                `raw_html` row, and the quote and list "still refuses the rules that are
                not ported yet" probes swap `<div>raw</div>` for a `ref_link` definition,
                which is the rule still unported. No expectation was weakened; the
                inputs they used are now replay cases in `wp-html-raw-html.test.ts`.

                Frontend gates. `pnpm test`'s baseline in this worktree is 9 failures (6
                `image-preview.test.tsx`, 3 `PostDetail.test.tsx`); the third run below
                is at exactly that, and the first two show the two documented Redis-race
                flakes (`scaffold-check.test.ts`, then `pipeline-events.test.ts`) that
                `todo.md` already records as load-sensitive:

                ```
                $ cd web && npx tsc --noEmit ; echo $?
                0

                $ cd web && npm run lint ; echo $?
                0

                $ cd web && npm run build ; echo $?
                0

                $ cd web && npx vitest run          # run 1
                 Test Files  3 failed | 106 passed (109)
                      Tests  10 failed | 2670 passed | 7 skipped (2686)
                 ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed)
                 ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed)
                 ❯ src/mastra/workflows/scaffold-check.test.ts (5 tests | 1 failed)

                $ cd web && npx vitest run          # run 2
                 Test Files  3 failed | 106 passed (109)
                      Tests  10 failed | 2669 passed | 7 skipped (2686)
                 ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed)
                 ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed)
                 ❯ src/mastra/pipeline-events.test.ts (40 tests | 1 failed)

                $ cd web && npx vitest run          # run 3
                 Test Files  2 failed | 107 passed (109)
                      Tests  9 failed | 2670 passed | 7 skipped (2686)
                 ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed)
                 ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed)
                ```

                `api/` gains only the exporter script, and its gates are at their
                recorded baselines:

                ```
                $ cd api && uv run pytest -q     # .env sourced
                120 failed, 241 passed, 25 errors in 15.17s

                $ cd api && uv run ruff check .
                Found 32 errors.

                $ cd api && uv run ruff format --check .
                9 files would be reformatted, 139 files already formatted
                ```

## 5.3c-iii-b-1-b-ii-3-b


                Split, because `escape_url` is not part of `ref_link` at all: it is
                `mistune.util` machinery that the inline `link` and `image` rules in
                -b-iii call too, and it is the half that drags in three Python stdlib
                tables and `urllib.parse.quote`. It is also verifiable on its own, as a
                pure function with a direct oracle, whereas `parse_ref_link` writes into
                `state.env` and emits no token, so nothing it produces is observable
                until the inline `link` rule exists.

## 5.3c-iii-b-1-b-ii-3-b-1


                  `web/src/mastra/wordpress/escape-url.ts` exports `unescape` and
                  `escapeUrl`. The three stdlib tables are data, not logic, so
                  `api/scripts/export_wp_html_escape_url_parity.py` writes them verbatim
                  into `web/src/mastra/wordpress/data/html5-entities.json` (2231 entity
                  names, 34 invalid charrefs, 126 invalid codepoints) rather than
                  retyping them, and writes the 89-case oracle plus a 2-case `raises`
                  array into `data/wp-html-escape-url-parity.json`.

                  `escape_url` is not reachable from `markdown_to_wp_html`'s output yet
                  (its only callers are `parse_ref_link` and the inline link rules), so
                  the oracle calls `mistune.util.escape_url` and `mistune.util.unescape`
                  directly instead of going through the converter.

                  ```
                  $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_escape_url_parity.py
                  wrote 2231 entities, 34 invalid charrefs and 126 invalid codepoints to
                  .../web/src/mastra/wordpress/data/html5-entities.json
                  wrote 89 cases and 2 raises to
                  .../web/src/mastra/wordpress/data/wp-html-escape-url-parity.json
                  ```

                  ```
                  $ pnpm -C web exec vitest run src/mastra/wordpress/escape-url.test.ts
                   ✓ src/mastra/wordpress/escape-url.test.ts (103 tests) 5ms

                   Test Files  1 passed (1)
                        Tests  103 passed (103)
                  ```

                  **Mutation table.** The 89 generated cases passed on the first run, so
                  the implementation was mutated to prove they have teeth. Ten
                  mutations, the last two of which survived:

                  | Mutation | Result |
                  | --- | --- |
                  | Look the entity name up with `in` on the imported JSON object instead of a `Map` | 6 failed |
                  | Longest-prefix loop runs down to `x > 0` instead of `x > 1` | **survived** |
                  | Trailing `;` made optional in the entity-name alternative | 2 failed |
                  | Lower-case percent hex | 39 failed |
                  | Percent encode UTF-16 code units instead of UTF-8 bytes | 19 failed |
                  | Check `_invalid_codepoints` before `_invalid_charrefs` | 2 failed |
                  | Drop `%` from the safe set | 3 failed |
                  | Drop the surrogate-range check | 2 failed |
                  | Drop the `.rstrip(";")` on the numeric digits | 10 failed |
                  | Drop the big-hex guard and call `parseInt` unconditionally | **survived** |

                  The big-hex guard was dead and is now deleted, the same call this
                  port has made before for a guard a control proved unreachable:
                  `parseInt` on a hex string past 13 digits rounds (or returns
                  `Infinity`), and both still compare greater than `0x10FFFF`,
                  which is the only question the code asks. It can never round a value
                  *down* across the boundary, because a value near `0x10FFFF` needs at
                  most six significant digits and is exact.

                  **Recorded as uncovered:** the longest-prefix loop's lower bound.
                  `range(len(s) - 1, 1, -1)` deliberately refuses to consider a
                  one-character prefix, but `html.entities.html5` has no one-character
                  name (its shortest four are `GT`, `gt`, `LT`, `lt`), so no input can
                  tell `x > 1` from `x > 0`. Kept faithful rather than papered over.

                  ```
                  $ cd api && uv run python -c "from html.entities import html5; print([k for k in html5 if len(k) == 1])"
                  []
                  ```

                  **Deviation: a lone surrogate no longer crashes the converter.**
                  `urllib.parse.quote` encodes with `errors='strict'`, so
                  `escape_url("\ud800")` raises `UnicodeEncodeError` and the crash
                  escapes `markdown_to_wp_html`. `TextEncoder` has no strict mode and
                  substitutes U+FFFD, so this port returns `%EF%BF%BD`. That removes an
                  error path rather than adding one. Both inputs are pinned in the
                  oracle's `raises` array and asserted by the "substitutes U+FFFD where
                  Python raised UnicodeEncodeError" test.

                  **Note on the `Map`.** The entity names come from user text and the
                  lookup is by name, so a plain-object lookup resolves every
                  `Object.prototype` key: `&constructor;` would unescape to the source
                  of `Object`. Python has no such hazard. Five prototype keys are in the
                  generated corpus and six in a hand-written control; mutation 1 above
                  is that bug, and it fails loudly.

                  Gates, all from the repo root:

                  ```
                  $ pnpm -C web exec tsc --noEmit
                  (exit 0, no output)

                  $ pnpm -C web lint
                  > content-pipeline-dashboard@0.1.0 lint
                  > eslint
                  (exit 0, no output)

                  $ pnpm -C web test
                   Test Files  2 failed | 108 passed (110)
                        Tests  9 failed | 2773 passed | 7 skipped (2789)

                  $ pnpm -C web build
                  ○  (Static)   prerendered as static content
                  ●  (SSG)      prerendered as static HTML (uses generateStaticParams)
                  ƒ  (Dynamic)  server-rendered on demand
                  (exit 0)
                  ```

                  9 failures is the recorded frontend baseline (6 `image-preview`, 3
                  `PostDetail`). A second run of the same suite reported 10, the extra
                  one being the known `scaffold-check` Redis race; both failure sets are
                  entirely pre-existing files.

                  Backend baselines unchanged. `pytest` was also run with this
                  iteration's files stashed and reported the identical numbers, which is
                  what proves those failures are pre-existing rather than caused here.
                  Nothing in this iteration is importable by the backend anyway: the
                  only Python file added is a `scripts/` exporter that no test loads.

                  ```
                  $ cd api && uv run pytest -q
                  120 failed, 241 passed, 25 errors in 14.98s

                  $ cd api && uv run ruff check .
                  Found 32 errors.

                  $ cd api && uv run ruff format --check .
                  9 files would be reformatted, 140 files already formatted
                  ```

                  The formatted-file count moves from 139 to 140 because of the new
                  exporter, which was run through `ruff format` and `ruff check` before
                  it generated the committed data.

## 5.3c-iii-b-1-b-ii-3-b-2


                  `web/src/mastra/wordpress/wp-html.ts` gains `parseRefLink`,
                  `parseLinkHref` (its `block=True` form), `parseLinkTitle`, `unikey`,
                  the four helper patterns and `BlockState.env`, which is shared with
                  the parent state so a definition inside a block quote or list item is
                  visible to the whole document. This finishes the block layer: every
                  rule in `BlockParser.DEFAULT_RULES` is now ported and only the inline
                  rules are left (item -b-iii).

                  `parse_ref_link` is the one block rule that emits no token, so the
                  rendered HTML only shows whether the definition line was consumed.
                  The definition itself is asserted through the new exported
                  `parseRefLinks`, which stops after the block parse exactly where
                  Python fills the env. Both channels are compared for every case.

                  **Command run and its real output.** Generate the oracle:

                  ```
                  $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_ref_link_parity.py
                  wrote 99 cases and 24 declines to /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/mastra/wordpress/data/wp-html-ref-link-parity.json
                  ```

                  **Failing first.** With `parse_ref_link` still the pre-port stub that
                  throws `UnportedMarkdownError`, the new suite fails:

                  ```
                  $ pnpm -C web exec vitest run src/mastra/wordpress/wp-html-ref-link.test.ts
                   Test Files  1 failed (1)
                        Tests  237 failed | 16 passed (253)
                  ```

                  (The 16 that passed are the oracle-shape check and the 15 decline
                  cases, which expect a throw either way.)

                  **Passing.** With the port in place, and after eight further corpus
                  cases were added to kill mutation 16 below:

                  ```
                  $ pnpm -C web exec vitest run src/mastra/wordpress/wp-html-ref-link.test.ts
                   Test Files  1 passed (1)
                        Tests  261 passed (261)
                  ```

                  ```
                  $ pnpm -C web exec vitest run src/mastra/wordpress/
                   Test Files  8 passed (8)
                        Tests  841 passed (841)
                  ```

                  **The oracle has teeth.** Sixteen mutations of the finished
                  implementation, each run against the full 261-test suite:

                  | # | Mutation | Tests failed |
                  | --- | --- | --- |
                  | 1 | `ref_link` may interrupt a paragraph (drop `appendParagraph`) | 6 |
                  | 2 | `unikey` upper-cases without the lower-case step | 1 |
                  | 3 | `unikey` trims instead of collapsing whitespace | 6 |
                  | 4 | href end position is never backed off | 174 |
                  | 5 | href end position is always backed off | **0** |
                  | 6 | angle bracket href allows a backslash | 3 |
                  | 7 | title scan ignores the blank-line bound (`match` not `boundedMatch`) | 3 |
                  | 8 | title keeps its backslash escapes (drop `unescapeChar`) | 2 |
                  | 9 | no end-of-line check after the title | 2 |
                  | 10 | no end-of-line check after the href | 11 |
                  | 11 | the last definition for a key wins (drop `has`) | 8 |
                  | 12 | an empty title is stored (`!== undefined` not truthiness) | 3 |
                  | 13 | href is not unescaped before encoding | 3 |
                  | 14 | end position prefers the href over the title | 22 |
                  | 15 | a child state gets its own env | 8 |
                  | 16 | bare href uses JavaScript's `\s` instead of Python's | 6 (was 0) |

                  Mutation 16 survived the first corpus, because Python's `\s` and
                  JavaScript's differ only on `\x1c`-`\x1f`, `\x85` and `\ufeff` and no
                  case used one. Four cases were added and it now fails 6 tests:
                  `[a]: /ur\ufeffl` is accepted by Python (the mark stays in the href
                  and is percent encoded) and refused by a `\s`-based port, and
                  `[a]: /ur\x85l`, `[a]: /ur\x1cl` and `[a]: /ur\xa0l` are the reverse.

                  **Mutation 5 is unreachable, and is kept for faithfulness rather than
                  papered over.** `LINK_HREF_BLOCK_RE` ends `(?:\s|$)`, and the ordered
                  alternation means `$` is only reached when there is no whitespace at
                  all after the href, that is when the href runs to the very end of
                  `state.src`. The off-by-one that `$` enables is therefore reachable
                  only from a block state whose `src` lacks a trailing newline. Fuzzing
                  3928 documents built from list, quote, code and definition fragments
                  found no such state:

                  ```
                  $ cd api && PYTHONPATH=. uv run python -c "<instrument BlockState.process, fuzz 4000 documents>"
                  docs: 3928 states whose src lacks a trailing newline: 0
                  ```

                  and instrumenting `parse_link_href` over all 123 corpus inputs
                  confirms the branch is never taken:

                  ```
                  $ cd api && PYTHONPATH=. uv run python -c "<instrument helpers.parse_link_href over the corpus>"
                  EOS-branch hits: 0 of 109
                  ```

                  **Three existing probes were retargeted, not deleted.**
                  `wp-html-blocks.test.ts` had a one-entry table asserting that
                  `ref_link` throws; with the block layer complete that table is gone and
                  its describe comment now records the full history (`block_quote` at
                  -ii-1, `list` at -ii-2, `raw_html` at -ii-3-a, `ref_link` here). The
                  "still refuses unported rules" probes in `wp-html-quotes.test.ts` and
                  `wp-html-lists.test.ts` used `> [label]: https://example.com` and
                  `- [label]: https://example.com` as their unported construct; both are
                  now replay cases in the new oracle, so both probes swap to
                  `an *emphasised* word`, which is the inline `emphasis` rule and still
                  unported. No assertion was weakened.

                  **Twelve hand-written controls**, added after the replay passed and
                  each checked against the real Python function before being committed:

                  ```
                  $ cd api && PYTHONPATH=. uv run python -c "<call the real block parser on each control input>"
                  '[constructor]: /url\n' -> {"CONSTRUCTOR": {"url": "/url", "label": "constructor"}}
                  '> [a]: /inside\n\n[b]: /outside\n' -> {"A": {"url": "/inside", "label": "a"}, "B": {"url": "/outside", "label": "b"}}
                  '[a]: /x?u=&amp;v=&lt;\n' -> {"A": {"url": "/x?u=&v=%3C", "label": "a"}}
                  '[a]: /url\\_x\n' -> {"A": {"url": "/url_x", "label": "a"}}
                  '[a]: /url\\x\n' -> {"A": {"url": "/url%5Cx", "label": "a"}}
                  '[a]: /url ""\n' -> {"A": {"url": "/url", "label": "a"}}
                  '[  Foo   Bar  ]: /url\n' -> {"FOO BAR": {"url": "/url", "label": "  Foo   Bar  "}}
                  '[a]: /url x\n' -> {}
                  '[a]: /url\n\n"title"\n' -> {"A": {"url": "/url", "label": "a"}}
                  '[a]: /url\n"title"\n' -> {"A": {"url": "/url", "label": "a", "title": "title"}}
                  '[a]: <a\\b>\n' -> {}
                  '[a]: <>\n' -> {"A": {"url": "", "label": "a"}}
                  ```

                  **Gates.** Frontend:

                  ```
                  $ pnpm -C web exec tsc --noEmit
                  tsc exit=0
                  $ pnpm -C web lint
                  lint exit=0
                  $ pnpm -C web test   (three consecutive runs, for the known flake)
                   Test Files  3 failed | 108 passed (111)   Tests  10 failed | 3032 passed | 7 skipped (3049)
                   Test Files  2 failed | 109 passed (111)   Tests   9 failed | 3033 passed | 7 skipped (3049)
                   Test Files  3 failed | 108 passed (111)   Tests  10 failed | 3032 passed | 7 skipped (3049)
                  $ pnpm -C web build
                  build exit=0
                  ```

                  The 9-failure floor is the recorded baseline: the 6 known
                  `image-preview.test.tsx` failures plus 3 flaky `PostDetail.test.tsx`
                  tests. No `src/mastra/wordpress/` test is among them.

                  Backend, unchanged at its baseline (this iteration adds one script
                  under `api/scripts/`, which was run through `ruff format` and
                  `ruff check --fix` before committing):

                  ```
                  $ cd api && uv run pytest -q
                  120 failed, 241 passed, 25 errors in 15.13s
                  $ cd api && uv run ruff check .
                  Found 32 errors.
                  $ cd api && uv run ruff format --check .
                  9 files would be reformatted, 141 files already formatted
                  $ cd api && uv run ruff check scripts/export_wp_html_ref_link_parity.py
                  All checks passed!
                  $ cd api && uv run ruff format --check scripts/export_wp_html_ref_link_parity.py
                  1 file already formatted
                  ```

## 5.3c-iii-b-1-b-iii


            **Split into four.** The nine rules do not sit at one level of difficulty.
            Two of them need nothing from the inline state at all, three read one flag
            off it, one needs the precedence scan, and two need three link helpers plus
            the reference-link env the block layer already fills. Splitting along what
            each rule needs from the state keeps every sub-item independently
            verifiable against its own oracle:

            * -iii-a `escape` and `codespan`, plus the inline state, the inline scan
              loop and the `codespan` renderer method. Carries the backtick-info-string
              fence case moved out of the -b-i corpus, because a codespan is what that
              paragraph renders to.
            * -iii-b `auto_link`, `auto_email` and `inline_html`, plus the `link`
              renderer method the two autolinks emit into and the `in_link` flag
              `inline_html` toggles. `_GutenbergRenderer` has no `inline_html` method,
              so that token raises; the oracle has to pin the raise, not an HTML string.
            * -iii-c `emphasis` and `strong`, plus their renderer methods and
              `precedence_scan`, which is what stops a codespan or a tag from being cut
              in half by an emphasis run that opened before it.
            * -iii-d `link` and `image`, plus `parse_link_label`, `parse_link_text` and
              `parse_link`, the `in_link` / `in_image` guards, the reference-link
              lookup against `state.env['ref_links']`, and the `link` and `image`
              renderer methods.

## 5.3c-iii-b-1-b-iii-a


              `web/src/mastra/wordpress/wp-html.ts` gains `InlineState` (the four
              nesting flags, `copy()`, `append_token`, and the `env` shared with the
              block state), `process_text`, `parse_method`'s dispatch, `InlineParser.parse`
              including its decline branch, `parse_escape`, `parse_codespan` and the
              renderer's `codespan` case. The two rules ported here are the two that
              read nothing off the state, which is why they come first.

              `escape` matches a *run* of backslash-plus-punctuation and emits one text
              token with the backslashes removed, so `\*` never reaches `emphasis`.
              `codespan` compiles a closing pattern per opening run, so three backticks
              do not close two and the character before the closing run may not itself
              be a backtick; the captured code has its newlines folded to spaces and one
              space taken off each end, but only when the code is not entirely
              whitespace.

              **Oracle.** `api/scripts/export_wp_html_inline_escape_codespan_parity.py`
              writes 95 cases to
              `web/src/mastra/wordpress/data/wp-html-inline-escape-codespan-parity.json`,
              every one of them the real `markdown_to_wp_html`'s output. The script
              replays the TypeScript scan loop over each parsed paragraph and refuses to
              write a case that reaches `emphasis`, `link`, `auto_link`, `auto_email` or
              `inline_html`, so there is no bucket of pinned-for-later cases here: every
              case is one the port renders today. The replay skips a codespan the way
              the handler does, which is what lets `` `<div>` `` be a case rather than an
              `inline_html` blocker.

              ```
              $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_inline_escape_codespan_parity.py
              wrote 95 cases to /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/mastra/wordpress/data/wp-html-inline-escape-codespan-parity.json
              $ cd api && uv run ruff check scripts/export_wp_html_inline_escape_codespan_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_wp_html_inline_escape_codespan_parity.py
              1 file already formatted
              ```

              ```
              $ pnpm -C web exec vitest run src/mastra/wordpress/wp-html-inline-escape-codespan.test.ts
               Test Files  1 passed (1)
                    Tests  109 passed (109)
              ```

              **A divergence the corpus found, and the fix.** `markdownToWpHtml` and
              `parseRefLinks` both spelled Python's document-level `content.strip()` as
              `content.trim()`, and `parse_fenced_code` spelled `info.strip()` as
              `info.trim()`. `String.prototype.trim` strips `\ufeff`; Python's
              `str.strip()` does not, because `"\ufeff".isspace()` is false. So a
              paragraph ending in a byte order mark lost it in TypeScript and kept it in
              Python. The three sites now call a new `pyStrip`, built from the
              `PY_SPACE` class the file already had. The case that found it is in the
              corpus:

              ```
              'a `b`\ufeff\n'
                -> '<!-- wp:paragraph -->\n<p>a <code>b</code>\ufeff</p>\n<!-- /wp:paragraph -->\n\n'
              ```

              The three sibling `.trim()` calls left in the file (`quote.trim() === ""`,
              `!src.trim()`, `!text.trim()`) are truthiness tests, not values, and
              `\ufeff` cannot change any of their answers.

              **Two tests updated, not deleted.** `wp-html-blocks.test.ts` asserted that
              `escape` and `codespan` *throw*, and that a fence whose backtick info
              string holds a backtick throws on the way to the paragraph fallback. Both
              assertions were correct for the state of the port and are wrong now that
              these two rules render. The rule list now names `auto_email` and
              `inline_html` in their place, and the fence case asserts the real Python
              output:

              ```
              '```a`b\nx\n```\n'
                -> '<!-- wp:paragraph -->\n<p>```a`b\nx</p>\n<!-- /wp:paragraph -->\n\n'
                   '<!-- wp:code -->\n<pre class="wp-block-code"><code></code></pre>\n<!-- /wp:code -->\n\n'
              ```

              **Mutations.** Each applied to `wp-html.ts` alone, with the corpus and the
              controls unchanged, then reverted. Twelve of thirteen are caught:

              | Mutation | Result |
              | --- | --- |
              | codespan: do not fold newlines inside the code to spaces | 3 failed |
              | codespan: strip the end spaces even when the code is all whitespace | 3 failed |
              | codespan: strip an end space when only one end has one | 6 failed |
              | codespan: let a backtick sit before the closing run | 2 failed |
              | codespan: drop the negative lookahead after the closing run | 2 failed |
              | codespan: an unclosed marker consumes nothing instead of emitting text | 8 failed |
              | escape: keep the backslashes in the emitted text | 39 failed |
              | escape: match one escape rather than a run | **survives** |
              | renderer: html escape the ampersand in a codespan | 3 failed |
              | loop: emit the text hole after the token instead of before it | 52 failed |
              | loop: drop the trailing text run after the last token | 41 failed |
              | loop: strip the inline source with `trim()` instead of Python's set | 5 failed |
              | wrapper: strip the document with `trim()` instead of `pyStrip` | 1 failed (this is the divergence above) |

              The survivor is genuinely unobservable rather than untested. Matching one
              escape at a time emits `{text "*"}, {text "_"}` where the run emits
              `{text "*_"}`, and `_GutenbergRenderer.text` concatenates, so no input can
              tell the two apart through this renderer. Recorded rather than papered
              over with a test that asserts on token shape the renderer never sees.

              **Gates.** Frontend:

              ```
              $ pnpm -C web exec tsc --noEmit
              tsc exit=0
              $ pnpm -C web lint
              lint exit=0
              $ pnpm -C web test   (three consecutive runs, for the known flake)
               Test Files  2 failed | 110 passed (112)   Tests   9 failed | 3142 passed | 7 skipped (3158)
               Test Files  3 failed | 109 passed (112)   Tests  10 failed | 3141 passed | 7 skipped (3158)
               Test Files  2 failed | 110 passed (112)   Tests   9 failed | 3142 passed | 7 skipped (3158)
              $ pnpm -C web build
              build exit=0
              ```

              The 9-failure floor is the recorded baseline: the 6 known
              `image-preview.test.tsx` failures plus 3 flaky `PostDetail.test.tsx`
              tests. No `src/mastra/wordpress/` test is among them. Total test count
              rises 3049 -> 3158 with this item's 109.

              Backend, unchanged at its baseline (this iteration adds one script under
              `api/scripts/`, formatted and linted above):

              ```
              $ cd api && set -a && . ../.env && set +a && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.07s
              $ cd api && uv run ruff check .
              Found 32 errors.
              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 142 files already formatted
              ```

              Note on the pytest invocation: without the repo `.env` sourced, every
              database test fails with `InvalidPasswordError` and the run reports
              `4 failed, 205 passed, 177 errors`. The baseline numbers above are the
              env-sourced run.

## 5.3c-iii-b-1-b-iii-b


              `web/src/mastra/wordpress/wp-html.ts` gains `parseAutoLink`,
              `parseAutoEmail`, `addAutoLink`, `parseInlineHtml`, their three dispatch
              arms, the renderer's `link` case and `MissingRendererError`. Two small
              exports were added for the parity surfaces the rendered HTML cannot
              reach: `parseInlineTokens` and `renderTokens`.

              **These three rules are the `in_link` rules, and `in_link` has no output
              of its own.** Inside an anchor an autolink is not a link, it is the
              literal text it was written as, so `<a href="/x"><https://e.example>`
              yields a text token. The rule that sets the flag is `inline_html`, and
              that is also the one inline token `_GutenbergRenderer` has no method for,
              so mistune's `BaseRenderer._get_method` raises
              `AttributeError: No renderer "'inline_html'"` before anything is
              rendered. The flag is therefore unobservable through
              `markdown_to_wp_html`, which is why the oracle has three corpora rather
              than one.

              **Oracle.** `api/scripts/export_wp_html_inline_autolink_parity.py` writes
              `web/src/mastra/wordpress/data/wp-html-inline-autolink-parity.json`:

              * 81 `html_cases`, whole documents through the real
                `markdown_to_wp_html`. 66 pin the HTML, 15 pin the `AttributeError`.
              * 19 `token_cases`, single inline strings through mistune's own
                `InlineParser.__call__`. This is the only surface `in_link` is visible
                on.
              * 6 `render_cases`, single `link` tokens through
                `_GutenbergRenderer.link`. `_add_auto_link` never sets a title, so the
                method's title branch has no input until the `link` rule lands in
                -iii-d; pinning it against the real method now keeps the ported method
                whole rather than half written.

              The script refuses to write any case that reaches `emphasis` or `link`,
              the two rules still unported, so nothing here is a silently pinned
              expectation.

              Four behaviours worth naming, each pinned by a case and a mutation:

              1. `escape_url` runs on the href and on the href only. It is
                 `quote(unescape(link))`, so `<https://e.example/?a=1&amp;b=2>` gets a
                 href of `?a=1&b=2` while the label keeps the entity it was written
                 with, and a non-ASCII path is percent encoded in the href alone.
              2. Rule order breaks the tie at one offset: `auto_link` is listed before
                 `auto_email`, so `<mailto:a@example.com>` is an autolink whose label
                 keeps the scheme, not an email whose label drops it.
              3. Python matches the four literal prefixes `"<a "`, `"<a>"`, `"<A "`,
                 `"<A>"` rather than parsing the tag, so `<a\n>` is a valid opening
                 anchor that toggles nothing. The port copies the literals.
              4. `_GutenbergRenderer.text` returns `raw`, so a string that fails every
                 inline rule reaches the paragraph with its angle brackets unescaped:
                 `<a:x>` renders as `<p><a:x></p>`.

              **A case-naming correction found while building the corpus.** Two cases
              were written expecting `<span>a</span>` and `<a href="/x">y</a>` on their
              own line to be block HTML. They are not. Block rule kind 6 needs a block
              tag name, and kind 7 needs the tag alone on its line, so both decline,
              fall back to a paragraph and raise out of the inline layer. The cases were
              renamed to say so and two genuinely-block variants (`<div>a</div>`,
              `<span>\na\n</span>`) were added beside them.

              **Three existing tests changed, because the behaviour they asserted is
              the behaviour this item implements.** `wp-html-blocks.test.ts` and
              `wp-html-inline-escape-codespan.test.ts` each listed `auto_link`,
              `auto_email` and `inline_html` among the rules that throw
              `UnportedMarkdownError`; those three entries are removed and `emphasis`
              and `link` remain. `wp-html-raw-html.test.ts`'s five rule-7 decline cases
              asserted `UnportedMarkdownError("inline_html")`; they now assert
              `MissingRendererError` with `tokenType === "inline_html"`, which is
              exactly where and why Python fails on the same input. No expectation was
              weakened.

              ```
              $ cd api && PYTHONPATH=. uv run python \
                  scripts/export_wp_html_inline_autolink_parity.py
              wrote 81 html cases (15 of them raising) and 19 token cases and 6 render
              cases to .../web/src/mastra/wordpress/data/wp-html-inline-autolink-parity.json

              $ cd web && pnpm exec vitest run src/mastra/wordpress/wp-html-inline-autolink.test.ts
               ✓ src/mastra/wordpress/wp-html-inline-autolink.test.ts (121 tests) 8ms
               Test Files  1 passed (1)
                    Tests  121 passed (121)

              $ cd web && pnpm exec vitest run src/mastra/wordpress/
               Test Files  10 passed (10)
                    Tests  1068 passed (1068)
              ```

              **Mutation testing.** Thirteen mutations of the new code, each run against
              the whole `src/mastra/wordpress/` suite. All thirteen were caught:

              ```
              $ python3 /tmp/mut_autolink.py
              CAUGHT  auto_link ignores in_link
              CAUGHT  auto_link keeps the closing bracket
              CAUGHT  auto_email drops the mailto scheme
              CAUGHT  auto_email ignores in_link
              CAUGHT  href is not escaped
              CAUGHT  label is escaped too
              CAUGHT  open anchor is matched by prefix rather than literals
              CAUGHT  close anchor never clears in_link
              CAUGHT  inline_html renders instead of raising
              CAUGHT  link renderer always emits a title
              CAUGHT  link renderer treats an empty title as present
              CAUGHT  auto_email is tried before auto_link
              CAUGHT  inline_html does not advance past the tag
              exit=0
              ```

              **Gates.** Frontend:

              ```
              $ cd web && pnpm exec tsc --noEmit
              tsc exit=0
              $ cd web && pnpm lint
              lint exit=0
              $ cd web && pnpm test   (three consecutive runs)
               Test Files  2 failed | 111 passed (113)   Tests   9 failed | 3260 passed | 7 skipped (3276)
               Test Files  3 failed | 110 passed (113)   Tests  10 failed | 3259 passed | 7 skipped (3276)
               Test Files  2 failed | 111 passed (113)   Tests   9 failed | 3260 passed | 7 skipped (3276)
              $ cd web && pnpm build
              build exit=0
              ```

              The 9-failure floor is the recorded baseline: the 6 known
              `image-preview.test.tsx` failures plus 3 flaky `PostDetail.test.tsx`
              tests. The tenth failure in the middle run is
              `scaffold-check.test.ts > emits the workflow lifecycle events the trace
              view will read`, already logged in `todo.md` as an intermittent. No
              `src/mastra/wordpress/` test is among any of them. Total test count rises
              3158 -> 3276: this item's 121 new tests, less the 3 removed entries from
              the two unported-rule lists.

              Backend, unchanged at its baseline (this iteration adds one script under
              `api/scripts/`, formatted and linted below):

              ```
              $ cd api && set -a && . ../.env && set +a && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.08s
              $ cd api && uv run ruff check .
              Found 32 errors.
              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 143 files already formatted
              $ cd api && uv run ruff check scripts/export_wp_html_inline_autolink_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_wp_html_inline_autolink_parity.py
              1 file already formatted
              ```

## 5.3c-iii-b-1-b-iii-c


              `web/src/mastra/wordpress/wp-html.ts` gains `parse_emphasis`,
              `EMPHASIS_END_RE`'s six patterns, `precedence_scan`, the
              `prec_auto_link` and `prec_inline_html` specification entries, the
              `emphasis` and `strong` renderer cases, and an `applyInlineRule`
              split out of `parse_method` because `precedence_scan` reaches the
              same table by rule name rather than by group participation.

              **One rule, two token types.** `parse_emphasis` reads the marker
              length: one `*` inside an emphasis and two inside a strong are
              literal text rather than a second nesting, and three open both
              flags at once and emit a `strong` wrapped in an `emphasis`. The
              span reaches to whatever `EMPHASIS_END_RE` finds first and the text
              between is re-parsed with the matching flag set, so the guard binds
              to the children and not to the rest of the paragraph. `*a *b* c*`
              is therefore `<em>a *b</em> c*` and not `<em>a *b* c</em>`.

              **`precedence_scan` is what stops an emphasis run from cutting a
              codespan, an autolink or a tag in half.** It looks inside the span
              for one of those openers, runs that rule from where it starts
              against the whole source, and if the rule ends at or past the
              emphasis closer the emphasis never happens: the scanned characters
              become one text token and the winner's tokens follow. A rule that
              ends short of the closer changes nothing. Python's
              `sc.search(src, pos, endpos)` truncates the subject, so the port
              searches `state.src.slice(0, endPos)`, while the second, anchored
              match runs against the untruncated source; swapping either one is
              caught by the corpus.

              **Two Python regex escapes had to be spelled out, and the file was
              already wrong about one of them.** `INLINE_SPECIFICATION.emphasis`
              read `\b_{1,3}(?=[^\s_])`, which is Python source, not JavaScript:
              Python's `\b` is Unicode aware and Python's `\s` is `str.isspace()`'s
              set. `\w` was verified exhaustively against CPython over every code
              point and is exactly `[\p{L}\p{N}_]`, so `\b` before or after an
              underscore becomes a lookaround on that class, and every inline
              pattern is now compiled with the `u` flag. Without the fix
              `café_a_` renders an emphasis in TypeScript and does not in Python.
              `prec_auto_link`'s `\d` is `[Nd]`, spelled `\p{Nd}`.

              `linebreak` and `softbreak` still spell `\s` the JavaScript way.
              That is out of this item's scope and is logged in `todo.md`.

              **Oracle.** `api/scripts/export_wp_html_inline_emphasis_parity.py`
              writes three corpora to
              `web/src/mastra/wordpress/data/wp-html-inline-emphasis-parity.json`:
              75 whole-document `html_cases` of which 2 pin the `AttributeError`
              a precedence scan won by a tag produces, 14 `token_cases` through
              mistune's own `InlineParser.__call__` for the nesting the rendered
              HTML flattens, and 7 `render_cases` for the two renderer methods'
              empty-children branch. The guard against pinning an unported rule
              changed shape this iteration: instead of replaying the scan loop by
              hand it wraps mistune's `_methods` table, which both `parse_method`
              and `precedence_scan` dispatch through, so a case whose *precedence
              scan* reaches the unported `link` rule is refused too.

              ```
              $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_inline_emphasis_parity.py
              wrote 75 html cases (2 of them raising) and 14 token cases and 7 render cases to
              .../web/src/mastra/wordpress/data/wp-html-inline-emphasis-parity.json

              $ pnpm -C web vitest run src/mastra/wordpress/wp-html-inline-emphasis.test.ts
               Test Files  1 passed (1)
                    Tests  110 passed (110)

              $ pnpm -C web vitest run src/mastra/wordpress/
               Test Files  11 passed (11)
                    Tests  1179 passed (1179)
              ```

              **Four existing tests changed, because the behaviour they pinned is
              what this item implements.** `wp-html-blocks.test.ts` no longer
              lists `emphasis` as throwing and asserts the real Python HTML for
              `an *emphasised* word` instead; the unported-rule loops in
              `wp-html-inline-escape-codespan.test.ts` and
              `wp-html-inline-autolink.test.ts` drop the `emphasis` row, leaving
              `link`; and the "still refuses" controls in `wp-html-lists.test.ts`
              and `wp-html-quotes.test.ts` swap their `*emphasised*` input for a
              `[link](/b)` one.

              **Mutations.** Twenty-four applied one at a time against
              `pnpm -C web vitest run src/mastra/wordpress/`; twenty-two failed
              the suite.

              | Mutation | Result |
              | --- | --- |
              | drop the `in_emphasis` guard | caught |
              | drop the `in_strong` guard | caught |
              | triple marker sets only `in_emphasis` | caught |
              | triple marker nests `emphasis` inside `strong` | caught |
              | word boundary uses JavaScript's ASCII `\w` | caught |
              | closing underscore uses a bare `\b` | caught |
              | opening lookahead uses JavaScript's `\s` | caught |
              | closing head uses JavaScript's `\s` | caught |
              | closing star run drops the one-more-star lookahead | caught |
              | closing head drops the escaped-marker alternative | caught |
              | closing head allows whitespace before the marker | caught |
              | precedence scan never runs | caught |
              | precedence scan searches past the closer | caught |
              | precedence scan accepts a winner that stops at the closer | caught |
              | precedence scan text token starts at the marker end | caught |
              | precedence scan runs the winner against the truncated source | caught |
              | precedence scan winner parses an empty source | caught |
              | precedence rules put the tag scan before the codespan | caught |
              | emphasis text keeps the whole closing run | caught |
              | emphasis renderer emits `<i>` | caught |
              | strong renderer emits `<b>` | caught |
              | `prec_auto_link` uses ASCII digits | **survived, unobservable** |
              | emphasis end pattern searched from the marker start | **survived, unobservable** |

              Both survivors are genuinely unobservable rather than untested.
              `prec_auto_link`'s `\p{Nd}`: the only strings where it and its ASCII
              spelling disagree contain a non-ASCII digit inside the scheme, and
              `auto_link`'s own pattern is ASCII-only, so `parse_auto_link` can
              never succeed there; `prec_inline_html` matches at the same offset
              whenever `prec_auto_link` does, and its rule cannot succeed there
              either, because the character that broke the scheme also breaks the
              tag. Searching the end pattern from `m.start()` instead of `m.end()`:
              the closing head is `[^\s*]` or `[^\s_]`, which cannot match a
              marker character, and every position between the two is a marker
              character, so the first candidate is `m.end()` either way.

              Gates, both stacks:

              ```
              $ pnpm -C web tsc --noEmit
              TSC EXIT=0

              $ pnpm -C web lint
              LINT EXIT=0

              $ pnpm -C web test
               Test Files  3 failed | 111 passed (114)
                    Tests  10 failed | 3370 passed | 7 skipped (3387)
              (the Phase 0 baseline of 9: 6 in image-preview.test.tsx and 3 in
              PostDetail.test.tsx, plus the known scaffold-check.test.ts flake already
              logged in todo.md. That file passes 5/5 in isolation:
                $ pnpm -C web vitest run src/mastra/workflows/scaffold-check.test.ts
                 Test Files  1 passed (1)
                      Tests  5 passed (5))

              $ pnpm -C web build
              BUILD EXIT=0

              $ cd api && uv run pytest -q          # with the repo .env sourced
              120 failed, 241 passed, 25 errors in 15.13s

              $ cd api && uv run ruff check .
              Found 32 errors.
              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 144 files already formatted
              $ cd api && uv run ruff check scripts/export_wp_html_inline_emphasis_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_wp_html_inline_emphasis_parity.py
              1 file already formatted
              ```

## 5.3c-iii-b-1-b-iii-d


              Done. `web/src/mastra/wordpress/wp-html.ts` gains `parseLinkLabel`,
              `parseLinkText`, `parseLinkAttrs` (mistune's `helpers.parse_link`),
              `parseLinkToken`, `parseLinkRule` and the `image` renderer case;
              `parseLinkHref` grows the `block` parameter it was written without, so the
              inline `LINK_HREF_INLINE_RE` branch now shares it with the block one.
              `PREVENT_BACKSLASH` moved up beside `PUNCTUATION` because the inline href
              and square-bracket patterns need it before the inline section runs.

              **This finishes `markdown_to_wp_html`.** Every rule in
              `BlockParser.DEFAULT_RULES` and `InlineParser.DEFAULT_RULES` is ported, so
              `UnportedMarkdownError` had no throw site left and is deleted along with
              `UNPORTED_INLINE_RULES`; the six test files that asserted a refusal now
              assert the real Python output instead. `MissingRendererError` stays: it is
              where mistune raises `AttributeError` for an `inline_html` token, which is
              a renderer gap rather than a parser one.

              **One real divergence found and fixed.** `helpers.LINK_LABEL` spells
              `\\.` and Python's `.` without `re.S` is exactly `[^\n]`, while
              JavaScript's also refuses `\r`, U+2028 and U+2029. A backslash before a
              line separator is therefore inside a label to mistune and would have ended
              it here, so the class is spelled out. Reachable through both layers, since
              `LINK_LABEL` is also in the block `ref_link` pattern: with the JavaScript
              dot, `[a\<U+2028>b]: /c` is not a definition and `[a\<U+2028>b]` is not a
              reference, so the document renders as two literal paragraphs instead of one
              link. Case in the corpus and a named control.

              **Four behaviours worth naming**, each read off the real function first:

              * An `image` is an inline token, so an image inside a paragraph nests a
                `<!-- wp:image -->` block comment between the `<p>` tags. Invalid
                Gutenberg, and exactly what Python emits.
              * `_INLINE_SQUARE_BRACKET_RE` carries an even backslash run into its match
                and `parse_link_text` compares the *whole* match against `"]"`, so `\\]`
                raises the nesting level rather than lowering it, while `\]` is skipped
                entirely.
              * The two nesting guards are asymmetric: a link inside a link text and an
                image inside an image alt are literal text, but a link inside an image alt
                and an image inside a link text both still nest.
              * `parse_link` passes `precedence_scan` the rule list without `link` in it,
                which is what stops the scan from recursing into the rule that called it.

              **Oracle.** `api/scripts/export_wp_html_inline_link_parity.py` writes
              `web/src/mastra/wordpress/data/wp-html-inline-link-parity.json` from the
              real Python: 91 whole-document `html_cases`, 2 `raising_cases` that pin the
              `AttributeError` a tag in a paragraph causes, 23 `token_cases` through
              `mistune.InlineParser.__call__` with an explicit `ref_links` env (the only
              surface the token's `ref` and `label` fields and an empty title are visible
              on) and 7 `render_cases` for `_GutenbergRenderer.image` and the `link` title
              branch.

              ```
              $ cd api && PYTHONPATH=. uv run python scripts/export_wp_html_inline_link_parity.py
              wrote 91 html cases, 2 raising cases, 23 token cases and 7 render cases to /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/mastra/wordpress/data/wp-html-inline-link-parity.json
              ```

              Failing first, with `parseLinkRule` stubbed to `return undefined` on entry:

              ```
              $ pnpm -C web exec vitest run src/mastra/wordpress/wp-html-inline-link.test.ts
               Test Files  1 failed (1)
                    Tests  100 failed | 38 passed (138)
              ```

              Passing, and the whole `wordpress/` suite with the six updated files:

              ```
              $ pnpm -C web exec vitest run src/mastra/wordpress/wp-html-inline-link.test.ts
               ✓ src/mastra/wordpress/wp-html-inline-link.test.ts (138 tests) 13ms
               Test Files  1 passed (1)
                    Tests  138 passed (138)
              $ pnpm -C web exec vitest run src/mastra/wordpress/
               ✓ src/mastra/wordpress/wordpress.test.ts (57 tests)
               ✓ src/mastra/wordpress/wordpress-write.test.ts (33 tests)
               ✓ src/mastra/wordpress/escape-url.test.ts (103 tests)
               ✓ src/mastra/wordpress/wp-html-blocks.test.ts (84 tests)
               ✓ src/mastra/wordpress/wp-html-quotes.test.ts (67 tests)
               ✓ src/mastra/wordpress/wp-html-raw-html.test.ts (105 tests)
               ✓ src/mastra/wordpress/wp-html-inline-autolink.test.ts (121 tests)
               ✓ src/mastra/wordpress/wp-html-inline-emphasis.test.ts (111 tests)
               ✓ src/mastra/wordpress/wp-html-inline-link.test.ts (138 tests)
               ✓ src/mastra/wordpress/wp-html-inline-escape-codespan.test.ts (109 tests)
               ✓ src/mastra/wordpress/wp-html-lists.test.ts (128 tests)
               ✓ src/mastra/wordpress/wp-html-ref-link.test.ts (261 tests)
               Test Files  12 passed (12)
                    Tests  1317 passed (1317)
              ```

              **Negative controls**, twenty-six mutations, each applied to `wp-html.ts`
              on its own and reverted (the file was `cmp`-checked against a saved copy
              afterwards), with the eight `wp-html*` test files run against each:

              | # | Mutation | Result |
              | --- | --- | --- |
              | 1 | `parse_link_text` compares only the bracket, not the whole match | caught |
              | 2 | `parse_link_text` keeps the closing bracket in the text | caught |
              | 3 | `parse_link_label` keeps the closing bracket in the label | caught |
              | 4 | the inline href branch does not back the cursor off by one | caught |
              | 5 | the href is percent encoded without being unescaped first | caught |
              | 6 | the href is not percent encoded | caught |
              | 7 | an empty title is stored rather than dropped | caught |
              | 8 | the closing parenthesis is looked for after the href, not the title | caught |
              | 9 | the two nesting guards are swapped | caught |
              | 10 | the nesting guard is dropped | caught |
              | 11 | the precedence scan is skipped | caught |
              | 12 | the precedence scan uses the default rules, which include `link` | caught |
              | 13 | a counted text running to the end of the source is still a link | **survived** |
              | 14 | an empty second label overwrites the first | caught |
              | 15 | an inline link returns the text end rather than the parenthesis end | caught |
              | 16 | the empty `ref_links` guard is dropped | **survived** |
              | 17 | the reference key is not case folded | caught |
              | 18 | a reference link carries no `title` key at all | caught |
              | 19 | the token builder sets the other nesting flag | caught |
              | 20 | the token builder starts from a fresh state instead of a copy | caught |
              | 21 | the image renderer reads the title instead of the url | caught |
              | 22 | `LINK_LABEL` uses JavaScript's dot | caught |
              | 23 | `PAREN_END_RE` uses JavaScript's whitespace class | caught |
              | 24 | the square bracket scan drops `PREVENT_BACKSLASH` | caught |
              | 25 | the inline href pattern is greedy | caught |
              | 26 | the second label advances the cursor even when it does not parse | caught |

              Six of these survived the first corpus and six cases were added for them:
              `[a[b] c\\](/d)` (1, the even-backslash quirk only reaches the counter
              when a nested bracket has already defeated `parse_link_label`),
              `[a](/b "")` as a token case (7, an empty title is falsy in the renderer so
              only the token shape shows it), `_a [b *c* d](/e) f_` (20, the copied
              `in_emphasis` flag is what keeps `*c*` literal inside the link text),
              `[a](/b "t"\x1c)` and `[a](/b "t"\ufeff)` (23, the two directions Python's
              and JavaScript's whitespace sets disagree in), `[a[b] c\] d](/e)` (24) and
              `[a][b` with a definition for `a` (26).

              The two survivors are unobservable, not untested:

              * **13.** Removing `if end_pos >= len(state.src) and label is None` opens
                exactly one new path, `precedence_scan`, because the branches after it are
                all behind `end_pos < len(state.src)` and the function returns `None` at
                the bottom for a `None` label anyway. `precedence_scan` only wins when its
                rule ends at `>= end_pos`, which here is `len(src)`, so the winning match
                would have to end on the final `]` that produced `end_pos`. No inline rule
                can: `codespan` ends on a backtick, `auto_link` and `inline_html` on `>`.
                Checked empirically as well, by patching the guard out of mistune's own
                `parse_link` and diffing the rendered HTML: 197502 generated documents over
                an alphabet of the characters these rules care about, 0 differed.
              * **16.** `if not ref_links: return None` guards a `.get` on the map that
                follows, and an empty map's `get` returns nothing either way. In Python the
                guard is load-bearing for `md.inline(s, {})`, where `env.get('ref_links')`
                is `None` and the `.get` would raise; in the port `InlineEnv` types
                `refLinks` as a required `Map`, so that shape does not exist. Kept for
                faithfulness, and noted here so a later reader does not hunt for the input.

              Gates, both stacks. `pnpm test` is at its recorded baseline: the same 9
              failures in `image-preview.test.tsx` (6) and `PostDetail.test.tsx` (3),
              neither of which imports `wp-html`, and both reproduce on their own.

              ```
              $ pnpm -C web exec tsc --noEmit
              (no output, exit 0)
              $ pnpm -C web lint
              (no output, exit 0)
              $ pnpm -C web test
               Test Files  2 failed | 113 passed (115)
                    Tests  9 failed | 3509 passed | 7 skipped (3525)
              $ pnpm -C web exec vitest run src/app/posts/PostDetail.test.tsx src/components/__tests__/image-preview.test.tsx
               Test Files  2 failed (2)
                    Tests  9 failed | 15 passed (24)
              $ pnpm -C web build
              ✓ Compiled successfully
              $ cd api && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.16s
              $ cd api && uv run ruff check scripts/export_wp_html_inline_link_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_wp_html_inline_link_parity.py
              1 file already formatted
              ```

## 5.3c-iii-b-1-c-i


            Ported to `web/src/mastra/wordpress/publish-metadata.ts` as
            `extractFrontmatter()` and `indexManifestImages()`. The oracle is
            `web/src/mastra/wordpress/data/wp-publish-metadata-parity.json`, written by
            `api/scripts/export_wp_publish_metadata_parity.py`: 43 frontmatter cases
            through the real `_extract_frontmatter`, and 19 manifest cases through the
            real indexing loop. That loop is inline in `publish_to_wordpress` rather than
            a function, so instead of transcribing it (which would make the oracle a copy
            of a copy) the script pulls the block out with `inspect.getsource`, dedents it
            and `exec`s it against a stub post. If the block moves, the extraction raises
            rather than recording stale answers, and the test asserts the recorded source
            still contains both marker lines.

            **`_extract_frontmatter` is four primitives and all four diverge.**

            * `\s` in `^---\s*\n(.*?)\n---\s*\n(.*)$` is Python's class, which holds
              `\x1c`-`\x1f` and `\x85` and omits `\ufeff`, where JavaScript's does the
              reverse. Both directions are observable and both are oracle cases: a file
              separator after the opening fence parses in Python (`{"title": "Hello"}`) and
              would not in JavaScript, and a BOM in the same position does not parse in
              Python (`{}`, body unchanged) and would in JavaScript. `PY_WHITESPACE` from
              `../textstat` is reused rather than respelled.
            * `.` under `re.DOTALL` is every character, which is `[\s\S]` here because
              JavaScript's `.` excludes more than Python's.
            * `str.strip()` with no argument uses that same Python class, not
              `String.trim()`'s, so `\x1c` around a key is stripped and a BOM around a key
              is kept (`{"\ufefftitle\ufeff": "Hello"}`).
            * `.strip('"').strip("'")` strips a *set* of characters at both ends in a
              fixed order. `'"Hello"'` loses the single quotes first and keeps the double
              ones, giving `"Hello"` with the quotes intact; the reverse order gives
              `Hello` and is caught.

            **The index has one quirk worth naming.** The two maps are written
            independently, so a featured entry followed by an inline entry with the same
            filename leaves `featured_filename` pointing at that filename while
            `manifest_by_file` holds the inline record. Preserved, and asserted directly
            as well as through the oracle.

            **Both maps are `Map`s, not objects, and the oracle carries them as pair
            lists.** The keys are model output: `__proto__` is an ordinary dict key in
            Python, and it does not survive a round trip through a JavaScript object
            literal. The first version of this test emitted `meta` as a JSON object and
            failed on the `__proto__` case with `expected { __proto__: 'x', title:
            'Hello' } to deeply equal { title: 'Hello' }`, which is the import dropping
            the key rather than a port defect.

            `_find_image_refs` in the same module is **not** ported: nothing in
            `publish.py` calls it and `grep` finds no other caller outside
            `api/tests/phase10/test_publish.py`. Porting dead code would be speculative.

            Twenty-two mutations of the port were run against the test file; twenty-one
            were caught.

            | # | mutation | result |
            | --- | --- | --- |
            | 1 | fence whitespace uses JavaScript's class | caught |
            | 2 | the frontmatter block match is greedy | caught |
            | 3 | the pattern is not anchored at the start | caught |
            | 4 | `.` replaces the DOTALL character class | caught |
            | 5 | the key is trimmed with `String.trim` | caught |
            | 6 | the value is trimmed with `String.trim` | caught |
            | 7 | the quote strips run in the other order | caught |
            | 8 | `stripChars` removes at most one character per end | caught |
            | 9 | `stripChars` only strips the leading end | caught |
            | 10 | the line is split on the last colon | caught |
            | 11 | a line without a colon is not skipped | caught |
            | 12 | the first entry wins in `byFile` | caught |
            | 13 | the first featured entry wins | caught |
            | 14 | only `placement` marks an entry featured | caught |
            | 15 | only `type` marks an entry featured | caught |
            | 16 | the filename keeps its leading slash | caught |
            | 17 | the filename is taken from the front of the url | caught |
            | 18 | a missing url becomes the string `undefined` | caught |
            | 19 | the filename is empty when the url has no slash | caught |
            | 20 | the frontmatter map is a plain object | caught |
            | 21 | the body is the whole content rather than the second group | caught |
            | 22 | `images === undefined` replaces `Array.isArray(images)` | SURVIVED |

            Mutation 22 is unobservable rather than untested. The two spellings differ only
            for an `images` value that is neither undefined nor an array, and Python raises
            on every one of those: a string iterates to characters whose `.get` is an
            `AttributeError`, a dict iterates to keys with the same result, a number is not
            iterable. Two sibling shapes raise for the same reason and are documented in the
            module header rather than reproduced: a non-empty non-object `image_manifest`,
            and an entry whose `url` is JSON null (`"/" in None` is a `TypeError`). The
            images stage only ever writes an object of objects with string urls.

            ```
            $ cd api && uv run python scripts/export_wp_publish_metadata_parity.py
            wrote 43 frontmatter cases (36 with a parsed block) and 19 manifest cases (6 with a featured image) to /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/mastra/wordpress/data/wp-publish-metadata-parity.json
            $ pnpm -C web exec vitest run src/mastra/wordpress/publish-metadata.test.ts
             Test Files  1 passed (1)
                  Tests  67 passed (67)
            ```

            Gates, both stacks. `pnpm test` reported 10 failures on the first run and 9 on
            the second; 9 is the recorded baseline and the tenth was the known
            `scaffold-check.test.ts` lifecycle-event flake in `todo.md`, which passes 5 of
            5 in isolation and touches nothing this item changes.

            ```
            $ pnpm -C web exec tsc --noEmit
            (no output, exit 0)
            $ pnpm -C web lint
            (no output, exit 0)
            $ pnpm -C web test
             Test Files  2 failed | 114 passed (116)
                  Tests  9 failed | 3576 passed | 7 skipped (3592)
            $ pnpm -C web build
            ✓ Compiled successfully
            $ cd api && uv run pytest -q
            120 failed, 241 passed, 25 errors in 15.15s
            $ cd api && uv run ruff check scripts/export_wp_publish_metadata_parity.py
            All checks passed!
            $ cd api && uv run ruff format --check scripts/export_wp_publish_metadata_parity.py
            1 file already formatted
            ```

## 5.3c-iii-b-1-c-ii-1


              Ported to `web/src/mastra/wordpress/mimetypes.ts` as
              `guessTypeFromFilename()`, with `splitext()` and the four tables exported so
              the test can check them rather than trust a transcription. The oracle is
              `web/src/mastra/wordpress/data/wp-mimetypes-parity.json`, written by
              `api/scripts/export_mimetypes_parity.py`: the four tables verbatim plus 100
              `guess_type` cases, 91 strict and 9 not.

              **The oracle cannot be generated on this machine, and that is the main
              finding of this item.** `mimetypes.init()` reads `mimetypes.knownfiles`, and
              on macOS `/etc/apache2/mime.types` exists. Reading it grows the strict table
              from 152 entries to 1036, adds 45 `image/*` extensions and changes `.ico`
              from `image/vnd.microsoft.icon` to `image/x-icon`. The deployed interpreter
              is `python:3.12-slim`, where no knownfile exists at all, so the builtin
              table is the whole table there. The export script asserts both
              `sys.version_info[:2] == (3, 12)` and that no knownfile is present, and is
              run inside that image:

              ```
              $ docker run --rm -v "$PWD":/w -w /w python:3.12-slim python api/scripts/export_mimetypes_parity.py
              wrote 152 strict types, 9 common types and 100 cases (50 classified as images) to /w/web/src/mastra/wordpress/data/wp-mimetypes-parity.json
              ```

              **`.webp` is not in the Python 3.12 builtin table.** It arrived in 3.13. The
              images stage writes every file as `.webp`, so in production
              `guess_type("featured-082326-abc.webp")` is `(None, None)` and the media
              sweep skips every image the pipeline generated: no uploads, no featured
              image, and the local `/media/...` URLs left in the published HTML. This port
              reproduces that, and the defect is logged in `todo.md` rather than fixed
              here, because fixing it changes what publishing does.

              ```
              $ docker run --rm python:3.12-slim python -c "import mimetypes, os; print([f for f in mimetypes.knownfiles if os.path.isfile(f)], len(mimetypes.MimeTypes().types_map[True]), mimetypes.guess_type('a.webp'))"
              [] 152 (None, None)
              ```

              **Four behaviours the port had to get right.**

              * `guess_type` runs the argument through `urllib.parse.urlparse` but only
                uses the parsed path when a scheme of more than one character was found.
                Otherwise it re-reads the **raw** argument, so none of `urlsplit`'s
                cleaning survives: `urlsplit` lstrips U+0000-U+0020 and deletes every tab,
                CR and LF, but `"a.p\tng"` is still `(None, None)` while
                `"ht\ttp:a.png#b.gif"` is `image/png`. Equally, the schemeless branch keeps
                the fragment and the query in the path, so `"a.png#b.gif"` is `image/gif`
                and `"http:a.png#b.gif"` is `image/png`.
              * `urlparse` also strips a `;` suffix from the path, but only for a scheme in
                `uses_params`, and only after lowercasing the scheme. `"HTTP:a;b.png"` is
                `(None, None)` and `"HTTQ:a;b.png"` is `image/png`.
              * `encodings_map` is matched case sensitively and the type tables are not.
                `"a.png.gz"` is `("image/png", "gzip")`, `"a.png.GZ"` is `(None, None)`,
                and `"a.png.Z"` is `("image/png", "compress")`. `suffix_map` runs before
                the encoding is stripped and is matched case insensitively, so `"a.SVGZ"`
                is `("image/svg+xml", "gzip")`; it is not reapplied afterwards, so
                `"a.svgz.gz"` is `(None, "gzip")`.
              * `posixpath.splitext` skips leading dots, so `".png"` and `"..png"` have no
                extension while `".hidden.png"` does.

              **The input domain is one POSIX path component**, which is what
              `Path.iterdir()` yields, so it cannot contain `/`. That makes the `//` netloc
              split, its IPv6 bracket validation and the `'/' in url` half of
              `_splitparams` unreachable. They are not ported and
              `guessTypeFromFilename` throws a `TypeError` rather than guessing if a
              caller ever passes a slash; the export script refuses to record a case with
              one.

              Beyond the oracle, 105993 randomly generated slash-free names (seeded, built
              from an alphabet of the characters every branch keys off) were run through
              the real `mimetypes.guess_type` inside `python:3.12-slim` and through the
              port: **0 differed**. Twenty-eight mutations of the port were then run
              against both the test file and that corpus; twenty-three were caught.

              | # | mutation | result |
              | --- | --- | --- |
              | 1 | leading space is not stripped | caught |
              | 2 | the C0 strip runs at both ends | caught |
              | 3 | a leading colon starts a scheme | SURVIVED |
              | 4 | a digit may open a scheme | caught |
              | 5 | the scheme is not lowercased | caught |
              | 6 | tab, CR and LF are kept | caught |
              | 7 | the schemeless branch reads the cleaned copy | caught |
              | 8 | a one-character scheme is accepted | caught |
              | 9 | every scheme splits params | caught |
              | 10 | params are never split | caught |
              | 11 | the fragment stays in the path | caught |
              | 12 | the query stays in the path | caught |
              | 13 | the data semicolon is searched past the comma | SURVIVED |
              | 14 | a data type with an equals is kept | SURVIVED |
              | 15 | a data type without a slash is kept | caught |
              | 16 | a comma-less data URL is text/plain | caught |
              | 17 | `splitext` accepts a dot at the separator | SURVIVED |
              | 18 | `splitext` does not skip leading dots | caught |
              | 19 | `splitext` drops the dot from the extension | caught |
              | 20 | `suffix_map` is matched case sensitively | caught |
              | 21 | `suffix_map` is applied at most once | SURVIVED |
              | 22 | `encodings_map` is matched case insensitively | caught |
              | 23 | the encoding suffix is not stripped | caught |
              | 24 | the type lookup is case sensitive | caught |
              | 25 | `strict` still falls back to `common_types` | caught |
              | 26 | an unknown type drops the encoding | caught |
              | 27 | scheme characters are not validated | caught |
              | 28 | the data branch keys off the raw prefix | caught |

              All five survivors are unobservable rather than untested, and each also
              produced 0 differences across the 105993-case corpus.

              * 3: `i > 0` and `i >= 0` differ only at `i == 0`, which needs `url[0] == ':'`,
                which fails the `url[0].isalpha()` test standing beside it.
              * 13 and 14: within a slash-free component the candidate type is a substring
                of a string with no `/`, so `'/' not in type` always holds and the data
                branch always yields `text/plain` whenever a comma is present. Neither
                mutation can change which prefix that verdict is drawn from.
              * 17: `dotIndex >= sepIndex` differs only when both are `-1`, and then the
                leading-dot loop does not execute and both spellings return `(p, "")`.
              * 21: every `suffix_map` value ends in `.gz`, `.bz2` or `.xz`, and none of
                those is a `suffix_map` key, so the loop can never run a second time.

              ```
              $ pnpm -C web exec vitest run src/mastra/wordpress/mimetypes.test.ts
               Test Files  1 passed (1)
                    Tests  212 passed (212)
              ```

              Gates, both stacks. The frontend failure count is the recorded 9-failure
              baseline: 6 in `image-preview.test.tsx` and 3 in `PostDetail.test.tsx`.

              ```
              $ pnpm -C web exec tsc --noEmit
              (no output, exit 0)
              $ pnpm -C web lint
              (no output, exit 0)
              $ pnpm -C web test
               Test Files  2 failed | 115 passed (117)
                    Tests  9 failed | 3788 passed | 7 skipped (3804)
              $ pnpm -C web build
              ✓ Compiled successfully in 4.1s
              $ set -a && . ./.env && set +a && cd api && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.20s
              $ cd api && uv run ruff check scripts/export_mimetypes_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_mimetypes_parity.py
              1 file already formatted
              ```

## 5.3c-iii-b-1-c-ii-2


              Four behaviours the obvious JavaScript spelling gets wrong:

              1. **`is_file()` stats, `readdir` does not.** `Path.is_file()` follows
                 symlinks, so a symlink to a file is uploaded and a symlink to a directory
                 is not. `readdir(dir, { withFileTypes: true })` answers from the directory
                 entry and gets both backwards.
              2. **Only four errnos are absence.** `pathlib._IGNORED_ERRNOS` is `ENOENT`,
                 `ENOTDIR`, `EBADF`, `ELOOP`; every other `OSError` propagates out of the
                 publish hook. So a name over `NAME_MAX` and an unreadable directory raise,
                 while an embedded NUL is a `ValueError` and is caught as absence.
              3. **`os.listdir` decodes with `surrogateescape`.** A byte that is not valid
                 UTF-8 becomes U+DC00 plus that byte. Node's default decoding replaces it
                 with U+FFFD, which loses the name and collides two distinct files into
                 one. `listMediaFiles` therefore reads names as `Buffer`s and carries a
                 byte path per entry, so the file that is opened later is the file that was
                 named.
              4. **`sorted()` compares code points.** `Array.prototype.sort` compares
                 UTF-16 code units, so an astral filename sorts before everything from
                 U+E000 through U+FFFF instead of after it.

              The oracle is `web/src/mastra/wordpress/data/wp-media-walk-parity.json`,
              written by `api/scripts/export_media_walk_parity.py`, which pulls the four
              walk lines out of the real `publish_to_wordpress` with `inspect.getsource`,
              asserts their exact shape, appends a `names.append(img_file.name)` in place
              of the mimetypes filter that follows them (item -ii-1) and executes the
              result against a scratch tree it builds from the case table the vitest file
              rebuilds. 34 `os.fsdecode` cases, 15 `sorted()` cases, 20 walk cases and 3
              error cases.

              ```
              $ cd api && uv run python scripts/export_media_walk_parity.py
              wrote 34 fsdecode cases, 15 sort cases and 20 walk cases keeping 26 files, plus 3 error cases, to /Users/cody/.../web/src/mastra/wordpress/data/wp-media-walk-parity.json

              $ cd web && pnpm exec vitest run src/mastra/wordpress/media-walk.test.ts
               ✓ src/mastra/wordpress/media-walk.test.ts (79 tests) 124ms

               Test Files  1 passed (1)
                    Tests  79 passed (79)
              ```

              **Corpus domain.** The walk cases hold only names that are valid UTF-8 and
              unique under case folding, because APFS rejects a filename that is not valid
              UTF-8 with `EILSEQ` (`fs.writeFileSync(Buffer.from([0xff]))` → `EILSEQ`) and
              is case-insensitive by default, so the vitest side could not rebuild such a
              tree. The two behaviours that hides are covered without a filesystem, by the
              `fsdecode` corpus and by the `sorts` corpus, whose names arrive as code point
              lists because a `surrogateescape`-decoded name holds lone surrogates that do
              not survive a round trip through JSON as text.

              **Mutation testing: 28 mutations, 20 fail, 8 survive.**

              | # | Mutation | Result |
              | --- | --- | --- |
              | 1 | `dirent.isFile()` instead of `stat` | 2 failed |
              | 2 | default string comparison in the sort | 1 failed |
              | 3 | `localeCompare` in the sort | 2 failed |
              | 4 | `bytes.toString("utf8")` instead of `decodeFsName` | **survives on APFS** |
              | 5 | no `is_dir()` gate, only existence | 1 failed |
              | 6 | `lstat` instead of `stat` | 2 failed |
              | 7 | every errno is absence | 2 failed |
              | 8 | `ERR_INVALID_ARG_VALUE` throws | 1 failed |
              | 9 | `EACCES` added to the ignored set | 1 failed |
              | 10 | `ELOOP` dropped from the ignored set | 2 failed |
              | 11 | `ENOTDIR` dropped from the ignored set | 1 failed |
              | 12 | decode allows encoded surrogates | 3 failed |
              | 13 | decode allows overlongs | 2 failed |
              | 14 | decode allows past U+10FFFF | 1 failed |
              | 15 | decode accepts 0xc0 and 0xc1 leads | **survives, equivalent** |
              | 16 | decode accepts leads past 0xf4 | **survives, equivalent** |
              | 17 | decode does not check continuation bytes | 1 failed |
              | 18 | decode does not check for truncation | **survives, equivalent** |
              | 19 | decode escapes with U+FFFD | 21 failed |
              | 20 | decode skips the whole invalid sequence | 9 failed |
              | 21 | compare advances by one UTF-16 unit | **survives, equivalent** |
              | 22 | compare treats a prefix as equal | 1 failed |
              | 23 | compare reverses the prefix rule | 1 failed |
              | 24 | compare reversed | 19 failed |
              | 25 | no sort at all | **survives on APFS** |
              | 26 | sort after the `is_file` filter | **survives, equivalent** |
              | 27 | path built from the decoded name | **survives on APFS** |
              | 28 | directories kept | 3 failed |

              Mutations 9 and 11 survived the first pass; the `EACCES` error case (a
              directory chmod-ed to `0444`, skipped when the test runs as root, and the
              export script refuses to run as root for the same reason) and the two
              `ENOTDIR` walk cases were added for them.

              Five survivors are provably equivalent code rather than uncovered behaviour.
              15 and 16 widen the lead-byte table into ranges the overlong and U+10FFFF
              checks reject anyway (13 and 14 both fail, so those checks are live). 18 is
              redundant with the continuation check, since reading past the end yields
              `undefined` and `(undefined & 0xc0) !== 0x80`. 21 cannot misalign, because two
              strings only keep advancing while their code points are equal and equal code
              points have equal encodings. 26 reorders a sort and a filter, and filtering
              preserves relative order.

              The other three survive only because APFS cannot hold the file that shows
              them. Node's `readdir` already returns names in `strcmp` order (200 random
              names created in scrambled order came back byte-sorted on both macOS and
              Linux), and byte order over valid UTF-8 *is* code point order, so on a
              filesystem that only accepts valid UTF-8 the sort has nothing left to do. The
              divergence needs a name that is not valid UTF-8, and there `readdir` order
              and Python's order are reversed:

              ```
              $ docker run --rm python:3.12-slim python -c "
              import os, pathlib, tempfile
              d = tempfile.mkdtemp()
              for raw in (b'\xff', b'\xef\xbf\xbd'):
                  open(os.path.join(d.encode(), raw), 'wb').close()
              print([[hex(ord(c)) for c in p.name] for p in sorted(pathlib.Path(d).iterdir())])
              "
              [['0xdcff'], ['0xfffd']]
              ```

              (`readdir` returns `['efbfbd', 'ff']`, the reverse.) So all three were
              measured on Linux instead, where the port runs in production. Node 24 strips
              the types, so `media-walk.ts` imports directly, and the expectation is the
              real Python walk over the same tree
              (`[[[97,46,119,101,98,112],"three"],[[56575],"one"],[[65533],"two"]]`, that
              is `a.webp`, `\udcff`, `�` with their contents):

              `/tmp/linuxcheck/check.mjs`, which is not committed because it needs
              docker and a non-APFS filesystem to mean anything:

              ```js
              import fs from "node:fs"
              import { readFile, writeFile } from "node:fs/promises"

              const EXPECTED = [[[97,46,119,101,98,112],"three"],[[56575],"one"],[[65533],"two"]]
              const SOURCE = "/work/media-walk.ts"

              function build() {
                const d = fs.mkdtempSync("/tmp/walk-")
                for (const [raw, body] of [[[0xff], "one"], [[0xef,0xbf,0xbd], "two"], [[...Buffer.from("a.webp")], "three"]])
                  fs.writeFileSync(Buffer.concat([Buffer.from(d + "/"), Buffer.from(raw)]), body)
                fs.mkdirSync(d + "/sub")
                return d
              }

              async function run(label, mutate) {
                const original = await readFile(SOURCE, "utf8")
                const copy = `/tmp/variant-${label.replace(/\W/g, "")}.ts`
                await writeFile(copy, mutate ? mutate(original) : original)
                const { listMediaFiles } = await import(copy)
                const files = await listMediaFiles(build())
                const got = files.map((f) => [[...f.name].map((c) => c.codePointAt(0)), fs.readFileSync(f.path, "utf8")])
                const ok = JSON.stringify(got) === JSON.stringify(EXPECTED)
                console.log(`${ok ? "MATCHES python" : "DIFFERS from python"}  ${label}`)
                if (!ok) console.log(`  got ${JSON.stringify(got)}`)
              }
              ```

              ```
              $ docker run --rm -v .../web/src/mastra/wordpress:/work:ro -v /tmp/linuxcheck/check.mjs:/check.mjs node:24-alpine node /check.mjs
              MATCHES python  the port as committed
              DIFFERS from python  mutation 4: default utf8 decode
                got [[[97,46,119,101,98,112],"three"],[[65533],"two"],[[65533],"one"]]
              DIFFERS from python  mutation 25: no sort at all
                got [[[97,46,119,101,98,112],"three"],[[65533],"two"],[[56575],"one"]]
              DIFFERS from python  mutation 27: path built from the decoded name
                got [[[97,46,119,101,98,112],"three"],[[56575],"two"],[[65533],"two"]]
              ```

              Mutation 4 collides the two names into one U+FFFD; 25 keeps `readdir`'s byte
              order, which is the reverse of Python's; 27 reads the wrong file for both
              entries (both come back `"two"`).

              **Gates.**

              ```
              $ cd web && pnpm exec tsc --noEmit
              tsc exit 0
              $ cd web && pnpm lint
              lint exit 0
              $ cd web && pnpm build
              build exit 0
              $ cd api && uv run ruff check scripts/export_media_walk_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_media_walk_parity.py
              1 file already formatted
              $ set -a; . ./.env; set +a; cd api && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.03s
              ```

              **Frontend suite: 10 failed / 3866 passed, one over the 9-failure baseline,
              and the extra failure is not this item's.** `scaffold-check.test.ts > emits
              the workflow lifecycle events the trace view will read` fails whenever the
              suite holds one more test file than it did at the baseline. Proven by
              elimination: 2/2 full runs failed it with `media-walk.test.ts` present, the
              suite returned to 9 failures with that file moved aside, and it failed again
              with the file replaced by a one-line `expect(1 + 1).toBe(2)` dummy. The run
              itself succeeds; only the drained `fullStream` is short (4 events), so
              `run.stream()` is missing events the orchestration worker already published.
              Recorded in `todo.md`, upgraded from `[investigate]` to `[confirmed]`, and it
              belongs to Phase 5's resumable-replay item rather than here.

              ```
              $ cd web && pnpm test           # with media-walk.test.ts
                    Tests  10 failed | 3866 passed | 7 skipped (3883)
              $ cd web && pnpm test           # media-walk.test.ts moved aside
                    Tests  9 failed | 3788 passed | 7 skipped (3804)
              $ cd web && pnpm test           # replaced by a one-line dummy test file
                    Tests  10 failed | 3788 passed | 7 skipped (3805)
              ```

## 5.3c-iii-b-1-c-ii-3


              Ported to `web/src/mastra/wordpress/media-upload.ts` as
              `uploadMediaFiles()` and `rewriteImageUrls()`, with
              `sweepMediaDirectory()` composing them onto `listMediaFiles()` and
              `guessTypeFromFilename()` so the whole sweep of 5.3c-iii-b-1-c-ii now has
              one entry point. The oracle is
              `web/src/mastra/wordpress/data/wp-media-upload-parity.json`, written by
              `api/scripts/export_media_upload_parity.py`, which pulls the twenty upload
              lines and the two rewrite lines out of the real `publish_to_wordpress` with
              `inspect.getsource`, asserts their exact shape, and executes them over real
              files in a scratch directory against a recording stand-in for the WordPress
              client: 26 cases recording the upload arguments, the image map, the featured
              media id and the rewritten document.

              **The oracle has to be generated inside the deployed image**, and the reason
              is the finding of this item. `mimetypes.guess_type` decides which files this
              loop uploads, and its table depends on both the interpreter and the host:
              Python 3.13 added `.webp` to the builtin table and 3.12 does not have it,
              and macOS has `/etc/apache2/mime.types`, which `mimetypes.init()` reads.
              Generating on this machine (`uv run`, Python 3.13.12) recorded
              `image/webp` for a `.webp` file and produced three test failures against the
              port, whose table came from `python:3.12-slim`. The script now refuses to
              run anywhere but the deployed image and the corpus pins the deployed answer:

              ```
              $ docker run --rm -v "$PWD":/w -w /w/api jena-api-oracle python -c "
              import sys, os, mimetypes
              print(sys.version)
              print([f for f in mimetypes.knownfiles if os.path.isfile(f)])
              print(mimetypes.guess_type('a.webp'), mimetypes.guess_type('a.png'))"
              3.12.14 (main, Aug 13 2026, 19:43:20) [GCC 14.2.0]
              []
              (None, None) ('image/png', None)
              ```

              That is the already-recorded production bug of 5.3c-iii-b-1-c-ii-1 seen from
              the other end: oracle case "a .webp file is not an image to the deployed
              table, so it is skipped" records that the images stage's own output is
              skipped, `featured_media_id` stays `null`, and the local
              `/media/p1/featured-082326-abc.webp` URL survives into the published HTML.
              Already in `todo.md`; the port reproduces it rather than fixing it.

              Four behaviours the obvious transcription gets wrong, each with an oracle
              case:

              * `img_info.get("alt_text", title)` falls back to the title only when the
                key is **absent**, so `""` and `null` are forwarded. `info.alt_text ??
                title` fails two cases.
              * `featured_media_id = media.get("id")` can put the variable back to `null`,
                which re-arms the `elif` for the next file: the fallback is "the first
                upload that has an id", and an id of `0` stops the search because `0 is
                not None`.
              * a `featured_filename` that matches no file leaves the featured media
                unset, and an empty one (a manifest url ending in `/`) is falsy and takes
                the first-image path.
              * `str.replace(local, remote)` is `replaceAll` **except** that JavaScript
                reads `$&`, `` $` ``, `$'`, `$$` and `$1` in the replacement as
                substitution patterns. Spelled `split(local).join(remote)`; the oracle
                carries a `source_url` holding all five.

              Two error paths are reproduced with Python's own messages, because the
              publish hook's `except Exception` writes `str(e)` to the post: a response
              that is not a dict raises `'list' object has no attribute 'get'` from
              `media.get`, and a non-string `source_url` raises `replace() argument 2 must
              be str, not int` from the rewrite, after every upload has already happened.
              Note that CPython spells the `None` singleton `None` in that message and
              `NoneType` in the `AttributeError`; both spellings are in the oracle.

              One divergence is deliberate and small: `WordPressClient.uploadMedia`'s
              `altText` parameter is widened from `string` to `unknown`, because the value
              comes out of `image_manifest` and Python forwards whatever is stored there
              into the patch body. The truthiness gate is the only thing that reads it.

              The rewrite's insertion-order pass corrupts a local URL that is a prefix of
              a later one (`/media/p1/a.png.png` becomes
              `https://wp.example/one.png.png`). Recorded verbatim in the oracle,
              reproduced by the port, and logged in `todo.md`; the images stage's
              timestamped filenames make it unreachable in practice.

              Twenty mutations, sixteen killed:

              | Mutation | Outcome |
              | --- | --- |
              | alt: `??` instead of `hasOwn` | killed |
              | alt: `in` instead of `hasOwn` | killed |
              | alt: always the title | killed |
              | mime: `includes` instead of `startsWith` | **survived, equivalent** |
              | mime: drop the null guard | killed |
              | mime: `break` instead of `continue` | killed |
              | source_url: fallback `null` instead of `""` | killed |
              | mediaGet: `??` instead of `hasOwn` | killed |
              | mediaGet: no guard for a non-object response | killed |
              | featured: drop the falsy `featuredFilename` guard | **survived, equivalent** |
              | featured: `==` null instead of `===` null | **survived, equivalent** |
              | featured: drop the `!featuredFilename` half of the fallback | killed |
              | featured: `featuredFilename === null` instead of falsy | killed |
              | featured: first match wins instead of last | **survived, equivalent** |
              | rewrite: `replaceAll` instead of `split`/`join` | killed |
              | rewrite: `replace`, so only the first occurrence | killed |
              | rewrite: reverse insertion order | killed |
              | rewrite: no `TypeError` for a non-string remote | killed |
              | rewrite: `RegExp` instead of a literal match | killed |
              | typeName: `list` reported as `object` | killed |

              The first mutation pass had six survivors; two became kills. `alt: in
              instead of hasOwn` survived because the control used
              `JSON.parse('{"__proto__": ...}')`, which gives an **own** `__proto__`
              property and leaves the prototype chain alone, so `in` and `hasOwn` agree on
              it. Replaced with `Object.create({ alt_text: "injected" })`, which is
              unreachable from a JSONB column but pins the guard. `mediaGet: ?? instead of
              hasOwn` survived because no oracle case had a stored `null` for
              `source_url`; two cases were added, and both raise at the rewrite rather
              than at the upload, which is what pinned the message spellings above.

              The four remaining survivors are equivalent over the reachable domain:

              * `includes` vs `startsWith`: no value in the mimetypes table contains
                `image/` anywhere but at index 0, which is now asserted as a test rather
                than argued.
              * dropping the falsy `featuredFilename` guard: the mutated `if` differs only
                for a file named `""` or `null`, and `iterdir()` yields neither. The guard
                is redundant in the Python original too.
              * `==` vs `===` null: `mediaGet` returns either a present JSON value or the
                `null` fallback, and a JSON value is never `undefined`.
              * first match wins vs last: `featuredMediaId` cannot be non-null when the
                match is reached, because the `elif` cannot fire while `featuredFilename`
                is truthy and two files in one directory cannot share a name.

              ```
              $ docker build -t jena-api-oracle api
              $ docker run --rm -v "$PWD":/w -w /w/api jena-api-oracle \
                    python scripts/export_media_upload_parity.py
              wrote web/src/mastra/wordpress/data/wp-media-upload-parity.json with 26 cases

              $ cd web && pnpm vitest run src/mastra/wordpress/media-upload.test.ts
               ✓ src/mastra/wordpress/media-upload.test.ts (34 tests) 25ms
               Test Files  1 passed (1)
                    Tests  34 passed (34)

              $ cd web && pnpm tsc --noEmit
              (no output, exit 0)

              $ cd web && pnpm lint
              (no output, exit 0)

              $ cd web && pnpm build
              ✓ Compiled successfully in 4.2s
              # the BetterAuthError lines about the default secret are the
              # pre-existing prerender noise of a shell without BETTER_AUTH_SECRET

              $ cd web && pnpm test
               Test Files  2 failed | 117 passed (119)
                    Tests  9 failed | 3901 passed | 7 skipped (3917)
              # the 9 are the baseline: 6 in image-preview.test.tsx and 3 in
              # PostDetail.test.tsx. The scaffold-check flake recorded under
              # 5.3c-iii-b-1-c-ii-2 did not fire on this run.

              $ cd api && uv run ruff check scripts/export_media_upload_parity.py
              All checks passed!
              $ cd api && uv run ruff format --check scripts/export_media_upload_parity.py
              1 file already formatted

              $ cd api && set -a && . ../.env && set +a && uv run pytest -q
              120 failed, 241 passed, 25 errors in 15.01s
              # the Phase 0 baseline exactly, unchanged by this item
              ```

## 5.3c-iii-b-1-c-iii


            Ported to `web/src/mastra/steps/wordpress-publish.ts`
            (`wordpressPublishStep`) and `web/src/mastra/workflows/wordpress-publish.ts`
            (`wordpressPublishWorkflow`, one `.then(step).commit()`), registered on the
            Mastra instance as `wordpressPublish`. The four pieces the hook composes were
            already ported under -c-i, -b and -c-ii; what this item adds is the part with
            no pure oracle, so it is verified by a run rather than by a corpus: a Node
            `http.Server` on a loopback port stands in for WordPress and records every
            request it receives, the images are real files under a real `MEDIA_DIR`, the
            row is a real row in the dev database, and the password is a real Fernet token
            produced by `web/src/lib/crypto.ts`.

            **There is no oracle for this item and that is deliberate.**
            `publish_to_wordpress` is a database transaction, a Redis publish and an HTTP
            conversation; every observable it has is a side effect. Recording it from
            Python would mean standing up a fake WordPress for the Python side too, and
            the recording would then only prove that two fakes agree. The Python source is
            read line by line in the module header instead, and the twenty mutations below
            are what stands in for the corpus.

            **Four behaviours a naive translation loses**, each with a test:

            * **A publish failure is not a step failure.** Python caught everything, marked
              the post `failed` and returned normally, so ARQ never retried a publish. The
              step returns its failure in `output.error` rather than throwing, because a
              thrown step is redelivered by `RedisStreamsPubSub` and every image would be
              uploaded to the site a second time.
            * **A missing post is not an error either.** Python logged and returned, having
              touched no column and published no event. `status: "missing"`.
            * **The `try` covers the success commit.** An exception raised after the row is
              already `published`, which is every failure in `append_execution_log` and in
              the event publish, still reaches `_fail`, which rewrites `wp_publish_status`
              to `failed` and leaves `wp_post_id` and `wp_post_url` in place. A post that
              exists on WordPress and reads as failed here is Python's behaviour and is
              preserved.
            * **`body` is computed and never used.** `_extract_frontmatter` is called for
              its metadata only; the HTML is rendered from the whole `content`, frontmatter
              included, because `markdown_to_wp_html` strips its own. Pinned by asserting
              the created post's content carries no `description:` line.

            **One divergence, outcome-equivalent but not message-equivalent.**
            `post.wp_post_id = wp_post.get("id")` assigns into an `integer` column and
            `post.wp_post_url = wp_post.get("link", "")` into a `text` one. A WordPress
            that answered `{"id": "7"}` made asyncpg raise, which Python caught and turned
            into a `failed` publish. `pg` sends parameters as text and Postgres would
            coerce `'7'` happily, so `integerColumn()` / `textColumn()` make the check
            here instead. The outcome matches; the recorded message does not, because
            Python's was asyncpg's.

            **Two smaller notes.** `pythonGet` was lifted out of `media-upload.ts` (it was
            `mediaGet`) because `wp_post.get("id")` is the same subscript against the same
            kind of decoded response, `AttributeError` message included.
            `WordPressClient.createPost`'s `featuredMedia` parameter widened from
            `number | null` to `unknown` for the same reason `altText` did in -c-ii-3: the
            value comes straight out of an upload response and Python forwards whatever
            was there.

            **Mutation testing: twenty mutations, nineteen killed, one equivalent.**

            | # | Mutation | Result |
            | --- | --- | --- |
            | 1 | `final_md_content` wins over `ready_content` | killed |
            | 2 | title always `posts.topic` | killed |
            | 3 | title always frontmatter, empty when absent | killed |
            | 4 | excerpt always `""` | killed |
            | 5 | status always `publish` | killed |
            | 6 | `categories` `[]` instead of `null` when unset | **survived, equivalent** |
            | 7 | update sends `null` categories instead of `[]` | killed |
            | 8 | always create, never update | killed |
            | 9 | no local-to-remote rewrite | killed |
            | 10 | no `publish_start` event | killed |
            | 11 | row never moves to `publishing` | killed |
            | 12 | failure log message loses its prefix | killed |
            | 13 | `publish_error` payload loses `message` | killed |
            | 14 | credential guard checks only `wp_url` | killed |
            | 15 | a missing post fails instead of returning quietly | killed |
            | 16 | featured media never sent on create | killed |
            | 17 | alt-text default is `posts.topic`, not the title | killed |
            | 18 | `uploaded` count always zero | killed |
            | 19 | `publish_complete` payload keys renamed | killed |
            | 20 | decrypt failure reported as the credentials message | killed |

            Mutation 6 is genuinely unobservable. `create_post` filters with
            `if categories:`, which is false for both `None` and `[]`, and the update
            branch spells `categories or []`, which is `[]` for both. No WordPress request
            can tell the two apart.

            Three of the twenty needed the tests strengthened before they died, and all
            three were real coverage gaps rather than equivalences:

            * 11 is a status that only exists while the hook is talking to WordPress, so
              the assertion had to be made from inside the fake site's request handler:
              the first `POST /media` reads the row back and records
              `wp_publish_status`. Nothing outside the run can see `publishing`.
            * 14 needed `wp_username` and `wp_app_password` knocked out one at a time on a
              profile that has a `wp_url`; the original fixture had a profile with none of
              the three, which an only-`wp_url` guard still rejects.
            * 5, 16 and the `final_md_content` fallback needed a row that takes the other
              side of every `or` in the hook: no `ready_content`, no frontmatter, no
              manifest and a profile with a null `wp_default_status`.

            ```
            $ pnpm -C web exec vitest run src/mastra/steps/wordpress-publish.test.ts
             Test Files  1 passed (1)
                  Tests  28 passed (28)

            $ pnpm -C web exec vitest run src/mastra/index.test.ts
             Test Files  1 passed (1)
                  Tests  8 passed (8)
            # includes the new "registers the WordPress publish hook as a one-step
            # workflow" case, which asserts the serialized step graph is a single
            # `wordpress-publish` step.

            $ pnpm -C web tsc --noEmit
            (no output, exit 0)

            $ pnpm -C web lint
            (no output, exit 0)

            $ pnpm -C web test
             Test Files  2 failed | 118 passed (120)
                  Tests  9 failed | 3930 passed | 7 skipped (3946)
            # the 9 are the Phase 0 baseline: 6 in image-preview.test.tsx and 3 in
            # PostDetail.test.tsx. The scaffold-check file-count flake recorded under
            # 5.3c-iii-b-1-c-ii-2 did not fire on this run.

            $ pnpm -C web build
            ✓ Compiled successfully

            $ cd api && set -a && . ../.env && set +a && uv run pytest -q
            120 failed, 241 passed, 25 errors in 15.15s
            # the Phase 0 baseline exactly, unchanged by this item
            ```

## 5.3c-iii-b-1-d


          `web/src/app/api/posts/[id]/publish/route.ts` ports `publish_post()`, and
          `web/src/mastra/start-wordpress-publish.ts` is the
          `enqueue_job("publish_to_wordpress", post_id)` it made. The start helper lives
          beside `start-pipeline.ts` and `start-crawl.ts` for the same reason those do:
          starting a run is the boundary between `web` and `worker`, so `startAsync()`
          publishes `workflow.start` onto Redis Streams and returns, and the uploads plus
          the two WordPress requests happen in the worker process.

          Python's shape is three checks and an enqueue, and the order between the second
          and the third is load-bearing: the content check runs before the format check,
          so a post with an unsupported `output_format` and nothing written yet is the
          "No content to publish" 400 rather than the format one. The default value of
          `posts.output_format` is `both`, which makes that the common case rather than a
          corner.

          Four behaviours preserved, each with its own test:

          - `not post.ready_content and not post.final_md_content` is Python truthiness,
            so a post whose `ready_content` is `""` falls through to `final_md_content`
            rather than counting as content. That is the same rule the exports use
            (5.3d-i) and `??` fails it.
          - the status written is `pending`, not `publishing`. `publishing` is what
            `wordpressPublishStep` sets from inside the run, so the row says `pending`
            for the time between this response and the worker picking the event up.
          - `str(post_id)` was the *parsed* `uuid.UUID`, so the echoed `post_id` was the
            lowercase canonical form however the client cased the path, and Postgres
            compares the `uuid` column case-insensitively either way. The handler echoes
            the stored id.
          - a null `output_format` was interpolated into the trailing 400 as `'None'`,
            because Python formatted the value straight into the f-string.

          **One divergence, temporary and named.** Python had a second branch that
          enqueued `publish_to_nextjs`, and the workflow behind it does not exist:
          `api/src/services/nextjs_publish.py` is still Python-only. Until item
          5.3c-iii-b-2 ports it, an `output_format` of `nextjs` takes the trailing 400
          with every other unsupported format. That 400 was listed under 5.3c-iii-b-2 in
          the split, but a handler needs a terminal branch, so it landed here and
          5.3c-iii-b-2 only inserts the `nextjs` branch above it.

          The write carries `ownedByCaller()` as well as the id even though the preceding
          `SELECT` already proved ownership, matching `/run` and `/pause`; and
          `updated_at` is hand-stamped, the deviation recorded under 5.2b, 5.3b-ii and
          5.3c-iii-a, so re-publishing an already `pending` post bumps it where
          SQLAlchemy's `onupdate` emitted no `UPDATE` at all.

          The twenty tests are in `web/src/app/api/posts/run-control.test.ts`, which now
          covers all six per-post pipeline-control endpoints against the real database,
          real BetterAuth sessions and the real Redis Streams bus. The start is recorded
          through a mock that reads `wp_publish_status` back *before* handing the start
          on, which is the only way to observe that Python committed `pending` before it
          enqueued: the worker overwrites the value as soon as it picks the event up, so
          an assertion made after the response cannot tell the two orders apart. That is
          the same "assert from inside the boundary" trick 5.3c-iii-b-1-c-iii needed for
          `publishing`.

          ```
          $ pnpm -C web vitest run src/app/api/posts/run-control.test.ts --reporter=verbose
           v POST /api/posts/{post_id}/publish > rejects an unauthenticated request 1ms
           v POST /api/posts/{post_id}/publish > answers a malformed path uuid with FastAPI's 422 2ms
           v POST /api/posts/{post_id}/publish > answers a post that does not exist with a 404 2ms
           v POST /api/posts/{post_id}/publish > answers another user's post with the same 404, starting nothing 4ms
           v POST /api/posts/{post_id}/publish > answers a post whose profile_id is null with a 404 3ms
           v POST /api/posts/{post_id}/publish > refuses a post with neither ready_content nor final_md_content 6ms
           v POST /api/posts/{post_id}/publish > treats empty content as absent, the way a falsy Python string was 6ms
           v POST /api/posts/{post_id}/publish > publishes a post whose only content is ready_content 8ms
           v POST /api/posts/{post_id}/publish > publishes a post whose ready_content is empty but has a draft to fall back on 6ms
           v POST /api/posts/{post_id}/publish > checks for content before it looks at output_format 5ms
           v POST /api/posts/{post_id}/publish > writes wp_publish_status = pending and answers 202 6ms
           v POST /api/posts/{post_id}/publish > commits pending before it starts the run, so the worker never races the write 4ms
           v POST /api/posts/{post_id}/publish > leaves the Next.js publish column alone 6ms
           v POST /api/posts/{post_id}/publish > re-publishes a post that already failed, clearing the status back to pending 6ms
           v POST /api/posts/{post_id}/publish > starts nothing for a pipeline run: publishing is its own workflow 5ms
           v POST /api/posts/{post_id}/publish > answers an output_format Python had no branch for with a 400 naming it 5ms
           v POST /api/posts/{post_id}/publish > renders a null output_format the way Python interpolated None 4ms
           v POST /api/posts/{post_id}/publish > takes that same 400 for nextjs, which is this item's one divergence 5ms
           v POST /api/posts/{post_id}/publish > echoes the stored id, not the path casing, as `str(post_id)` did 5ms
           v POST /api/posts/{post_id}/publish > publishes a real workflow.start for wordpress-publish 32ms
           Test Files  1 passed (1)
                Tests  73 passed (73)
             Start at  08:09:34
             Duration  2.69s (transform 220ms, setup 82ms, import 877ms, tests 1.66s, environment 0ms)
          ```

          The last of those is a real start over the bus, not a recorded one: the fixture
          profile carries no WordPress credentials, so a worker started by another test
          file that picks the event up stops at the credentials guard without an upload or
          an outbound request. The 53 tests already in the file are the five other control
          endpoints, unchanged.

          Twenty mutations, each applied to the handler alone and reverted after
          measuring. All twenty are killed:

          ```
          1  ownership predicate dropped from the lookup            2 failed | 71 passed (73)
          2  content guard deleted                                  3 failed | 70 passed (73)
          3  content guard tests for null instead of falsiness      1 failed | 72 passed (73)
          4  content guard reads only ready_content                10 failed | 63 passed (73)
          5  content guard reads only final_md_content              1 failed | 72 passed (73)
          6  status written as publishing rather than pending       7 failed | 66 passed (73)
          7  run started before the status is committed             4 failed | 69 passed (73)
          8  run never started                                      5 failed | 68 passed (73)
          9  status write dropped, run still started                7 failed | 66 passed (73)
          10 202 becomes 200                                        6 failed | 67 passed (73)
          11 output_format check dropped, every format publishes    3 failed | 70 passed (73)
          12 nextjs joins the wordpress branch                      1 failed | 72 passed (73)
          13 null output_format interpolated as JavaScript null     1 failed | 72 passed (73)
          14 format check runs before the content check             1 failed | 72 passed (73)
          15 404 dropped, an unknown post answers 400               3 failed | 70 passed (73)
          16 auth check dropped                                     1 failed | 72 passed (73)
          17 uuid guard dropped                                     1 failed | 72 passed (73)
          18 the nextjs publish column is written too               1 failed | 72 passed (73)
          19 pipeline run started in place of the publish workflow  6 failed | 67 passed (73)
          20 response echoes the raw path id, not the stored one    1 failed | 72 passed (73)
          ```

          Mutation 20 survived the first pass, against the 72-test suite, and is the one
          gap the twenty found: every test until then handed the endpoint a path id that
          was already the stored lowercase form, so `id` and `post.id` were the same
          string. The uppercase-path test above was added for it, and the whole table was
          then re-measured against the 73-test suite, which is the run pasted here.

          Gates:

          ```
          $ pnpm -C web tsc --noEmit
          TSC EXIT=0
          (no output)

          $ pnpm -C web lint
          LINT EXIT=0
          (no output)

          $ pnpm -C web test
           Test Files  2 failed | 118 passed (120)
                Tests  9 failed | 3950 passed | 7 skipped (3966)
          # the 9 are the Phase 0 baseline: 6 in image-preview.test.tsx and 3 in
          # PostDetail.test.tsx. Passing count 3930 -> 3950 (+20).
          # Two of the three full runs made for this item reported 10 failures instead,
          # the extra being src/mastra/workflows/scaffold-check.test.ts: that is the
          # flake recorded under 5.3c-iii-b-1-c-ii-2, and the failing file list on those
          # runs was exactly the baseline two plus scaffold-check.

          $ pnpm -C web build
          v Compiled successfully in 4.3s
          |- f /api/posts/[id]/publish
          # The 15 BetterAuth "default secret" lines are the pre-existing,
          # environment-driven warning recorded under item 1.2.

          $ cd api && set -a && . ../.env && set +a && uv run pytest -q
          120 failed, 241 passed, 25 errors in 15.07s
          # the Phase 0 baseline exactly, unchanged by this item
          ```

## 5.3c-iii-b-2-a


            Ported to `web/src/mastra/nextjs/frontmatter-mapping.ts`. Thirty lines of
            Python, and almost every one of them is a distinction JavaScript spells the
            same way as its opposite, so the port is pinned by an oracle rather than by
            reading:

            - `jena_field in jena_frontmatter` in the string-target branch is key
              membership, so a field stored as `null` is copied through, while
              `jena_frontmatter.get(jena_field)` in the dict-target branch cannot tell a
              stored `null` from an absent key. The same field takes both branches
              depending on the mapping, and they disagree about it.
            - `value is None` and `default is not None` are identity against `None`, not
              truthiness. `false`, `0`, `""` and `[]` are all values, and all defaults.
            - `isinstance(target, dict)` excludes a list, so a target stored as an array
              is skipped entirely rather than read for a `key`.
            - the `continue` after a default is taken means a default is never wrapped by
              `transform: "array"`; only a real value is.

            **Four shapes an object-based transcription would lose**, which is why both
            the mapping and the frontmatter are `Map`s and so is the result:

            - `__proto__` is an ordinary dict key in Python. `result["__proto__"] = v` on
              an object literal is a prototype write, not a field: the test asserts
              `Object.hasOwn(naive, "__proto__") === false` after exactly that write.
              Both a source field and a target key can be `__proto__`, and the oracle
              covers both.
            - `target.get("key", jena_field)` hands back whatever the mapping stored, so
              the result's keys are not all strings. `{"key": null}` produces a `None` key
              and `{"key": 5}` an `int` key, which an object would stringify.
            - an object reorders integer-like keys ahead of the rest; Python's dict and a
              `Map` both keep insertion order. A mapping onto targets `"10"` and `"2"`
              comes out in that order here and reversed through `Object.fromEntries`.
            - Python hashes `True` with `1`, so two targets writing those two keys write
              one entry. `Map` does not, so `setResultKey` looks for the twin.

            **One divergence, deliberate:** a mapping whose `key` is a list or an object
            raises `TypeError: unhashable type: 'list'` out of the hook in Python, and the
            hook does not catch it, so the publish fails. The port raises the same
            `TypeError` with the same message rather than stringifying the key, because
            the alternative is publishing a post Python refused to publish. Two oracle
            cases record it.

            The oracle is `web/src/mastra/nextjs/data/nextjs-frontmatter-mapping-parity.json`,
            written by `api/scripts/export_frontmatter_mapping_parity.py`, which asserts
            the fifteen lines it is describing are still in the real function
            (`inspect.getsource`) before it runs them, so the recorded answers cannot
            drift without the export failing. 55 cases; both the inputs and the result are
            pair lists, and the result's keys carry their Python type.

            ```
            $ cd api && PYTHONPATH=. uv run python scripts/export_frontmatter_mapping_parity.py
            wrote 55 cases to .../web/src/mastra/nextjs/data/nextjs-frontmatter-mapping-parity.json (42 with a non-empty result, 2 raising)

            $ pnpm -C web vitest run src/mastra/nextjs/frontmatter-mapping.test.ts
             v src/mastra/nextjs/frontmatter-mapping.test.ts (61 tests) 4ms
             Test Files  1 passed (1)
                  Tests  61 passed (61)
               Duration  401ms
            ```

            Twenty-one mutations, each applied to the module alone and reverted after
            measuring. Eighteen are killed:

            ```
            1  membership check becomes a value check                1 failed | 60 passed (61)
            2  the dict target check accepts a list                  1 failed | 60 passed (61)
            3  an unhashable list key is written rather than raised   1 failed | 60 passed (61)
            4  an unhashable dict key is written rather than raised   1 failed | 60 passed (61)
            5  a stored null key falls back to the source field       1 failed | 60 passed (61)
            6  the key fallback is dropped                            1 failed | 60 passed (61)
            7  a default stored as null is treated as a default       1 failed | 60 passed (61)
            8  the default check becomes truthiness                   3 failed | 58 passed (61)
            9  the first value check becomes truthiness               2 failed | 59 passed (61)
            10 the second value check only sees an absent key         1 failed | 60 passed (61)
            11 the continue after a default is dropped                SURVIVED
            12 any transform wraps                                    5 failed | 56 passed (61)
            13 the array transform wraps a list too                   2 failed | 59 passed (61)
            14 the array transform is applied to a default too        1 failed | 60 passed (61)
            15 the true/1 key equivalence is dropped                  1 failed | 60 passed (61)
            16 the twin lookup runs even for a key already present    SURVIVED
            17 the target fields are read without a hasOwn guard      SURVIVED
            18 the mapping is walked in reverse                       6 failed | 55 passed (61)
            19 a string target writes the source field name          12 failed | 49 passed (61)
            20 the dict branch reads the frontmatter under the target key  16 failed | 45 passed (61)
            21 an absent key is not None                             10 failed | 51 passed (61)
            ```

            The three survivors are equivalent mutants, and the argument is the same one
            Python's own source supports:

            - **11** deletes the `continue` after a default is written. The very next
              statement is `if (isNone(value)) continue`, and the branch was only entered
              because `value` is `None`, so control leaves the iteration at the same point
              either way. Python carries the identical redundancy.
            - **16** removes the `if (!result.has(key))` guard around the twin lookup. If
              the key is already present its twin cannot also be present, because the
              lookup that inserted it would have merged them; the map starts empty, so the
              invariant holds by induction and the guard can never change the answer.
            - **17** replaces the `Object.hasOwn` read of `transform` and `default` with a
              direct property read. `Object.prototype` carries neither name, and the
              mapping's targets are `JSON.parse` output whose prototype is
              `Object.prototype`, so the two reads agree on every value reachable from the
              `nextjs_frontmatter_map` JSONB column. Killing it would need
              `Object.create({default: ...})`, which no JSONB decode produces, so a
              control for it would pin depth rather than a defect.

            Two oracle cases were added mid-item for mutations 4 and 10, which the first
            53 did not reach: no case had a dict-shaped `key`, and no case had a source
            field stored as `null` with no default beside it.

            Gates:

            ```
            $ pnpm -C web tsc --noEmit
            TSC EXIT=0
            (no output)

            $ pnpm -C web lint
            LINT EXIT=0
            (no output)

            $ pnpm -C web test
             Test Files  2 failed | 119 passed (121)
                  Tests  9 failed | 4011 passed | 7 skipped (4027)
            # the 9 are the Phase 0 baseline: 6 in image-preview.test.tsx and 3 in
            # PostDetail.test.tsx, and no other file failed. Passing 3950 -> 4011 (+61).

            $ pnpm -C web build
            v Compiled successfully in 4.2s

            $ cd api && uv run ruff check scripts/export_frontmatter_mapping_parity.py
            All checks passed!
            $ cd api && uv run ruff format --check scripts/export_frontmatter_mapping_parity.py
            1 file already formatted

            $ cd api && set -a && . ../.env && set +a && uv run pytest -q
            120 failed, 241 passed, 25 errors in 15.21s
            # the Phase 0 baseline exactly, unchanged by this item
            ```

## 5.3d-i


      Ported to `web/src/app/api/posts/[id]/export/markdown/route.ts` and
      `web/src/app/api/posts/[id]/export/html/route.ts`. The two content
      transformations live in `web/src/app/api/posts/export-content.ts`:
      `stripLeadingH1()` (from `strip_leading_h1` in
      `api/src/pipeline/helpers.py`, whose only callers were these endpoints) and
      `rewriteMediaUrls()` (the `export_content.replace(f"/media/{post_id}/", "/")`
      line). Ownership is the same inner join to `website_profiles` used by `GET
      /api/posts/{post_id}`, so another user's post and a missing one are the same
      404, and a post with a null `profile_id` is invisible.

      **Three regex-dialect differences make a literal transcription wrong**, and
      each is pinned by its own oracle case rather than argued:

      - `re.MULTILINE` makes Python's `^` and `$` match around `\n` only;
        JavaScript's `m` flag also matches around `\r`, ` ` and ` `. The
        Python semantics are spelled out as `(?:^|(?<=\n))` and `(?=\n|$)`.
      - Without `re.DOTALL` Python's `.` excludes `\n` alone; JavaScript's also
        excludes `\r`, ` ` and ` `. `[^\n]` is used wherever Python wrote
        a non-DOTALL `.`.
      - `str.strip("\"'")` strips a *set* of characters from both ends until it
        reaches one outside the set, which no `trim`-shaped JavaScript API does.

      The oracle is `web/src/app/api/posts/data/strip-leading-h1-parity.json`,
      written by `api/scripts/export_strip_leading_h1_parity.py` running the real
      Python helper over 30 inputs (18 of which it modifies, 12 of which it returns
      untouched, so a no-op implementation and an always-strip implementation both
      fail).

      ```
      $ cd api && PYTHONPATH=. uv run python scripts/export_strip_leading_h1_parity.py
      wrote 30 cases to /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/app/api/posts/data/strip-leading-h1-parity.json (18 of them modified by the strip)
      ```

      Two smaller Python/JavaScript differences are left in place, deliberately, and
      are the known gap in this item: Python's `\s` covers `\x1c`-`\x1f` and `\x85`
      where JavaScript's does not and JavaScript's covers `﻿` where Python's
      does not, and `str.lower()` and `String.toLowerCase()` disagree on a handful
      of non-Latin characters. Closing either would mean hand-rolling a character
      class in place of `\s` and a case-folding table in place of `toLowerCase()`,
      inside a function whose input is YAML frontmatter written by an LLM. Neither
      difference can change whether an H1 is stripped without a control character
      inside a markdown heading.

      Two behaviours worth naming because they look like bugs and are faithful:
      `post.ready_content or post.final_md_content` treats an empty string as
      absent, so a post whose `ready_content` is `""` exports `final_md_content`
      (`??` fails that test); and the HTML export applies neither the H1 strip nor
      the media rewrite, because those exist to make an MDX file portable into a
      blog repository while the HTML is pasted into a CMS still serving images from
      this app.

      `str()` on the `uuid.UUID` FastAPI parsed is always the lowercase canonical
      form, so an uppercase id in the request path still rewrote lowercase media
      URLs. `rewriteMediaUrls()` lowercases the id to keep that.

      Starlette appends `charset=utf-8` to any `text/*` media type, probed rather
      than assumed, so both handlers spell the content type out in full:

      ```
      $ cd api && uv run python -c "..."
      {'content-disposition': 'attachment; filename="a.mdx"', 'content-length': '1', 'content-type': 'text/markdown; charset=utf-8'}
      {'content-disposition': 'attachment; filename="a.html"', 'content-length': '9', 'content-type': 'text/html; charset=utf-8'}
      ```

      52 tests in `web/src/app/api/posts/export.test.ts`: 30 oracle replays, a
      guard that the oracle covers both outcomes, 3 for the media rewrite, and 18
      handler tests against the real database and real BetterAuth sessions.

      ```
      $ pnpm -C web vitest run src/app/api/posts/export.test.ts --reporter=verbose
       ✓ src/app/api/posts/export.test.ts > stripLeadingH1 against the Python oracle > covers both outcomes, so a no-op implementation cannot pass 1ms
       ✓ ... > matches Python: empty 1ms
       ✓ ... > matches Python: no frontmatter, leading h1 1ms
       ✓ ... > matches Python: frontmatter without a title key 1ms
       ✓ ... > matches Python: title matches h1 1ms
       ✓ ... > matches Python: title does not match h1 1ms
       ✓ ... > matches Python: match differs only by case 1ms
       ✓ ... > matches Python: double-quoted title, bare h1 1ms
       ✓ ... > matches Python: single-quoted title, bare h1 1ms
       ✓ ... > matches Python: bare title, quoted h1 1ms
       ✓ ... > matches Python: h1 preceded by blank lines 1ms
       ✓ ... > matches Python: h1 indented by spaces 1ms
       ✓ ... > matches Python: several blank lines after the h1 1ms
       ✓ ... > matches Python: no blank line after the h1 1ms
       ✓ ... > matches Python: h1 is the whole body, no trailing newline 1ms
       ✓ ... > matches Python: h2 rather than h1 1ms
       ✓ ... > matches Python: hash with no space 1ms
       ✓ ... > matches Python: trailing spaces after the h1 text 1ms
       ✓ ... > matches Python: trailing spaces after the title 1ms
       ✓ ... > matches Python: two title keys, first wins 1ms
       ✓ ... > matches Python: title key not at line start 1ms
       ✓ ... > matches Python: body contains a later thematic break 1ms
       ✓ ... > matches Python: frontmatter fence with trailing spaces 1ms
       ✓ ... > matches Python: crlf line endings 1ms
       ✓ ... > matches Python: title contains a colon 1ms
       ✓ ... > matches Python: h1 text differs by trailing punctuation 1ms
       ✓ ... > matches Python: body is empty 0ms
       ✓ ... > matches Python: lone carriage return inside the title and the h1 1ms
       ✓ ... > matches Python: title key preceded by a lone carriage return 1ms
       ✓ ... > matches Python: line separator inside the title and the h1 1ms
       ✓ ... > matches Python: media urls survive the strip 0ms
       ✓ src/app/api/posts/export.test.ts > rewriteMediaUrls > rewrites every occurrence, not just the first 1ms
       ✓ ... > rewriteMediaUrls > lowercases the id, because FastAPI handed the handler a parsed UUID 1ms
       ✓ ... > rewriteMediaUrls > leaves another post's media directory alone 1ms
       ✓ ... > GET /api/posts/{post_id}/export/markdown > 401s without a session 6ms
       ✓ ... > 422s on a malformed uuid 11ms
       ✓ ... > 404s on a post that does not exist 4ms
       ✓ ... > 404s on another user's post, with the same body as a missing one 4ms
       ✓ ... > 404s on a post with no profile, because the ownership join is inner 3ms
       ✓ ... > 404s with its own detail when neither content column holds anything 4ms
       ✓ ... > prefers ready_content over final_md_content 4ms
       ✓ ... > falls through to final_md_content when ready_content is empty, matching `or` 4ms
       ✓ ... > serves the body as a .mdx attachment named after the slug 4ms
       ✓ ... > strips the duplicated H1 and rewrites every media URL 4ms
       ✓ ... > rewrites media URLs for an uppercase id in the path 4ms
       ✓ ... > GET /api/posts/{post_id}/export/html > 401s without a session 2ms
       ✓ ... > 422s on a malformed uuid 2ms
       ✓ ... > 404s on another user's post, with the same body as a missing one 3ms
       ✓ ... > 404s with its own detail when final_html_content is empty 3ms
       ✓ ... > ignores ready_content: the HTML export reads one column only 3ms
       ✓ ... > serves the body as an .html attachment named after the slug 3ms
       ✓ ... > applies no H1 strip and no media rewrite, unlike the markdown export 3ms

       Test Files  1 passed (1)
            Tests  52 passed (52)
      ```

      Six negative controls, each reverted immediately after:

      ```
      NC1  literal transcription of all three Python regexes (m flag, bare `.`)
           -> 3 failed | 49 passed
           x matches Python: lone carriage return inside the title and the h1
           x matches Python: title key preceded by a lone carriage return
           x matches Python: line separator inside the title and the h1
      NC2  `.trim()` in place of `str.strip("\"'")`
           -> 1 failed | 51 passed
           x matches Python: bare title, quoted h1
      NC3  `replace()` in place of `replaceAll()`
           -> 2 failed | 50 passed
           x rewrites every occurrence, not just the first
           x strips the duplicated H1 and rewrites every media URL
      NC4  no `toLowerCase()` on the path id
           -> 2 failed | 50 passed
           x lowercases the id, because FastAPI handed the handler a parsed UUID
           x rewrites media URLs for an uppercase id in the path
      NC5  `??` in place of Python's `or` for ready_content
           -> 1 failed | 51 passed
           x falls through to final_md_content when ready_content is empty, matching `or`
      NC7  HTML export routed through stripLeadingH1
           -> 1 failed | 51 passed
           x applies no H1 strip and no media rewrite, unlike the markdown export
      ```

      NC1 is the reason the last three oracle cases exist: before they were added,
      the literal transcription passed all 49 tests, so the careful implementation
      was unpinned. The three added inputs put a lone `\r` or a ` ` inside the
      title and the H1, which is exactly where the two dialects part.

      Frontend gates, all from `web/`:

      ```
      $ pnpm tsc --noEmit
      TSC_EXIT=0

      $ pnpm lint
      LINT_EXIT=0

      $ pnpm test
      TEST_EXIT=1
       Test Files  2 failed | 73 passed (75)
            Tests  9 failed | 1305 passed | 7 skipped (1321)
      # 6 image-preview.test.tsx + 3 PostDetail.test.tsx, the recorded baseline.

      $ pnpm build
      BUILD_EXIT=0
      ✓ Compiled successfully in 3.6s
      ✓ Generating static pages using 15 workers (30/30) in 245.4ms
      Route (app)
      ├ ƒ /api/posts/[id]/export/html
      ├ ƒ /api/posts/[id]/export/markdown
      ```

      Backend gates, unchanged from their baseline:

      ```
      $ cd api && set -a && . ../.env && set +a && uv run pytest -q
      125 failed, 236 passed, 25 errors in 12.95s

      $ uv run ruff check .
      Found 32 errors.

      $ uv run ruff format --check .
      9 files would be reformatted, 130 files already formatted
      ```

## 5.3d-ii


      Ported to `web/src/app/api/posts/[id]/export/all/route.ts`. The content half
      is the same three steps `/export/markdown` runs (`ready_content or
      final_md_content`, `stripLeadingH1`, `rewriteMediaUrls`), reused from
      `export-content.ts`; the 404 detail is a different string
      (`"No content available to export"`, not `"No markdown content available"`)
      so it stays in the handler. The archive half is new.

      **The zip writer is `fflate` (0.8.3), added as a direct dependency of
      `web/`.** Node has no zip API. Of the three candidates the item named:

      - `archiver` is a stream pipeline with a large dependency tree, and is
        present in this repo only as a transitive dependency of the `mastra` CLI
        devDependency, so using it would mean either promoting it to a direct
        production dependency or importing a devDependency's transitive package
        from production code.
      - `jszip` is several times the size and its API is promise-based, which buys
        nothing here: Python did not stream either (see below).
      - `fflate` has zero dependencies and a synchronous `zipSync(entries)` that
        returns the finished bytes, which is the exact shape of what Python was
        doing. Its default `level` is 6 deflate, the same method
        `zipfile.ZIP_DEFLATED` selects.

      **`StreamingResponse` is replaced by a plain `Response`, and that is not a
      downgrade.** Python built the entire archive into a `BytesIO`, called
      `buf.seek(0)`, and handed the finished buffer to `StreamingResponse`.
      Nothing was ever produced lazily, so the streaming wrapper only changed
      whether a `content-length` was sent. A `Response` over the `Uint8Array`
      `zipSync` returns is the same archive delivered the same way.

      Python's own zip semantics, probed rather than assumed:

      ```
      $ cd api && uv run python /tmp/probe_zip_5_3d_ii.py
      IS_FILE: [('.hidden', True), ('broken.webp', False), ('link-to-file.webp', True),
       ('real.webp', True), ('subdir', False)]
      METHODS: [('a.mdx', 8), ('real.webp', 8)]
      ZIP_DEFLATED = 8
      SIG: 504b0304 method field: 8
      DUP WARNINGS: ["Duplicate name: 'dup.mdx'"]
      DUP NAMELIST: ['dup.mdx', 'dup.mdx']
      HEADERS: {'content-disposition': 'attachment; filename="s.zip"',
       'content-type': 'application/zip'}
      ```

      Three things that fixes in place. `Path.is_file()` follows symlinks and
      answers `False` on a broken one rather than raising, so `Dirent.isFile()`
      from `readdir(dir, { withFileTypes: true })` is **not** a valid port: it
      reports on the directory entry, so a symlink pointing at an image would be
      dropped. The handler `stat`s each entry and treats a throwing `stat` as the
      broken-symlink case. `.hidden` is included, because `iterdir()` filters on
      nothing but `is_file()`. And `StreamingResponse` does not append a charset to
      `application/zip`, only to `text/*`, so the content type is bare.

      **Interop check: Python's own `zipfile` reads the archive `fflate` writes.**
      A throwaway test drove the real handler against the real database with a
      real media file and wrote the response bytes to disk; `zipfile` read them
      back with CRCs intact.

      ```
      $ uv run python -c "import zipfile; z = zipfile.ZipFile('/tmp/zip-interop.zip'); ..."
      TESTZIP (None means no corruption): None
      zip-interop-cd7eedd7-4b21-4c53-b192-a46f3078e9b9.mdx method= 8 size= 600 compressed= 13
      img.webp method= 8 size= 4 compressed= 6
      mdx head: b'hello hello hello hello hello '
      img bytes: ffd80080
      ```

      Deviations, both consequences of `zipSync` taking an object rather than an
      ordered list of entries, and neither changing any file's contents:

      1. An image whose name is exactly `<slug>.mdx` replaces the markdown entry
         instead of producing the duplicate-name archive Python emits with a
         `UserWarning` (`DUP NAMELIST: ['dup.mdx', 'dup.mdx']` above). A zip with
         two entries under one name is not something a reader can resolve
         sensibly, so the object-keyed API's behaviour is the better of the two.
      2. An image named with a canonical integer string (`"42"`, no extension)
         would be moved to the front of the archive by JavaScript's own object key
         ordering. Python emits entries in `iterdir()` order, which is itself
         arbitrary readdir order, so neither implementation promises an order.

      One faithfulness detail kept: `zf.write()` copies the source file's mtime
      into its archive entry while `writestr` stamps the current time, so the
      media entries carry their `stat` mtime and the `.mdx` entry does not.

      `web/src/lib/api.ts` needs no change: `posts.exportAll(id)` already builds
      `/api/posts/{id}/export/all`, which is the path this handler answers on.

      21 tests in `web/src/app/api/posts/export-all.test.ts`, against the real
      database, real BetterAuth sessions and a real temporary `MEDIA_DIR` holding
      real files, symlinks and a subdirectory. The archive is read back two ways
      on purpose: `unzipSync` for the entry map, and a hand-parsed local file
      header inflated with `node:zlib` so the deflate claim does not rest on the
      same library that wrote it.

      ```
      $ set -a && . ./.env && set +a && cd web \
        && npx vitest run src/app/api/posts/export-all.test.ts --reporter=verbose
      ✓ GET /api/posts/{post_id}/export/all: access > 401s without a session 7ms
      ✓ GET /api/posts/{post_id}/export/all: access > 422s on a malformed uuid 13ms
      ✓ GET /api/posts/{post_id}/export/all: access > 404s on a post that does not exist 4ms
      ✓ GET /api/posts/{post_id}/export/all: access > 404s on another user's post, with the same body as a missing one 5ms
      ✓ GET /api/posts/{post_id}/export/all: access > 404s on a post with no profile, because the ownership join is inner 3ms
      ✓ GET /api/posts/{post_id}/export/all: content selection > 404s with a detail of its own, not the markdown export's 5ms
      ✓ GET /api/posts/{post_id}/export/all: content selection > 404s even when images exist, because the check is on content alone 5ms
      ✓ GET /api/posts/{post_id}/export/all: content selection > prefers ready_content over final_md_content 5ms
      ✓ GET /api/posts/{post_id}/export/all: content selection > falls through to final_md_content when ready_content is empty, matching `or` 4ms
      ✓ GET /api/posts/{post_id}/export/all: content selection > strips the duplicated H1 and rewrites every media URL in the .mdx entry 5ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > serves application/zip with no charset, as a .zip attachment named after the slug 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > holds only the .mdx when the post has no media directory 3ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > holds only the .mdx when the media directory is empty 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > adds every media file at the archive root, under its own bare name 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > copies image bytes through unchanged, including bytes that are not valid utf-8 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > skips subdirectories, which is what `is_file()` excludes 3ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > includes dotfiles, because iterdir() filters on nothing but is_file() 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > follows a symlink to a file, which Dirent.isFile() would have skipped 3ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > skips a broken symlink instead of failing the export 3ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > lowercases the id for both the media directory and the URL rewrite 4ms
      ✓ GET /api/posts/{post_id}/export/all: the archive > is a deflate-compressed zip, read straight out of the local file header 3ms
      Test Files  1 passed (1)
           Tests  21 passed (21)
      ```

      Negative controls, each applied to the handler alone with the tests
      unchanged:

      ```
      NC1  postMediaDir(id) instead of postMediaDir(id.toLowerCase())
           Tests  21 passed (21)          <- does NOT fail, see below
      NC2  post.readyContent ?? post.finalMdContent instead of ||
           x falls through to final_md_content when ready_content is empty, matching `or`
           Tests  1 failed | 20 passed (21)
      NC3  readdir({withFileTypes:true}).filter(d => d.isFile()) instead of stat()
           x follows a symlink to a file, which Dirent.isFile() would have skipped
           Tests  1 failed | 20 passed (21)
      NC4  skip the media directory entirely (mdx-only archive)
           x adds every media file at the archive root, under its own bare name
           x copies image bytes through unchanged, including bytes that are not valid utf-8
           x includes dotfiles, because iterdir() filters on nothing but is_file()
           x follows a symlink to a file, which Dirent.isFile() would have skipped
           x skips a broken symlink instead of failing the export
           x lowercases the id for both the media directory and the URL rewrite
           Tests  6 failed | 15 passed (21)
      NC5  zipSync(entries, { level: 0 }) (store) instead of the default deflate
           x is a deflate-compressed zip, read straight out of the local file header
           Tests  1 failed | 20 passed (21)
      ```

      **NC1 did not fail, and that is a real limitation rather than a passing
      control.** macOS's default APFS is case-insensitive, so the uppercase media
      directory path resolves to the lowercase directory the test created. The
      `toLowerCase()` in the handler is still required on a case-sensitive
      filesystem (Linux, which is what both Railway services run on), and the URL
      rewrite half of the same test is a plain string comparison that fails on
      either platform. The test carries this caveat in a comment above it.

      Frontend gates:

      ```
      $ cd web && npx tsc --noEmit
      TSC_EXIT=0

      $ cd web && npx eslint
      LINT_EXIT=0

      $ set -a && . ./.env && set +a && cd web && npx vitest run
       Test Files  2 failed | 74 passed (76)
            Tests  9 failed | 1326 passed | 7 skipped (1342)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx. Passing count is 1305 -> 1326, the 21 added here.

      $ cd web && npx next build
      BUILD_EXIT=0
      Route (app)
      ...
      ├ f /api/posts/[id]/duplicate
      ├ f /api/posts/[id]/export/all
      ├ f /api/posts/[id]/export/html
      ├ f /api/posts/[id]/export/markdown
      ├ f /api/posts/[id]/pause
      ...
      ```

      `api/` gates, unchanged by this iteration and still on their baseline:

      ```
      $ set -a && . ./.env && set +a && cd api && uv run pytest -q
      125 failed, 236 passed, 25 errors in 13.30s

      $ uv run ruff check .
      Found 32 errors.

      $ uv run ruff format --check .
      9 files would be reformatted, 130 files already formatted
      ```

## 5.3d-iii


      `web/src/app/api/posts/[id]/logs/route.ts` ports `get_execution_logs` and
      `web/src/app/api/posts/[id]/analytics/route.ts` ports `post_analytics`. Both are
      thin, and both hide a decision a reading gets wrong, so both are pinned by an
      oracle: `api/scripts/export_post_logs_analytics_parity.py` drives the two real
      endpoint coroutines with a stubbed session standing in for `_get_user_post()`, the
      same technique the create-post oracle used in 5.3b-i, and writes
      `web/src/app/api/posts/data/logs-analytics-parity.json`.

      ```
      $ cd api && PYTHONPATH=. uv run python scripts/export_post_logs_analytics_parity.py
      wrote 19 log cases and 15 analytics cases to .../web/src/app/api/posts/data/logs-analytics-parity.json
      ```

      **`/logs`: three filters, and each one is falsy-guarded rather than
      absent-guarded.** `if level:`, `if stage:` and `if since:` all test truthiness, so
      an empty value skips its filter entirely rather than matching nothing. That splits
      three ways once the query string is involved:

      - `?level=` parses to `[""]`, a non-empty list holding the empty string, so it
        filters and matches nothing;
      - `?stage=` and `?since=` parse to `""`, which is falsy, so they do not filter;
      - `level` absent parses to `None` in FastAPI and `[]` from `getAll()` here, and
        both are falsy, so the two agree without a special case.

      `level` is the only repeated parameter (`list[str] | None = Query(None)`), so it is
      `getAll()`; `stage` and `since` are scalars and Starlette's `QueryParams` keeps the
      last occurrence of each, which is the same `.at(-1)` recorded in 5.3c-i.

      **`since` is a string comparison, not a date one.** Python evaluates
      `entry.get("ts", "") > since`, so an entry with no `ts` compares as `""` and loses
      to any non-empty `since`, and a bare `"2026-08"` filters just as well as a full
      timestamp. The oracle pins both:

      ```
      an entry with no ts defaults to the empty string and loses -> 0 entries
      since is not parsed as a date, so a bare word filters       -> 6 entries
      since is a strict string comparison                         -> 3 entries
      ```

      JavaScript's `>` on strings compares UTF-16 code units where Python compares code
      points, and the two disagree once an astral character meets one in
      `U+E000`-`U+FFFF`, so the comparison is spelled out as `pythonGreater()` rather
      than left to the operator. Only `ts` values reach it and `append_execution_log`
      writes an ISO timestamp, but `since` is client-supplied.

      **`/analytics`: `ready_content` is deliberately not consulted.** The content is
      `final_md_content or draft_content or ""`, unlike every export endpoint, which
      prefers `ready_content`. So the numbers describe the edited draft rather than the
      assembled article. Pinned by the "ready_content is not consulted" case.

      **The two keyword rules differ.** `related_keywords[0]` is the primary only when it
      is a string, otherwise the primary is empty; `related_keywords[1:]` becomes the
      secondaries with the non-strings dropped. A list starting with a number therefore
      loses its head without promoting the next entry, which the obvious
      "filter to strings, take the first" rewrite gets wrong (negative control 5 below).

      The computation itself is `computeAnalytics` from `web/src/mastra/analytics`,
      already ported and pinned by its own parity data in Phase 3; these tests re-verify
      it end to end on a fresh article, including the rounding and the substring-based
      internal/external link split.

      Two oracle cases the Python allows and the database does not, so they are not in
      the file: `execution_logs` and `topic` are both `NOT NULL` in `posts`, so
      `post.execution_logs or []` and `post.topic or ""` can only ever see the empty list
      and the empty string, never a null.

      ```
      $ PGPASSWORD=... psql -h localhost -p 5435 -U pipeline -d content_pipeline \
          -c "select column_name, is_nullable from information_schema.columns
              where table_name='posts'
                and column_name in ('topic','website_url','related_keywords','execution_logs');"
         column_name    | is_nullable
      ------------------+-------------
       related_keywords | YES
       execution_logs   | NO
       topic            | NO
       website_url      | YES
      (4 rows)
      ```

      **Deviation: two crash paths become empty answers.** `entry.get(...)` on a
      non-dict raised `AttributeError`, and `entry.get("ts", "") > since` with a
      non-string `ts` raised `TypeError`; both surfaced as a 500. A non-object entry is
      treated here as one with no keys and a non-string `ts` as absent, which removes
      both error paths rather than adding one. Nothing can write such an entry:
      `append_execution_log` in `api/src/pipeline/helpers.py` is the only writer and it
      appends a five-string dict.

      **Contract note, logged in `todo.md` rather than changed here.**
      `PostAnalytics.seo_checklist` in `web/src/lib/api.ts` is typed
      `Record<string, boolean>`, but `_seo_checklist` has always returned
      `internal_link_count` and `external_link_count` alongside the seven booleans, so
      the real shape is `Record<string, boolean | number>`. The oracle shows it:

      ```
      "seo_checklist": {
       "keyword_in_title": false,
       "keyword_in_first_100_words": true,
       "keyword_in_h2": false,
       "has_h2_headings": true,
       "has_internal_links": true,
       "has_external_links": true,
       "internal_link_count": 2,
       "external_link_count": 1,
       "has_meta_description": true
      }
      ```

      Unlike the `thread_id` disagreement in 5.3a, correcting this one is not confined to
      `api.ts`: `SeoChecklist` in `web/src/components/analytics-bar.tsx` maps over every
      entry and renders the two counts as SEO checks, so the fix is a UI decision that
      belongs to Phase 8. `api.ts` is left alone and the endpoint reproduces the mixed
      map exactly. `api.ts` also has no client for `/logs` and never did; the endpoint is
      ported for parity and has no dashboard caller.

      The 52 tests are in `web/src/app/api/posts/logs-analytics.test.ts`, against the
      real database and real BetterAuth sessions:

      ```
      $ pnpm -C web vitest run src/app/api/posts/logs-analytics.test.ts --reporter=verbose
       v GET /api/posts/{post_id}/logs > rejects an unauthenticated request 3ms
       v GET /api/posts/{post_id}/logs > answers a malformed path uuid with FastAPI's 422 12ms
       v GET /api/posts/{post_id}/logs > answers a post that does not exist with a 404 4ms
       v GET /api/posts/{post_id}/logs > answers another user's post with the same 404 6ms
       v GET /api/posts/{post_id}/logs > answers a post whose profile_id is null with a 404 3ms
       v GET /api/posts/{post_id}/logs > returns a bare array, not an envelope 5ms
       v ... > matches the Python filters > empty list 5ms
       v ... > matches the Python filters > no filters returns every entry in order 3ms
       v ... > matches the Python filters > single level 4ms
       v ... > matches the Python filters > two levels 3ms
       v ... > matches the Python filters > level matching nothing 4ms
       v ... > matches the Python filters > empty level list is falsy, so no filter 3ms
       v ... > matches the Python filters > level of the empty string filters, matching nothing 3ms
       v ... > matches the Python filters > an entry with no level key never matches a level filter 3ms
       v ... > matches the Python filters > a non-string level is compared by equality, not by str() 3ms
       v ... > matches the Python filters > stage 3ms
       v ... > matches the Python filters > stage matching nothing 3ms
       v ... > matches the Python filters > empty stage is falsy, so no filter 3ms
       v ... > matches the Python filters > a null stage value never matches 3ms
       v ... > matches the Python filters > since is a strict string comparison 3ms
       v ... > matches the Python filters > since before everything 3ms
       v ... > matches the Python filters > since after everything 3ms
       v ... > matches the Python filters > an entry with no ts defaults to the empty string and loses 3ms
       v ... > matches the Python filters > since is not parsed as a date, so a bare word filters 3ms
       v ... > matches the Python filters > all three filters compose 3ms
       v GET /api/posts/{post_id}/logs > collects every occurrence of level, unlike the scalar parameters 3ms
       v GET /api/posts/{post_id}/logs > keeps the last occurrence of stage, matching Starlette's QueryParams 3ms
       v GET /api/posts/{post_id}/logs > keeps the last occurrence of since 3ms
       v GET /api/posts/{post_id}/logs > treats a valueless level as the empty string, which matches nothing 3ms
       v GET /api/posts/{post_id}/logs > treats a valueless stage as absent, since the empty string is falsy in Python 3ms
       v GET /api/posts/{post_id}/logs > compares since by code point, where JavaScript's > compares UTF-16 code units 3ms
       v GET /api/posts/{post_id}/analytics > rejects an unauthenticated request 1ms
       v GET /api/posts/{post_id}/analytics > answers a malformed path uuid with FastAPI's 422 1ms
       v GET /api/posts/{post_id}/analytics > answers a post that does not exist with a 404 2ms
       v GET /api/posts/{post_id}/analytics > answers another user's post with the same 404 3ms
       v GET /api/posts/{post_id}/analytics > answers a post whose profile_id is null with a 404 2ms
       v GET /api/posts/{post_id}/analytics > emits exactly the seven keys PostAnalytics declares, in order 32ms
       v ... > matches the Python wiring > no content at all 4ms
       v ... > matches the Python wiring > draft only 4ms
       v ... > matches the Python wiring > final_md_content wins over draft_content 3ms
       v ... > matches the Python wiring > empty final_md_content falls through to draft 3ms
       v ... > matches the Python wiring > ready_content is not consulted 3ms
       v ... > matches the Python wiring > no keywords 3ms
       v ... > matches the Python wiring > empty keyword list 3ms
       v ... > matches the Python wiring > one keyword is the primary and there are no secondaries 3ms
       v ... > matches the Python wiring > the first keyword is primary and the rest are secondary 3ms
       v ... > matches the Python wiring > a non-string first keyword yields an empty primary 3ms
       v ... > matches the Python wiring > non-string keywords are dropped from the secondaries 3ms
       v ... > matches the Python wiring > topic feeds the title check 3ms
       v ... > matches the Python wiring > an empty topic is an empty title 3ms
       v ... > matches the Python wiring > website_url decides which links count as internal 3ms
       v ... > matches the Python wiring > a null website_url leaves the domain empty 3ms
       Test Files  1 passed (1)
            Tests  52 passed (52)
         Start at  14:40:51
         Duration  924ms (transform 63ms, setup 119ms, import 460ms, tests 223ms, environment 0ms)
      ```

      Negative controls, each reverted after measuring:

      ```
      # 1. compare since with JavaScript's own > instead of pythonGreater()
      Tests  1 failed | 51 passed (52)
        x compares since by code point, where JavaScript's > compares UTF-16 code units

      # 2. level.includes(String(value)) instead of a string-typed equality
      Tests  1 failed | 51 passed (52)
        x a non-string level is compared by equality, not by str()

      # 3. read level with .slice(-1), the last-wins rule the scalar parameters use
      Tests  2 failed | 50 passed (52)
        x two levels
        x collects every occurrence of level, unlike the scalar parameters

      # 4. prefer readyContent in the analytics content fallback
      Tests  1 failed | 51 passed (52)
        x ready_content is not consulted

      # 5. filter related_keywords to strings first, then take the head as primary
      Tests  1 failed | 51 passed (52)
        x a non-string first keyword yields an empty primary

      # 6. drop the website_profiles join and match on posts.id alone, in both handlers
      Tests  4 failed | 48 passed (52)
        x answers another user's post with the same 404          (logs)
        x answers a post whose profile_id is null with a 404     (logs)
        x answers another user's post with the same 404          (analytics)
        x answers a post whose profile_id is null with a 404     (analytics)
      ```

      Gates:

      ```
      $ pnpm -C web tsc --noEmit
      TSC EXIT=0
      (no output)

      $ pnpm -C web lint
      LINT EXIT=0
      (no output)

      $ pnpm -C web test
       Test Files  2 failed | 75 passed (77)
            Tests  9 failed | 1378 passed | 7 skipped (1394)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx, both pre-existing. Passing count 1326 -> 1378 (+52).

      $ pnpm -C web build
      BUILD EXIT=0
      v Compiled successfully in 3.5s
      |- f /api/posts/[id]/analytics
      |- f /api/posts/[id]/logs
      # The BetterAuth "default secret" lines are the pre-existing, environment-driven
      # warning recorded under item 1.2.

      $ cd api && set -a && . ../.env && set +a && uv run pytest -q
      125 failed, 236 passed, 25 errors in 13.10s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

      All three Python numbers are the recorded baseline; the new oracle script is
      ruff-clean and ruff-formatted, which is why the format line reads 131 already
      formatted rather than 130. Measured by moving the script aside and re-running:
      `Found 32 errors` / `9 files would be reformatted, 130 files already formatted` /
      `4 failed, 205 passed, 177 errors` at HEAD without it. **Note the pytest run needs
      `../.env` sourced first**: without it the suite reports `4 failed, 205 passed,
      177 errors` because `POSTGRES_HOST_PORT` is 5435 in this checkout, not the 5433
      compose default. That is the trap recorded in the project memory, and it is easy to
      mistake for a regression.

## 5.4


  Only three of the seven are reachable from the dashboard: `web/src/lib/api.ts`'s
  `queue` namespace declares `status`, `pauseAll` and `resumeAll` and nothing else, and
  `grep -rn "worker-status\|dead-letter\|worker_alive" web/src packages` returns nothing.
  That is why the two ARQ-shaped items sort last.

## 5.4a


    `web/src/app/api/queue/route.ts` ports `queue_status()`. One grouped count over the
    caller's posts, joined to `website_profiles` and filtered on `user_id`, folded into
    the six numbers `QueueStatus` in `web/src/lib/api.ts` declares.

    Two details of the Python arithmetic are load-bearing and preserved:

    - `running` is the sum of the groups whose key is one of the six pipeline stages, so
      a post parked at a review gate still counts as running. `api/src/worker.py:168`
      sets `current_stage = stage` before the stage executes and nothing resets it while
      the gate holds, so the stage name is what a gated post carries.
    - `total` is `sum(counts.values())`, the sum of *every* group, not of the five
      reported buckets. That difference is reachable, because `posts.current_stage` is
      nullable in the live database with no check constraint:

      ```
      $ psql -c "select column_name, is_nullable, data_type, column_default from
                 information_schema.columns where table_name='posts'
                 and column_name in ('current_stage','profile_id');"
        column_name  | is_nullable |     data_type     |        column_default
      ---------------+-------------+-------------------+------------------------------
       profile_id    | YES         | uuid              |
       current_stage | YES         | character varying | 'pending'::character varying
      ```

      SQLAlchemy's `group_by` puts a null into its own group and `func.count(Post.id)`
      counts it, confirmed against the same server rather than assumed:

      ```
      $ psql -tA -c "with t(id, stage) as (values (1,'pending'),(2,null),(3,'write'))
                     select coalesce(stage,'<NULL>'), count(id) from t group by stage order by 1;"
      <NULL>|1
      pending|1
      write|1
      ```

      So a row carrying null or an unrecognised stage lands in `total` and in no bucket,
      and the five buckets do not have to add up to `total`. Nothing in the application
      writes such a row, but the port reproduces the arithmetic rather than the
      assumption behind it.

    The join is kept inner to mirror the original, with the same honest note recorded
    under 5.3a: it is the `user_id` predicate that excludes a post whose `profile_id` is
    null, since an unowned row matches no user, so swapping the join for a left join
    changes nothing. That is negative control 3 below, which does not fail, and the test
    is named for the predicate rather than for the join.

    No deviation from the Python for this endpoint: it is a pure read, writes nothing,
    and enqueues nothing, so the `updated_at` deviation recorded under 5.2b, 5.3b-ii and
    5.3c-iii-a does not arise.

    Eleven tests in `web/src/app/api/queue/route.test.ts`, against the real database and
    real BetterAuth sessions:

    ```
    $ pnpm -C web vitest run src/app/api/queue/route.test.ts --reporter=verbose
     v src/app/api/queue/route.test.ts > GET /api/queue > rejects an unauthenticated request 3ms
     v src/app/api/queue/route.test.ts > GET /api/queue > answers every bucket at zero when the caller has no posts 16ms
     v src/app/api/queue/route.test.ts > GET /api/queue > counts pending, complete, failed and paused into their own buckets 8ms
     v src/app/api/queue/route.test.ts > GET /api/queue > sums all six pipeline stages into running 8ms
     v src/app/api/queue/route.test.ts > GET /api/queue > counts a post left on its stage at a review gate as running 3ms
     v src/app/api/queue/route.test.ts > GET /api/queue > uses the column default when no stage is given, so a fresh post is pending 2ms
     v src/app/api/queue/route.test.ts > GET /api/queue > counts only the caller's posts 6ms
     v src/app/api/queue/route.test.ts > GET /api/queue > excludes a post with no profile, which matches no user 3ms
     v src/app/api/queue/route.test.ts > GET /api/queue > counts a null stage in total and in no bucket 2ms
     v src/app/api/queue/route.test.ts > GET /api/queue > counts an unrecognised stage in total and in no bucket 2ms
     v src/app/api/queue/route.test.ts > GET /api/queue > returns numbers, not the bigint strings the driver reports counts as 2ms
     Test Files  1 passed (1)
          Tests  11 passed (11)
       Start at  14:47:05
       Duration  540ms (transform 43ms, setup 78ms, import 308ms, tests 89ms, environment 0ms)
    ```

    The file's two profiles are created once in `beforeAll` and only the posts are
    cleared between tests, because a shared `clearFixtures()` that also dropped the
    profiles left every later insert violating `posts_profile_id_fkey`.

    Negative controls, each reverted after measuring:

    ```
    # 1. drop the .where(eq(websiteProfiles.userId, user.id)) predicate
    Tests  1 failed | 10 passed (11)
      x counts only the caller's posts

    # 2. compute total as running + pending + complete + failed + paused
    Tests  2 failed | 9 passed (11)
      x counts a null stage in total and in no bucket
      x counts an unrecognised stage in total and in no bucket

    # 3. leftJoin instead of innerJoin
    Tests  11 passed (11)
    # Does not fail, and is recorded because it is the control that proves the note
    # above: the user_id predicate, not the join strategy, is what hides an unowned
    # post. Keeping the inner join is a faithfulness choice with no behavioural weight.

    # 4. replace count(posts.id) with sql<number>`count(${posts.id})`, losing the
    #    Number mapping
    Tests  8 failed | 3 passed (11)
      x counts pending, complete, failed and paused into their own buckets
      x sums all six pipeline stages into running
      x counts a post left on its stage at a review gate as running
      x uses the column default when no stage is given, so a fresh post is pending
      x counts only the caller's posts
      x excludes a post with no profile, which matches no user
      x counts a null stage in total and in no bucket
      x counts an unrecognised stage in total and in no bucket
    # node-postgres returns bigint as a string, so every bucket became a concatenation.
    # Drizzle's count() helper carries .mapWith(Number); a raw sql`count(...)` does not.
    ```

    Gates:

    ```
    $ pnpm -C web tsc --noEmit
    TSC EXIT=0
    (no output)

    $ pnpm -C web lint
    LINT EXIT=0
    (no output)

    $ pnpm -C web test
     Test Files  2 failed | 76 passed (78)
          Tests  9 failed | 1389 passed | 7 skipped (1405)
    # 9 failed is the recorded baseline, unchanged, and confirmed to be the same two
    # files:
    #   $ grep -E "FAIL |x " | grep -oE "src/[^ ]+\.tsx?" | sort | uniq -c
    #      3 src/app/posts/PostDetail.test.tsx
    #      6 src/components/__tests__/image-preview.test.tsx
    # Passing count 1378 -> 1389 (+11).

    $ pnpm -C web build
    BUILD EXIT=0
    v Compiled successfully in 3.8s
    Route (app)
    |- f /api/queue

    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 13.74s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    # "already formatted" moved 129 -> 131 as parity scripts were added under
    # api/scripts/ in 5.3d-i and 5.3d-iii; the 9 would-reformat files are unchanged.
    ```

## 5.4b


    Ported to `web/src/app/api/queue/pause-all/route.ts` and
    `web/src/app/api/queue/resume-all/route.ts`. Both keep the shape
    `web/src/lib/api.ts` declares for them, `{ status: string; count: number }` at 200.

    **`pause_all()` is not the per-post pause in a loop.** It carries a stage guard the
    per-post endpoint does not have, `current_stage in ["pending", *STAGES]`, so a post
    that is complete, failed, already paused or carrying an unrecognised or null stage
    is left alone and is not counted. `POST /api/posts/{post_id}/pause` (5.3c-iii-a) has
    no such guard and will pause a finished post. Two endpoints with the same verb are
    not the same predicate, and the port keeps both.

    **`resume_all()` enqueues the single-stage form.** Python called
    `enqueue_job("run_pipeline_stage", str(post.id), next_stage)` with the stage
    argument, and `run_pipeline_stage(ctx, post_id, stage=None)` documents what that
    means:

    ```
    $ sed -n '54,59p' api/src/worker.py
    async def run_pipeline_stage(ctx, post_id: str, stage: str | None = None):
        """Execute the pipeline for a post.

        If `stage` is specified, runs only that stage (no gate checks).
        Otherwise, runs all remaining stages sequentially (with gate checks).
    ```

    So "resume all" advances each post by exactly one stage and does not stop for review
    on that stage, which is narrower than the endpoint's name suggests. The port keeps
    it: `startPipeline(id, [stage])`, the same substitution 5.3c-i made for ARQ's
    positional `stage`.

    **`count` is the number of posts that were paused, not the number of runs started.**
    A post whose six stages are all complete has no next stage, so Python wrote
    `current_stage = "complete"`, enqueued nothing, and still incremented `count`.

    **The next stage comes from `stage_status`, never from `current_stage`,** because
    `pause_all()` overwrote `current_stage` with `"paused"` and remembered nothing. That
    is the same first-non-complete scan `_next_stage()` does, so the handler reuses
    `nextStage()` from `web/src/app/api/posts/run-control.ts` rather than restating it.
    The consequence is real and is pinned by a test: a post paused at `ready` with an
    empty `stage_status` resumes at `research`.

    Deviations, both argued rather than silent:

    - **Write order.** Python enqueued inside the loop, *before* `session.commit()`, so
      a worker could read a post whose new `current_stage` was not yet visible. The port
      commits the whole batch in one `db.transaction()` and starts the runs afterwards.
      Nothing observable changes: the workflow derives the stages it runs from
      `stage_status`, not from `current_stage`.
    - **`updated_at`.** Drizzle has no SQLAlchemy `onupdate`, so both handlers set
      `updatedAt` explicitly, as every ported write in 5.3 does.

    `pause_all()`'s select-then-write is kept as a select-then-write rather than folded
    into one `UPDATE ... WHERE`, because Drizzle's `update()` takes no join and the
    ownership restriction lives on the join.

    No pytest file covers either endpoint (`grep -rln "pause-all\|resume-all" api/tests`
    returns nothing), so there was no Python coverage to port; the 20 tests below are new.

    ```
    $ pnpm -C web exec vitest run src/app/api/queue/queue-control.test.ts --reporter=verbose
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > rejects an unauthenticated request 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > reports zero when the caller has no posts 16ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > pauses a post sitting at 'pending' 5ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > pauses a post sitting at any of the six stage names 16ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > leaves complete, failed, already-paused and null-stage posts alone 7ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > does not pause another user's post 5ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > does not pause a post with no profile, because the join is inner 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/pause-all > starts nothing 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > rejects an unauthenticated request 1ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > reports zero and starts nothing when nothing is paused 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > recovers the next stage from stage_status, not from current_stage 4ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > treats an empty stage_status as 'start from research' 4ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > marks an all-complete post 'complete' and starts nothing for it 4ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > enqueues the single-stage form, so the resumed stage skips its review gate 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > resumes several posts in one call, each at its own next stage 7ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > does not resume another user's paused post 3ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > does not resume a paused post with no profile, because the join is inner 4ms
     ✓ src/app/api/queue/queue-control.test.ts > POST /api/queue/resume-all > puts a real single-stage workflow.start on the Redis Streams bus 66ms
     ✓ src/app/api/queue/queue-control.test.ts > pause-all followed by resume-all > round-trips a running post back to the stage it was on 6ms
     ✓ src/app/api/queue/queue-control.test.ts > pause-all followed by resume-all > loses the stage a post was on when stage_status does not agree with it 5ms
     Test Files  1 passed (1)
          Tests  20 passed (20)
    ```

    Negative controls, each applied to the handler and reverted:

    | Change | Result |
    | --- | --- |
    | `pause-all` drops the `["pending", *STAGES]` guard | 1 failed ("leaves complete, failed, already-paused and null-stage posts alone") |
    | `pause-all` drops the `website_profiles.user_id` predicate | 1 failed ("does not pause another user's post") |
    | `resume-all` calls `startPipeline(id)` instead of `startPipeline(id, [stage])` | 3 failed (the three that assert the named stage) |
    | `resume-all` returns `count: resumed.length` instead of `rows.length` | 2 failed (the all-complete post and the three-post batch) |
    | `resume-all` scans `nextStage(null)` instead of `nextStage(row.stageStatus)` | 5 failed |

    Gates:

    ```
    $ pnpm -C web exec tsc --noEmit
    # exit 0, no output

    $ pnpm -C web exec eslint
    # exit 0, no output

    $ pnpm -C web exec vitest run
     Test Files  2 failed | 77 passed (79)
          Tests  9 failed | 1409 passed | 7 skipped (1425)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx. 1389 -> 1409 passed is exactly this iteration's 20.

    $ pnpm -C web exec next build
    # exit 0
    ✓ Compiled successfully in 3.7s
    ├ ƒ /api/queue
    ├ ƒ /api/queue/pause-all
    ├ ƒ /api/queue/resume-all

    $ cd api && uv run pytest -q
    125 failed, 236 passed, 25 errors in 13.48s
    # the recorded baseline, unchanged. Requires `set -a; . ./.env; set +a` first.

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

## 5.4c


    Reads three ARQ artefacts that do not exist under Mastra: the `arq:worker:*`
    heartbeat keys, the `arq:queue` sorted set's cardinality, and
    `WORKER_LAST_COMPLETED_KEY`. Each needs a Redis Streams equivalent designed and a
    writer in the TypeScript worker before the endpoint can be ported honestly. Note
    that Python's `active_jobs` count here is *not* user-scoped, unlike every other
    query in this router.

    Split, because two of the three replacements come free from the transport's own
    bookkeeping and the third needs a writer in the worker plus a decision about which
    runs count as "completed": 5.4c-i the liveness and backlog reads, 5.4c-ii the
    last-completed writer and the route handler itself.

## 5.4c-i


      `web/src/mastra/worker-health.ts` exposes `readWorkerHealth()`, which answers
      both from the consumer group Mastra's orchestration worker already joins. There
      is no heartbeat writer, on purpose: a worker process that is consuming the
      orchestration topic *is* a registered consumer in that topic's group, and Redis
      tracks how long ago it last interacted. That is a liveness signal the worker
      cannot forget to emit and cannot emit while wedged, which a separate `SET key EX
      n` loop cannot claim.

      **Python's `worker_alive` is always `False`, and this port does not reproduce
      that.** `worker_status()` scans `arq:worker:*` and skips
      `WORKER_LAST_COMPLETED_KEY` (`"arq:worker:last_completed"`), which is the only
      key that pattern can match, because ARQ writes its heartbeat under
      `<queue_name>:health-check`:

      ```
      $ api/.venv/bin/python -c "
      from arq.constants import default_queue_name, health_check_key_suffix
      print('default_queue_name=', default_queue_name)
      print('health_check_key_suffix=', health_check_key_suffix)
      print('computed health key=', default_queue_name + health_check_key_suffix)
      "
      default_queue_name= arq:queue
      health_check_key_suffix= :health-check
      computed health key= arq:queue:health-check
      ```

      `api/src/worker.py`'s `WorkerSettings` does not set `health_check_key`, so the
      scan pattern and the key ARQ writes never intersect. Transcribing that faithfully
      would mean shipping a health endpoint that reports every worker as dead. Nothing
      consumes the endpoint (`web/src/lib/api.ts`'s `queue` namespace declares only
      `status`, `pauseAll` and `resumeAll`), so there is no behaviour to preserve here,
      only an intent, and the intent is a liveness check.

      Deviations from the Python, both deliberate:

      1. `worker_alive` is real rather than always false, per the paragraph above.
      2. `queued_jobs` changes unit. ARQ's `ZCARD arq:queue` counted whole jobs waiting
         to be picked up. The nearest Mastra artefact is the orchestration topic's
         undelivered backlog, which counts *events* (a run start, and each step's run
         and end), so one pipeline run contributes many entries over its life. The
         module names the field `queuedEvents` rather than `queuedJobs` so the
         difference is not smuggled in under the old name.

      The two constants the module needs, `TOPIC_WORKFLOWS = "workflows"` and
      `DEFAULT_GROUP = "mastra-orchestration"`, are internal to `@mastra/core` and not
      exported, so they are restated in `worker-health.ts` and pinned by a test that
      starts a real worker and reads the group back out of Redis:

      ```
      $ grep -n 'const TOPIC_WORKFLOWS' node_modules/@mastra/core/dist/pull-transport-C-gk1xyp.js
      29:const TOPIC_WORKFLOWS = "workflows";

      $ grep -n 'const DEFAULT_GROUP' node_modules/@mastra/core/dist/worker-BeL6789j.js
      113:const DEFAULT_GROUP = "mastra-orchestration";
      ```

      **The 15 s liveness threshold is measured, not guessed.** A threshold is
      unavoidable because nothing in the transport ever runs `XGROUP DELCONSUMER`, so
      every worker process that has ever run leaves its consumer entry behind forever
      (the live dev Redis lists hundreds). The risk that makes the number matter is the
      opposite one: if a consumer stops polling while a step executes, a *busy* worker
      is reported dead. A probe sampled `XINFO CONSUMERS` every 2 s for 110 s across a
      100 s step, under the production `reclaimIdleMs` of 15 minutes:

      ```
      idle series: [912,859,813,777,717,680,619,568,527,474,415,357,313,269,44,179,
      142,85,34,1018,971,917,862,782,737,693,638,588,559,80,497,462,426,391,328,288,
      219,161,84,24,1005,966,895,858,119,746,714,677,620,112,7,981,927,872,815]
      max idle during/after a 100s step: 1018
      ```

      The sawtooth is the `XREADGROUP ... BLOCK 1000` poll: the read loop keeps polling
      while a step executes, so a busy worker looks exactly as alive as a quiet one.
      15 s allows fifteen missed polls, ~14x the observed worst case, and still calls a
      killed worker dead inside a dashboard refresh. `WORKER_ALIVE_IDLE_LIMIT_MS`
      carries that derivation in its doc comment.

      Third detail, found at runtime rather than in the types: `XINFO GROUPS` returns a
      nil `lag` when Redis cannot determine the backlog (after entries are deleted from
      the middle of a stream), but the installed `@redis/client@5.12.1` typings declare
      `lag: NumberReply<number>` with no null. Runtime wins, so `queuedEvents` is
      `number | null` and reports the unknown case rather than flattening it to 0.
      "No backlog" and "backlog unknown" are different answers and only one of them is
      reassuring. When no group exists at all, `XLEN` is the exact backlog rather than
      an estimate of it, because nothing has been delivered.

      `redis@5.12.1` added as a direct dependency of `web/`, pinned to the version
      `@mastra/redis-streams` already resolves, because the transport keeps its clients
      private and exposes no `XINFO`.

      ```
      $ pnpm -C web exec vitest run src/mastra/worker-health.test.ts --reporter=verbose
       ✓ src/mastra/worker-health.test.ts > orchestrationStreamKey > is the transport's `<keyPrefix>:<topic>` 0ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > reports a cold system rather than throwing when the stream does not exist 0ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > counts every entry as queued when no worker has ever created the group 0ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > reports the group's lag once the group exists but has consumed nothing 0ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > drops the delivered entry out of the backlog and counts its consumer 0ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > separates live from stale consumers by idle time, not by existence 1ms
       ✓ src/mastra/worker-health.test.ts > readWorkerHealth arithmetic > reports an unknown backlog as null rather than as zero 0ms
       ✓ src/mastra/worker-health.test.ts > against a real Mastra worker > finds the orchestration group under the name and stream key this module assumes 1ms
       ✓ src/mastra/worker-health.test.ts > against a real Mastra worker > reports a worker that is subscribed and waiting as alive 0ms
       ✓ src/mastra/worker-health.test.ts > against a real Mastra worker > reports a worker 20s into a step as alive, not as dead 0ms
       ✓ src/mastra/worker-health.test.ts > against a real Mastra worker > reports a stopped worker as dead even though Redis still lists its consumer 0ms

       Test Files  1 passed (1)
            Tests  11 passed (11)
         Duration  38.78s
      ```

      Negative controls, each reverted immediately:

      ```
      # count consumers instead of filtering by idle
      -  const liveWorkers = consumers.filter((c) => Number(c.idle) < idleLimitMs).length
      +  const liveWorkers = consumers.length
            Tests  2 failed | 9 passed (11)
      #   x separates live from stale consumers by idle time, not by existence
      #   x reports a stopped worker as dead even though Redis still lists its consumer

      # flatten an unknown lag to 0
      -  const queuedEvents = rawLag === null || rawLag === undefined ? null : Number(rawLag)
      +  const queuedEvents = Number(rawLag ?? 0)
            Tests  1 failed | 10 passed (11)
      #   x reports an unknown backlog as null rather than as zero

      # report 0 instead of XLEN when no group exists
      -    return { workerAlive: false, liveWorkers: 0, queuedEvents: await client.xLen(streamKey) }
      +    return { workerAlive: false, liveWorkers: 0, queuedEvents: 0 }
            Tests  1 failed | 10 passed (11)
      #   x counts every entry as queued when no worker has ever created the group

      # wrong consumer-group constant
      -  export const ORCHESTRATION_GROUP = "mastra-orchestration"
      +  export const ORCHESTRATION_GROUP = "mastra-orchestrator"
            Tests  4 failed | 7 passed (11)
      #   the whole "against a real Mastra worker" suite
      ```

      The last control is why the group-name test asserts a literal on both sides
      (`expect(groupNames).toContain("mastra-orchestration")` *and*
      `expect(ORCHESTRATION_GROUP).toBe("mastra-orchestration")`) and why the
      post-stop consumer read tolerates a missing group: the first version of the test
      compared the constant to itself and the suite skipped rather than failed.

      ```
      $ pnpm -C web exec tsc --noEmit
      # exit 0

      $ pnpm -C web exec eslint
      # exit 0

      $ pnpm -C web exec vitest run
       Test Files  2 failed | 78 passed (80)
            Tests  9 failed | 1420 passed | 7 skipped (1436)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx. 1409 -> 1420 passed is exactly this iteration's 11.

      $ pnpm -C web exec next build
      # exit 0
      ├ ƒ /api/queue
      ├ ƒ /api/queue/pause-all
      ├ ƒ /api/queue/resume-all

      $ cd api && uv run pytest -q
      125 failed, 236 passed, 25 errors in 12.99s
      # the recorded baseline, unchanged. Requires `set -a; . ./.env; set +a` first.

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.4c-ii


      `_record_job_completed()` writes an ISO timestamp to
      `WORKER_LAST_COMPLETED_KEY` at `api/src/worker.py:313`, inside `_run_pipeline`'s
      `try` and after the `if is_full_pipeline:` block, so it fires for every run that
      reaches the end without raising, single-stage runs included. The Mastra
      equivalent needs a writer in the worker process (the natural home is
      `steps/pipeline-complete.ts`, but that step only runs on a *full* pipeline, so
      the placement needs checking against the Python's scope before it is copied) and
      then the handler, which also carries `active_jobs`: a `current_stage IN (STAGES)`
      count that Python leaves un-scoped by user, unlike every other query in this
      router (already logged in `todo.md`).

      **The writer.** `recordRunCompleted()` and `readLastCompleted()` in
      `web/src/mastra/worker-health.ts` write and read
      `mastra:worker:last_completed`. The key is renamed because nothing named
      `arq:` survives the port; the value is still one ISO timestamp per completed
      run.

      Still a written timestamp rather than one derived from the run rows Mastra
      already keeps. `listWorkflowRuns({ status: "success" })` in
      `@mastra/pg` ends `ORDER BY "createdAt" DESC`, so the most recently *started*
      successful run is not the most recently *finished* one when two runs overlap,
      and answering it correctly means either scanning every successful run ever (the
      call returns all rows when `perPage`/`page` are omitted) or picking an arbitrary
      window over the last N. One `SET` per completed run is cheaper than both and
      says exactly what Python said.

      **Where it fires.** The item flagged that `steps/pipeline-complete.ts` might be
      too narrow, because Python's call sits *outside* `if is_full_pipeline:`. Checked
      rather than assumed: the step is in the chain unconditionally and only its
      `markPipelineComplete` call is gated on `inputData.stages`, so a named-stage
      rerun passes through it exactly as a full run does. That is the same reach as
      `_record_job_completed()`: every run that gets to the end without raising, and
      no run that raised or parked at a review gate. Both branches are asserted
      against real runs in `workflows/pipeline-completion.test.ts`.

      **The handler.** `web/src/app/api/queue/worker-status/route.ts` answers the four
      keys Python answered, from four sources rather than Python's four:

      | key | Python | here |
      | --- | --- | --- |
      | `worker_alive` | `SCAN arq:worker:*` | live consumers in the orchestration group (5.4c-i) |
      | `queued_jobs` | `ZCARD arq:queue` | the group's undelivered `lag`, `null` when Redis cannot tell |
      | `last_completed` | `GET arq:worker:last_completed` | `GET mastra:worker:last_completed` |
      | `active_jobs` | `current_stage IN (STAGES)`, un-scoped | the same count, scoped to the caller |

      Three deviations, all deliberate:

      1. **`active_jobs` is user-scoped.** Python's query has no user predicate, so
         every caller was told how many posts were running across the whole
         installation. Phase 5's rule is that a handler which reports another
         tenant's rows is a defect to close, so it joins `website_profiles` and
         filters on `user_id` like the rest of the router. The `todo.md` entry keeps
         its other two items (the unscoped `session.get` in `retry_dead_letter` and
         the ignored user dependency), which belong to 5.4d.
      2. **`worker_alive` can be `true`.** Python's could not: it scanned
         `arq:worker:*` while ARQ wrote its heartbeat to `arq:queue:health-check`.
         Argued under 5.4c-i; reproducing a constant `false` would be transcribing a
         bug.
      3. **The timestamp is spelled differently.** `Date#toISOString()` gives
         `...T12:00:00.000Z` where `datetime.now(UTC).isoformat()` gave
         `...T12:00:00.000000+00:00`: same instant, same ISO 8601, three fewer digits
         of precision. Nothing consumes the string except this endpoint, which passes
         it through, and `web/src/lib/api.ts` declares no `workerStatus` at all.

      **One existing test updated.** `src/mastra/no-next-imports.test.ts` asserts the
      exact package allowlist of the Mastra entry graph, and the entry graph now
      reaches `redis` through `pipelineCompleteStep`. The allowlist gained `"redis"`
      with a comment naming this item. That is an intended change to what the entry
      point pulls in, not a test bent to pass: the transport keeps its own clients
      private, so a step that writes a Redis key has to open one.

      **One assertion deliberately not written.** The suspended run in
      `pipeline-completion.test.ts` gets no "did not record a completed job" case.
      The key is global to the Redis instance and vitest runs files in parallel, so
      another file's run completing during this one would flip it. The fact it would
      assert, that a suspended run never reaches the step, is already pinned by that
      run's null `completed_at`.

      ```
      $ pnpm -C web exec vitest run src/mastra/worker-health.test.ts \
          src/app/api/queue/worker-status/route.test.ts --reporter=verbose
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > rejects an unauthenticated request 3ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > answers the four keys Python answered, and no others 28ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > counts a post on each of the six stages as active 9ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > counts no post that is not on a stage 7ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > counts only the caller's active posts 8ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > excludes an active post with no profile, which matches no user 4ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > reports the timestamp the worker last recorded 5ms
       ✓ src/app/api/queue/worker-status/route.test.ts > GET /api/queue/worker-status > reports null when no run has ever finished 3ms
       ✓ src/mastra/worker-health.test.ts > last completed > does not collide with the ARQ key it replaces 0ms
       ✓ src/mastra/worker-health.test.ts > last completed > reads null until a run has finished 1ms
       ✓ src/mastra/worker-health.test.ts > last completed > writes the instant it returns, as an ISO 8601 timestamp 1ms
       ✓ src/mastra/worker-health.test.ts > last completed > keeps only the latest run's timestamp 7ms
       ✓ src/mastra/worker-health.test.ts > last completed > opens its own connection when given no client 8ms
       Test Files  2 passed (2)
            Tests  24 passed (24)
      # 24 = 8 new route tests, 5 new last-completed tests, and 5.4c-i's 11 unchanged.

      $ pnpm -C web exec vitest run src/mastra/workflows/pipeline-completion.test.ts --reporter=verbose
       ✓ a full run that finishes > records the run as the worker's last completed job 0ms
       ✓ a named-stage run that finishes the post > still records the run as the worker's last completed job 0ms
       ✓ a full run with every stage already complete > records the run as the worker's last completed job 0ms
       Test Files  1 passed (1)
            Tests  14 passed (14)
      # Real runs against real Postgres, real Redis and the evented engine, with only
      # the provider calls stubbed. Each of the three deletes the key immediately
      # before its run, so a non-null read afterwards is this run's work.
      ```

      Four negative controls, each applied and reverted:

      ```
      # 1. drop `await recordRunCompleted()` from pipelineCompleteStep
      $ pnpm -C web exec vitest run src/mastra/workflows/pipeline-completion.test.ts
            Tests  3 failed | 11 passed (14)
      # the three real-run assertions, one per branch that reaches the step.

      # 2. drop `inArray(posts.currentStage, [...STAGES])` from the handler
      $ pnpm -C web exec vitest run src/app/api/queue/worker-status/route.test.ts
            Tests  1 failed | 7 passed (8)
      # × counts no post that is not on a stage

      # 3. restore Python's un-scoped active_jobs (drop the join and the user_id filter)
      $ pnpm -C web exec vitest run src/app/api/queue/worker-status/route.test.ts
            Tests  4 failed | 4 passed (8)
      # × counts only the caller's active posts
      # × excludes an active post with no profile, which matches no user
      # × counts no post that is not on a stage  (the dev database holds posts on a
      #   stage that belong to neither test user, which is the hole itself)

      # 4. write String(Date.now()) instead of new Date().toISOString()
      $ pnpm -C web exec vitest run src/mastra/worker-health.test.ts
            Tests  1 failed | 15 passed (16)
      # × writes the instant it returns, as an ISO 8601 timestamp
      ```

      ```
      $ pnpm -C web exec tsc --noEmit
      # exit 0

      $ pnpm -C web exec eslint
      # exit 0

      $ pnpm -C web test
       Test Files  2 failed | 79 passed (81)
            Tests  9 failed | 1436 passed | 7 skipped (1452)
      # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
      # PostDetail.test.tsx. 1420 -> 1436 passed is exactly this iteration's 16.

      $ pnpm -C web build
      # exit 0
      ├ ƒ /api/queue
      ├ ƒ /api/queue/pause-all
      ├ ƒ /api/queue/resume-all
      ├ ƒ /api/queue/worker-status

      $ cd api && uv run pytest -q
      125 failed, 236 passed, 25 errors in 12.81s
      # the recorded baseline, unchanged. Requires `set -a; . ./.env; set +a` first.

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.4d


    All three read `DLQ_KEY`, a Redis list `api/src/worker.py` pushes onto when a job
    exhausts its retries. The TypeScript worker had no such list, so the item was blocked
    on deciding where a permanently failed Mastra run is recorded. It is decided, and the
    answer is that the Redis list is not ported:

    - a failed run is already recorded, durably and with its error, by Mastra itself.
      `processWorkflowFail` in `@mastra/core`'s workflow event processor calls
      `workflowsStore.updateWorkflowState({... opts: { status: "failed", error:
      prevResult.error ... }})` before it publishes anything, and that store is the
      Postgres adapter pointed at `content_pipeline`. A second list in Redis would be a
      parallel copy of the same fact with nothing keeping the two in step.
    - the half of `_move_to_dlq()` that Mastra does *not* cover is the post row:
      `current_stage = "failed"` and the `_error` entry in `stage_logs` the dashboard
      reads. That is a writer, not an endpoint, and nothing in the port wrote it.

    Split accordingly: 5.4d-i the writer, 5.4d-ii the list endpoint, 5.4d-iii the retry
    and clear endpoints. Two defects to carry over knowingly or fix deliberately in the
    last two: `retry_dead_letter()` looks the post up with an unscoped
    `session.get(Post, post_id)`, so any authenticated user can retry any post, and the
    three endpoints do not scope the DLQ by user at all. The scoping hole should be
    closed the way 5.3b-iii closed the batch profile lookup.

## 5.4d-i


      `web/src/mastra/failure-recorder.ts` ports the post-writing half of `_move_to_dlq()`
      (`api/src/worker.py:389`): `recordRunFailure()` stamps `current_stage = "failed"`
      and merges `_error = {message, attempts, failed_at}` into `stage_logs`, through the
      new `markPipelineFailed()` in `post-state.ts`. Before this, a run that died left the
      row parked on the stage it was executing and the `failed` bucket 5.4a reports was
      unreachable.

      **Where the hook lives.** `Mastra`'s config takes `events: { [topic]: listener }`
      and `startWorkers()` is what subscribes them
      (`mastra/index.d.ts:2223`: "starts all registered workers and subscribes
      user-defined event listeners"). That puts the listener inside a registered Mastra
      primitive and in the right process for free: only the `worker` service calls
      `startWorkers()`, so `web` never records a failure it did not execute. The listener
      map is exported as `workerEvents` from `src/mastra/index.ts` and the test instance
      subscribes that same object rather than a restatement of it.

      **Two measured properties of the topic**, both of which say the write must be safe
      to repeat:

      ```
      $ # a temporary process.stdout.write in the duplicate-delivery test
      $ pnpm exec vitest run src/mastra/failure-recorder.test.ts | grep FAIL_EVENTS
      FAIL_EVENTS=2
      ```

      One failed run publishes `workflow.fail` twice (two distinct event ids, both
      `deliveryAttempt: 1`, ~5ms apart). And `addTopicListener` subscribes with no
      `group`, which `events/types.d.ts` documents as fan-out ("When not set, behaves as
      fan-out (all subscribers get every message)"), so every worker process receives
      every event as well. The write is derived entirely from the event, so a repeat
      rewrites the same values; the idempotency test pins that.

      **`attempts` is derived, not guessed.** Python passed ARQ's `job_try`, always
      `MAX_ATTEMPTS` by the time it reached the DLQ. The evented engine republishes
      `workflow.step.run` while `retryCount >= (getEntryRetries(leaf) ??
      workflow.retryConfig.attempts ?? 0)` is false and only fails the run once that is
      exhausted, so a run that reaches `workflow.fail` ran the failing step
      `attempts + 1` times. The workflow sets no `retryConfig`, and the engine's default
      was read off the instance rather than assumed:

      ```
      $ # temporary test: console.log(JSON.stringify(pipelineWorkflow.retryConfig))
      RETRY {"attempts":0,"delay":0}
      ```

      so `_error.attempts` is 1 today and follows a later retry policy without another
      edit here.

      **Deviations from Python, recorded rather than smoothed over:**

      1. No Redis dead-letter list is written. The run's own row in Mastra's Postgres
         storage carries `status: "failed"` and the error, and is what 5.4d-ii will read.
      2. `failed_at` is `new Date().toISOString()`: millisecond precision with a `Z`
         suffix, where Python's `datetime.now(UTC).isoformat()` gave microseconds and
         `+00:00`. Both ISO 8601; nothing parses the field.
      3. Python only reached `_move_to_dlq()` after three ARQ attempts and, on the way,
         published a `stage_error` SSE event and appended an execution log. Those two
         belong to item 5.5, which owns the transport and the `events` router, and are
         still not written. This item writes the post row only.
      4. Python's `failed_stage` is `target_stages[0] if len(target_stages) == 1 else ""`,
         so a full pipeline recorded no stage at all. The stage is not part of `_error`,
         so nothing was lost here; 5.4d-ii can do better from `stepResults`.

      **Tests.** `web/src/mastra/failure-recorder.test.ts`, 15 of them. The first suite is
      a real run of the real workflow on a real evented engine, real Redis Streams and the
      real database, with the two provider calls it reaches stubbed: `research` and
      `outline` return text and `write` throws, which is the shape of every real failure
      and bills nothing. The second drives `recordRunFailure` with hand-built events for
      the branches a happy run never produces.

      ```
      $ pnpm -C web exec vitest run src/mastra/failure-recorder.test.ts --reporter=verbose
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > fails the run rather than swallowing the stage error 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > stamps current_stage failed, which is the queue route's failed bucket 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records the stage's error text as _error.message, Python's str(e) 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records how many times the run was executed, Python's job_try 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records failed_at as a timestamp, close to the run 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > merges _error in rather than replacing stage_logs 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > leaves the stages before the failure committed 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > leaves the failing stage's column unwritten 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > is published a terminal failure event more than once for one run 0ms
       ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > reports the failing step and its error 0ms
       ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a failure from another workflow 1ms
       ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a terminal event that is not a failure 1ms
       ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a run whose input carries no post id 0ms
       ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > records a thrown non-Error, which the engine passes through as it was 1ms
       ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > is safe to repeat: a second delivery rewrites the same values 2ms

       Test Files  1 passed (1)
            Tests  15 passed (15)
         Duration  2.90s
      ```

      The expected stage error is captured off `console.error` rather than off the
      instance logger, because `MastraBase`'s constructor gives every primitive its own
      `ConsoleLogger` and only adopts the Mastra instance's logger in `__registerMastra`,
      which the engine never calls on its `StepExecutor`. Spying on
      `testMastra.getLogger()` therefore misses the failing step's line and leaves it on
      stderr, which the no-new-warnings rule forbids.

      **Negative controls**, each applied and reverted:

      - dropped `events: workerEvents` from the test instance: the row is never stamped,
        `beforeAll` throws `post 00000000-0000-4000-8000-0000000005d1 was never marked
        failed` and all 15 tests skip. Weaker than a failure (a throwing hook skips rather
        than fails), but it is what proves the subscription and not something else does
        the work.
      - dropped the `data?.workflowId !== PIPELINE_WORKFLOW_ID` guard: `3 failed | 12
        passed`, the three "ignores ..." tests.
      - replaced the `coalesce(stage_logs,'{}') || ...` merge with a plain
        `stageLogs: { _error: error }` assignment: `2 failed | 13 passed`, the merge test
        and the idempotency test.
      - hardcoded `attempts` to Python's `MAX_ATTEMPTS = 3`: `1 failed | 14 passed`, the
        `job_try` test.

      **Gates.**

      ```
      $ pnpm -C web exec tsc --noEmit
      tsc exit=0

      $ pnpm -C web lint
      (no output) lint exit=0

      $ pnpm -C web test
       Test Files  2 failed | 80 passed (82)
            Tests  9 failed | 1451 passed | 7 skipped (1467)
      ```

      9 failed is the recorded baseline: the 6 `image-preview` failures and the 3
      `PostDetail` failures. An earlier run of the same command in this iteration also
      failed `scaffold-check.test.ts`'s stream-event assertion for 10 failed; that is the
      flake already logged in `todo.md` and reproduced at HEAD, and it did not recur.

      ```
      $ pnpm -C web build
      ✓ Compiled successfully in 3.3s
      (15 pre-existing BetterAuth default-secret lines, one per page-data worker)

      $ (set -a; . ./.env; set +a; cd api && uv run pytest -q)
      125 failed, 236 passed, 25 errors in 12.98s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.4d-ii


      `web/src/app/api/queue/dead-letter/route.ts` answers Python's
      `{entries, count}` shape, newest first, with `post_id`, `stage`, `error`,
      `attempts` and `failed_at` per entry. `web/src/mastra/dead-letter.ts` is the
      reader: `listFailedRuns()` calls the workflow storage domain's
      `listWorkflowRuns({workflowName: "pipeline", status: "failed"})` and parses each
      snapshot.

      **Why the storage API and not a hand-written query.** `@mastra/pg` indexes exactly
      this read; it creates the index itself:

      ```
      $ grep -n "snapshot ->> 'status'" web/node_modules/@mastra/pg/dist/index.js
      20468: * listWorkflowRuns() status filters can use an index instead of scanning every snapshot.
      20474: })} (workflow_name, (snapshot ->> 'status'), "createdAt" DESC)`;
      ```

      and its `ORDER BY "createdAt" DESC` is the newest-first order `LPUSH` plus
      `LRANGE 0 -1` gave Python, so the ordering is the adapter's rather than a sort
      bolted on afterwards.

      **The snapshot really does carry all five fields.** Read off a real failed run in
      the dev database rather than assumed, which is what settled the field mapping:

      ```
      $ psql -tA -c "select jsonb_pretty(snapshot) from mastra_workflow_snapshot
                     where run_id='624d1ea0-38f4-4e4c-91d9-c623d7d0707a';"
      {
          "error": { "name": "Error", "message": "provider exploded mid-draft" },
          "status": "failed",
          "context": {
              "input":    { "postId": "00000000-0000-4000-8000-0000000005d1" },
              "write":    { "status": "failed", "error": {...}, "endedAt": 1787432235685 },
              "outline":  { "status": "success", ... },
              "research": { "status": "success", ... }
          },
          ...
      }
      ```

      So `post_id` is `context.input.postId`, `error` is the top-level `error.message`,
      `stage` is the one stage id in `context` whose own `status` is `"failed"`, and
      `failed_at` is the row's `updatedAt`. `attempts` is not in the snapshot and is
      derived from `pipelineWorkflow.retryConfig` the same way 5.4d-i derives it.

      **Two deliberate deviations from Python, both closing holes rather than
      transcribing them:**

      1. **The list is scoped to the caller.** Python's DLQ had no user dimension at all
         (`dead_letter_queue()` takes a `user` dependency and never reads it), so every
         authenticated user was shown every tenant's failures, post ids and error text
         included. The entries are joined to `posts` through `website_profiles.user_id`
         here, the way every other Phase 5 handler scopes. A run whose post has been
         deleted, or whose post has no profile and so no owner, is therefore not
         reported either.
      2. **`stage` is populated for a full pipeline run.** Python set it to
         `target_stages[0] if len(target_stages) == 1 else ""`, so the common case
         recorded nothing. The snapshot names the step that threw, and the real-run test
         asserts `"write"` for a run started with no `stages`.

      **One defensive guard with a real failure behind it.** `postIdOf` requires the
      UUID shape rather than merely a non-empty string, because the handler feeds these
      into a `posts.id IN (...)` predicate. Negative control 4 below is what that guard
      is for: a single snapshot carrying a non-UUID takes the whole endpoint down with
      `invalid input syntax for type uuid`.

      **The cost of the unpaginated read, measured rather than waved at.** The call
      materialises every failed `pipeline` run in the installation before the caller's
      are picked out, because nothing on a run row carries the owning user, so
      pagination cannot be applied before the scoping. The rows are small: a stage's
      step output is counters and a model id, not the article.

      ```
      $ psql -tA -c "select count(*), pg_size_pretty(sum(pg_column_size(snapshot)))
                     from mastra_workflow_snapshot
                     where workflow_name='pipeline' and snapshot->>'status'='failed';"
      442|487 kB

      $ # temporary test calling listFailedRuns() against the same database
      DLQ_TIMING runs=430 elapsed_ms=40
      ```

      **Not wired to the dashboard, and not wired now.** `web/src/lib/api.ts`'s `queue`
      namespace still declares only `status`, `pauseAll` and `resumeAll`; the port keeps
      the contract as it was, so no caller changed.

      **One branch is deliberately untested:** `parseSnapshot`'s string arm.
      `WorkflowRun.snapshot` is typed `WorkflowRunState | string`, but `@mastra/pg`
      already runs `JSON.parse` on a string column before returning the row, so the arm
      cannot be reached through the adapter. It exists to satisfy the declared type.

      **Tests.** `web/src/app/api/queue/dead-letter.test.ts`, 20 of them. The first
      suite is a real failed run: the real workflow on a real evented engine over real
      Redis Streams writing a real snapshot, with `research`/`outline` stubbed to return
      text and `write` stubbed to throw. That is what proves the parsing matches what
      the engine writes rather than what the test thinks it writes. The other two suites
      persist snapshots through the same storage adapter to reach the branches one
      failing run cannot produce.

      ```
      $ pnpm -C web exec vitest run src/app/api/queue/dead-letter.test.ts --reporter=verbose
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > reports the run 29ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > names the step that threw, which Python left empty for a full pipeline 10ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > carries the failing stage's error text, Python's str(e) 9ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > reports how many times the run executed, Python's attempts 9ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > reports failed_at as a timestamp close to the run 9ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > carries exactly the five keys Python's DLQ entry had 9ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > counts the entries it returned 9ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > reports the failing step and its error 0ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > rejects a request with no session 0ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes another user's failed run, which Python showed to everyone 20ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes a run whose post has been deleted 11ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes a run whose post has no profile, so no owner 10ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes a run whose input carries no post id 15ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > survives a run whose post id is not a UUID rather than failing the query 15ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes a failed run of a workflow that is not the pipeline 8ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, run rows the caller must not see > excludes a pipeline run that did not fail 8ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, entry contents > reports the nested images workflow's id when image generation dies 8ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, entry contents > reports a null stage when no step recorded a failure 8ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, entry contents > reports a thrown non-Error, which the engine passes through as it was 8ms
       ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, entry contents > orders entries newest first, as LPUSH plus LRANGE did 9ms

       Test Files  1 passed (1)
            Tests  20 passed (20)
         Duration  2.05s
      ```

      **Negative controls**, each applied and reverted:

      - dropped the `.filter((run) => mine.has(run.postId))` scoping: `3 failed | 17
        passed`, the other user's run, the deleted post and the orphan post.
      - dropped `status: "failed"` from the storage query: `1 failed | 19 passed`,
        "excludes a pipeline run that did not fail".
      - dropped `workflowName` from the storage query: `1 failed | 19 passed`,
        "excludes a failed run of a workflow that is not the pipeline".
      - replaced the UUID test in `postIdOf` with Python-style `.length > 0`: `18 failed
        | 2 passed`, with `Caused by: error: invalid input syntax for type uuid:
        "not-a-uuid"`. One bad row breaks every request, which is the whole point of the
        guard.
      - relaxed `failedStageOf` from `step?.status === "failed"` to `step` (any recorded
        step): `3 failed | 17 passed`, both stage assertions and the null-stage case.

      **Gates.**

      ```
      $ pnpm -C web exec tsc --noEmit
      tsc exit=0

      $ pnpm -C web lint
      (no output) lint exit=0

      $ pnpm -C web test
       Test Files  2 failed | 81 passed (83)
            Tests  9 failed | 1471 passed | 7 skipped (1487)
      ```

      9 failed is the recorded baseline: the 6 `image-preview` failures and the 3
      `PostDetail` failures. 1471 passed is 1451 plus this item's 20.

      ```
      $ pnpm -C web build
      ✓ Compiled successfully in 3.6s

      $ (set -a; . ./.env; set +a; cd api && uv run pytest -q)
      125 failed, 236 passed, 25 errors in 13.02s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.4d-iii-a


      Split out of 5.4d-iii because the two endpoints share one design decision and
      the retry is what makes it observable: 5.4d-iii-a settles what "in the queue"
      means and ports the retry, 5.4d-iii-b ports `DELETE /api/queue/dead-letter` on
      top of it.

      **The decision.** Python's DLQ was an operator inbox: an entry sat in the Redis
      list until someone retried it or cleared the list. 5.4d-ii's `listFailedRuns()`
      has no such dimension, because a Mastra run row is a permanent record of a run;
      every failure that ever happened is on it forever, so nothing in it can be
      "removed" without deleting the run history Studio and the trace view read.

      The acknowledgement is read off the post instead, from the `_error` entry
      `markPipelineFailed()` merges into `stage_logs`. That is not an invented marker.
      `retry_dead_letter()` pops exactly that key as part of a retry:

      ```
      $ sed -n '189,195p' api/src/api/queue.py
          # Reset post status and re-enqueue
          post.current_stage = "pending"
          # Clear error from stage_logs
          logs = dict(post.stage_logs or {})
          logs.pop("_error", None)
          post.stage_logs = logs
          await session.commit()
      ```

      So `_error` was already Python's own per-post record of an unhandled failure; it
      kept a second copy in Redis and this port keeps one. An entry is now a failed
      `pipeline` run whose post the caller owns *and* whose post still carries
      `_error`, which `listDeadLetterEntries()` in `web/src/mastra/dead-letter.ts`
      expresses as one extra predicate on the join 5.4d-ii already did:

      ```ts
      sql`jsonb_exists(coalesce(${posts.stageLogs}, '{}'::jsonb), '_error')`
      ```

      `jsonb_exists(...)` rather than the `?` operator, which Drizzle would hand to
      node-postgres inside a statement that also carries `$n` placeholders.

      The rejected alternative was deleting the run row on retry (the storage domain
      does expose `deleteWorkflowRunById`, checked in
      `node_modules/@mastra/core/dist/storage/domains/workflows/base.d.ts`). It matches
      Python's removal exactly and costs the failed run's history, which is the
      observability this whole port is for.

      **The retry.** `web/src/app/api/queue/dead-letter/[post_id]/retry/route.ts` is
      Python's handler minus the Redis list: the post is looked up, the entry is
      required, `retryFailedPost()` in `post-state.ts` writes `current_stage = 'pending'`
      and `stage_logs - '_error'` in one statement, and `startPipeline(postId)` starts a
      full pipeline, which is what `enqueue_job("run_pipeline_stage", str(post.id))`
      with no stage meant to ARQ. Both of Python's 404 texts are kept apart: "Post not
      found" for a post the caller has none of, "Post not found in dead letter queue"
      for one that exists with no unacknowledged failed run. The pop is done in SQL
      rather than as Python's read-modify-write for the reason `mergeStageStatus`
      records: the whole-map write erases anything a concurrent stage logged in between.

      Deviations from Python, all recorded rather than smoothed over:

      - **The post is looked up scoped to the caller.** Python used a bare
        `session.get(Post, post_id)`, the hole `todo.md` carries, so any authenticated
        user could reset any other user's post and start a run that spends the owner's
        provider credits. Another user's post now answers 404, as in every
        `/api/posts/{post_id}` handler.
      - **A malformed id answers 422**, not a database error. Python annotated the
        parameter `str`, so FastAPI did not parse it and the raw string reached a `uuid`
        column.
      - **A post that fails, is retried, and fails again reports two entries** where
        Python reported one, because it has two failed run rows and one `_error`. The
        entries are the runs that really failed, which is the more honest answer, and
        the alternative is the run-row deletion rejected above.
      - **5.4d-ii's `GET` changes with it**: a retired entry drops out of the list. Its
        suite was updated in the same commit, `insertPost` now seeds `_error` for the
        fixtures that back *persisted* run rows (no recorder ever ran for them), and
        `testMastra` now registers `events: workerEvents` so the real failing run gets
        its `_error` from the recorder rather than from the test. One test was added
        for the exclusion.

      ```
      $ pnpm -C web exec vitest run src/app/api/queue/dead-letter-retry.test.ts --reporter=verbose
       ✓ ... a real failed run > the run really failed and really reached the dead-letter list
       ✓ ... a real failed run > answers 202 with Python's body
       ✓ ... a real failed run > resets current_stage to 'pending'
       ✓ ... a real failed run > pops _error out of stage_logs, as Python's logs.pop('_error') did
       ✓ ... a real failed run > removes only that key, leaving the rest of stage_logs as it found it
       ✓ ... a real failed run > leaves stage_status alone, so the retried run resumes rather than restarts
       ✓ ... a real failed run > leaves the stages that did complete in their columns
       ✓ ... a real failed run > starts a full pipeline, which is what an unnamed stage meant to ARQ
       ✓ ... a real failed run > drops the post out of the dead-letter list
       ✓ ... a real failed run > answers 404 the second time, because the entry is gone
       ✓ ... requests that cannot retry > rejects a request with no session
       ✓ ... requests that cannot retry > answers 422 for an id that is not a UUID, where Python reached the database
       ✓ ... requests that cannot retry > answers 404 for a post that does not exist
       ✓ ... requests that cannot retry > answers 404 for another user's dead-letter entry, which Python retried
       ✓ ... requests that cannot retry > answers 404 for an owned post with no failed run
       ✓ ... requests that cannot retry > answers 404 for a failed run whose _error was already popped
       ✓ ... requests that cannot retry > answers 404 for a dead-letter entry whose post has no profile, so no owner
       ✓ ... the run it starts > publishes workflow.start for the post with no stages named

       Test Files  1 passed (1)
            Tests  18 passed (18)

      $ pnpm -C web exec vitest run src/app/api/queue/dead-letter-retry.test.ts src/app/api/queue/dead-letter.test.ts
       Test Files  2 passed (2)
            Tests  39 passed (39)
      ```

      The first suite is the round trip the endpoint exists for, end to end: the real
      workflow on a real evented engine over real Redis Streams fails inside `write`,
      the failure recorder stamps `_error`, `GET /dead-letter` reports the entry, the
      retry resets the post, and the entry is gone. Only the two provider boundaries
      the run reaches are stubbed. `startPipeline` is recorded rather than executed
      everywhere but one test, because a retry starts a *full* pipeline and a live
      provider call on a bus a dev worker may be consuming is not something a test
      should put there; the one real start uses a post whose `stage_status` already
      calls every stage complete, so the run it starts executes nothing.

      Negative controls, each reverted after measuring:

      | Control | Result |
      | --- | --- |
      | Drop the `jsonb_exists` predicate from `listDeadLetterEntries` | 4 failed: the list still shows the retried post, the second retry answers 202, an already-popped entry is retryable, and 5.4d-ii's retired-entry test |
      | `retryFailedPost` sets `pending` without popping `_error` | 3 failed: the pop, the list, the second retry |
      | Look the post up unscoped, as Python's `session.get` did | 1 failed: another user's entry is retried. The orphan-post test still passed, because the inner join excludes a null `profile_id` on its own |
      | `startPipeline(postId, ["write"])` instead of a full pipeline | 2 failed: the recorded call and the real `workflow.start` payload |
      | Drop the dead-letter membership check | 3 failed: the second retry, a post with no failed run, a post whose `_error` was popped |

      One thing the tests do not pin: nothing asserts the retried run *resumes* from
      `stage_status` rather than restarting, because the retry only writes the post and
      the resumption is the workflow's own behaviour, already covered by the Phase 4
      suites. The write side of it is pinned (`stage_status` and the completed stages'
      columns are untouched).

      Two facts found while writing the suite and worth carrying forward:

      - Both `Mastra` constructors call `__registerMastra` on the same
        `pipelineWorkflow` object and the last one wins, so in a test file that builds
        its own instance, `startPipeline` publishes through *that* transport. A
        subscription on the production key prefix sees nothing. The observer had to
        move onto the file's own `pubsub`.
      - `waitForStart` needs an explicit `it(..., 30_000)`; vitest's 5 s default fires
        before a 15 s wait can.

      ```
      $ pnpm -C web exec tsc --noEmit
      (exit 0, no output)

      $ pnpm -C web lint
      (exit 0, no output)

      $ pnpm -C web test
       Test Files  2 failed | 82 passed (84)
            Tests  9 failed | 1490 passed | 7 skipped (1506)
      ```

      9 failed is the recorded baseline: the 6 `image-preview` failures and the 3
      `PostDetail` failures, and 1490 passed is 1471 plus this iteration's 19. An
      earlier run of the same command failed `scaffold-check.test.ts`'s
      `workflow-step-result` assertion for 10 failed; that file passes on its own
      (`5 passed`) and it is the flake already logged in `todo.md`.

      ```
      $ pnpm -C web build
      ✓ Compiled successfully in 3.6s
      ├ ƒ /api/queue/dead-letter
      ├ ƒ /api/queue/dead-letter/[post_id]/retry

      $ (set -a; . ./.env; set +a; cd api && uv run pytest -q)
      125 failed, 236 passed, 25 errors in 14.38s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.4d-iii-b


      `DELETE` added to `web/src/app/api/queue/dead-letter/route.ts` next to the
      `GET` item 5.4d-ii ported. Python read `llen(DLQ_KEY)`, deleted the key and
      returned `{status: "cleared", count}`. There is no key here, so clearing is
      retiring the caller's entries: `clearFailureMarkers()` in
      `web/src/mastra/post-state.ts` pops `_error` off every post the caller's
      entries name, in one statement for the whole batch, the way Python's clear
      was one `DELETE`.

      **The acknowledgement expression now has one definition.** `retryFailedPost()`
      and `clearFailureMarkers()` are the two endpoints that retire an entry and
      both need the same pop, so `coalesce(stage_logs, '{}'::jsonb) - '_error'` was
      lifted to a `dropErrorLog` constant they share rather than copied. The `-`
      operator rather than a read-modify-write is the reason `retryFailedPost`
      already recorded: Python read the map, mutated a copy and wrote the whole
      thing back, which erases anything a concurrently running stage logged in
      between.

      **Three deviations from Python, all deliberate.**

      1. **The clear is scoped to the caller.** Python deleted one global Redis
         list, so any authenticated user could wipe every tenant's dead-letter
         queue. This is the last of the three tenancy holes `todo.md` recorded for
         this router; the other two closed in 5.4d-ii and 5.4d-iii-a.
      2. **`count` is entries, not posts.** Python's `count` was the list length,
         which is exactly the `count` `GET` had reported a moment earlier, so that
         invariant is what is preserved: `DELETE` returns what `GET` would have. A
         post with two failed runs therefore contributes two to `count` and one
         write, which follows from the divergence `listDeadLetterEntries` already
         records (a run row is a permanent record of a run, so a post that failed
         twice has two of them).
      3. **`updated_at` moves on a cleared post.** Python never wrote a post at
         all, so there is no Python behaviour to match here; every other write in
         this port stamps it, and nothing in `web/src/lib/api.ts` branches on it.

      **Deliberately preserved.** `current_stage` is left where the failure put it,
      so a cleared post stays `failed` and keeps counting in the `failed` bucket
      `GET /api/queue` reports (5.4a). `stage_status` is untouched, so a later
      manual rerun still resumes rather than restarts. The engine's failed run row
      survives, so the run history Studio shows is not traded away for the
      dismissal, which is the same call 5.4d-iii-a made when it rejected
      `deleteWorkflowRunById`.

      **`web/src/lib/api.ts` needed no change.** Its `queue` namespace declares
      `status`, `pauseAll` and `resumeAll` and nothing else, and
      `grep -rn "dead-letter" web/src packages` finds no caller outside the two
      route files and their tests. The endpoint is ported for parity, not for a
      dashboard consumer that exists today.

      18 tests in `web/src/app/api/queue/dead-letter-clear.test.ts`. The first
      suite is the round trip for real: the real workflow on a real evented engine
      over real Redis Streams fails inside `write`, the failure recorder stamps
      `_error`, `GET` reports the entry, `DELETE` retires it, and the post's stage,
      its sibling `stage_logs` entries, its `stage_status` and the engine's run row
      all survive. The second suite persists run snapshots through the same storage
      adapter for the shapes one failure cannot produce: two failed runs on one
      post, an already-retired post, another tenant's entry and a post no profile
      owns.

      ```
      $ (set -a; . ./.env; set +a; cd web && pnpm exec vitest run \
          src/app/api/queue/dead-letter-clear.test.ts --reporter=verbose)
      RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > the run really failed inside write, and the engine said so 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > the entry was listed before the clear 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > answers 200 with Python's cleared envelope 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > counts entries, matching what GET reported a moment earlier 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > pops _error off the post 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > leaves every other stage_logs entry alone 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > leaves current_stage on failed, so the queue's failed bucket is unchanged 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > leaves stage_status alone, so a later retry still resumes 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > keeps the engine's failed run row 7ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > drops the entry out of GET 10ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, a real failed run > is idempotent: a second clear finds nothing to clear 11ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > counts runs, not posts: two failed runs on one post are two entries 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > retires every one of the caller's posts that carried _error 1ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > leaves the caller's already-retired post byte-identical 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > does not touch another tenant's entry 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > does not touch a post no profile owns 0ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > leaves the bystander's own queue intact, and clearable by them 22ms
       ✓ src/app/api/queue/dead-letter-clear.test.ts > DELETE /api/queue/dead-letter, scope and count > rejects an unauthenticated clear 1ms

       Test Files  1 passed (1)
            Tests  18 passed (18)
         Start at  16:32:28
         Duration  1.94s (transform 125ms, setup 72ms, import 686ms, tests 1.12s, environment 0ms)
      ```

      Negative controls, each reverted after running:

      | Change | Result |
      | --- | --- |
      | `DELETE` clears every failed run's post, unscoped, the way Python's global list wipe did | 8 failed, including both tenancy tests and the unauthenticated one |
      | The clear also writes `current_stage = "pending"` | 1 failed: `leaves current_stage on failed` |
      | The clear replaces `stage_logs` wholesale instead of popping one key | 1 failed: `leaves every other stage_logs entry alone` |
      | `count` reports posts cleared rather than entries | 1 failed: `counts runs, not posts` |
      | Membership drops the `_error` predicate, so every post the caller owns is an entry | 4 failed, including the already-retired post and the idempotence test |

      The unscoped control failing the unauthenticated test too is worth naming: it
      is not a second tenancy assertion, it is the orphan post that control had
      already cleared in an earlier test, so `rejects an unauthenticated clear`'s
      "and nothing was written" half no longer had an untouched row to check.

      Gates, all at the recorded baseline:

      ```
      $ (set -a; . ./.env; set +a; cd web && pnpm exec tsc --noEmit); echo "exit: $?"
      exit: 0

      $ (set -a; . ./.env; set +a; cd web && pnpm run lint); echo "exit: $?"
      > content-pipeline-dashboard@0.1.0 lint /.../web
      > eslint
      exit: 0

      $ (set -a; . ./.env; set +a; cd web && pnpm exec vitest run)
       Test Files  2 failed | 83 passed (85)
            Tests  9 failed | 1508 passed | 7 skipped (1524)
      ```

      9 failed is the recorded baseline: the 6 `image-preview` failures and the 3
      `PostDetail` ones. 1490 -> 1508 passed is exactly this iteration's 18.

      ```
      $ (set -a; . ./.env; set +a; cd web && pnpm run build); echo "exit: $?"
      exit: 0

      $ (set -a; . ./.env; set +a; cd api && uv run pytest -q)
      125 failed, 236 passed, 25 errors in 12.73s

      $ (cd api && uvx ruff check .)
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ (cd api && uvx ruff format --check .)
      9 files would be reformatted, 131 files already formatted
      ```

      The three Python numbers are the recorded baseline, unchanged. Requires
      `set -a; . ./.env; set +a` first.

## 5.5


  Split, because this router is two halves and only one of them is a router. Python's
  `api/src/api/events.py` is 67 lines of SSE plumbing over a `publish_event()` helper that
  every other module calls, and **nothing in the TypeScript port published anything yet**:

  ```
  $ git grep -ln "stage_start" HEAD -- web/src
  HEAD:web/src/app/monitor/_components/overview-tab.tsx
  HEAD:web/src/app/posts/[id]/page.tsx
  HEAD:web/src/hooks/use-sse.ts
  ```

  Three readers and no writer. So the producers have to exist before the endpoints can
  serve them. Split into 5.5a the bus plus `stage_start`, 5.5b `stage_complete`,
  `pipeline_complete` and `stage_error`, 5.5c `execution_logs` and the `log` event,
  5.5d the two SSE route handlers, 5.5e resumable replay across a reconnect.

  **The finding that decided the design, recorded here because it is not obvious and it
  cost a search to establish.** The tempting port is no producer at all: the evented
  engine already publishes per-step lifecycle events, so `web` could subscribe and
  translate them into `use-sse.ts`'s shape. That is not available. Those events go to
  `workflow.events.v2.<runId>`, which `@mastra/core`'s own topic policy calls run-local:

  ```
  $ grep -n "RUN_LOCAL_TOPIC_PREFIXES: readonly" web/node_modules/@mastra/core/dist/events/topics.d.ts
  9:export declare const RUN_LOCAL_TOPIC_PREFIXES: readonly ["workflow.events.v2."];

  $ grep -n "isRunLocalTopic(topic)" web/node_modules/@mastra/core/dist/mastra-Bn5mWcPE.js
  577:					} else if (isRunLocalTopic(topic)) return target.publish(topic, event, { localOnly: true });

  $ sed -n '108,118p' web/node_modules/@mastra/redis-streams/dist/index.js
  	async publish(topic, event, options) {
  		if (this.#closed) throw new Error("RedisStreamsPubSub: cannot publish on closed client");
  		if (options?.localOnly) {
  			const localEvent = {
  				...event,
  				id: randomUUID(),
  				createdAt: /* @__PURE__ */ new Date(),
  				deliveryAttempt: event.deliveryAttempt ?? 1
  			};
  			this.#deliverLocal(topic, localEvent);
  			return;
  ```

  `mastra.pubsub` tags those publishes `localOnly`, and `RedisStreamsPubSub.publish`
  short-circuits that flag to an in-process delivery and never writes to Redis. A run
  executing in the `worker` service therefore emits step events that the `web` service
  cannot see by any subscription. The comment in `topics.d.ts` gives the reason: the
  payloads accumulate step results and "routinely run to megabytes", so relaying them
  would be expensive as well as unavailable. An explicit, small publish from inside the
  step is the port. **This also constrains item 8.1**: the run-trace view cannot be fed
  by subscribing to Mastra's stream from `web` either.

## 5.5a


    `web/src/mastra/pipeline-events.ts` is the port of `publish_event()`:
    `publishPipelineEvent(pubsub, postId, event, data)` flattens the call site's fields
    alongside `event` and `post_id`, which is the object `use-sse.ts` parses. It goes into
    the `Event` envelope's `data`, so a subscriber forwards `event.data` untouched, and
    the envelope's `runId` carries the post id because this bus is keyed by post, as
    Python's channel name was.

    **Deviation 1: one topic, not one per post.** Python published each payload to
    `pipeline:post:<id>` and `pipeline:global`, two Redis PUBSUB channels that retain
    nothing. `RedisStreamsPubSub` maps a topic to a retained Redis stream, so a topic per
    post would create a stream on the first event of every run and, with
    `streamIdleTtlMs` disabled in `index.ts`, leave it there after the post was deleted.
    `TOPIC_PIPELINE_EVENTS = "pipeline-events"` is trimmed by the transport's own
    `MAXLEN ~ 10000` and gives one ordered sequence, which is also what 5.5e needs to
    replay a reconnect without a gap. Both Python channels collapse into it: the global
    feed is the topic unfiltered, a post's feed is the topic filtered on `post_id`.

    **The write this item restored.** Python's stage loop ran two statements between its
    skip check and its node call:

    ```
    $ sed -n '161,180p' api/src/worker.py
                # Persist "running" to DB before SSE so fetchPost reads correct state
                async with session_factory() as session:
                    post_obj = await session.get(Post, uuid.UUID(post_id))
                    if post_obj:
                        ss = dict(post_obj.stage_status or {})
                        ss[stage] = "running"
                        post_obj.stage_status = ss
                        post_obj.current_stage = stage
                        await session.commit()
                    await append_execution_log(
                        session,
                        post_id,
                        stage,
                        "info",
                        "stage_start",
                        f"Starting {stage}...",
                    )

                # SSE after DB is committed
                await publish_event(
    ```

    (`append_execution_log` is item 5.5c; only the row write and the publish are this
    item's.)

    Nothing in the port wrote `"running"` at all. `STATUS_RUNNING` was declared in
    `state.ts` and used by exactly one route (`POST /api/posts`, seeding the first stage)
    and by no step:

    ```
    $ git grep -n "STATUS_RUNNING\|markStageRunning" HEAD -- web/src/mastra ':!*.test.ts'
    HEAD:web/src/mastra/state.ts:85:export const STATUS_RUNNING = "running"
    ```

    So a post spent every provider call looking, to the dashboard, like it was still
    parked on the stage before. `markStageRunning()` in `post-state.ts` is the missing
    write and `announceStageStart()` in `steps/stage-io.ts` is the pair, in Python's
    order: row first, event second, because a browser that reacts to `stage_start` by
    refetching the post must not read a row that still names the previous stage.

    Placed after the gate rather than before it, in the position Python's block held
    relative to its `continue`: a skipped stage and a stage parked in front of a reviewer
    are both "not running", and `markStageForReview` already moves the row for the gate
    case. The transport comes off the `mastra` handed to `execute` rather than from
    `index.ts`, which would close an import cycle and would publish onto the production
    transport even when a test is running the workflow on its own.

    **Deviation 2: `images-manifest` now writes the row, where it wrote nothing.** The
    `images` stage is two steps: the manifest call and the assembling step that commits
    `image_manifest`. The announcement belongs to the stage's start, so it is in the
    manifest step, which means that step now stamps `current_stage` and
    `stage_status.images = "running"`. Its test
    ("writes nothing to the post row, because the assembling step is the only writer")
    asserted the old behaviour and was rewritten to assert the new one exactly: the
    running marker and the `updatedAt` that comes with it, and every other column
    unchanged. That is a deliberate behaviour change, not a test relaxed to pass.

    **Deviation 3: the six per-stage parity harnesses gained a `pubsub`.** They call
    `step.execute` directly with a hand-built `mastra`, which now needs the collaborator
    the step uses. Each records what was published and asserts the payload, so the change
    added coverage rather than silencing a call.

    ```
    $ pnpm exec vitest run src/mastra/pipeline-events.test.ts --reporter=verbose
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > announces each of the six stages exactly once, in pipeline order 1ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > carries Python's payload and nothing else 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > names the event on the envelope too, so a subscriber can filter without parsing 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > commits the row before the event goes out 1ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > leaves the post finished, so announcing changed no outcome 1ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > announces the five stages that ran and not the one that did not 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > never calls the skipped stage running 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage parked at a review gate > announces nothing, because a stage waiting for a human is not running 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage parked at a review gate > leaves the row on the gate's own status rather than on running 1ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > flattens the caller's fields alongside the event name and post id 102ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > publishes an event with no payload as the two fields Python always sent 1ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > lets a caller's field override nothing it should not: post_id stays the argument 101ms
     ✓ src/mastra/pipeline-events.test.ts > the run's own quality warnings > are the stubbed draft's, not a new one from announcing 0ms
     Test Files  1 passed (1)
          Tests  13 passed (13)
       Duration  5.29s
    ```

    Three of those suites are real runs of the real workflow on a real evented engine,
    real Redis Streams and the real database, with only the six agent calls stubbed. The
    fourth publishes through the same real transport.

    **A trap this file hit and now guards against.** The topic is a retained stream and an
    ungrouped subscription reads it from the beginning, so the first version of the file
    replayed every previous run of itself into its assertions. The first negative control
    below passed on the events of the run before it. `pubsub.clearTopic()` in `beforeAll`
    is the fix, and the controls were only meaningful after it.

    Negative controls, each reverted after measuring:

    | change | result |
    | --- | --- |
    | `research` does not call `announceStageStart` | 3 failed: order, payload, row-before-event |
    | publish before `markStageRunning` instead of after | 1 failed: commits the row before the event goes out |
    | drop `markStageRunning`, keep the publish | 1 failed: commits the row before the event goes out |
    | announce before the skip check and the gate | 3 failed: skip x2, gate x1 |

    `beforeAll` waits for the expected events with a non-throwing helper on purpose: the
    first control, written against a throwing wait, reported 13 skips instead of the 3
    failures that name the missing event.

    Gates:

    ```
    $ pnpm -C web exec tsc --noEmit
    TSC EXIT=0
    (no output)

    $ cd web && pnpm run lint
    LINT EXIT=0
    (no output)

    $ cd web && pnpm test
     Test Files  2 failed | 84 passed (86)
          Tests  9 failed | 1527 passed | 7 skipped (1543)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx, both pre-existing. Passing count 1508 -> 1527 (+19):
    # 13 in pipeline-events.test.ts and one announcement test in each of the six
    # per-stage parity files.

    $ cd web && pnpm build
    BUILD EXIT=0
    ✓ Compiled successfully in 3.5s

    $ cd api && uv run pytest -q
    125 failed, 236 passed, 25 errors in 12.56s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

    The three Python numbers are the recorded baseline, unchanged. Requires
    `set -a; . ./.env; set +a` first.

## 5.5b


    The three remaining events a run tells the dashboard about itself. With 5.5a's
    `stage_start`, `use-sse.ts`'s four pipeline event names all have a producer.

    Where each one is published, and the Python line it comes from:

    | Event | Python | Port |
    | --- | --- | --- |
    | `stage_complete` | `worker.py:266`, after the `async with session_factory()` block that saved the stage | `announceStageComplete()` in `steps/stage-io.ts`, called by all six stages after `saveStageOutput` and `markRerunComplete` |
    | `pipeline_complete` | `worker.py:300`, inside `if is_full_pipeline:` after `_post_completion_hook` | `steps/pipeline-complete.ts`, inside the same `!inputData.stages` branch that stamps `completed_at` |
    | `stage_error` | `worker.py:321`, in the `except` around the stage loop | `failure-recorder.ts`, on the `workflows-finish` listener that item 5.4d-i added |

    `announceStageComplete` takes the `StageStepOutput` the step is about to return
    rather than the fields separately, so what the browser is told and what the next
    step receives cannot drift apart. The payload is Python's exactly:
    `{stage, model, duration_s}`. The token counts stayed in the execution log,
    which is item 5.5c, and are deliberately not added here.

    **Deviation 1: `stage_error` names the stage that threw.** Python computed
    `failed_stage = target_stages[0] if len(target_stages) == 1 else ""`, so a full
    pipeline run reported no stage at all and `posts/[id]/page.tsx` rendered
    "Pipeline failed". The `workflow.fail` event's `stepResults` names the step whose
    own status is `failed`, so the port reports it and the toast reads "write
    failed". This is the same choice, for the same reason, that 5.4d-ii recorded for
    the dead-letter list. The `""` case is still reachable and still tested: a
    terminal event with no failed step result reports it.

    **Deviation 2: the announcement is guarded by run id.** 5.4d-i measured the
    evented engine publishing `workflow.fail` twice for one failed run, and the
    database write absorbs that because it rewrites the same values. A notification
    does not: `global-notifications.tsx` raises one toast per `stage_error` and
    `debug-log-panel.tsx` appends one line. So `recordRunFailure` announces once per
    run id, from a bounded in-process `Set`. It is explicitly not a distributed
    lock: a second `worker` process on the same fan-out topic would announce again.
    Python published exactly one `stage_error` per attempt, so one per run is the
    faithful count.

    **Deviation 3: `workerEvents` became `createWorkerEvents(pubsub)`.** A listener
    that publishes needs a transport, and importing `index.ts` from inside
    `failure-recorder.ts` would close an import cycle (`index.ts` already imports the
    listener) and would publish onto the production transport even when a test builds
    its own instance. The four test files that registered the production map now
    register the same factory on their own transport, which is what makes the
    `stage_error` assertions below possible at all.

    Two positions worth stating because they are not transcription:

    - The `images` stage announces from `steps/images-assemble.ts`, not from
      `images-manifest`, because that is the only step in the three-step stage that
      writes the row, and it is where Python's single whole-stage `duration_s` is
      computed. It announces on the parse-failure branch too, with `duration_s` 0,
      because Python's `images_node` *returned* on that branch rather than raising,
      so the worker loop reached its publish with `timer.duration` still 0.
    - A run that names its stages sends no `pipeline_complete`, matching Python's
      `if is_full_pipeline:`. Its own stage still reports `stage_complete`.

    **A hermeticity bug in `failure-recorder.test.ts`, found by this item and fixed.**
    Asserting "exactly one `stage_error`" failed with 26. The cause is 5.5a's trap on
    a second topic: `workflows-finish` is a retained Redis stream and an ungrouped
    `subscribe()` reads it from its first entry, so every previous execution of the
    file replayed. Measured before the fix:

    ```
    FAILEVENTS 54 [ 27 distinct run ids, each appearing twice ]
    STAGEERRORS 26
    ```

    27 historical runs, two `workflow.fail` deliveries each, all re-processed by the
    listener on every subsequent execution. It was invisible before this item because
    the only effect was rewriting one post row with the same values. The fix is
    `await pubsub.clearTopic("workflows-finish")` before subscribing, next to the one
    5.5a already added for the pipeline topic.

    Tests. `pipeline-events.test.ts` gained a fourth real run (a post whose finished
    stages are rerun with `stages: ["edit"]`) and thirteen assertions; the delivery
    time snapshot is now keyed by event name as well as stage, because `stage_start`
    and `stage_complete` both name one and a single key let the later delivery
    overwrite what the earlier saw. `failure-recorder.test.ts` subscribes the pipeline
    topic and asserts the announcement off the same real failing run it already had.

    ```
    $ pnpm exec vitest run src/mastra/pipeline-events.test.ts src/mastra/failure-recorder.test.ts --reporter=verbose
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > fails the run rather than swallowing the stage error 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > stamps current_stage failed, which is the queue route's failed bucket 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records the stage's error text as _error.message, Python's str(e) 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records how many times the run was executed, Python's job_try 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records failed_at as a timestamp, close to the run 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > merges _error in rather than replacing stage_logs 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > leaves the stages before the failure committed 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > leaves the failing stage's column unwritten 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > is published a terminal failure event more than once for one run 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > reports the failing step and its error 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > announces stage_error on the pipeline bus, in Python's payload shape 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > announces it once, though the engine published the failure more than once 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > stamps the row failed before it announces 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > announces no stage_complete for the stage that threw 0ms
     ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > never says the pipeline finished 0ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a failure from another workflow 1ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a terminal event that is not a failure 1ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > ignores a run whose input carries no post id 1ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > records a thrown non-Error, which the engine passes through as it was 2ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > reports no stage when no step result says which one failed 1ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > names the stage whose own step result failed 1ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > is safe to repeat: a second delivery rewrites the same values 3ms
     ✓ src/mastra/failure-recorder.test.ts > recordRunFailure > announces the repeat delivery only once, though it writes both times 1ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > announces each of the six stages exactly once, in pipeline order 1ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > carries Python's payload and nothing else 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > names the event on the envelope too, so a subscriber can filter without parsing 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > commits the row before the event goes out 1ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > leaves the post finished, so announcing changed no outcome 2ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > reports each of the six stages complete, once, in pipeline order 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > carries Python's stage_complete payload and nothing else 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > rounds duration_s to Python's two decimal places 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > commits the stage before it reports it complete 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > finishes with exactly one pipeline_complete, in Python's payload 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > stamps the post finished before it says the pipeline is 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that executes every stage > sends pipeline_complete after the last stage_complete 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > announces the five stages that ran and not the one that did not 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > never calls the skipped stage running 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > reports the five stages that ran complete and not the one that did not 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage the run skips > still finishes the run, because a skipped stage is a finished one 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage parked at a review gate > announces nothing, because a stage waiting for a human is not running 0ms
     ✓ src/mastra/pipeline-events.test.ts > a stage parked at a review gate > leaves the row on the gate's own status rather than on running 1ms
     ✓ src/mastra/pipeline-events.test.ts > a stage parked at a review gate > reports nothing complete and never finishes the pipeline 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that names one stage > announces only the stage it was asked to run 0ms
     ✓ src/mastra/pipeline-events.test.ts > a run that names one stage > says nothing about the pipeline, because the run finished and the post did not 0ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > flattens the caller's fields alongside the event name and post id 1ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > publishes an event with no payload as the two fields Python always sent 1ms
     ✓ src/mastra/pipeline-events.test.ts > publishPipelineEvent > lets a caller's field override nothing it should not: post_id stays the argument 102ms
     ✓ src/mastra/pipeline-events.test.ts > announceStageComplete > rounds duration_s to two places, as Python's round(duration_s, 2) did 0ms
     ✓ src/mastra/pipeline-events.test.ts > announceStageComplete > sends the model and the duration, and leaves the token counts off 0ms
     ✓ src/mastra/pipeline-events.test.ts > the run's own quality warnings > are the stubbed draft's, not a new one from announcing 0ms
     Test Files  2 passed (2)
          Tests  50 passed (50)
       Start at  18:17:28
       Duration  6.44s (transform 193ms, setup 163ms, import 1.10s, tests 8.92s, environment 0ms)
    ```

    The six per-stage parity harnesses each assert the new announcement too, and
    `research.test.ts` gained the one ordering assertion that is not a race: its
    recording transport reads the row from *inside* the publish callback, which
    `publishPipelineEvent` awaits, so the step cannot proceed past the announcement
    until the read has happened.

    ```
    $ pnpm exec vitest run src/mastra/steps --reporter=verbose
     ✓ src/mastra/steps/outline.test.ts > outline step announcement > announces the stage on the event bus, in Python's payload shape 7ms
     ✓ src/mastra/steps/research.test.ts > research step announcement > announces the stage on the event bus, in Python's payload shape 8ms
     ✓ src/mastra/steps/research.test.ts > research step announcement > commits the stage before it reports it complete, and not before it starts 7ms
     ✓ src/mastra/steps/write.test.ts > write step announcement > announces the stage on the event bus, in Python's payload shape 9ms
     ✓ src/mastra/steps/ready.test.ts > ready step announcement > announces the stage on the event bus, in Python's payload shape 7ms
     ✓ src/mastra/steps/images-manifest.test.ts > images step announcement > announces the stage on the event bus, in Python's payload shape 6ms
     ✓ src/mastra/steps/edit.test.ts > edit step announcement > announces the stage on the event bus, in Python's payload shape 12ms
     ✓ src/mastra/steps/images-assemble.test.ts > images assemble step announcement > announces stage_complete once it has committed the manifest 2ms
     ✓ src/mastra/steps/images-assemble.test.ts > images assemble step announcement > announces the parse-failure branch too, the way Python's node returning did 2ms
     ✓ src/mastra/steps/images-assemble.test.ts > images assemble step announcement > announces nothing for a stage the run skipped 2ms
     Test Files  10 passed (10)
          Tests  172 passed (172)
    ```

    Negative controls, each reverted after measuring:

    | # | Change | Result |
    | --- | --- | --- |
    | 1 | `roundSeconds()` returns its argument | 3 failed: both rounding tests and the images payload |
    | 2 | `research` never calls `announceStageComplete` | 4 failed: the research parity announcement, and three of the full-run assertions |
    | 3 | `outline` announces before `saveStageOutput` | **27 passed, caught nothing** (see below) |
    | 4 | `research` announces before `saveStageOutput` | 1 failed: `commits the stage before it reports it complete, and not before it starts` |
    | 5 | the `pipeline_complete` publish removed | 4 failed across the full run and the skipped-stage run |
    | 6 | the `!inputData.stages` gate removed from that publish | 1 failed: `says nothing about the pipeline, because the run finished and the post did not` |
    | 7 | the `stage_error` publish removed | 7 failed |
    | 8 | the run-id guard removed | 2 failed: both "announces it once" assertions |
    | 9 | `stage` hardcoded to `""`, as Python sent it | 2 failed: the payload shape and the named-stage case |

    **Control 3 is the honest one to record.** The commit-before-publish assertion
    over a *real* Redis topic does not catch a swapped order for `stage_complete`, and
    the reason is measurable rather than mysterious: the subscriber's own `SELECT` is
    a slower round trip than the step's `UPDATE`, so the write wins the race even when
    it is issued second. 5.5a's equivalent control did fail, because `stage_start`
    writes an absent key and any early read sees `undefined`; here the row already
    says `running`, so an early read is merely the wrong one of two present values.
    Control 4 is the fix: the deterministic version of the same assertion, added to
    `research.test.ts`, which is what actually pins the order.

    Gates:

    ```
    $ pnpm -C web exec tsc --noEmit
    TSC EXIT=0
    (no output)

    $ pnpm run lint          # from web/; `pnpm -C web lint` runs next lint and does nothing
    LINT EXIT=0
    (no output)

    $ pnpm exec vitest run   # from web/
     Test Files  2 failed | 84 passed (86)
          Tests  9 failed | 1553 passed | 7 skipped (1569)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx. Passing count 1527 -> 1553 (+26): 14 in
    # pipeline-events.test.ts, 8 in failure-recorder.test.ts, 3 in
    # images-assemble.test.ts and 1 in research.test.ts. Run twice, identical.

    $ pnpm build             # from web/
    BUILD EXIT=0
    ✓ Compiled successfully in 4.0s

    $ cd api && uv run pytest -q
    120 failed, 241 passed, 25 errors in 13.24s
    # 361 tests + 25 errors, the same totals as the recorded 125/236 baseline; five
    # tests that were failing on shared dev-database state now pass. Nothing under
    # api/ was touched by this item.

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

    Two flakes surfaced by the full suite, one fixed here and one logged.

    **Fixed: this item's own.** `failure-recorder.test.ts > stamps the row failed
    before it announces` failed on one full run. The subscriber pushed the event onto
    the array the wait polls *before* awaiting its row snapshot, so `beforeAll` could
    return while that read was still in flight and the assertion read an unset key.
    Both subscribers now snapshot the row first and push last. Two consecutive full
    runs since, both at the 9-failure baseline.

    **Logged, not this item's.**
    `scaffold-check.test.ts > emits the workflow lifecycle events the trace view will
    read` failed on one full run and passed alone and on every other. It is the only
    file that streams a run off the *production* instance and transport on the default
    Redis key prefix while 85 other files run in parallel; every other real-run file
    isolates itself with a `keyPrefix`. In `todo.md` as `[investigate]`. It touches no
    topic this item writes.

## 5.5c


    Split, because it is two writers with different call sites and different failure
    behaviour. `append_execution_log()` is a database statement with nine call sites, six
    in `api/src/worker.py`, two in `api/src/pipeline/publish.py` and one inside
    `publish_stage_log()` itself; `publish_stage_log()` is a module-level context
    (`set_event_context` / `clear_event_context`) wrapped around a publish plus a
    swallowed call to the first, with 28 call sites, all of them inside the six stage
    nodes. Porting them together would be one iteration that touches every stage file.

## 5.5c-i


      `web/src/mastra/execution-log.ts` is the writer. The three entries go in beside
      the three events 5.5a and 5.5b published, in the positions Python's own
      `append_execution_log` calls occupied relative to them: `stage_start` inside
      `announceStageStart` between the `"running"` write and the publish,
      `stage_complete` inside `announceStageComplete` before the publish, and
      `pipeline_complete` inside the completion step between the stamp and the publish.

      **The writer's shape is fixed by two readers that already exist**, not chosen
      here: `GET /api/posts/{id}/logs` (ported, item 5.3d-iii) filters on `level`,
      `stage` and a string comparison against `ts`, and `GET /api/analytics/logs`
      (item 5.8, still Python) does the same in SQL with
      `ORDER BY log_entry->>'ts' DESC`.

      A real entry pair, written through `announceStageStart` and
      `announceStageComplete` against the real database and read back off the column:

      ```
      [
        {
          "ts": "2026-08-22T23:47:11.468+00:00",
          "event": "stage_start",
          "level": "info",
          "stage": "write",
          "message": "Starting write..."
        },
        {
          "ts": "2026-08-22T23:47:11.469+00:00",
          "data": {
            "model": "claude-opus-4-6",
            "cost_usd": 0.355995,
            "tokens_in": 8213,
            "duration_s": 41.83,
            "tokens_out": 3104
          },
          "event": "stage_complete",
          "level": "info",
          "stage": "write",
          "message": "Stage write complete"
        }
      ]
      ```

      Both numbers in that `data` are Python's, checked against Python rather than
      derived twice from the same source:

      ```
      $ python3 -c "
      print(round((8213/1_000_000*15.0)+(3104/1_000_000*75.0),6))
      print(round(41.8271,2))
      print(round((100/1_000_000*15.0)+(20/1_000_000*75.0),6))
      print(round(0.125,2), round(0.375,2))
      "
      0.355995
      41.83
      0.003
      0.12 0.38
      ```

      **Decision 1: `cost_usd` keeps Python's hardcoded Opus rates.** The entry at
      `api/src/worker.py:244` prices every stage at 15.0 / 75.0 per million tokens,
      including the Perplexity call in `research` and the Gemini calls in `images`, and
      it ignores `MODEL_COSTS` in `api/src/pipeline/helpers.py` entirely. That is wrong
      as a bill and it is reproduced anyway: `GET /api/analytics/logs` serves these
      entries straight through, so correcting it would make a run's reported cost jump
      at the cutover for a reason no operator could account for. Logged in `todo.md` as
      `[confirmed]` instead.

      **Decision 2: the timestamp keeps Python's `+00:00` offset and loses its
      microseconds.** `toISOString()` ends in `Z`, and both readers compare `ts` as a
      plain string: `Z` (U+005A) sorts above `+` (U+002B) and above every digit, so a
      `Z` entry would sort after every `+00:00` entry recorded in the same second, and
      the analytics `until` bound would exclude it. The suffix is rewritten. The
      fractional part is left at JavaScript's three digits rather than padded to
      Python's six, because padding would claim precision the runtime does not have and
      its only effect on the comparison is to move an entry within the millisecond it
      was already in.

      **Decision 3: `updated_at` is deliberately not stamped.** Python issued this as
      raw `text(...)` SQL, which bypasses SQLAlchemy's `onupdate`, so appending a log
      line was never a change to the post. Stamping it here would reorder the posts
      list twice per stage. Pinned by its own test.

      **Fix in the path of the change: `roundSeconds` now uses `pythonRound`.** The
      same measured duration is written twice, into the `stage_complete` event and into
      the `stage_complete` log entry, and the two must not disagree.
      `Math.round(value * 100) / 100` breaks ties upward where Python breaks them to
      even, and a duration is milliseconds over 1000, so `0.125` and `0.375` are exact
      ties: Python renders `0.12` and `0.38` (above), `Math.round` renders `0.13` and
      `0.38`. `pythonRound` already existed for the analytics port.

      **Two committed tests were updated, not to make them pass but because the row
      they assert on changed.** `images-manifest.test.ts`'s "writes only the running
      marker" and `images-assemble.test.ts`'s "touches nothing else on the row" both
      compare the whole row before and after; `execution_logs` is now one of the
      columns a stage writes, so both now name it. The manifest one asserts the entry
      itself, which its frozen clock makes exact.

      Writer tests, against the real database:

      ```
      $ (cd web && npx vitest run src/mastra/execution-log.test.ts --reporter=verbose)
       RUN  v4.0.18 .../web

       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > stores Python's five keys and stamps the timestamp itself 18ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > writes the timestamp in the offset form Python's isoformat() produced 3ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > stores `data` when there is any and omits the key when there is not 3ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > appends in call order rather than replacing 3ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > keeps every entry when six stages append at once 9ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > leaves `updated_at` where it was, as Python's raw SQL did 3ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > writes nothing and raises nothing for a post that does not exist 2ms
       ✓ src/mastra/execution-log.test.ts > appendExecutionLog > stores an entry the logs route's filters can read back 2ms
       ✓ src/mastra/execution-log.test.ts > stageCostUsd > prices both token counts at Python's hardcoded Opus rates 1ms
       ✓ src/mastra/execution-log.test.ts > stageCostUsd > rounds to six places the way Python's round() does 1ms

       Test Files  1 passed (1)
            Tests  10 passed (10)
         Duration  370ms (transform 36ms, setup 85ms, import 173ms, tests 46ms, environment 0ms)
      ```

      The "keeps every entry when six stages append at once" case is why the append is
      done in SQL rather than as a read-modify-write, and the last case reads the stored
      entry back through the three expressions `api/src/api/analytics.py` applies, so
      the shape is checked by a reader rather than by its author.

      Seven more assertions folded into the four real workflow runs
      `pipeline-events.test.ts` already drives (real evented engine, real Redis Streams
      transport, real database, only the provider boundaries stubbed):

      ```
      $ (cd web && npx vitest run src/mastra/pipeline-events.test.ts --reporter=verbose)
       ✓ ... > what a run writes to execution_logs > records a start and a complete for each of the six stages, then the run 1ms
       ✓ ... > what a run writes to execution_logs > carries Python's stage_complete data, including the tokens the event omits 1ms
       ✓ ... > what a run writes to execution_logs > records the same duration the event carried, rounded the same way 1ms
       ✓ ... > what a run writes to execution_logs > stamps every entry with a timestamp that sorts against Python's 1ms
       ✓ ... > what a run writes to execution_logs > says nothing about a stage the run skipped 1ms
       ✓ ... > what a run writes to execution_logs > says nothing at all about a run parked at its first gate 1ms
       ✓ ... > what a run writes to execution_logs > records only the named stage for a rerun, and nothing about the pipeline 1ms

       Test Files  1 passed (1)
            Tests  34 passed (34)
         Duration  6.83s (transform 127ms, setup 82ms, import 601ms, tests 6.08s, environment 0ms)
      ```

      Four negative controls, each reverted after it was measured:

      ```
      # 1. nowIso() returns toISOString() unchanged (the `Z` form)
      × writes the timestamp in the offset form Python's isoformat() produced
      Tests  1 failed | 9 passed (10)

      # 2. `if (entry.data)` instead of Python's `if data:` (empty dict stored)
      × stores `data` when there is any and omits the key when there is not
      Tests  1 failed | 9 passed (10)

      # 3. the stage_start and pipeline_complete entries removed
      × records a start and a complete for each of the six stages, then the run
      × says nothing about a stage the run skipped
      × records only the named stage for a rerun, and nothing about the pipeline
      Tests  3 failed | 31 passed (34)

      # 4. the stage_complete entry's token counts zeroed
      × carries Python's stage_complete data, including the tokens the event omits
      Tests  1 failed | 33 passed (34)
      ```

      Gates. Frontend from `web/`, with `set -a; . ./.env; set +a` first:

      ```
      $ pnpm tsc --noEmit
      TSC EXIT=0

      $ pnpm lint
      LINT EXIT=0

      $ pnpm test
       Test Files  2 failed | 85 passed (87)
            Tests  9 failed | 1570 passed | 7 skipped (1586)
         Duration  78.68s

      $ pnpm build
      BUILD EXIT=0
      ✓ Compiled successfully in 3.4s
      ```

      The 9 failures are the recorded baseline unchanged: 6 in `image-preview.test.tsx`
      and 3 in `PostDetail.test.tsx`. 1570 passed against the previous item's 1553, which
      is the 17 tests above. `scaffold-check.test.ts`'s "emits the workflow lifecycle
      events the trace view will read" failed once under full-suite load and passed on
      the rerun; logged in `todo.md` as `[investigate]` rather than chased.

      Python, unchanged because nothing Python was touched:

      ```
      $ cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 13.11s

      $ cd api && uv run ruff check .
      Found 32 errors.

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.5c-ii


      `web/src/mastra/steps/pipeline-start.ts` is the head step, added to
      `workflows/pipeline.ts` ahead of `research`, so the chain is now

      ```
      pipeline-start -> research -> outline -> write -> edit -> images -> ready
        -> pipeline-complete
      ```

      It ports exactly the block at `api/src/worker.py:117`: one `execution_logs`
      entry, `stage: ""`, `level: "info"`, `event: "pipeline_start"`, message
      `"Full pipeline run initiated"`, and nothing else. There is no SSE event beside
      it, because Python published none and `use-sse.ts` has no handler for one.

      **Why this entry is worth a step of its own.** It is the only record that a full
      run was ever picked up. A run that dies inside `research` commits no column and
      moves no status, so without it `GET /api/posts/{id}/logs` shows an empty array
      for a post that has in fact been running for a minute, and an operator cannot
      tell that from a post that was never enqueued.

      **Decision: a step, not the route handler that starts the run.** The structural
      rule of the port is one reason. The stronger one is that the two say different
      things: `startPipeline` returning means the `workflow.start` event reached
      Redis, while this entry means the worker consumed it and began executing. Only
      the second is what the log line claims. It is the exact mirror of
      `pipeline-complete` at the other end of the chain, down to the gate: both are
      about the run rather than any stage, both write `stage: ""`, and both do nothing
      for a run that named its stages.

      The step's `outputSchema` is `stageStepInputSchema` rather than
      `stageStepOutputSchema`, because it produces no stage meta and `research`
      consumes the workflow's own input shape. It returns `inputData` untouched, so
      adding it changes nothing about what the first stage receives.

      A real stored entry, written through the step against the real database and read
      back off the column:

      ```
      [
        {
          "ts": "2026-08-23T00:05:27.450+00:00",
          "event": "pipeline_start",
          "level": "info",
          "stage": "",
          "message": "Full pipeline run initiated"
        }
      ]
      ```

      `web/src/mastra/steps/pipeline-start.test.ts`, against the real database:

      ```
      $ pnpm exec vitest run --reporter=verbose src/mastra/steps/pipeline-start.test.ts
       ✓ a run with no stage selection > writes Python's pipeline_start entry and nothing else 27ms
       ✓ a run with no stage selection > leaves the columns that describe where the run is alone 6ms
       ✓ a run with no stage selection > passes its input through unchanged, so the chain is untouched 3ms
       ✓ a run that names its stages > writes nothing, because Python gated the entry on is_full_pipeline 3ms
       ✓ a run that names its stages > still passes its input through, selection included 2ms
       ✓ the step's position in the registered workflow > is the head of the chain, ahead of research 3ms

       Test Files  1 passed (1)
            Tests  6 passed (6)
      ```

      The end-to-end evidence is 5.5a's four real workflow runs in
      `pipeline-events.test.ts`, on a real evented engine over real Redis Streams
      against the real database, which now assert the ordering the step's position
      produces. Two of those assertions changed behaviour rather than being added:
      the full run's log now opens with `pipeline_start`, and the run parked at its
      first gate, which previously wrote nothing at all, now records that it started.

      ```
      $ pnpm exec vitest run --reporter=verbose src/mastra/pipeline-events.test.ts
       ✓ what a run writes to execution_logs > opens with the run, records a start and a complete per stage, then closes with the run 1ms
       ✓ what a run writes to execution_logs > carries Python's pipeline_start message and no data 1ms
       ✓ what a run writes to execution_logs > carries Python's stage_complete data, including the tokens the event omits 1ms
       ✓ what a run writes to execution_logs > records the same duration the event carried, rounded the same way 1ms
       ✓ what a run writes to execution_logs > stamps every entry with a timestamp that sorts against Python's 1ms
       ✓ what a run writes to execution_logs > says nothing about a stage the run skipped 1ms
       ✓ what a run writes to execution_logs > still opens a run that skips its first stage with pipeline_start 1ms
       ✓ what a run writes to execution_logs > records a run parked at its first gate as started and nothing more 1ms
       ✓ what a run writes to execution_logs > records only the named stage for a rerun, and nothing about the pipeline 1ms

       Test Files  1 passed (1)
            Tests  36 passed (36)
      ```

      Negative controls, each reverted immediately:

      | Control | Result |
      | --- | --- |
      | `if (!inputData.stages)` replaced with `if (true)` | 2 failed: the step test's rerun case and `pipeline-events`' "records only the named stage for a rerun" |
      | `.then(pipelineStartStep)` removed from the chain | 5 failed: the position test and all four `pipeline-events` ordering assertions |
      | message changed to `"Pipeline started"` | 2 failed: the step test's entry-shape case and `pipeline-events`' message case |
      | step moved behind `researchStep` in the chain | 1 failed: the position test, which is the only thing that pins head-of-chain rather than merely present |

      Gates. Frontend from `web/`, with `set -a; . ../.env; set +a` first:

      ```
      $ pnpm exec tsc --noEmit
      TSC EXIT=0

      $ pnpm run lint
      LINT EXIT=0

      $ pnpm test
       Test Files  2 failed | 86 passed (88)
            Tests  9 failed | 1578 passed | 7 skipped (1594)
         Duration  79.14s

      $ pnpm build
      BUILD EXIT=0
      ```

      The 9 failures are the recorded baseline unchanged: 6 in `image-preview.test.tsx`
      and 3 in `PostDetail.test.tsx`. 1578 passed against the previous item's 1570, the
      6 new step tests plus the 2 added to `pipeline-events.test.ts`.

      One run of the suite during this item also reported the
      `scaffold-check.test.ts` lifecycle-events flake already tracked in `todo.md`
      (`expected [ 'workflow-start', ...(3) ] to include 'workflow-step-result'`).
      Three subsequent runs were clean. Nothing in this item touches that file.

      Python, unchanged because nothing under `api/` was touched:

      ```
      $ cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 12.91s

      $ uv run ruff check .
      Found 32 errors.

      $ uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.5c-iii


      Split, because settling the retry half is not an `execution_logs` change at all.
      Python's two entries look like one branch with two arms, but only the second arm
      is reachable from where the port records a failure: the evented engine keeps its
      retries inside the run, republishing `workflow.step.run` with `retryCount + 1`
      and only publishing `workflow.fail` once the policy is spent
      (`node_modules/@mastra/core/dist/workflow-event-processor-Dp87-e6z.js:3434`):

      ```
      if (stepResult.status === "failed") if (retryCount >= (getEntryRetries(leaf) ??
        workflow.retryConfig.attempts ?? 0) || stepResult.nonRetryable)
          await this.mastra.pubsub.publish("workflows", { type: "workflow.step.end", ...
      else return this.mastra.pubsub.publish("workflows", { type: "workflow.step.run",
        ..., retryCount: retryCount + 1, ... })
      ```

      So a `workflows-finish` listener sees exhaustion and never sees a retry, and the
      retry entry needs both a retry policy on the workflow (`retryConfig` is the engine
      default `{attempts: 0}` today, recorded under 5.4d-i) and a writer inside the step,
      where `retryCount` and the thrown error are both in hand. That is a workflow-level
      change with its own blast radius: it re-bills a stage's provider call on retry and
      moves the `attempts` every dead-letter test asserts. 5.5c-iii-a is the entry that
      is reachable now; 5.5c-iii-b is that decision.

## 5.5c-iii-a


        `recordRunFailure()` in `web/src/mastra/failure-recorder.ts` already ported the
        two other things Python's `except` block did (stamp the row, publish
        `stage_error`); this adds the third, `api/src/worker.py:348`:

        ```python
        await append_execution_log(
            session, post_id, failed_stage, "error", "stage_error",
            f"Pipeline failed after {job_try} attempts: {e}",
            data={"error": str(e), "attempts": job_try, "moved_to_dlq": True},
        )
        ```

        Three decisions, none of them transcription:

        1. **Position: after the publish.** Every other pair in this port writes the row
           first and announces second, and 5.5c-i put each log entry where Python's own
           `append_execution_log` call sat relative to the publish. Python's exception
           branch is the one place that publishes first and appends afterwards
           (`api/src/worker.py:321` then `:348`), so the append follows the publish here.
        2. **Inside the run-id guard.** `markPipelineFailed` is safe to repeat because it
           rewrites the same values, and the engine publishes `workflow.fail` more than
           once per failed run (measured under 5.4d-i). `appendExecutionLog` is an
           append, so an unguarded call leaves two copies of the entry on the row for
           `GET /api/posts/{id}/logs` to serve. The existing announcement guard now
           guards both reports and was renamed `firstReportOf` to say so.
        3. **`moved_to_dlq: true` kept, and still true.** The Redis list the key names is
           not ported, but 5.4d-iii-a made `stage_logs._error` the port's definition of
           being in the dead-letter queue, and `markPipelineFailed` has just written it.
           Nothing outside `api/src/worker.py` reads the key:

           ```
           $ grep -rn "moved_to_dlq" api/src web/src
           api/src/worker.py:358:                        "moved_to_dlq": True,
           ```

        `stage` on the entry is the step whose own result failed, not Python's `""` for a
        full run, which is the same choice 5.4d-i and 5.5b already recorded for `_error`
        and for the `stage_error` event. `attempts` is `executionsBeforeFailure()`, the
        one already derived from `pipelineWorkflow.retryConfig`, so the entry and
        `_error.attempts` cannot disagree.

        The entry as actually stored, read back off the row after a real
        `workflow.fail`:

        ```
        $ npx vitest run src/mastra/tmp-entry-dump.test.ts   # temporary, not committed
        STORED [
          {
            "ts": "2026-08-23T00:12:30.332+00:00",
            "data": {
              "error": "provider exploded mid-draft",
              "attempts": 1,
              "moved_to_dlq": true
            },
            "event": "stage_error",
            "level": "error",
            "stage": "write",
            "message": "Pipeline failed after 1 attempts: provider exploded mid-draft"
          }
        ]
        ```

        `Pipeline failed after 1 attempts` reads oddly and is Python's own string with
        the attempt count this engine makes true; 5.5c-iii-b is where that count moves.

        Seven new tests. Four are assertions on the file's existing real failing run (a
        real evented engine, real Redis Streams, the real database, with `research` and
        `outline` stubbed and `write` throwing), including the whole run's log read back
        as an ordered trail; three drive `recordRunFailure` directly for the repeat and
        ignored-event cases a single run cannot produce.

        ```
        $ npx vitest run src/mastra/failure-recorder.test.ts --reporter=verbose
         ✓ a pipeline run that fails > fails the run rather than swallowing the stage error 0ms
         ✓ a pipeline run that fails > stamps current_stage failed, which is the queue route's failed bucket 0ms
         ✓ a pipeline run that fails > records the stage's error text as _error.message, Python's str(e) 0ms
         ✓ a pipeline run that fails > records how many times the run was executed, Python's job_try 0ms
         ✓ a pipeline run that fails > records failed_at as a timestamp, close to the run 0ms
         ✓ a pipeline run that fails > merges _error in rather than replacing stage_logs 0ms
         ✓ a pipeline run that fails > leaves the stages before the failure committed 0ms
         ✓ a pipeline run that fails > leaves the failing stage's column unwritten 0ms
         ✓ a pipeline run that fails > is published a terminal failure event more than once for one run 0ms
         ✓ a pipeline run that fails > reports the failing step and its error 0ms
         ✓ a pipeline run that fails > announces stage_error on the pipeline bus, in Python's payload shape 0ms
         ✓ a pipeline run that fails > announces it once, though the engine published the failure more than once 0ms
         ✓ a pipeline run that fails > stamps the row failed before it announces 0ms
         ✓ a pipeline run that fails > announces no stage_complete for the stage that threw 0ms
         ✓ a pipeline run that fails > writes Python's error entry to execution_logs, once 0ms
         ✓ a pipeline run that fails > timestamps the error entry in the offset form the analytics query sorts on 0ms
         ✓ a pipeline run that fails > closes the log with the failure, after the stages that did complete 0ms
         ✓ a pipeline run that fails > writes no pipeline_complete entry for a run that died 0ms
         ✓ a pipeline run that fails > never says the pipeline finished 0ms
         ✓ recordRunFailure > ignores a failure from another workflow 1ms
         ✓ recordRunFailure > ignores a terminal event that is not a failure 1ms
         ✓ recordRunFailure > ignores a run whose input carries no post id 1ms
         ✓ recordRunFailure > records a thrown non-Error, which the engine passes through as it was 2ms
         ✓ recordRunFailure > reports no stage when no step result says which one failed 1ms
         ✓ recordRunFailure > names the stage whose own step result failed 1ms
         ✓ recordRunFailure > is safe to repeat: a second delivery rewrites the same values 3ms
         ✓ recordRunFailure > announces the repeat delivery only once, though it writes both times 2ms
         ✓ recordRunFailure > appends the error entry naming the stage it announced, with Python's data keys 2ms
         ✓ recordRunFailure > appends nothing for a repeat delivery, because an append is not idempotent 3ms
         ✓ recordRunFailure > appends nothing for an event it ignores 1ms
         Test Files  1 passed (1)
              Tests  30 passed (30)
           Duration  3.04s (transform 147ms, setup 117ms, import 618ms, tests 2.23s, environment 0ms)
        ```

        Negative controls, each one applied to
        `web/src/mastra/failure-recorder.ts` and reverted:

        | Control | Result |
        | --- | --- |
        | append removed entirely | `4 failed`, 26 passed: the real run's entry, its `ts` form, the ordered trail, and the direct-call entry |
        | append moved above the run-id guard | `3 failed`, 27 passed: the real run's "once", the trail, and "appends nothing for a repeat delivery" |
        | entry `stage` hardcoded to `""` (Python's full-run value) | `3 failed`, 27 passed: both entry assertions and the trail |
        | `moved_to_dlq` dropped from `data` | `2 failed`, 28 passed: both entry assertions |

        Gates, from `web/` (`pnpm -C web ...` fails with
        `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` in this worktree):

        ```
        $ npx tsc --noEmit
        TSC EXIT=0

        $ npx eslint .
        LINT EXIT=0

        $ npx vitest run
        Test Files  2 failed | 86 passed (88)
             Tests  9 failed | 1585 passed | 7 skipped (1601)
        # the 9 are the recorded baseline: 6 image-preview, 3 PostDetail.
        # 1594 -> 1601 is exactly this item's seven new tests.

        $ npx next build
        BUILD EXIT=0
        v Compiled successfully in 3.7s

        $ cd api && uv run pytest -q
        120 failed, 241 passed, 25 errors in 13.79s

        $ cd api && uv run ruff check .
        Found 32 errors.

        $ cd api && uv run ruff format --check .
        9 files would be reformatted, 131 files already formatted
        ```

## 5.5c-iii-b-1


          `MAX_ATTEMPTS = 3` now lives in `web/src/mastra/state.ts` beside the status
          vocabulary, ported from `api/src/worker.py:51`, and
          `web/src/mastra/workflows/pipeline.ts` spends it as
          `retryConfig: { attempts: MAX_ATTEMPTS - 1 }`.

          **The minus one is the engine's counting, read off the processor rather than
          guessed.** The evented engine republishes `workflow.step.run` while
          `retryCount < attempts` and routes to `workflow.step.end` (and so
          `workflow.fail`) once it is spent, so `attempts` is retries *after* the first
          execution while Python's `MAX_ATTEMPTS` was executions:

          ```
          $ sed -n '3434p' web/node_modules/.pnpm/@mastra+core@1.61.0_express@5.2.1_zod@4.4.3/node_modules/@mastra/core/dist/workflow-event-processor-Dp87-e6z.js
          		if (stepResult.status === "failed") if (retryCount >= (getEntryRetries(leaf) ?? workflow.retryConfig.attempts ?? 0) || stepResult.nonRetryable) await this.mastra.pubsub.publish("workflows", {
          ```

          **Decision 1: the retry is per step, where Python's was per job, and that is
          the closer port rather than a compromise.** ARQ re-ran the whole job
          (`max_tries = MAX_ATTEMPTS`, `api/src/worker.py:609`), but `_run_pipeline()`
          opened each iteration with `if ss.get(stage) == "complete": continue`
          (`api/src/worker.py:151`), so a retry only ever re-ran the stage that threw and
          the ones after it. The engine retries the failing step and then carries on down
          the chain: the same set of provider calls, and so the same bill. Pinned by its
          own test, which asserts `research` and `outline` were each generated once while
          `write` was generated three times.

          **Decision 2: `delay` is left unset rather than set to Python's
          `retry_delay = 10`.** The processor's only `retryConfig` reference is the line
          pasted above; `delay` is never read, and the file's one sleep helper
          (`abortableSleep`, line 255) is exported for sleep steps and never called on the
          retry path. Setting it would be a value that reads as honoured and is not. So
          the three attempts are immediate where Python spaced them ten seconds apart,
          which is a real regression against a rate-limiting provider and is logged in
          `todo.md` with the shape of a fix (a backoff inside the step, which can read
          `retryCount`).

          **Decision 3: `executionsBeforeFailure()` stays derived from the workflow's
          `retryConfig` in both `failure-recorder.ts` and `dead-letter.ts`.** It now
          reports 3 rather than 1 with no change to either module, which is what the two
          accessors were written for. The limit is measured, not assumed: negative control
          3 below puts `retries: 0` on the `write` step and the accessor keeps reporting
          3, because `getEntryRetries(leaf) ?? workflow.retryConfig.attempts` lets a step
          override the workflow and the accessor cannot see it. No step sets `retries`
          today; one that did would make `_error.attempts` lie.

          **Two assertions changed rather than being written fresh, because the intended
          behaviour changed.** `_error.attempts`, the dead-letter list's `attempts` and
          the `stage_error` entry's `Pipeline failed after N attempts` all moved from 1 to
          `MAX_ATTEMPTS`, and the failing run's `execution_logs` trail now carries one
          `stage_start/write` per attempt. That last one is parity, not a new artefact:
          Python's retry re-entered `_run_pipeline()` and re-announced the stage it
          resumed on.

          Two new tests on the file's existing real failing run (real evented engine, real
          Redis Streams, real database, `write` throwing):

          ```
          $ pnpm vitest run src/mastra/failure-recorder.test.ts src/app/api/queue/dead-letter.test.ts --reporter=verbose
           ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > records how many times the run was executed, Python's job_try 0ms
           ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > re-executes the failing stage MAX_ATTEMPTS times, Python's max_tries 0ms
           ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > does not re-run the stages that already completed 0ms
           ✓ src/mastra/failure-recorder.test.ts > a pipeline run that fails > closes the log with the failure, after the stages that did complete 0ms
           ✓ src/app/api/queue/dead-letter.test.ts > GET /api/queue/dead-letter, a real failed run > reports how many times the run executed, Python's attempts 21ms
           Test Files  2 passed (2)
                Tests  53 passed (53)
             Start at  19:31:09
             Duration  3.94s (transform 242ms, setup 170ms, import 1.37s, tests 4.35s, environment 0ms)
          ```

          The test proving the policy was written first and failed for the right reason
          before `retryConfig` existed:

          ```
          $ pnpm vitest run src/mastra/failure-recorder.test.ts
          AssertionError: expected "generate" to be called 3 times, but got 1 times
                Tests  1 failed | 31 passed (32)
          ```

          Negative controls, each reverted after measuring:

          | # | Mutation | Result |
          | --- | --- | --- |
          | 1 | `attempts: MAX_ATTEMPTS` (off by one) | 6 failed, 47 passed of 53 |
          | 2 | `attempts: 0` (no policy, the previous state) | 6 failed, 47 passed of 53 |
          | 3 | `retries: 0` on the `write` step, policy left alone | 2 failed, 30 passed of 32 |

          Control 3 is the interesting one: only the two execution-count assertions fail.
          `_error.attempts` still reads 3, which is the accessor limitation recorded as
          decision 3.

          Gates:

          ```
          $ pnpm exec tsc --noEmit
          TSC EXIT=0
          (no output)

          $ pnpm lint
          LINT EXIT=0
          (no output)

          $ pnpm test
           Test Files  2 failed | 86 passed (88)
                Tests  9 failed | 1587 passed | 7 skipped (1603)
          # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
          # PostDetail.test.tsx. Passing count 1585 -> 1587 (+2). An earlier full run of
          # the same command reported 10 failed, the extra one being the
          # scaffold-check.test.ts lifecycle-events flake already tracked in todo.md;
          # it passed alone (5 passed) and on the rerun above.

          $ pnpm build
          BUILD EXIT=0
          ✓ Compiled successfully in 3.8s
          ✓ Generating static pages using 15 workers (35/35) in 465.2ms

          $ cd api && uv run pytest -q
          120 failed, 241 passed, 25 errors in 13.41s
          # Better than the Phase 0 baseline of 125 failed / 235 passed / 25 errors, and
          # untouched by this item: no Python file changed.

          $ cd api && uv run ruff check .
          Found 32 errors.

          $ cd api && uv run ruff format --check .
          9 files would be reformatted, 131 files already formatted
          ```

## 5.5c-iii-b-2


          Split, because the six stages are not one shape here. Five of them are a
          single step in `pipelineWorkflow`'s own chain, so the parent's
          `retryConfig.attempts` is what retries them and the `retryCount` their
          `execute` receives is the attempt number Python called `job_try`. `images`
          is a nested workflow (`workflows/images.ts`), and a nested run is a fresh
          `Run` carrying its own `retryConfig`, which `createWorkflow` defaults to
          `{attempts: 0, delay: 0}` (`agent-DSxJoGjY.js:4951`). Its three sub-steps
          therefore see a `retryCount` that is not the parent's, and the attempt
          number Python recorded is not in hand anywhere inside them. That is a
          different problem with a different answer, so it gets its own item.

## 5.5c-iii-b-2-a


            `recordStageRetry()` in `web/src/mastra/steps/stage-io.ts` ports Python's
            `if job_try < MAX_ATTEMPTS:` branch (`api/src/worker.py:333`) verbatim:
            level `warning`, event `retry`, message
            `Pipeline attempt {n} failed, retrying...`, and the three data keys
            `attempt`, `max_attempts`, `error`. Each of the five steps now wraps its
            `execute` body in `try` / `catch`, calls it, and rethrows the error
            unchanged.

            Three decisions, argued rather than assumed:

            1. **Inside the step, not beside its sibling entry.** The `error` /
               `stage_error` entry from the same Python block is written by
               `failure-recorder.ts` off the `workflows-finish` topic. That listener
               cannot see a retry by construction: the evented processor routes a
               failed step to `workflow.step.end` (and so to `workflow.fail`) only
               when `retryCount >= (getEntryRetries(leaf) ?? workflow.retryConfig.attempts ?? 0)`,
               and otherwise republishes `workflow.step.run` with `retryCount + 1`
               (`workflow-event-processor-Dp87-e6z.js:3434`). Nothing terminal is
               published while attempts remain, so the only vantage point that sees
               one is the step that threw.

            2. **`retryCount + 1` is `job_try`, and `attempt >= MAX_ATTEMPTS` is the
               gate.** The engine counts retries after the first execution, so the
               first failure arrives with `retryCount === 0`. Python's own condition
               was `job_try < MAX_ATTEMPTS`, which is `attempt < MAX_ATTEMPTS` here,
               and it holds exactly when the workflow's `attempts`
               (`MAX_ATTEMPTS - 1`, item 5.5c-iii-b-1) leaves a retry to come. So the
               entry that promises another attempt is written when and only when one
               follows.

            3. **No SSE event beside it.** Python published `stage_error` once per
               attempt from this block; that publish is already ported in the failure
               recorder, once per run. Adding a second publish here would raise a
               dashboard toast per attempt for a run that has not failed yet, which
               is a user-visible change rather than a port.

            One deviation from Python, the same one 5.5c-iii-a records for the
            `stage_error` entry: the stage names the step that threw, where Python
            sent `""` for a full run because its runner only knew the whole job had
            failed.

            Not covered, and deliberately: a step whose *input* fails schema
            validation throws inside `StepExecutor.execute` before `step.execute` is
            called (`workflow-event-processor-Dp87-e6z.js:1122`), so no `catch` in the
            step body can see it and no retry entry is written for it. Python had no
            equivalent failure mode, since it passed a dict.

            The two entries a failing `write` stage stores, read back off the row:

            ```json
            [
              {
                "ts": "2026-08-23T00:43:16.735+00:00",
                "data": {
                  "error": "provider exploded mid-draft",
                  "attempt": 1,
                  "max_attempts": 3
                },
                "event": "retry",
                "level": "warning",
                "stage": "write",
                "message": "Pipeline attempt 1 failed, retrying..."
              },
              {
                "ts": "2026-08-23T00:43:16.736+00:00",
                "data": {
                  "error": "provider exploded mid-draft",
                  "attempt": 2,
                  "max_attempts": 3
                },
                "event": "retry",
                "level": "warning",
                "stage": "write",
                "message": "Pipeline attempt 2 failed, retrying..."
              }
            ]
            ```

            The third attempt writes nothing, which is Python's `else` branch and the
            reason the run's trail ends `stage_start/write` then `stage_error/write`.

            Before the implementation, with the assertions written first:

            ```
            $ npx vitest run src/mastra/failure-recorder.test.ts
            Tests  3 failed | 32 passed (35)

            AssertionError: expected [] to have a length of 2 but got +0
              src/mastra/failure-recorder.test.ts:462:21
            AssertionError: expected Set{} to deeply equal Set{ 'write' }
              src/mastra/failure-recorder.test.ts:484:29
            # plus the whole-trail assertion, which the retry entries interleave into.
            ```

            Six boundary tests against the real database, driving `recordStageRetry`
            directly, because a real run only ever fails on its last attempt and so
            can never reach the branch that writes nothing:

            ```
            $ npx vitest run src/mastra/steps/stage-retry.test.ts --reporter=verbose
             ✓ recordStageRetry > writes Python's entry for the first failure, with retryCount read as job_try 20ms
             ✓ recordStageRetry > writes nothing on the attempt that spends the last one, Python's else branch 2ms
             ✓ recordStageRetry > writes an entry for every attempt before the last one 3ms
             ✓ recordStageRetry > records a thrown non-Error the way Python's str(e) would 2ms
             ✓ recordStageRetry > names the stage that threw, which is what the log reader groups on 2ms
             ✓ recordStageRetry > timestamps the entry in the offset form the analytics query sorts on 4ms

             Test Files  1 passed (1)
                  Tests  6 passed (6)
            ```

            Three assertions on the file's existing real failing run (real evented
            engine, real Redis Streams, real database, `write` throwing), plus the
            whole-trail assertion the entries now interleave into:

            ```
            $ npx vitest run src/mastra/failure-recorder.test.ts --reporter=verbose
             ✓ a pipeline run that fails > closes the log with the failure, after the stages that did complete 0ms
             ✓ a pipeline run that fails > writes Python's retry entry for every attempt that had another one left 0ms
             ✓ a pipeline run that fails > timestamps the retry entries in the offset form the analytics query sorts on 0ms
             ✓ a pipeline run that fails > writes no retry entry against a stage that never threw 0ms

             Test Files  1 passed (1)
                  Tests  35 passed (35)
            ```

            Negative controls, each reverted after measuring, run over both files
            (41 tests, all passing at baseline):

            | Control | Result |
            | --- | --- |
            | `if (attempt >= MAX_ATTEMPTS) return` deleted | 4 failed, 37 passed |
            | `const attempt = retryCount` instead of `retryCount + 1` | 5 failed, 36 passed |
            | gate loosened to `attempt > MAX_ATTEMPTS` | 4 failed, 37 passed |
            | the `recordStageRetry` call deleted from `write.ts` only | 3 failed, 38 passed |

            The third control is the one worth keeping: an off-by-one in the gate
            leaves the entry looking right on every attempt except the last, where it
            silently claims a retry that never comes. It fails the boundary test and
            the run's exact-count and whole-trail assertions.

            Gates:

            ```
            $ npx tsc --noEmit
            TSC EXIT=0

            $ npx eslint
            LINT EXIT=0

            $ npx vitest run
             Test Files  3 failed | 86 passed (89)
                  Tests  10 failed | 1595 passed | 7 skipped (1612)
            # 9 is the standing baseline: 6 in image-preview.test.tsx and 3 in
            # PostDetail.test.tsx, both pre-existing. The tenth is the known
            # scaffold-check.test.ts flake logged in todo.md; it passed alone:
            $ npx vitest run src/mastra/workflows/scaffold-check.test.ts
             Test Files  1 passed (1)
                  Tests  5 passed (5)

            $ npx next build
            BUILD EXIT=0
            ✓ Compiled successfully in 3.4s
            ✓ Generating static pages using 15 workers (35/35) in 295.6ms

            $ cd api && uv run pytest -q
            120 failed, 241 passed, 25 errors in 13.24s
            # Better than the Phase 0 baseline of 125 failed / 235 passed / 25 errors,
            # and untouched by this item: no Python file changed.

            $ cd api && uv run ruff check .
            Found 32 errors.

            $ cd api && uv run ruff format --check .
            9 files would be reformatted, 131 files already formatted
            ```

## 5.5c-iii-b-2-b-i


              **The two questions, answered.**

              1. *Does the parent retry a nested workflow entry at all under
                 `pipelineWorkflow.retryConfig`?* **No.** `runLeafStep` handles a
                 nested entry by publishing `workflow.start` for the inner run and
                 then returning, 124 lines before the failing-status retry branch:

                 ```
                 $ sed -n '3308,3312p;3434,3435p' node_modules/@mastra/core/dist/workflow-event-processor-Dp87-e6z.js
                 			}
                 			return;
                 		}
                 		if (isSingleStepEntry(step)) await this.mastra.pubsub.publish(`workflow.events.v2.${runId}`, {
                 			type: "watch",
                 		if (stepResult.status === "failed") if (retryCount >= (getEntryRetries(leaf) ?? workflow.retryConfig.attempts ?? 0) || stepResult.nonRetryable) await this.mastra.pubsub.publish("workflows", {
                 			type: "workflow.step.end",
                 ```

                 A nested run reports back through `processWorkflowEnd`, which
                 publishes `workflow.step.end` on the parent directly
                 (`workflow-event-processor-Dp87-e6z.js:2621`), so the parent sees a
                 finished entry and never a failed one it could retry.

              2. *Do a nested run's steps restart at `retryCount === 0` on each parent
                 attempt?* **The question does not arise.** Because there is only ever
                 one parent attempt at a nested entry, the inner `retryCount` is a
                 single ascending sequence owned by the inner workflow's own
                 `retryConfig` and never restarts.

              This contradicts the guess recorded in `todo.md` when 5.5c-iii-b-2-a was
              written, that the nested entry is dispatched as `entry.step.execute(...)`
              like any step and so inherits the parent's policy. It is dispatched that
              way only *after* the nested branch has been ruled out, which is the whole
              reason the ledger asked for a measurement rather than a reading.

              **Measured, not read.** `web/src/mastra/workflows/nested-retry.test.ts`
              runs three synthetic workflows on a real evented engine, a real Redis
              Streams transport and real Postgres storage, each around a step that
              records `retryCount` and throws:

              | Workflow | Policy | Executions of its failing step |
              | --- | --- | --- |
              | plain step under a parent that declares `attempts: 2` (control) | parent | 3 |
              | nested workflow with no policy, under the same parent | parent | **1** |
              | nested workflow that declares `attempts: 2`, under the same parent | inner | 3, at `retryCount` 0, 1, 2 |

              The control carries the measurement. Without it, "the nested step ran
              once" is equally consistent with the parent's policy being inert for
              every entry, which would mean the five stages ported in 5.5c-iii-b-1 do
              not retry either.

              **The defect this exposed, and the fix.** `imagesWorkflow` is the one
              stage that is a nested workflow rather than a step, so
              `pipelineWorkflow.retryConfig` never reached it: the `images` stage got a
              single attempt where Python's `max_tries = MAX_ATTEMPTS` gave every stage
              three. `web/src/mastra/workflows/images.ts` now declares
              `retryConfig: { attempts: MAX_ATTEMPTS - 1 }` on `imagesWorkflow` itself.
              Recorded in `todo.md` as confirmed and fixed, replacing the `[investigate]`
              entry that guessed the other way.

              Three decisions worth stating:

              - **The policy is restated on `imagesWorkflow`, not inherited.** There is
                nothing to inherit from: `createWorkflow` defaults `retryConfig` to
                `{attempts: 0, delay: 0}` and the retry branch above reads
                `workflow.retryConfig` for whichever workflow owns the entry. So the
                constant appears in two places, and `images-retry.test.ts` asserts the
                two agree rather than leaving that to review.
              - **It applies per sub-step, not per stage.** A failing `images-manifest`
                re-runs the whole stage, since nothing downstream has run yet; a failing
                `images-generate` re-runs only that entry of the fan-out, where Python's
                job retry would have re-entered the stage from the manifest. The set of
                provider calls a retry spends is the same or smaller, which is the same
                argument `pipeline.ts` already records for the other five stages. Noted
                in `todo.md` as a residual asymmetry rather than worked around.
              - **`delay` is absent here too**, for the reason 5.5c-iii-b-1 recorded:
                the evented processor reads `retryConfig.attempts` and nothing else, so
                a delay would be a value that reads as honoured and is not.

              A side effect worth naming: `executionsBeforeFailure()` in
              `failure-recorder.ts` and `dead-letter.ts` derives its attempt count from
              `pipelineWorkflow.retryConfig`, so before this change a run that died in
              `images` recorded `attempts: 3` on a stage that had run once. That record
              is now true.

              **Pre-implementation, `images-retry.test.ts` failing for the right
              reason** (the whole point of the item, so pasted before the fix):

              ```
              $ pnpm exec vitest run src/mastra/workflows/images-retry.test.ts
               FAIL  src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > calls the manifest provider once per attempt Python's max_tries allowed
              AssertionError: expected "generate" to be called 3 times, but got 1 times
               FAIL  src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > announces the stage once per attempt, as a retried step re-runs its whole body
              AssertionError: expected [ { …(5) } ] to have a length of 3 but got 1
               Test Files  1 failed (1)
                    Tests  3 failed | 1 passed (4)
              ```

              **After the fix.**

              ```
              $ pnpm exec vitest run src/mastra/workflows/nested-retry.test.ts src/mastra/workflows/images-retry.test.ts --reporter=verbose
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy on a plain step (control) > executes the failing step once per attempt the parent allows 1ms
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy on a plain step (control) > fails the run once the attempts are spent 0ms
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy across a nested workflow boundary > does not retry a nested workflow entry under the parent's policy 0ms
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy across a nested workflow boundary > still fails the parent run when the nested run fails 0ms
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy across a nested workflow boundary > retries the nested workflow's own steps under the nested workflow's policy 0ms
               ✓ src/mastra/workflows/nested-retry.test.ts > the engine's retry policy across a nested workflow boundary > fails the parent run once the nested workflow's attempts are spent 0ms
               ✓ src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > declares the pipeline's policy on the nested workflow itself 0ms
               ✓ src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > calls the manifest provider once per attempt Python's max_tries allowed 0ms
               ✓ src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > fails the parent run once those attempts are spent 0ms
               ✓ src/mastra/workflows/images-retry.test.ts > the images stage under the pipeline's retry policy > announces the stage once per attempt, as a retried step re-runs its whole body 1ms

               Test Files  2 passed (2)
                    Tests  10 passed (10)
              ```

              Both files capture `console.error` and assert the expected step-failure
              lines rather than leaving them on stderr, for the reason
              `failure-recorder.test.ts` records: the engine's `StepExecutor` never
              adopts the Mastra instance's logger, so the failing step's line is
              written by a logger no spy on `testMastra.getLogger()` can reach.

              **Negative controls.** Four, each reverted immediately after:

              | Control | Expected | Result |
              | --- | --- | --- |
              | no `retryConfig` on `imagesWorkflow` (the pre-implementation state) | `images-retry` fails | 3 failed, 1 passed |
              | `attempts: MAX_ATTEMPTS` instead of `MAX_ATTEMPTS - 1` | `images-retry` fails | 3 failed, 1 passed |
              | give the inner no-policy workflow a policy | the measurement's headline test fails | 2 failed, 4 passed |
              | take the policy off the control workflow | the control fails, proving the harness can see a retry at all | 2 failed, 4 passed |

              The off-by-one control failing the same three tests as no policy at all is
              the reason the count is read off `pipelineWorkflow` in the test rather
              than restated: `MAX_ATTEMPTS` and `MAX_ATTEMPTS - 1` are equally plausible
              spellings and only the engine settles which is right.

              **Gates.**

              ```
              $ pnpm exec tsc --noEmit
              (exit 0, no output)

              $ pnpm run lint
              > eslint
              (exit 0, no output)

              $ pnpm exec vitest run
               Test Files  2 failed | 89 passed (91)
                    Tests  9 failed | 1606 passed | 7 skipped (1622)
              # The Phase 0 baseline: 6 in `image-preview.test.tsx` plus 3 in
              # `PostDetail.test.tsx`. No new failure.

              $ pnpm run build
              ✓ Compiled successfully
              ```

              Python, untouched by this item (no file under `api/` changed):

              ```
              $ cd api && uv run pytest -q
              120 failed, 241 passed, 25 errors in 13.78s

              $ cd api && uv run ruff check .
              Found 32 errors.

              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 131 files already formatted
              ```

## 5.5c-iii-b-2-b-ii


              `recordStageRetry()` needed no change: 5.5c-iii-b-2-a built it as a
              free function over `(stage, postId, retryCount, error)`, so this item
              is three `try` / `catch` wrappers and the tests that pin them.
              `images-manifest`, `images-generate` and `images-assemble` each call it
              with the stage name `"images"` and rethrow unchanged.

              **The open question, answered: all three sub-steps write, and the entry
              is filed under `images`, not under the sub-step.** The reasoning, and
              what was rejected:

              1. *Only `images-manifest` writes.* Rejected. `images-assemble` is the
                 sub-step that writes the row, so a failure there is exactly the
                 failure an operator most needs the record of, and it would have been
                 silent. The fan-out risk that motivated the question turns out to be
                 near-theoretical: `generateOneImage` is documented and implemented as
                 never throwing (`web/src/mastra/images/generate-one.ts:138`, every
                 provider, optimizer and filesystem failure is recorded on the returned
                 entry), so `images-generate` can only throw on the credential read or
                 on its own `imageSpecSchema.parse`.
              2. *File the entry under the sub-step's id.* Rejected. The two readers
                 that consume `execution_logs` group on `stage`
                 (`GET /api/posts/{id}/logs`, `GET /api/analytics/logs`), and Python
                 only ever wrote `images` there. Which sub-step threw stays recoverable
                 from `data.error`.
              3. *One entry per failing fan-out branch is a deviation, recorded here.*
                 A vanished Gemini credential would fail all five `images-generate`
                 branches at once and write five identical entries for the one attempt,
                 where Python wrote one per stage per attempt. Left as is rather than
                 deduplicated: the branches genuinely do retry independently (see the
                 asymmetry `workflows/images.ts` already records), so five entries is
                 the honest report of five retries, and suppressing four of them would
                 need cross-branch state the step does not have.

              **The blind spot, stated rather than papered over.** `images-assemble`
              takes its post id from `getStepResult(imagesManifestStep)`, resolved
              before the `try` so the `catch` has it. A `getStepResult` that itself
              threw writes no entry, because there is no post id to write it against.
              That is the same class of blind spot 5.5c-iii-b-2-a recorded for input
              schema validation, which throws before `execute` is entered at all.

              The pre-implementation run, failing for the right reason (the entry does
              not exist yet), before the three wrappers were added:

              ```
              $ pnpm exec vitest run src/mastra/steps/images-retry-entry.test.ts
               ✗ 'images-manifest' on the way out > writes the stage's retry entry while attempts remain
               ✗ 'images-generate' on the way out > writes the stage's retry entry while attempts remain
               ✗ 'images-assemble' on the way out > writes the stage's retry entry while attempts remain
              AssertionError: expected [] to deeply equal [ { ts: Any<String>, …(5) } ]
               Test Files  1 failed (1)
                    Tests  3 failed | 6 passed (9)
              ```

              The whole `execution_logs` trail of the real failing nested run in
              `workflows/images-retry.test.ts`, read off the row after the run: real
              evented engine, real Redis Streams, real Postgres storage, real database,
              with only the Claude call stubbed to throw.

              ```
              [
                {
                  "ts": "2026-08-23T01:07:55.427+00:00",
                  "event": "stage_start",
                  "level": "info",
                  "stage": "images",
                  "message": "Starting images..."
                },
                {
                  "ts": "2026-08-23T01:07:55.428+00:00",
                  "data": {
                    "error": "manifest provider exploded",
                    "attempt": 1,
                    "max_attempts": 3
                  },
                  "event": "retry",
                  "level": "warning",
                  "stage": "images",
                  "message": "Pipeline attempt 1 failed, retrying..."
                },
                {
                  "ts": "2026-08-23T01:07:55.435+00:00",
                  "event": "stage_start",
                  "level": "info",
                  "stage": "images",
                  "message": "Starting images..."
                },
                {
                  "ts": "2026-08-23T01:07:55.436+00:00",
                  "data": {
                    "error": "manifest provider exploded",
                    "attempt": 2,
                    "max_attempts": 3
                  },
                  "event": "retry",
                  "level": "warning",
                  "stage": "images",
                  "message": "Pipeline attempt 2 failed, retrying..."
                },
                {
                  "ts": "2026-08-23T01:07:55.441+00:00",
                  "event": "stage_start",
                  "level": "info",
                  "stage": "images",
                  "message": "Starting images..."
                }
              ]
              ```

              Three attempts, two retries, and nothing after the last attempt, which is
              Python's `if job_try < MAX_ATTEMPTS:` gate holding across the nested
              workflow boundary.

              The new direct-call file. A real run can only ever fail inside
              `images-manifest`, because a failing manifest never reaches the fan-out
              and `generateOneImage` never throws, so the other two sub-steps' catches
              are unreachable from a real run and need driving directly:

              ```
              $ pnpm exec vitest run --reporter=verbose src/mastra/steps/images-retry-entry.test.ts
               ✓ 'images-manifest' on the way out > writes the stage's retry entry while attempts remain 28ms
               ✓ 'images-manifest' on the way out > writes nothing on the attempt that spends the last one 5ms
               ✓ 'images-manifest' on the way out > rethrows the error unchanged, so the engine still sees the failure 5ms
               ✓ 'images-generate' on the way out > writes the stage's retry entry while attempts remain 3ms
               ✓ 'images-generate' on the way out > writes nothing on the attempt that spends the last one 2ms
               ✓ 'images-generate' on the way out > rethrows the error unchanged, so the engine still sees the failure 2ms
               ✓ 'images-assemble' on the way out > writes the stage's retry entry while attempts remain 2ms
               ✓ 'images-assemble' on the way out > writes nothing on the attempt that spends the last one 1ms
               ✓ 'images-assemble' on the way out > rethrows the error unchanged, so the engine still sees the failure 1ms
               ✓ images-manifest, which is the sub-step a real failing run reaches > leaves the announcement it already wrote in front of the retry 3ms
               ✓ images-manifest, which is the sub-step a real failing run reaches > records the error the agent threw, not the step's own wrapper 3ms
               Test Files  1 passed (1)
                    Tests  11 passed (11)
              ```

              The real nested run, with the two assertions this item adds:

              ```
              $ pnpm exec vitest run --reporter=verbose src/mastra/workflows/images-retry.test.ts
               ✓ declares the pipeline's policy on the nested workflow itself 0ms
               ✓ calls the manifest provider once per attempt Python's max_tries allowed 0ms
               ✓ fails the parent run once those attempts are spent 0ms
               ✓ announces the stage once per attempt, as a retried step re-runs its whole body 0ms
               ✓ records a retry for every attempt but the last, under the stage's own name 1ms
               ✓ interleaves the retry after every attempt that is followed by another 0ms
               Test Files  1 passed (1)
                    Tests  6 passed (6)
              ```

              **Negative controls.** Each mutation applied on its own, both files run
              together (17 tests), then reverted.

              | Mutation | Result | What it shows |
              | --- | --- | --- |
              | `images-manifest`'s `catch` removed (file reverted to `HEAD`) | 5 failed of 17 | The real nested run and the manifest half of the direct-call file both depend on it. |
              | `retryCount + 1` in all three catches | 6 failed of 17 | The off-by-one is caught in both directions: it inflates the attempt number on every entry and makes the last attempt write one it should not. |
              | `"images-manifest"` used as the stage name instead of `"images"` | 3 failed of 17 | The stage name the log reader groups on is pinned, not incidental. |
              | `catch` removed from `images-generate` and `images-assemble` only | 2 failed of 17, and the real nested run still passes | The two sub-steps a real run cannot reach are carried entirely by the direct-call file. Without it this change would have looked complete with two thirds of it missing. |

              Frontend gates, from `web/`:

              ```
              $ pnpm exec tsc --noEmit
              (exit 0, no output)

              $ pnpm run lint
              > eslint
              (exit 0, no output)

              $ pnpm exec vitest run
               Test Files  2 failed | 90 passed (92)
                    Tests  9 failed | 1618 passed | 7 skipped (1635)
              # The Phase 0 baseline: 6 in `image-preview.test.tsx` plus 3 in
              # `PostDetail.test.tsx`. No new failure.
              # The first run of the suite showed 10 failed, the known
              # `scaffold-check.test.ts` flake already recorded in `todo.md`; it
              # passes on its own and on the second full run.

              $ pnpm run build
              ✓ Compiled successfully
              ```

              Python, untouched by this item (no file under `api/` changed):

              ```
              $ cd api && uv run pytest -q
              120 failed, 241 passed, 25 errors in 12.83s

              $ cd api && uv run ruff check .
              Found 32 errors.

              $ cd api && uv run ruff format --check .
              9 files would be reformatted, 131 files already formatted
              ```

## 5.5c-iv


      All four sub-items done: 5.5c-iv-a the helper plus `outline` / `write` / `ready`,
      5.5c-iv-b `research`'s five, 5.5c-iv-c `edit`'s seven, 5.5c-iv-d `images`' seven.
      All 28 of Python's call sites are ported; evidence under each sub-item.

      Split, because the 28 calls are neither evenly spread nor all the same shape:

      ```
      $ for f in research outline write edit ready images; do printf "%-9s %s\n" "$f" \
          "$(grep -c 'await publish_stage_log(' api/src/pipeline/stages/$f.py)"; done
      research  5
      outline   3
      write     3
      edit      7
      ready     3
      images    7
      ```

      `outline`, `write` and `ready` write the same three lines in the same three
      positions and share a writer. `research`'s five sit inside its validator retry
      loop, `edit`'s seven inside its link-validation and quality passes, and `images`'
      seven inside the nested workflow's three sub-steps, which have their own attempt
      numbering. Porting them together would be one iteration touching every stage file.

## 5.5c-iv-a


        `publishStageLog()` is in `web/src/mastra/steps/stage-io.ts`, beside the three
        announcement writers that already live there, because it is the fourth thing a
        stage writes about itself and shares both of their collaborators.

        **Decision 1: the module-level context is deleted, not replaced.** Python's
        stage nodes received a `PipelineState` dict and nothing else, so the runner
        parked the Redis handle, the post id and the session factory in module globals
        for them to read back:

        ```
        $ grep -rn "set_event_context\|clear_event_context" api/src --include=*.py
        api/src/pipeline/helpers.py:31:def set_event_context(
        api/src/pipeline/helpers.py:41:def clear_event_context() -> None:
        api/src/worker.py:186:            set_event_context(redis, post_id, session_factory)
        api/src/worker.py:190:            clear_event_context()
        api/src/worker.py:316:        clear_event_context()
        ```

        A Mastra step's `execute` already receives `mastra`, and every call site already
        has the post id, so both are arguments. Two things go with the globals. Python's
        `if _event_redis is None ...: return` no-op branch has nothing left to test, so a
        stage driven outside the runner now publishes and stores where Python silently
        did neither. And the failure mode the globals carried, two runs in one process
        sharing one post id, cannot be expressed.

        **Decision 2: publish first, and let the append fail.** Both are Python's, and
        both are the reverse of what `announceStageStart` and `announceStageComplete` do
        (5.5c-i recorded that those two commit the row first because the dashboard
        refetches the post on them). A progress line carries its whole content in the
        payload, so there is nothing to refetch and nothing to race; and Python wrapped
        only this call in `try/except`, at `logger.debug`, because a log line is not
        worth failing a paid-for provider call over. The port keeps the swallow and logs
        it through `mastra.getLogger()?.debug`.

        **Decision 3: `f"{x:.1f}"` goes through `pythonRound` first.** The third line of
        every stage renders the elapsed seconds to one decimal place, and a duration is
        milliseconds divided by 1000, so 250ms and 750ms boundaries are exact ties at
        one place. Python resolves those to even and `toFixed` resolves them away from
        zero: `2.25` renders `2.2` in Python and `2.3` through `toFixed` alone. Same
        reasoning as `roundSeconds` in 5.5b, same helper.

        The nine call sites, in Python's own order relative to the stage body: after
        `load_rules` and before `build_stage_prompt`, immediately before the provider
        call, and once it has answered and before the runner saved the column. That last
        position is why `tokensOut` and `durationS` are now named before the output
        object rather than computed inside it: the line reports the same two numbers the
        step returns, and computing them twice is how they drift.

        A real event and its stored entry, written by `publishStageLog` against the real
        database and read back off the column (post row inserted and deleted by the
        probe; token count and duration are the fixture's, not a live call):

        ```
        {
          "event": "log",
          "post_id": "00000000-0000-4000-8000-0000000055f9",
          "stage": "outline",
          "message": "Rules loaded, building prompt...",
          "level": "info",
          "timestamp": "2026-08-23T01:27:15.366+00:00"
        }
        {
          "ts": "2026-08-23T01:27:15.367+00:00",
          "event": "log",
          "level": "info",
          "stage": "outline",
          "message": "Rules loaded, building prompt..."
        }
        ```

        **Measured while writing the tests: `received` in `pipeline-events.test.ts` is
        not in delivery order.** Its subscriber awaits a row read before pushing the
        event (5.5b's fix for a real flake), so the array's order is the order those
        reads resolved in. A first draft asserting that every progress line lands
        between its stage's `stage_start` and `stage_complete` failed on this run's own
        data, which recorded `stage_complete`/`research` ahead of `stage_start`/`research`
        and one `ready` log after `stage_complete`/`ready`. The SSE assertions are
        therefore counts, and ordering is pinned on `execution_logs`, where the entry is
        written by the publishing process itself. Logged in `todo.md`.

        Pre-implementation, the new file against HEAD:

        ```
        $ npx vitest run src/mastra/steps/stage-log.test.ts --reporter=verbose
        TypeError: (0 , __vite_ssr_import_3__.publishStageLog) is not a function
         Test Files  1 failed (1)
              Tests  9 failed (9)
        ```

        And the three stages' existing whole-sequence announcement assertions, which are
        a behaviour change rather than a test edit:

        ```
        $ npx vitest run src/mastra/steps/outline.test.ts src/mastra/steps/write.test.ts \
            src/mastra/steps/ready.test.ts
         Test Files  3 failed (3)
              Tests  3 failed | 34 passed (37)
        ```

        The writer's own suite, against the real database:

        ```
        $ npx vitest run src/mastra/steps/stage-log.test.ts --reporter=verbose
         v publishStageLog > publishes Python's payload under the default `log` event name 17ms
         v publishStageLog > stamps the timestamp in the offset form the stored entries use 2ms
         v publishStageLog > writes the same line to execution_logs 3ms
         v publishStageLog > carries a call site's own level and event name to both 2ms
         v publishStageLog > carries `data` onto both the event and the entry 2ms
         v publishStageLog > omits `data` from both when it is an empty object, per Python's `if data:` 4ms
         v publishStageLog > publishes before it appends, which is the reverse of the stage announcements 5ms
         v publishStageLog > swallows an append failure, reports it at debug, and still published 2ms
         v publishStageLog > swallows an append failure with no logger configured at all 6ms
         Test Files  1 passed (1)
              Tests  9 passed (9)
        ```

        The real run, on a real evented engine, a real Redis Streams topic and the real
        database (four new assertions, and the whole-trail assertion updated to
        interleave three `log` entries per ported stage):

        ```
        $ npx vitest run src/mastra/pipeline-events.test.ts --reporter=verbose
         v a run that executes every stage > delivers three progress lines for each ported stage and none for the others 0ms
         v a run that executes every stage > carries Python's log payload and nothing else 0ms
         v what a run writes to execution_logs > opens with the run, records a start and a complete per stage, then closes with the run 2ms
         v what a run writes to execution_logs > carries each stage's three progress lines, in the order the node wrote them 2ms
         v what a run writes to execution_logs > stores a progress line with no data key, as Python's `if data:` did 2ms
         Test Files  1 passed (1)
              Tests  40 passed (40)
        ```

        `failure-recorder.test.ts`'s whole-trail assertion on its real failing run also
        changed, for the right reason: `write` now writes two of its three lines before
        the stubbed provider throws, once per attempt.

        ```
        $ npx vitest run src/mastra/failure-recorder.test.ts
         Test Files  1 passed (1)
              Tests  35 passed (35)
        ```

        Negative controls, each reverted after measuring:

        ```
        # 1. append before publish, rather than after
        Tests  1 failed | 8 passed (9)
          x publishes before it appends, which is the reverse of the stage announcements

        # 2. drop Python's `if data:` emptiness test, sending an empty object
        Tests  1 failed | 8 passed (9)
          x omits `data` from both when it is an empty object, per Python's `if data:`

        # 3. remove the try/catch, letting an append failure out of the helper
        Tests  2 failed | 7 passed (9)
          x swallows an append failure, reports it at debug, and still published
          x swallows an append failure with no logger configured at all

        # 4. remove the three call sites from `write` only
        Test Files  2 failed | 1 passed (3)
        Tests  4 failed | 52 passed (56)
          x write step announcement > announces the stage on the event bus, in Python's payload shape
          x a run that executes every stage > delivers three progress lines for each ported stage and none for the others
          x what a run writes to execution_logs > opens with the run, records a start and a complete per stage, then closes with the run
          x what a run writes to execution_logs > carries each stage's three progress lines, in the order the node wrote them
        ```

        Stated blind spot: no test distinguishes `pythonRound(x, 1).toFixed(1)` from a
        bare `toFixed(1)`. The two disagree only on durations that are exact multiples of
        0.25 ending in .25 or .75, which is roughly 2 stage completions in 1000 and not
        something a real elapsed time can be made to hit on demand. The reasoning is
        recorded above and on the helper instead.

        Gates:

        ```
        $ npx tsc --noEmit
        TSC EXIT=0
        (no output)

        $ npx eslint
        LINT EXIT=0
        (no output)

        $ npx vitest run
         Test Files  2 failed | 91 passed (93)
              Tests  9 failed | 1632 passed | 7 skipped (1648)
        # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
        # PostDetail.test.tsx, both pre-existing. Passing count 1618 -> 1632 (+14).

        $ npx next build
        BUILD EXIT=0
        v Compiled successfully in 3.6s

        $ cd api && uv run pytest -q
        120 failed, 241 passed, 25 errors in 13.51s

        $ cd api && uv run ruff check .
        Found 32 errors.

        $ cd api && uv run ruff format --check .
        9 files would be reformatted, 131 files already formatted
        ```

## 5.5c-iv-b


        The five, from `api/src/pipeline/stages/research.py`: the rules-loaded line at
        :55, the provider-call line at :79 inside the loop, the validation-failed line
        at :98 inside the loop, the degraded line at :109 in the loop's `else` clause,
        and the received line at :120 after the `finally`. Ported into
        `web/src/mastra/steps/research.ts` at the same five positions.

        **Decision 1: Python's `for ... else` becomes the post-loop
        `if (!isValidResearch(text))` that was already there.** The step's existing
        degraded-research branch is exactly the `else` clause's condition, because a
        `break` only happens on a valid response. So the fifth call site attaches to a
        branch the port already had rather than needing new control flow, and the
        `mastra.getLogger()?.error(...)` beside it is Python's `logger.error` from the
        same clause.

        **Decision 2: the failure line is written on the final attempt too, and it
        still reads "retrying...".** Python wrote it from inside the loop body with no
        guard, so a run that exhausts all three attempts records
        `Response validation failed (attempt 3), retrying...` and then the degraded
        line. Reproduced rather than corrected: the line is what a reader of the run
        log has always seen, and the `else` line is what tells them the stage gave up.
        This is the opposite of `recordStageRetry`'s gate (item 5.5c-iii-b-2-a), which
        is guarded, because that one claims another attempt from the engine.

        **Decision 3: the degraded message keeps Python's em dash, written as
        `\u2014`.** The message goes straight onto the wire and into
        `debug-log-panel.tsx`, so its bytes are a contract. This port's own rule bans
        the character in source, so it is an escape in both
        `DEGRADED_RESEARCH_MESSAGE` and the test's `PYTHON_DEGRADED_MESSAGE`; the
        string each builds is byte-identical to Python's. Recorded as a deliberate
        deviation from the writing rule, cross-checked below.

        **Decision 4: the model name stays in the message rather than being read off
        the response.** Python hardcoded `Calling Perplexity sonar-pro`, so the line
        still says `sonar-pro` if the provider answers as an alias. Matching
        5.5c-iv-a's treatment of `Calling Claude for outline...`.

        Python's own rendering of all eight distinct messages, for byte comparison
        against the stored entries below. **Every `\u2014` in this item's pasted
        output is a transcription of the em dash character, which the commands
        actually printed and which this document may not contain.** Confirmed as
        U+2014 in the Python source:

        ```
        $ sed -n 109,114p api/src/pipeline/stages/research.py | hexdump -C | grep -n "e2 80"
        7:00000060  e2 80 94 20 22 0a 20 20   20 20 20 20 20 20 20 20  |... ".          |
        ```

        ```
        $ cd api && python3 -c "
        MAX=3
        for attempt in (1,2,3):
            msg = (f'Calling Perplexity sonar-pro (attempt {attempt}/{MAX})...'
                   if attempt>1 else 'Calling Perplexity sonar-pro...')
            print(repr(msg))
            print(repr(f'Response validation failed (attempt {attempt}), retrying...'))
        print(repr('WARNING: Research quality may be degraded \u2014 Perplexity returned unexpected responses.'))
        print(repr(f'Received {60} tokens in {0.0:.1f}s'))"
        'Calling Perplexity sonar-pro...'
        'Response validation failed (attempt 1), retrying...'
        'Calling Perplexity sonar-pro (attempt 2/3)...'
        'Response validation failed (attempt 2), retrying...'
        'Calling Perplexity sonar-pro (attempt 3/3)...'
        'Response validation failed (attempt 3), retrying...'
        'WARNING: Research quality may be degraded \u2014 Perplexity returned unexpected responses.'
        'Received 60 tokens in 0.0s'
        ```

        A real run of the step against the real database, driven with a refusal on
        every attempt so all nine lines are reached. Published payload and stored
        entry, dumped from a throwaway probe:

        ```
        published (9 of 9, `log` events only)
          {event: log, level: info,    stage: research, post_id: <id>,
           message: "Rules loaded, building prompt...",         timestamp: 2026-08-23T01:35:38.303+00:00}
          {event: log, level: info,    message: "Calling Perplexity sonar-pro..."}
          {event: log, level: warning, message: "Response validation failed (attempt 1), retrying..."}
          {event: log, level: info,    message: "Calling Perplexity sonar-pro (attempt 2/3)..."}
          {event: log, level: warning, message: "Response validation failed (attempt 2), retrying..."}
          {event: log, level: info,    message: "Calling Perplexity sonar-pro (attempt 3/3)..."}
          {event: log, level: warning, message: "Response validation failed (attempt 3), retrying..."}
          {event: log, level: error,
           message: "WARNING: Research quality may be degraded \u2014 Perplexity returned unexpected responses."}
          {event: log, level: info,    message: "Received 60 tokens in 0.0s"}

        stored in posts.execution_logs (same nine, `ts` in place of `timestamp`,
        no post_id, no data key)
          {ts: 2026-08-23T01:35:38.303+00:00, stage: research, level: info,
           event: log, message: "Rules loaded, building prompt..."}
          ... (eight more, messages identical to the published list above)
        ```

        Every message matches Python's rendering above character for character,
        including the em dash.

        Pre-implementation, the five new tests failing for the right reason:

        ```
        $ cd web && npx vitest run src/mastra/steps/research.test.ts
        Tests  5 failed | 11 passed (16)
        # all five in `research step progress lines`, each on an empty
        # execution_logs or an `announced` array carrying only the two
        # announcements.
        ```

        After:

        ```
        $ cd web && npx vitest run src/mastra/steps/research.test.ts --reporter=verbose
        ✓ research step prompt parity > sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
        ✓ research step prompt parity > sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
        ✓ research step persistence and output > commits the research to its column and reports Python's stage meta
        ✓ research step persistence and output > fails loudly on a post that does not exist rather than billing a call
        ✓ research step meta-response retry loop > retries a meta-response with the reinforced prompt and sums both calls' tokens
        ✓ research step meta-response retry loop > stops after the attempt cap and keeps the last response, as Python does
        ✓ isValidResearch > accepts the golden fixtures' research documents
        ✓ isValidResearch > rejects every refusal phrasing Python listed
        ✓ isValidResearch > rejects a clean response that covers fewer than two expected sections
        ✓ research step announcement > announces the stage on the event bus, in Python's payload shape
        ✓ research step announcement > commits the stage before it reports it complete, and not before it starts
        ✓ research step progress lines > writes Python's three lines when the first attempt validates
        ✓ research step progress lines > names the attempt only after the first, and warns on each failure
        ✓ research step progress lines > warns on the last attempt too, then reports the stage degraded
        ✓ research step progress lines > publishes each line, interleaved with the two announcements
        ✓ research step progress lines > carries Python's payload on a progress line and stores no data key
        Test Files  1 passed (1)
             Tests  16 passed (16)
        ```

        Changed assertions on the two files that run the real workflow, both real
        behaviour changes rather than test edits to force a pass:

        - `pipeline-events.test.ts`: `LOGGING_STAGES` gains `research`, the per-stage
          `log` count for `research` moves from 0 to 3, and the whole-trail assertion
          now interleaves three `log` entries between `research`'s two announcements.
          Three and not five because the stubbed response validates on the first
          attempt, so neither the failure line nor the degraded line is reached.
        - `failure-recorder.test.ts`: the failing run's trail gains `research`'s three
          lines ahead of `stage_complete/research`.

        Negative controls, each reverted after measuring, run over
        `research.test.ts`, `pipeline-events.test.ts` and `failure-recorder.test.ts`
        together (91 tests):

        | Control | Result |
        | --- | --- |
        | Drop the rules-loaded line | 9 failed, 82 passed |
        | Always name the attempt, dropping Python's ternary | 4 failed, 87 passed |
        | Skip the failure line on the final attempt | 1 failed, 90 passed |
        | Write the degraded line at `warning` instead of `error` | 1 failed, 15 passed (research only) |
        | Drop the received line | 8 failed, 83 passed |

        **Two pre-existing test flakes fixed on the way, both measured at HEAD before
        the change.** Neither is an assertion edit; both are test infrastructure.

        1. `stage-log.test.ts` and `pipeline-start.test.ts` both used post id
           `...0055d1`. vitest runs files in parallel, so each file's `beforeEach`
           delete raced the other's insert and the loser failed on `posts_pkey`.
           `stage-log.test.ts` moves to `...0055d3`, with the reason recorded beside
           the constant.
        2. `failure-recorder.test.ts`'s `waitForFailure()` returned as soon as
           `current_stage` read `failed`, but `recordRunFailure` writes the row,
           publishes, and only then appends the `stage_error` entry (item 5.5c-iii-a
           follows Python's order for that one pair). The snapshot could therefore
           predate the append. It now also waits for the entry to be present.

        Measured at HEAD, with this iteration's four files reverted:

        ```
        $ cd web && npx vitest run
        Test Files  3 failed | 90 passed (93)
             Tests  12 failed | 1629 passed | 7 skipped (1648)
        # 9 baseline (6 image-preview, 3 PostDetail) plus the three
        # failure-recorder trail assertions racing the append.
        ```

        Frontend gates:

        ```
        $ cd web && npx tsc --noEmit
        TSC EXIT=0

        $ cd web && npx eslint
        LINT EXIT=0

        $ cd web && npx vitest run
        Test Files  2 failed | 91 passed (93)
             Tests  9 failed | 1637 passed | 7 skipped (1653)
        # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
        # PostDetail.test.tsx, both pre-existing. Passing count 1632 -> 1637 (+5),
        # and the three failure-recorder races are gone.

        $ cd web && npx next build
        BUILD EXIT=0
        ✓ Compiled successfully in 4.3s

        $ cd api && uv run pytest -q
        120 failed, 241 passed, 25 errors in 15.15s

        $ cd api && uv run ruff check .
        Found 32 errors.

        $ cd api && uv run ruff format --check .
        9 files would be reformatted, 131 files already formatted
        ```

## 5.5c-iv-c


        **Correction to this item's own wording.** It said these seven "are the only
        ones in the six stages that carry `data`". They are not: none of them carries
        `data`, and the only three call sites in the six stages that do are all in
        `images`, which is 5.5c-iv-d. Measured:

        ```
        $ grep -rn 'data=' api/src/pipeline/stages/
        api/src/pipeline/stages/images.py:90:                data={"error": error_msg, "raw_snippet": raw_snippet},
        api/src/pipeline/stages/images.py:184:                        data={"index": i, "bytes": len(image_bytes), "path": image_url},
        api/src/pipeline/stages/images.py:200:                        data={"index": i, "error": str(e)},
        ```

        What is actually distinctive about `edit`'s seven is the level: four of them are
        `level="warning"`, where the other 21 non-`images` call sites are all the
        default `info`.

        The seven, from `api/src/pipeline/stages/edit.py`: the rules-loaded line at :36,
        the provider-call line at :48, the received line at :74, the stripped-links line
        at :91, and the three inside `_validate_edit_output` at :203, :224 and :239.
        Ported into `web/src/mastra/steps/edit.ts` at the same seven positions.

        **Decision 1: the four warnings move off `logger.warn` and onto the event bus.**
        Item 3.4e landed `editOutputWarnings()` returning its messages and the step
        sending them to `mastra.getLogger()?.warn`, with a comment saying the event bus
        that should carry them was item 5.5. This is that item, so the step now walks
        the same list and publishes each through `publishStageLog(..., {level:
        "warning"})`, and the stripped-links line goes the same way. Nothing is reported
        twice: a warning that still reached the logger would mean the stage reports the
        same problem in two places, so the four run-level tests that used to assert on
        the logger now assert the message is on the row and that the logger saw nothing.

        **Decision 2: `editOutputWarnings()` stays a pure function returning messages.**
        Python publishes from inside `_validate_edit_output`. Keeping the assembly
        separate from the publishing lets a test name an exact message without standing
        up a transport (`counts em-dashes in the output the way Python's str.count
        does` does exactly that), and the step preserves Python's order by walking the
        list in order. The three conditions and their order are the parity-relevant
        part, and they are unchanged.

        **Decision 3: `logger.exception` stays on the logger.** Python's link-validation
        failure branch calls `logger.exception("Link validation failed, skipping")`, not
        `publish_stage_log`. So a browser is told nothing when the link check itself
        could not run, and is told only about links that were actually removed. Kept, and
        asserted both ways: the logger gets exactly that one line, and no `Stripped`
        line is published.

        **Decision 4: `_validate_edit_output` keeps running before `validate_links`.**
        Python's order, and it is load-bearing rather than incidental: the quality
        warnings describe the model's own answer, dead links included, and stripping a
        link changes the `has_external_links` check they read. Pinned by asserting the
        stripped-links line is last and that a quality warning precedes it. This was
        found by a negative control that passed (see the table below), and the assertion
        exists because of it.

        **Decision 5: the em dash in the em-dash warning stays the literal character it
        has carried since item 3.4e.** The message is a wire contract, rendered into
        `debug-log-panel.tsx`, so its bytes matter. Item 5.5c-iv-b wrote `research`'s one
        such message as `\u2014` to keep the character out of source; `edit.ts` already
        held it literally from before that convention, alongside the same character in
        the `ACTION REQUIRED` prompt text, and rewriting either is churn this item does
        not need. Confirmed U+2014 on both sides:

        ```
        $ grep -n 'em-dash(es)' api/src/pipeline/stages/edit.py | head -1 | hexdump -C | grep -A1 'e2 80'
        00000030  7d 20 65 6d 2d 64 61 73  68 28 65 73 29 20 e2 80  |} em-dash(es) ..|
        00000040  94 20 73 68 6f 75 6c 64  20 62 65 20 7a 65 72 6f  |. should be zero|
        ```

        Python's own rendering of the seven distinct messages, for byte comparison
        against the stored entries below. **Every — in this item's pasted output is a
        transcription of the em dash character, which the commands actually printed and
        which this document may not otherwise contain.**

        ```
        $ cd api && uv run python -c '<the seven f-strings, with sample values>'
        'Rules loaded, building prompt...'
        'Calling Claude for editing + SEO polish...'
        'Received 5953 tokens in 0.0s'
        'Edit output contains 2 em-dash(es) — should be zero'
        'Flesch reading ease is 47.8 (target 60-70, still too hard to read)'
        'SEO checks still failing after edit: Keyword In Title, Has Internal Links'
        'Stripped 1 dead link(s): http://127.0.0.1:65436/gone'
        ```

        Failing before the implementation, with the new and updated tests in place and
        `web/src/mastra/steps/edit.ts` reverted to HEAD:

        ```
        $ npx vitest run src/mastra/steps/edit.test.ts src/mastra/pipeline-events.test.ts \
            src/mastra/workflows/pipeline.test.ts
         Test Files  3 failed (3)
              Tests  14 failed | 55 passed (69)
        ```

        A real stored trail, read off `posts.execution_logs` after the step ran against
        the real database with the real link validator over real sockets (the
        `strips a dead link over real sockets` test, dumped by a temporary failing
        assertion that was then removed). Five of the seven lines are here; the em-dash
        and Flesch branches are false for this content, which is what the separate
        `reports every quality problem` test is for:

        ```
        [
          { event: "stage_start", level: "info", message: "Starting edit...",
            stage: "edit", ts: "2026-08-22T00:51:48.813+00:00" },
          { event: "log", level: "info", message: "Rules loaded, building prompt...",
            stage: "edit", ts: "2026-08-22T00:51:48.813+00:00" },
          { event: "log", level: "info", message: "Calling Claude for editing + SEO polish...",
            stage: "edit", ts: "2026-08-22T00:51:48.813+00:00" },
          { event: "log", level: "info", message: "Received 5953 tokens in 0.0s",
            stage: "edit", ts: "2026-08-22T00:51:48.833+00:00" },
          { event: "log", level: "warning",
            message: "SEO checks still failing after edit: Keyword In Title, Keyword In First 100 Words, Keyword In H2, Has H2 Headings, Has Internal Links, Has Meta Description",
            stage: "edit", ts: "2026-08-22T00:51:48.833+00:00" },
          { event: "log", level: "warning",
            message: "Stripped 1 dead link(s): http://127.0.0.1:65436/gone",
            stage: "edit", ts: "2026-08-22T00:51:48.833+00:00" },
          { event: "stage_complete", level: "info", message: "Stage edit complete", stage: "edit",
            data: { cost_usd: 0.57333, duration_s: 0, model: "claude-opus-4-6",
                    tokens_in: 8457, tokens_out: 5953 }, ts: "2026-08-22T00:51:48.833+00:00" },
        ]
        ```

        And the matching published events, from the real Redis Streams run in
        `pipeline-events.test.ts`:

        ```
        { event: "log", level: "info", message: "Rules loaded, building prompt...",
          post_id: "00000000-0000-4000-8000-00000000055a", stage: "edit",
          timestamp: "2026-08-23T01:50:08.460+00:00" }
        { event: "log", level: "info", message: "Calling Claude for editing + SEO polish...",
          post_id: "00000000-0000-4000-8000-00000000055a", stage: "edit",
          timestamp: "2026-08-23T01:50:08.460+00:00" }
        { event: "log", level: "info", message: "Received 5953 tokens in 0.0s",
          post_id: "00000000-0000-4000-8000-00000000055a", stage: "edit",
          timestamp: "2026-08-23T01:50:08.460+00:00" }
        { event: "log", level: "warning",
          message: "SEO checks still failing after edit: Keyword In Title, Has Internal Links",
          post_id: "00000000-0000-4000-8000-00000000055a", stage: "edit",
          timestamp: "2026-08-23T01:50:08.460+00:00" }
        ```

        Negative controls, each run against
        `src/mastra/steps/edit.test.ts src/mastra/pipeline-events.test.ts
        src/mastra/workflows/pipeline.test.ts` (69 tests), or the first two only where
        marked (60 tests):

        | Control | Result |
        | --- | --- |
        | Ship it | 69 passed |
        | Drop the three `info` lines | 9 failed, 60 passed |
        | Drop the three quality-warning publishes | 8 failed, 61 passed |
        | Drop the stripped-links publish (2 files) | 1 failed, 59 passed |
        | Publish all four warnings at the default `info` level | 6 failed, 63 passed |
        | Run `editOutputWarnings` after `validateLinks`, on the stripped content (2 files) | 1 failed, 59 passed |

        The last control is the one that changed the shipped tests. It passed 60/60
        before the ordering assertion was added, so Python's "validate the answer, then
        the links" order was unpinned: the log came out in the wrong order and the
        warnings described post-strip content, and nothing noticed. The assertion in
        `strips a dead link over real sockets` (the stripped line is last, a quality
        warning precedes it) is what makes it fail.

        Test counts: `edit.test.ts` 15 -> 20, `pipeline-events.test.ts` 40 -> 40 (five
        assertions changed rather than added, because `edit`'s lines belong in the
        existing per-stage lists), and one assertion rewritten in each of
        `pipeline.test.ts`, `pipeline-completion.test.ts`, `rerun-completion.test.ts`
        and `concurrency.test.ts`. Across the six touched files, 98 -> 103.

        Behaviour changes, stated rather than smuggled in as test edits: the four
        `logger.warn` assertions in the run-level workflow tests now assert the same
        messages on `posts.execution_logs` and assert the logger is empty, because the
        destination changed by design; `pipeline-events.test.ts`'s per-stage line count
        for `edit` moves 0 -> 5 and its rerun trail gains five `log` entries.

        Gates:

        ```
        $ npx tsc --noEmit
        TSC EXIT=0
        (no output)

        $ npx eslint
        LINT EXIT=0
        (no output)

        $ npx vitest run
         Test Files  2 failed | 91 passed (93)
              Tests  9 failed | 1642 passed | 7 skipped (1658)
        # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
        # PostDetail.test.tsx, both pre-existing. Passing count 1637 -> 1642 (+5).
        # 1637 is HEAD measured now, not the 1632 pasted under 5.5c-iv-b: that entry's
        # gate output was captured before its own last tests were added.

        $ npx next build
        BUILD EXIT=0
        v Compiled successfully in 4.1s
        # The first full vitest run of this pair hit the known scaffold-check.test.ts
        # flake (3 failed files, 12 skipped, 1637 passed). Rerunning gave the numbers
        # above, which is the same pattern recorded under 5.5c-iii-b-1.

        $ cd api && uv run pytest -q
        120 failed, 241 passed, 25 errors in 15.17s

        $ cd api && uv run ruff check .
        Found 32 errors.

        $ cd api && uv run ruff format --check .
        9 files would be reformatted, 131 files already formatted
        ```

## 5.5c-iv-d


        Split, because the seven do not sit in one step and the two halves have
        different problems. Five of them are inside `images_node` before the fan-out and
        are a straight transcription like `outline`'s; the remaining two are inside
        `_generate_one`, publish under event names that are not `log`
        (`image_generated` / `image_failed`), and have to decide which of
        `generateOneImage`'s three outcomes they belong to from outside a function that
        never throws:

        ```
        $ grep -n "await publish_stage_log(" api/src/pipeline/stages/images.py
        55:        await publish_stage_log("Rules loaded, building prompt...", stage="images")
        59:        await publish_stage_log("Calling Claude for image manifest...", stage="images")
        74:        await publish_stage_log(
        85:            await publish_stage_log(
        111:        await publish_stage_log(
        180:                    await publish_stage_log(
        195:                    await publish_stage_log(
        ```

        ```
        $ awk 'NR>=125 && NR<=207' api/src/pipeline/stages/images.py | grep -c "publish_stage_log"
        2
        ```

## 5.5c-iv-d-1


          Four are info lines on the happy path and the fifth, the parse-failure warning,
          takes the place of the fourth. Rendered by Python itself:

          ```
          $ cd api && uv run python -c "
          tokens_out=3037
          num_images=5
          error_msg='Failed to parse manifest'
          print(repr('Rules loaded, building prompt...'))
          print(repr('Calling Claude for image manifest...'))
          print(repr(f'Manifest received ({tokens_out} tokens)'))
          print(repr(f'Manifest parse failed: {error_msg}'))
          print(repr(f'Generating {num_images} images via Gemini...'))
          "
          'Rules loaded, building prompt...'
          'Calling Claude for image manifest...'
          'Manifest received (3037 tokens)'
          'Manifest parse failed: Failed to parse manifest'
          'Generating 5 images via Gemini...'
          ```

          **Decision 1: the "Generating N images" line stays in the manifest step, not in
          the workflow's `.map()`.** Python computes `num_images = len(manifest.get("images",
          []))` at `images.py:110` and publishes one statement later, *before* it creates
          the media directory and constructs `GeminiClient`. Those last two are the port's
          `.map()` (`workflows/images.ts:85`), so the two candidate homes are the end of
          `images-manifest` and the top of the `.map()`. The manifest step wins on three
          counts: the line is about the manifest the step just parsed rather than about
          the fan-out, the count is derived from the same `images` array the step already
          returns so the line and the output cannot disagree, and `.map()`'s callback is
          not handed `mastra`, so publishing from there would need a transport imported
          rather than passed. Relative order against everything observable is unchanged,
          because nothing between the two positions publishes or writes.

          **Decision 2: the parse-failure notice moves off the logger and onto the event
          bus.** It was `mastra.getLogger()?.warn(...)` from item 3.5f-i. Python never
          logged it; it published it, at `level="warning"` with two `data` keys. This is
          the same correction item 5.5c-iv-c made to `edit`'s four quality warnings, and
          it has the same consequence: a browser watching a run now hears that the
          manifest could not be parsed, where before only the server log did.

          **Decision 3: `data.error` carries the raw JSON value, the message carries
          `String()` of it.** Python's `data={"error": error_msg, ...}` stores the value
          `manifest["error"]` unchanged while the f-string applies `str()` to it. Both are
          reproduced literally. `String()` is not `str()` for a truthy container
          (`{'a': 1}` against `[object Object]`), and that divergence is reachable because
          `pythonTruthy` deliberately admits a non-empty dict or list here. It is recorded
          in `todo.md` rather than fixed: a faithful `str()` for arbitrary JSON is its own
          port, and the value the column and the payload carry is correct either way.

          **Decision 4: `Manifest received` is published before the parse, not after.**
          That is Python's position (`images.py:74`, ahead of `_parse_manifest` at 80), and
          it is load bearing rather than incidental: a manifest that turns out to be prose
          has still been paid for, so the line that reports what it cost has to go out
          before the line that reports it was unusable. Negative control NC5 below moves it
          after the parse and fails.

          One consequence of item 5.5c-iv-a's deletion of Python's module-level event
          context applies with extra force here: the fan-out's per-image lines
          (5.5c-iv-d-2) are still unported, so a run currently reports four lines for
          `images` and no per-image progress at all. That is the item split, not a gap in
          this one.

          Before the implementation, with the tests written and the five call sites absent
          (this is negative control NC1, which doubles as the pre-implementation state):

          ```
          $ git checkout HEAD -- web/src/mastra/steps/images-manifest.ts
          $ cd web && npx vitest run src/mastra/steps/images-manifest.test.ts \
              src/mastra/pipeline-events.test.ts src/mastra/workflows/images.test.ts \
              src/mastra/workflows/images-retry.test.ts \
              src/mastra/steps/images-retry-entry.test.ts
          Test Files  5 failed (5)
               Tests  11 failed | 81 passed (92)
          ```

          After, the same five files:

          ```
          $ cd web && npx vitest run src/mastra/steps/images-manifest.test.ts \
              src/mastra/pipeline-events.test.ts src/mastra/workflows/images.test.ts \
              src/mastra/workflows/images-retry.test.ts \
              src/mastra/steps/images-retry-entry.test.ts
          Test Files  5 passed (5)
               Tests  92 passed (92)
          ```

          The real published events and the real stored entries for the first golden
          fixture, dumped from a throwaway probe against the live database and then
          removed (`expect({...}).toEqual({})`, the technique item 5.5c-iv-a recorded):

          ```
          + "announced": [
          +   { "event": "stage_start", "message": "Starting images...",
          +     "post_id": "00000000-0000-4000-8000-000000000f11", "stage": "images" },
          +   { "event": "log", "level": "info",
          +     "message": "Rules loaded, building prompt...",
          +     "post_id": "00000000-0000-4000-8000-000000000f11", "stage": "images",
          +     "timestamp": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Calling Claude for image manifest...",
          +     "post_id": "00000000-0000-4000-8000-000000000f11", "stage": "images",
          +     "timestamp": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Manifest received (3037 tokens)",
          +     "post_id": "00000000-0000-4000-8000-000000000f11", "stage": "images",
          +     "timestamp": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Generating 5 images via Gemini...",
          +     "post_id": "00000000-0000-4000-8000-000000000f11", "stage": "images",
          +     "timestamp": "2026-08-22T00:52:57.065+00:00" },
          + ],
          + "stored": [
          +   { "event": "stage_start", "level": "info", "message": "Starting images...",
          +     "stage": "images", "ts": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Rules loaded, building prompt...",
          +     "stage": "images", "ts": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Calling Claude for image manifest...",
          +     "stage": "images", "ts": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Manifest received (3037 tokens)",
          +     "stage": "images", "ts": "2026-08-22T00:52:57.065+00:00" },
          +   { "event": "log", "level": "info",
          +     "message": "Generating 5 images via Gemini...",
          +     "stage": "images", "ts": "2026-08-22T00:52:57.065+00:00" },
          + ]
          ```

          The clock is the fixture's frozen `captured_at`, which is why all five stamps
          agree; the offset form is Python's `isoformat()`, per item 5.5c-i.

          Negative controls, each run against the same five files (baseline
          `5 passed / 92 passed`):

          | Control | Result |
          | --- | --- |
          | NC1: all five call sites removed (implementation at HEAD) | 5 files failed, 11 tests failed |
          | NC2: `Manifest received` reports `inputTokens` instead of `outputTokens` | 3 files failed, 7 tests failed |
          | NC3: `Generating N images` published before the parse-failure branch | 2 files failed, 2 tests failed |
          | NC4: parse-failure notice left on `getLogger().warn` | 2 files failed, 2 tests failed |
          | NC5: `Manifest received` published after the parse instead of before | 2 files failed, 2 tests failed |
          | NC6: only the `Generating N images` line removed | 2 files failed, 7 tests failed |

          NC3, NC4 and NC5 each fail only two tests, and that is the point of having all
          three: the parse-failure branch is reached by exactly two assertions (the
          fixture-driven one in `images-manifest.test.ts` and the real nested run in
          `workflows/images.test.ts`), so three different ways of getting that branch
          wrong are individually pinned rather than jointly.

          Tests added, all against the real Alembic-owned database:

          - `web/src/mastra/steps/images-manifest.test.ts`, five new: the four lines in
            order on both the event bus and the row, the two interpolations pinned against
            the *second* fixture so neither is asserted twice from one set of numbers, the
            interleaving with `stage_start`, Python's five payload keys with no `data` key,
            and a skipped stage writing nothing at all.
          - The same file's parse-failure test rewritten from a logger assertion to a
            published-event assertion, including the three lines that precede the warning.
          - `web/src/mastra/workflows/images.test.ts`'s real unparseable-manifest run now
            asserts the whole stored `log` trail and that the logger saw nothing.
          - `web/src/mastra/pipeline-events.test.ts`: `LOG_LINES_PER_STAGE.images` 0 to 4,
            `messagesFor("images")`, and the per-stage delivery count.
          - `web/src/mastra/workflows/images-retry.test.ts` and
            `web/src/mastra/steps/images-retry-entry.test.ts`: the failing-attempt trails
            gain the two lines an attempt reaches before the agent throws.

          Frontend gates:

          ```
          $ npx tsc --noEmit
          TSC EXIT=0

          $ npx eslint .
          LINT EXIT=0

          $ npx vitest run
          Test Files  2 failed | 91 passed (93)
               Tests  9 failed | 1647 passed | 7 skipped (1663)
          # The 9 are the Phase 0 baseline (3 in PostDetail.test.tsx, 6 in
          # image-preview.test.tsx). HEAD measured immediately before, by reverting all
          # six changed files: 9 failed | 1642 passed | 7 skipped (1658), so this item is
          # exactly +5 tests and no new failures.

          $ npx next build
          BUILD EXIT=0
          v Compiled successfully in 4.0s
          ```

          Python gates, unchanged because nothing under `api/` was touched:

          ```
          $ cd api && uv run pytest -q
          120 failed, 241 passed, 25 errors in 15.13s

          $ cd api && uv run ruff check .
          Found 32 errors.

          $ cd api && uv run ruff format --check .
          9 files would be reformatted, 131 files already formatted
          ```

## 5.5c-iv-d-2


          The design question this half has and the first half did not:
          `generateOneImage` never throws and returns the same `{spec, usage}` shape for
          all three of Python's outcomes (generated, provider/optimizer failure, and the
          no-prompt short circuit that publishes nothing). Deciding which of the two lines
          to publish by inspecting the returned spec is an inference that a provider error
          whose message happened to be `"no prompt"` would defeat. The likely shape is a
          publish callback or an explicit outcome discriminant on the return; pick one,
          argue the other down, and check `use-sse.ts` and `debug-log-panel.tsx` for what
          they already do with the two event names before choosing the payload.

          **The design question, answered: an outcome discriminant on the return.**
          `generateOneImage` now returns `outcome`, a three-member discriminated union
          (`{kind: "generated", bytes, url}` / `{kind: "failed", error}` /
          `{kind: "no-prompt"}`), and `imagesGenerateStep` publishes off it. The two
          values each line interpolates ride on the discriminant rather than being read
          back off the entry, so the message a browser sees and the manifest the
          dashboard renders cannot drift.

          The publish callback is argued down on three counts. It would put an `await` on
          a transport inside the one function whose oracle is a pure data fixture
          (`images/data/image-generation-parity.json`), so all 40 of `generate-one.test.ts`'s
          parity assertions would have to carry a stub they do not otherwise need. It
          would put pipeline I/O outside a Mastra primitive, where the structural rule in
          section 2 of the objective puts it inside one. And the only thing it buys,
          publishing one statement earlier, is unobservable: nothing runs between
          `generateOneImage`'s return and the step's publish. The one place it is *not*
          unobservable is recorded as a deviation below.

          **What `use-sse.ts` and `debug-log-panel.tsx` do with the two names: nothing.**
          `NAMED_EVENTS` in `web/src/hooks/use-sse.ts` lists eight names and neither of
          these is among them, so `EventSource` drops both today exactly as it dropped
          Python's. That is not a defect this item introduces or fixes: the port
          reproduces what Python published, and whether the hook should listen for two
          more names is item 5.5d's contract question. Logged in `todo.md`.

          ```
          $ grep -n "image_generated\|image_failed" web/src/hooks/use-sse.ts \
              web/src/components/debug-log-panel.tsx; echo "exit $?"
          exit 1
          ```

          Python's rendering of both messages, the adjacent logger line, and both `data`
          dicts, with the values `workflows/images.test.ts`'s real runs produce:

          ```
          $ python3 -c "
          i = 0; image_bytes = b'x' * 232
          image_url = '/media/00000000-0000-4000-8000-0000000000f3/shot-0.webp'
          print(repr(f'Image {i} generated ({len(image_bytes)} bytes)'))
          print(repr({'index': i, 'bytes': len(image_bytes), 'path': image_url}))
          i = 2; e = Exception('no prompt')
          print(repr(f'Image {i} failed: {e}'))
          print(repr(f'Failed to generate image {i}: {e}'))
          print(repr({'index': i, 'error': str(e)}))"
          'Image 0 generated (232 bytes)'
          {'index': 0, 'bytes': 232, 'path': '/media/00000000-0000-4000-8000-0000000000f3/shot-0.webp'}
          'Image 2 failed: no prompt'
          'Failed to generate image 2: no prompt'
          {'index': 2, 'error': 'no prompt'}
          ```

          **Recorded decisions.**

          1. **`logger.error` stays, beside the publish.** Python ran both from the same
             `except` (`api/src/pipeline/stages/images.py:191-201`). Items 5.5c-iv-c and
             5.5c-iv-d-1 moved lines *off* the logger, and this is deliberately the
             opposite call: those were lines Python only ever published and the port had
             wrongly logged, where this one Python both logged and published, and the two
             have different readers (an operator tailing the worker, and a browser).
          2. **The no-prompt branch publishes nothing.** Python returns from it before the
             semaphore and before either call, so an entry the model gave no prompt leaves
             no trace on the bus or on the row. Pinned by an assertion that the trail
             contains no entry for that index, not just by a count.
          3. **The entry is filed under `stage: "images"`.** Same reason as
             5.5c-iii-b-2-b-ii: both `execution_logs` readers group on `stage`, and Python
             passed `stage="images"` from inside the fan-out.
          4. **The discriminant is on the step's output schema, not just its local
             variable.** The fan-out's output is persisted in the workflow snapshot, and
             `imagesAssembleStep` parses it back; leaving `outcome` off the schema would
             have made the step's declared output disagree with what it returns.

          **Recorded deviation.** Python's success publish sits *inside* the same `try`
          that catches provider errors, so a dead Redis there turned a generated image
          into a stored failure and then raised out of the failure publish. Here the
          publish is one statement outside `generateOneImage`, so a dead Redis fails the
          step and the engine retries it under `imagesWorkflow.retryConfig`. The port's
          behaviour is the better one and the divergence is confined to a
          transport-failure path.

          Pre-implementation, with the tests written and the implementation absent:

          ```
          $ cd web && npx vitest run src/mastra/images/generate-one.test.ts \
              src/mastra/steps/images-generate.test.ts
           Test Files  2 failed (2)
                Tests  11 failed | 40 passed (51)
          ```

          Those 11 are exactly the 11 new assertions: 4 in `generate-one.test.ts` on the
          discriminant and 7 in `images-generate.test.ts` on the two lines.

          The real five-image run in `workflows/images.test.ts`, read back off
          `posts.execution_logs` (the row is written by the process that publishes, so it
          cannot race the assertion; `.foreach()` appends in completion order, so the
          entries are sorted by the index each carries):

          ```
          $ pnpm -C web exec vitest run --reporter=verbose src/mastra/workflows/images.test.ts
           ✓ publishes one `image_generated` per entry, on the row, in manifest order
           ✓ publishes `image_failed` for a provider error that reads like the short circuit
           Test Files  1 passed (1)
                Tests  10 passed (10)
          ```

          The second of those is the inference control, run against the real evented
          engine rather than argued about: one entry's Gemini call fails with the message
          `"no prompt"`, so the stored entry is byte-identical to a short circuit
          (`generated: false`, `error: "no prompt"`, no `usage`), and the run still
          records `Image 2 failed: no prompt` at level `error` plus the four
          `image_generated` lines.

          Negative controls, each applied alone and reverted:

          | Control | Result |
          | --- | --- |
          | Drop the `no-prompt` early return, so the short circuit publishes too | 4 failed |
          | Drop Python's adjacent `logger.error` line | 1 failed |
          | Publish both lines under the default `log` event name | 6 failed |
          | Send the failure line at the default `info` level | 2 failed |
          | Infer the branch from the returned entry instead of the discriminant | 1 failed |
          | Rename the `path` data key to `url` | 3 failed |

          The inference control failing exactly one test is the point of the misleading-error
          run: it is the only assertion in the suite that can tell the discriminant from a
          plausible re-derivation, and without it the whole design decision would have been
          unpinned.

          Frontend gates. HEAD measured by reverting every changed file first: 1663 tests,
          1645 passed, 11 failed, which is the 9 known plus two flakes
          (`pipeline-events > carries Python's log payload and nothing else`, an instance
          of the `received`-ordering defect already recorded in `todo.md`, and
          `scaffold-check > emits the workflow lifecycle events the trace view will read`,
          likewise recorded). This change adds 15 tests and leaves the 9 known failures
          untouched. The full suite was run three times here and reported 9, 10 and 9
          failures; the varying one is a flake, and the 9-failure runs are the baseline
          set exactly:

          ```
          $ pnpm -C web exec tsc --noEmit
          exit 0

          $ pnpm -C web lint
          > content-pipeline-dashboard@0.1.0 lint
          > eslint
          exit 0

          $ pnpm -C web test
           FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage logs when present
           FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage tabs
           FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > shows Run Next and Run All buttons when not running or complete
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays alt text
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays image with filename
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays placement info
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays prompt text
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays style metadata
           FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > renders image cards from manifest
           Test Files  2 failed | 91 passed (93)
                Tests  9 failed | 1662 passed | 7 skipped (1678)

          $ pnpm -C web build
          exit 0
          ```

          Those 9 are the Phase 0 baseline: 6 in `image-preview.test.tsx` and 3 in
          `PostDetail.test.tsx`.

          Python gates, unchanged because nothing under `api/` was touched:

          ```
          $ cd api && uv run pytest -q
          120 failed, 241 passed, 25 errors in 15.02s

          $ cd api && uv run ruff check .
          Found 32 errors.

          $ cd api && uv run ruff format --check .
          9 files would be reformatted, 131 files already formatted
          ```

## 5.5d


    Split, because the two endpoints share a generator in Python but not a
    security question in TypeScript. Both call `_subscribe_and_stream()`, and neither
    Python handler authenticated anything: `post_events()` took `post_id: str` and
    `global_events()` took no parameter at all, so any caller received any post's feed
    or every post's feed. Phase 5's multi-tenancy rule closes that, and the two
    endpoints close it differently. The per-post one resolves ownership once, before
    the stream opens, with the same inner join every other `{post_id}` handler uses.
    The global one cannot: it has no single post to check, its feed spans posts the
    caller may create after connecting, and an ownership lookup per delivered event is
    a design decision rather than a transcription. So 5.5d-i is the per-post endpoint
    plus the framing and subscription machinery both share, and 5.5d-ii is the global
    endpoint and its per-event scoping.

## 5.5d-i


      Ported to `web/src/app/api/events/[post_id]/route.ts`, with
      `web/src/app/api/events/sse.ts` (the wire format `sse_starlette` used to write)
      and `web/src/app/api/events/stream.ts` (the port of `_subscribe_and_stream()`,
      the generator both Python endpoints shared).

      **Deviation 1, deliberate: the endpoint is authenticated and ownership-scoped,
      and the Python one was not.** `post_events()` took `post_id: str`, declared no
      session dependency and did no lookup, so any caller who knew or guessed a post id
      received that post's live feed, which carries stage messages, model names and
      per-stage token counts. Phase 5's rule is that a handler which can read another
      user's post is a defect rather than a follow-up, so this resolves ownership with
      the same inner join to `website_profiles` every other `{post_id}` handler uses,
      before the stream opens. `EventSource` cannot set headers but does send
      same-origin cookies, so the BetterAuth session `use-sse.ts` already carries is
      what authenticates it and the hook needed no change.

      **Deviation 2, a consequence of the first: a malformed id is now a 422.** Python
      typed the parameter `str`, so `/api/events/not-a-uuid` opened a stream on
      `pipeline:post:not-a-uuid`, a channel nothing ever published to, and the browser
      sat on an empty connection. Resolving ownership means comparing against a uuid
      column, so the id is validated with the shared `isUuid()` / `unprocessableUuid()`
      pair instead of reaching Postgres and raising.

      **Deviation 3: the keepalive comment carries an ISO 8601 timestamp.**
      `EventSourceResponse._ping()` interpolated `datetime.now(timezone.utc)`, whose
      `str()` is `2026-08-22 12:34:56.789012+00:00`. The frame is an SSE comment, which
      `EventSource` discards before any listener runs, so neither spelling is
      observable to `use-sse.ts`; the 15s interval is the part that matters and it is
      preserved.

      **What the transport swap forced, read off the installed package rather than
      assumed.** `RedisStreamsPubSub.subscribe()` anchors a newly created consumer group
      at `0` unless told otherwise, and `SubscribeOptions.startFrom` documents that
      default:

      ```
      $ grep -n "startFrom" web/node_modules/@mastra/core/dist/events/types.d.ts
      84:    startFrom?: 'earliest' | 'latest';

      $ grep -n "groupAnchor = options" web/node_modules/@mastra/redis-streams/dist/index.js
      164:		const groupAnchor = options?.startFrom === "latest" ? "$" : "0";
      ```

      Left at the default, a browser connecting mid-run would be handed the whole
      retained stream (`maxStreamLength` defaults to 10000) as if it were live, where
      Python's `PUBLISH` retained nothing and a connection saw only what arrived after
      it. Replay is item 5.5e and has to be asked for, so this subscribes with
      `startFrom: "latest"`.

      The second forced behaviour is that every delivery is acked, including the ones
      the `post_id` filter drops. Nothing acks on a subscriber's behalf:

      ```
      $ sed -n '557,565p' web/node_modules/@mastra/redis-streams/dist/index.js
      		try {
      			const result = sub.cb(event, ack, nack);
      			if (result && typeof result.catch === "function") result.catch(async () => {
      				await nack();
      			});
      		} catch {
      			await nack();
      		}
      	}
      ```

      An unacked entry stays in the group's pending list for the life of the
      subscription, so a dashboard left open for a day would accumulate one entry per
      event published installation-wide. The filtered-out ones are the leak, because
      nothing writes them to the client and so nothing acks them as a side effect.

      **One subscription per request, matching `redis.pubsub()` per request.** Each
      `subscribe()` opens its own Redis connection and creates a private
      `__fanout-<uuid>` consumer group, and `unsubscribe()` is what quits the one and
      destroys the other, so teardown is wired to `request.signal` (Python's
      `await request.is_disconnected()` poll) and to the stream's `cancel()`. A
      process-wide subscription fanned out in memory would be one connection instead of
      one per browser, but it is a different design from the one Python had and nothing
      here needs it yet; the leak it would avoid is closed by the teardown, proven by
      its own test.

      **Not deviations, deliberately preserved.** `data:` carries the whole published
      payload including `event` and `post_id`, which is what `json.dumps(parsed)` sent
      and what `use-sse.ts` parses. A payload with no `event` key is named `update`,
      which is `parsed.get("event", "update")`. Frames are separated by `\r\n`, which
      is `EventSourceResponse.DEFAULT_SEPARATOR`, and the four response headers
      (`Content-Type` with Starlette's appended charset, `Cache-Control: no-store`,
      `Connection: keep-alive`, `X-Accel-Buffering: no`) are the ones that class set.

      `web/src/lib/api.ts` needed no change: `sseUrl.post()` already points at
      `/api/events/{id}` and the hook's `NAMED_EVENTS` list is unchanged.

      Pre-implementation state, measured by moving the three new source files aside:

      ```
      $ pnpm -C web vitest run src/app/api/events/events.test.ts
      Error: Cannot find module './[post_id]/route' imported from
      '.../web/src/app/api/events/events.test.ts'
       Test Files  1 failed (1)
            Tests  no tests
      ```

      Negative controls, each applied alone and reverted, against the 16 tests:

      | Control | Result |
      | --- | --- |
      | NC1: `startFrom: "latest"` dropped, so a new group anchors at `0` | 1 failed |
      | NC2: deliveries left unacked | 1 failed |
      | NC3: ownership check removed, matching Python's unauthenticated handler | 3 failed |
      | NC4: frames separated by `\n` instead of `\r\n` | 1 failed |
      | NC5: `post_id` filter dropped, so every post's events are forwarded | 1 failed |
      | NC6: teardown leaves the subscription open | 1 failed |
      | NC7: no `update` fallback for a payload with no event name | 1 failed |
      | NC8: subscriptions share one consumer group, so deliveries round-robin | 4 failed |

      NC4 failing exactly one test is the point of asserting on raw bytes once: the
      frame parser in the test reads the same `SSE_SEPARATOR` constant, so every other
      assertion stays green when the separator changes and only the byte-exact
      comparison notices. NC8 is the control that pins why the subscription takes no
      `group`: a shared group makes two browsers watching one post compete for its
      events, and each would see roughly half a run.

      The 16 tests run against the real database, real BetterAuth sessions and the real
      Redis Streams topic, with every asserted event published by a second
      `RedisStreamsPubSub` client so a frame that reaches the response body provably
      travelled through Redis rather than an in-process emitter:

      ```
      $ pnpm -C web vitest run src/app/api/events/events.test.ts --reporter=verbose
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > rejects an unauthenticated request 255ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > answers a malformed path uuid with FastAPI's 422 266ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > answers a post that does not exist with a 404 258ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > answers another user's post with the same 404, opening no stream 261ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > answers a post whose profile_id is null with a 404 261ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > answers an owned post with sse_starlette's four response headers 1271ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > delivers a published event as one CRLF-framed named frame 1318ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > carries the whole published payload in data, event name and post_id included 1345ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > delivers every event name useSSE() listens for, in publication order 1340ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > ignores events for other posts 1329ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > names an event with no `event` key `update`, as parsed.get('event', 'update') did 1326ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > drops an event carrying no post_id rather than broadcasting it 1353ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > does not replay events published before the connection opened 1328ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > fans out to two concurrent readers of the same post instead of round-robining 2352ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > destroys its consumer group and stops delivering once the client disconnects 1829ms
 ✓ src/app/api/events/events.test.ts > GET /api/events/{post_id} > acknowledges every delivery, so a long-lived reader accumulates no pending entries 1332ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
   Duration  18.40s (transform 157ms, setup 85ms, import 798ms, tests 17.45s, environment 0ms)
      ```

      Frontend gates:

      ```
      $ pnpm -C web tsc --noEmit
      (no output, exit 0)

      $ pnpm -C web lint
      (no output, exit 0)

      $ pnpm -C web test
       Test Files  3 failed | 91 passed (94)
            Tests  10 failed | 1677 passed | 7 skipped (1694)
      ```

      The ten are the nine already recorded plus one known flake, and no file touched
      here appears among them: six in `src/components/__tests__/image-preview.test.tsx`,
      three in `src/app/posts/PostDetail.test.tsx`, and
      `scaffold-check > emits the workflow lifecycle events the trace view will read`,
      the flake `todo.md` records.

      ```
      $ pnpm -C web build
      ✓ Compiled successfully in 4.1s
      ✓ Generating static pages using 15 workers (35/35) in 313.4ms
      ├ ƒ /api/events/[post_id]
      ```

      Python gates, unchanged from the recorded baseline:

      ```
      $ cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.05s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.5d-ii


      `web/src/app/api/events/route.ts` ports `global_events()`, with the scoping
      decision in `web/src/app/api/events/scope.ts` and one change to the shared
      `stream.ts` that the scoping forces.

      **The design question this item was split out for: what does "the caller's own
      posts" mean for a feed that has no post id?** The per-post endpoint resolves
      ownership once, before the stream opens, because it has exactly one row to check.
      This one has none. Three shapes were considered and two rejected:

      - *A snapshot of owned post ids taken at connect time.* One query per connection,
        no per-event cost, and wrong for the endpoint's main consumer:
        `global-notifications.tsx` and the monitor's overview tab open this feed on
        mount and the posts they are waiting to hear about are frequently created
        afterwards. A snapshot silently never delivers those. Rejected.
      - *An ownership query per delivered event.* Correct and always fresh, and it puts
        a database round trip on the hot path of a feed that carries tens of events per
        run per post, for an answer that changes approximately never. Rejected.
      - *Adopted: resolve per post id, lazily, memoised for the life of the
        connection.* One query per distinct post a connection hears about, not one per
        event, and a post created after the connection opened resolves on its first
        event like any other. Concurrent events for the same unseen post share one
        in-flight query because the promise is cached rather than its result.

      **Deviation 1, and the reason this endpoint needed a decision at all: it is
      authenticated and scoped, and the Python one was neither.** `global_events()`
      took no parameters and no session dependency, subscribed every caller to
      `pipeline:global`, and forwarded the channel verbatim, so one tenant's dashboard
      received every other tenant's stage messages, model names and error text. This is
      the same deviation recorded under 5.5d-i for the per-post endpoint, applied to the
      endpoint where it actually leaks everything rather than one guessed id.

      **Deviation 2, the cost of memoising: a negative answer is remembered too.** A
      post whose profile is reassigned to the caller mid-connection stays invisible
      until the browser reconnects. Re-querying only the negatives would make an
      unowned run more expensive than an owned one, which is the wrong way round, and
      `useSSE()` reconnects on any transport error and on every page load. The
      behaviour is asserted rather than left implicit, including the reconnect that
      picks the reassignment up.

      **`stream.ts` change: deliveries are now considered one at a time.** Reading the
      installed transport rather than assuming, `RedisStreamsPubSub` invokes a
      subscriber and does not await what it returns:

      ```
      $ sed -n '556,563p' web/node_modules/@mastra/redis-streams/dist/index.js
              try {
                      const result = sub.cb(event, ack, nack);
                      if (result && typeof result.catch === "function") result.catch(async () => {
                              await nack();
                      });
              } catch {
                      await nack();
              }
      ```

      So two events whose `matches` calls take different amounts of time race, and the
      cached one overtakes the one waiting on Postgres. That is invisible while
      `matches` is synchronous, which is all 5.5d-i needed, and becomes a real
      reordering the moment a predicate asks the database. Every delivery is now chained
      onto the previous one, the link added synchronously inside the turn the transport
      called the listener in, so the chain is built in delivery order. A `matches` that
      rejects is swallowed on the chain rather than left to stall every event behind it,
      and the event it concerns is not sent: fail closed is the right answer for a
      predicate deciding who may see what. The scope memo drops itself on a rejected
      lookup so a transient database error is retried on the next event rather than
      cached as a decision.

      The three cases the per-post endpoint answers with a 404 are the three this one
      silently drops, because it shares `ownedByCaller()` from 5.3c-ii: a post that does
      not exist, a post owned by someone else, and a post whose `profile_id` is null.

      The twelve new tests join the sixteen from 5.5d-i in
      `web/src/app/api/events/events.test.ts`, against the real database, real
      BetterAuth sessions and the real Redis Streams topic, with every asserted event
      published by a separate `RedisStreamsPubSub` client:

      ```
      $ pnpm -C web vitest run src/app/api/events/events.test.ts --reporter=verbose
       v GET /api/events > rejects an unauthenticated request 251ms
       v GET /api/events > opens with the same four response headers as the per-post stream 1271ms
       v GET /api/events > delivers events for every post the caller owns, not just one 1330ms
       v GET /api/events > drops another user's events, which global_events() broadcast to everyone 1323ms
       v GET /api/events > drops an event for a post that no longer exists 1332ms
       v GET /api/events > drops an event for a post whose profile_id is null, as the inner join did 1336ms
       v GET /api/events > delivers events for a post created after the connection opened 1340ms
       v GET /api/events > preserves publication order across posts whose ownership is not yet resolved 1329ms
       v GET /api/events > remembers an ownership answer instead of re-querying per event 1333ms
       v GET /api/events > remembers a negative answer too, so a mid-connection reassignment needs a reconnect 2436ms
       v GET /api/events > acknowledges deliveries it drops, so an unowned run leaks no pending entries 1317ms
       v GET /api/events > scopes two concurrent callers to their own posts on the same topic 2352ms
       Test Files  1 passed (1)
            Tests  28 passed (28)
         Start at  22:21:56
         Duration  35.30s (transform 167ms, setup 85ms, import 821ms, tests 34.33s, environment 0ms)
      ```

      Two of those need saying out loud, because they assert a property through its
      consequence rather than by counting queries, which would have meant mocking the
      database:

      - "remembers an ownership answer instead of re-querying per event" deletes the
        post row after its first event has been delivered and asserts the second event
        still arrives. A lookup per event would start dropping the feed there.
      - "preserves publication order" publishes two rounds across three owned posts, so
        each post's first event pays for a lookup and its second reads the memo. Without
        the delivery chain the three cached events overtake the three uncached ones.

      Negative controls, each reverted after measuring:

      ```
      # 1. drop the scoping: pipelineEventStream(request, () => true), which is what
      #    Python did
      Tests  5 failed | 23 passed (28)
        x drops another user's events, which global_events() broadcast to everyone
        x drops an event for a post that no longer exists
        x drops an event for a post whose profile_id is null, as the inner join did
        x remembers a negative answer too, so a mid-connection reassignment needs a reconnect
        x scopes two concurrent callers to their own posts on the same topic

      # 2. drop the delivery chain in stream.ts: await matches() inline as 5.5d-i did
      Tests  1 failed | 27 passed (28)
        x preserves publication order across posts whose ownership is not yet resolved

      # 3. drop the memo read in scope.ts, so every event queries
      Tests  2 failed | 26 passed (28)
        x remembers an ownership answer instead of re-querying per event
        x remembers a negative answer too, so a mid-connection reassignment needs a reconnect

      # 4. resolve ownership with eq(posts.id, id) instead of ownedByCaller(id, userId)
      Tests  4 failed | 24 passed (28)
        x drops another user's events, which global_events() broadcast to everyone
        x drops an event for a post whose profile_id is null, as the inner join did
        x remembers a negative answer too, so a mid-connection reassignment needs a reconnect
        x scopes two concurrent callers to their own posts on the same topic

      # 5. serve an unauthenticated caller the unfiltered feed instead of a 401
      Tests  1 failed | 27 passed (28)
        x rejects an unauthenticated request

      # 6. ack only the deliveries that produced a frame
      Tests  2 failed | 26 passed (28)
        x acknowledges every delivery, so a long-lived reader accumulates no pending entries
        x acknowledges deliveries it drops, so an unowned run leaks no pending entries
      ```

      Control 6 also re-proves the 5.5d-i ack test, which is the point: a global feed
      drops far more deliveries than a per-post one, so an unacked drop accumulates a
      pending entry per event published installation-wide.

      Frontend gates:

      ```
      $ pnpm -C web tsc --noEmit
      TSC EXIT=0
      (no output)

      $ pnpm -C web lint
      LINT EXIT=0
      (no output)

      $ pnpm -C web test
       Test Files  2 failed | 92 passed (94)
            Tests  9 failed | 1690 passed | 7 skipped (1706)
      ```

      Nine failed is the recorded baseline: six in
      `src/components/__tests__/image-preview.test.tsx` and three in
      `src/app/posts/PostDetail.test.tsx`. 5.5d-i measured ten because the
      `scaffold-check` flake `todo.md` records fired in that run; it passed in this one.
      Passing count 1677 -> 1690.

      ```
      $ pnpm -C web build
      BUILD EXIT=0
      v Compiled successfully in 4.3s
      v Generating static pages using 15 workers (36/36) in 306.4ms
      |- f /api/events
      |- f /api/events/[post_id]
      ```

      Python gates, unchanged from the recorded baseline:

      ```
      $ set -a && . ./.env && set +a && cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.06s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

      Worth recording for the next iteration that runs pytest: without sourcing the repo
      `.env` first, every database test fails with
      `asyncpg.exceptions.InvalidPasswordError` and the run reports 177 errors instead
      of the baseline 25. That is the environment, not a regression.

## 5.5e


    Split, because the installed transport does not offer the resume primitive this item
    assumed and the replacement is three separable pieces. `SubscribeOptions` in
    `@mastra/core` offers `startFrom: 'earliest' | 'latest'` and nothing else, and
    `RedisStreamsPubSub` never shows a subscriber the Redis entry id it read:

    ```
    $ sed -n '80,84p' web/node_modules/@mastra/core/dist/events/types.d.ts
        /**
         * Where a newly created subscription should begin reading.
         * Defaults to 'earliest'. Existing consumer groups keep their checkpoint.
         */
        startFrom?: 'earliest' | 'latest';

    $ grep -n "#deliverMessage(sub\|sub.cb(" web/node_modules/@mastra/redis-streams/dist/index.js
    212:                                        await this.#deliverMessage(sub, entry.id, entry.message);
    472:                                await this.#deliverMessage(sub, entry.id, entry.message);
    476:        async #deliverMessage(sub, streamId, fields) {
    558:                        const result = sub.cb(event, ack, nack);
    ```

    The read loop knows `entry.id` and `#deliverMessage()` takes it, but the subscriber
    is invoked as `sub.cb(event, ack, nack)`: `streamId` is closed over by `ack`/`nack`
    and reaches nothing else. So a replay cannot ask Redis for a position by entry id and
    cannot ask `subscribe()` for one at all. It has to re-read the retained stream from
    `earliest` and drop what the client already holds, which needs (a) an anchor on the
    wire, (b) a handler that skips to it, and (c) a client that carries it across the
    reconnect `useSSE()` performs itself. Item
    5.5e-iii is not optional plumbing: `use-sse.ts` builds a **new** `EventSource` on
    every retry, and the `Last-Event-ID` buffer is per `EventSource` object, so the
    browser sends no such header here and the anchor has to travel as a query parameter.

## 5.5e-i


      `web/src/app/api/events/anchor.ts` defines the anchor as
      `<createdAt milliseconds>-<transport uuid>`, `encodeSseEvent()` in `sse.ts` gained
      an optional third argument that writes it, and `pipelineEventStream()` reads it off
      the delivered envelope rather than the payload.

      **This is an addition, not a port.** Python yielded `{"event": ..., "data": ...}`
      dicts and `ServerSentEvent.encode()` guards the field with `if self.id is not None`,
      so no frame `api/src/api/events.py` produced ever carried an id. The field order and
      the newline stripping are still `encode()`'s, which is why they are matched exactly:

      ```
      $ sed -n '38,46p' api/.venv/lib/python3.13/site-packages/sse_starlette/event.py
              if self.id is not None:
                  # Clean newlines in the event id
                  buffer.write("id: " + self._LINE_SEP_EXPR.sub("", self.id) + self._sep)

              if self.event is not None:
                  # Clean newlines in the event name
                  buffer.write(
                      "event: " + self._LINE_SEP_EXPR.sub("", self.event) + self._sep
                  )
      ```

      `id` before `event`, and the id stripped of line breaks so it cannot open a second
      field. `encodeSsePing()` is untouched and stays a bare comment, so a keepalive
      cannot move the client's `Last-Event-ID` off a real position.

      **Why both halves of the anchor.** The uuid is the exact match: `publish()` stamps
      `randomUUID()` per event and it names one stream entry. The timestamp is the
      fallback, and it is load-bearing rather than decorative, because `maxStreamLength`
      is 10000 and the anchor event can have been trimmed away by the time a client
      reconnects; a replay that skips until it sees a uuid no longer on the stream would
      skip forever and leave the browser connected and silent. Anything stamped later than
      the anchor was published after it, trimmed anchor or not, which is the bound 5.5e-ii
      will resume on. The separator is `-`, which also occurs inside the uuid, so the
      parse splits on the first one.

      **Known imprecision, recorded now rather than discovered later.** `publish()` assigns
      `createdAt` before awaiting `xAdd`, so two concurrent publishes can be stamped in one
      order and land in the stream in the other. When 5.5e-ii falls back to the timestamp
      the effect is a duplicate frame, never a gap, which is the right way round for this
      item's requirement.

      Eleven new tests in `web/src/app/api/events/events.test.ts` (28 -> 39). The
      integration ones assert on the raw bytes of frames that crossed a real Redis
      connection; the expected id is read back independently off the stream with
      `xRange`, so nothing asserts the implementation against itself.

      ```
      $ cd web && npx vitest run src/app/api/events/events.test.ts
       Test Files  1 passed (1)
            Tests  39 passed (39)
      ```

      Six negative controls, each reverted after it was measured. Two of them changed a
      test rather than only confirming one, and both changes are recorded here because
      the tests as first written were too weak:

      | # | Reverted behaviour | Failed |
      | --- | --- | --- |
      | NC1 | drop the third argument at the call site (the pre-implementation state) | 5 |
      | NC2 | write `id:` after `event:` | 3 |
      | NC3 | anchor is the uuid alone | 5 |
      | NC4 | anchor is the timestamp alone | 5 |
      | NC5 | anchor is a per-connection counter plus the uuid | 4 |
      | NC6 | do not strip line breaks out of the id | 1 |

      ```
      $ # NC1: send(encodeSseEvent(eventName(payload), payload))
           x delivers a published event as one CRLF-framed named frame
           x puts id: before event: on every frame, as ServerSentEvent.encode() ordered them
           x names the transport's own event id and publish timestamp
           x keeps the whole uuid, which contains the separator four times over
           x issues a distinct, non-decreasing id per event across one run
            Tests  5 failed | 34 passed (39)

      $ # NC2: `event: ...` then `id: ...`
           x delivers a published event as one CRLF-framed named frame
           x puts id: before event: on every frame, as ServerSentEvent.encode() ordered them
           x strips line breaks out of the id, so an id cannot forge a second field
            Tests  3 failed | 36 passed (39)

      $ # NC3: return `${event.id}`
           x names the transport's own event id and publish timestamp
           x keeps the whole uuid, which contains the separator four times over
           x issues a distinct, non-decreasing id per event across one run
           x joins the publish timestamp to the transport uuid
           x accepts the string createdAt a payload carries before the transport revives it
            Tests  5 failed | 34 passed (39)

      $ # NC4: return `${millis}`
           x names the transport's own event id and publish timestamp
           x keeps the whole uuid, which contains the separator four times over
           x issues a distinct, non-decreasing id per event across one run
           x joins the publish timestamp to the transport uuid
           x accepts the string createdAt a payload carries before the transport revives it
            Tests  5 failed | 34 passed (39)

      $ # NC5: const anchor = `${(counter += 1)}-${event.id}`
           x stamps the same event with the same id on the feed as on the per-post stream
           x names the transport's own event id and publish timestamp
           x keeps the whole uuid, which contains the separator four times over
           x issues a distinct, non-decreasing id per event across one run
            Tests  4 failed | 35 passed (39)

      $ # NC6: `id: ${id}` instead of `id: ${singleLine(id)}`
           x strips line breaks out of the id, so an id cannot forge a second field
            Tests  1 failed | 38 passed (39)
      ```

      NC3 and NC4 first failed only four tests each: "issues a distinct, non-decreasing id
      per event across one run" passed against a uuid-only anchor because
      `Number("3f1a2b3c")` is `NaN` and an array of `NaN`s sorts to itself. The test now
      asserts each timestamp is an integer inside the window the test itself ran in, which
      is what makes it a statement about the timestamp rather than about sorting.

      NC5 first failed only three: "stamps the same event with the same id on the feed as
      on the per-post stream" opened both connections before publishing, so a
      per-connection counter reached the same value on each and agreed by accident. The
      feed now joins one event late, so the two connections have delivered different
      numbers of frames by the time they share one, and only an anchor derived from the
      event can still agree.

      One existing assertion changed rather than being added to: "delivers a published
      event as one CRLF-framed named frame" pinned the whole frame byte for byte and every
      frame now carries one more line. It still pins the whole frame, with the id line
      included and its value taken from the frame, because the value itself is pinned
      against the stream entry by a separate test.

      Frontend gates:

      ```
      $ cd web && npx tsc --noEmit
      TSC EXIT=0

      $ cd web && npx eslint
      LINT EXIT=0
      (no output)

      $ cd web && npx vitest run
       Test Files  2 failed | 92 passed (94)
            Tests  9 failed | 1701 passed | 7 skipped (1717)
      ```

      Nine failed is the recorded baseline: six in
      `src/components/__tests__/image-preview.test.tsx` and three in
      `src/app/posts/PostDetail.test.tsx`. Passing count 1690 -> 1701.

      The first full run of this suite reported eleven, adding
      `src/mastra/pipeline-events.test.ts > carries Python's log payload and nothing else`
      to the `scaffold-check` flake `todo.md` already records. Both pass in isolation and
      neither reappeared on the second full run, so the shared Redis topic has a second
      cross-file interference alongside the recorded one:

      ```
      $ cd web && npx vitest run src/mastra/pipeline-events.test.ts src/mastra/workflows/scaffold-check.test.ts
       Test Files  2 passed (2)
            Tests  45 passed (45)
      ```

      ```
      $ cd web && npx next build
      BUILD EXIT=0
      v Compiled successfully in 4.0s
      v Generating static pages using 15 workers (36/36) in 291.4ms
      |- f /api/events
      |- f /api/events/[post_id]
      ```

      Python gates, unchanged from the recorded baseline (no Python was touched):

      ```
      $ set -a && . ./.env && set +a && cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.11s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.5e-ii


      `anchor.ts` gained `parseAnchor()`, `requestAnchor()` and `anchorPosition()`;
      `pipelineEventStream()` reads the anchor once per request and, while it is still
      catching up, drops every delivery `anchorPosition()` does not place after it. The
      skip runs inside the same chained `tail` the ordering fix uses, so the decision is
      made in delivery order, and it runs **before** `matches`, so a client with a large
      backlog behind it does not pay for an ownership lookup per skipped event.

      **This is an addition, not a port.** `PUBLISH` retains nothing, so every event
      `api/src/api/events.py` published while a browser was reconnecting was gone; the
      Python endpoints had no anchor, no parameter and no replay. The behaviour being
      added is the ledger's own requirement, not a Python behaviour being preserved.

      **Three decisions and the evidence behind each.**

      1. *Header first, then the query parameter.* Both are real paths and they age
         differently: the parameter is fixed when the URL is built, the header is
         whatever the last frame that `EventSource` object received carried. A browser
         reconnecting an existing object sends a stale parameter and a current header, so
         taking the older of the two would replay everything twice. A header that does
         not parse falls through to the parameter rather than cancelling the replay.
      2. *An unparseable anchor means "no anchor", not an error.* The alternative is
         refusing the connection or handing back the whole retained stream, and a client
         whose only mistake is an id this server did not write deserves neither.
      3. *The timestamp comparison is strict (`>`), so the anchor's own millisecond reads
         as "before".* When the anchor is still on the stream the uuid settles it exactly
         and nothing published after it is lost. When the anchor has been **trimmed** the
         client already has an unavoidable gap, because entries are trimmed oldest first
         and everything between the anchor and the oldest retained entry went with it; the
         timestamp's job there is to stop the replay skipping forever, not to make a lossy
         stream lossless. `>=` would trade that exactness for duplicates on every
         reconnect, and NC4 below measures it.

      **The cost, measured rather than assumed.** The transport hands a subscriber decoded
      payloads and never the Redis entry id (recorded under 5.5e above), so there is no
      position to seek to and catching up means reading every retained entry. Against the
      dev stream holding its full 10000:

      ```
      $ docker compose exec -T redis redis-cli xlen "mastra:topic:pipeline-events"
      10005
      ```

      the replaying tests run at about 2.9s each where the equivalent non-replaying test
      ("does not replay events published before the connection opened") runs at 1.34s, so
      the scan of a full stream costs roughly 1.3s before the first frame, paid once per
      reconnect. That is recorded in `stream.ts` so it is not rediscovered later.

      Nineteen new tests in `web/src/app/api/events/events.test.ts` (39 -> 59): seven
      integration tests that disconnect a real connection and reconnect through the real
      handler, plus unit coverage of the three new functions.

      ```
      $ cd web && npx vitest run src/app/api/events/events.test.ts
       Test Files  1 passed (1)
            Tests  59 passed (59)
      ```

      Seven negative controls, each reverted after it was measured:

      | # | Reverted behaviour | Failed |
      | --- | --- | --- |
      | NC1 | the pre-implementation state: always `"latest"`, no skip loop | 5 |
      | NC2 | always `startFrom: "earliest"`, anchor or not | 12 |
      | NC3 | drop the exact-uuid match, leaving only the timestamp | 2 |
      | NC4 | `>=` instead of `>` on the timestamp | 3 |
      | NC5 | send the anchored event itself instead of dropping it | 5 |
      | NC6 | prefer the query parameter over the header | 2 |
      | NC7 | split the anchor on the last `-` instead of the first | 12 |

      ```
      $ # NC1
           x resumes where the client stopped, with no gap across the disconnect
           x accepts the anchor as the Last-Event-ID header a browser's own reconnect sends
           x prefers the header over a query parameter, because the two age differently
           x resumes from the anchor's timestamp when the anchored event is gone from the stream
           x replays the queue-wide feed from an anchor, still scoped to the caller
            Tests  5 failed | 53 passed (58)

      $ # NC2: every connection replays the retained stream
           x does not replay events published before the connection opened
           x delivers events for every post the caller owns, not just one
           x drops another user's events, which global_events() broadcast to everyone
           x drops an event for a post that no longer exists
           x drops an event for a post whose profile_id is null, as the inner join did
           x delivers events for a post created after the connection opened
           x preserves publication order across posts whose ownership is not yet resolved
           x remembers a negative answer too, so a mid-connection reassignment needs a reconnect
           x stamps the same event with the same id on the feed as on the per-post stream
           x scopes two concurrent callers to their own posts on the same topic
           x ignores an anchor it did not write rather than replaying the whole stream
           x replays the queue-wide feed from an anchor, still scoped to the caller
            Tests  12 failed | 46 passed (58)

      $ # NC3: remove `if (event.id === anchor.id) return "at"`
           x resumes on the uuid when what follows the anchor shares its millisecond
           x recognises the anchor itself by uuid, whatever its timestamp says
            Tests  2 failed | 57 passed (59)

      $ # NC4: millis >= anchor.millis
           x prefers the header over a query parameter, because the two age differently
           x resumes from the anchor's timestamp when the anchored event is gone from the stream
           x treats the anchor's own millisecond as before, so an exact match still settles it
            Tests  3 failed | 56 passed (59)

      $ # NC5: `if (position === "before") return` with no early return on "at"
           x resumes where the client stopped, with no gap across the disconnect
           x resumes on the uuid when what follows the anchor shares its millisecond
           x accepts the anchor as the Last-Event-ID header a browser's own reconnect sends
           x prefers the header over a query parameter, because the two age differently
           x replays the queue-wide feed from an anchor, still scoped to the caller
            Tests  5 failed | 54 passed (59)

      $ # NC6: parameter checked first, header second
           x prefers the header over a query parameter, because the two age differently
           x prefers the header, which is the fresher of the two
            Tests  2 failed | 57 passed (59)

      $ # NC7: trimmed.lastIndexOf("-")
           x resumes where the client stopped, with no gap across the disconnect
           x resumes on the uuid when what follows the anchor shares its millisecond
           x accepts the anchor as the Last-Event-ID header a browser's own reconnect sends
           x prefers the header over a query parameter, because the two age differently
           x resumes from the anchor's timestamp when the anchored event is gone from the stream
           x replays the queue-wide feed from an anchor, still scoped to the caller
           x splits on the first separator, which keeps the uuid whole
           x reads back exactly what eventAnchor() wrote
           x takes the Last-Event-ID header when there is one
           x takes the query parameter, which is the path useSSE() will use
           x prefers the header, which is the fresher of the two
           x falls through to the parameter when the header does not parse
            Tests  12 failed | 47 passed (59)
      ```

      **NC3 was run twice and the first run is the reason there are 59 tests and not 58.**
      With the exact-uuid match removed, only the one unit test failed: every replay
      integration test happened to publish its post-anchor events a comfortable
      millisecond or more after the anchor (the client has to receive a frame and
      disconnect in between, which takes over a second), so the timestamp fallback alone
      carried all of them and the uuid half was never exercised end to end. The added test
      "resumes on the uuid when what follows the anchor shares its millisecond" publishes
      six events in one turn, finds an adjacent pair the transport stamped with the same
      `createdAt`, and anchors on the first of that pair, so the successor is one the
      timestamp places "before" the anchor and only the uuid can rescue. It is
      deterministic rather than lucky: six concurrent stamps span microseconds, so at most
      one millisecond boundary can fall inside them and at least four of the five adjacent
      pairs must share a value.

      Frontend gates:

      ```
      $ cd web && npx tsc --noEmit
      TSC EXIT=0

      $ cd web && npx eslint
      LINT EXIT=0
      (no output)

      $ cd web && npx vitest run
       Test Files  3 failed | 91 passed (94)
            Tests  10 failed | 1720 passed | 7 skipped (1737)

      $ cd web && npx next build
      BUILD EXIT=0
      v Compiled successfully in 4.0s
      v Generating static pages using 15 workers (36/36) in 296.6ms
      |- f /api/events
      |- f /api/events/[post_id]
      ```

      Passing count 1701 -> 1720. **Ten failed, not the recorded nine**, and the tenth is
      not this item's: it is `scaffold-check.test.ts > emits the workflow lifecycle events
      the trace view will read`, the cross-file flake `todo.md` already records, which has
      stopped being intermittent in this environment. Measured on both sides rather than
      assumed, by reverting all three changed files to HEAD and running the whole suite:

      ```
      $ git checkout -- web/src/app/api/events/ && cd web && npx vitest run
       Test Files  3 failed | 91 passed (94)
            Tests  10 failed | 1700 passed | 7 skipped (1717)
      ```

      Same ten failures at HEAD, so the baseline moved on its own. It also passes alone and
      alongside this item's file, which rules the new replay traffic out as the trigger:

      ```
      $ cd web && npx vitest run src/mastra/workflows/scaffold-check.test.ts src/app/api/events/events.test.ts
       Test Files  2 passed (2)
            Tests  64 passed (64)
      ```

      Python gates, unchanged from the recorded baseline (no Python was touched):

      ```
      $ set -a && . ./.env && set +a && cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.12s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

## 5.5e-iii


      `web/src/hooks/use-sse.ts` now keeps `lastEventId` beside `source` inside the
      effect, sets it from every delivered frame, and builds the next `EventSource`'s URL
      with `?last_event_id=<anchor>` when it holds one. Four decisions in that sentence
      are load-bearing:

      - **The parameter name is imported, not spelled again.** The hook reads
        `LAST_EVENT_ID_PARAM` from `web/src/app/api/events/anchor.ts`, the same constant
        `requestAnchor()` looks the parameter up with. A literal in each file would be
        two independent spellings of one wire contract, and a typo in either would fail
        silently: the client would ask for a replay and the server would answer with a
        live-only stream, which is exactly the pre-5.5e behaviour and so invisible.
        `anchor.ts` has no server-only import and its single `@mastra/core/events` import
        is `import type`, so the client bundle takes nothing but the two string constants
        and the pure functions. `pnpm build` below is the proof it links.
      - **The anchor is a plain `let` inside the effect, not a ref outside it.** A ref
        would survive a `postId` change, and the two feeds are filters over one topic, so
        an anchor carried from `post-1` into `post-2` would open the new page on every
        retained `post-2` event since that timestamp. Negative control 1 below is that
        exact mistake.
      - **It advances before the JSON parse, not after.** The browser's own
        `Last-Event-ID` buffer is set from the `id:` field regardless of what `data`
        holds, and a frame this hook cannot read is still a frame the server does not
        need to send again. Tracking inside the `try` would leave the anchor stuck behind
        an unreadable frame and replay it on every future reconnect. Negative control 4.
      - **An id-less frame leaves the anchor alone.** `eventAnchor()` omits `id:` for an
        event the transport did not stamp (5.5e-i), so a frame with no id is not a
        position; `MessageEvent.lastEventId` is `""` there, and overwriting with it would
        throw away a real position and restart the replay from the beginning of the
        retained stream. Negative control 3.

      The client half now meets the server half: item 5.5e-ii's
      `it("takes the query parameter, which is the path useSSE() will use")` asserts
      `requestAnchor()` reads what this builds, and
      `it("resumes where the client stopped, with no gap across the disconnect")` asserts
      the handler answers it with the missed events and no gap.

      **The seven tests failed first**, with the hook at `HEAD` and the new tests in
      place. Five of the seven; the other two are guards that a correct implementation
      and a missing implementation both pass, and negative controls 1 and 2 give them
      their teeth:

      ```
      $ git show HEAD:web/src/hooks/use-sse.ts > web/src/hooks/use-sse.ts
      $ cd web && pnpm vitest run src/hooks/use-sse.test.ts --no-color
           x puts the last delivered event's id on the URL of the next EventSource 3ms
           x takes the anchor from a named event too, not only from an unnamed one 1ms
           x advances the anchor rather than accumulating parameters across two reconnects 1ms
           x keeps the previous anchor when a frame arrives without an id 1ms
           x advances the anchor on a frame whose data does not parse, as the browser's own buffer does 1ms
       Test Files  1 failed (1)
      ```

      (`x` above transcribes the multiplication sign vitest prints for a failed test.)

      ### `cd web && pnpm vitest run src/hooks/use-sse.test.ts --no-color --reporter=verbose` -> **exit 0**

      ```
       + src/hooks/use-sse.test.ts > useSSE > connects to global SSE endpoint when no postId 9ms
       + src/hooks/use-sse.test.ts > useSSE > connects to post-specific SSE endpoint 2ms
       + src/hooks/use-sse.test.ts > useSSE > sets connected to true on open 53ms
       + src/hooks/use-sse.test.ts > useSSE > receives message events and updates lastEvent 54ms
       + src/hooks/use-sse.test.ts > useSSE > receives named events and sets event type 5ms
       + src/hooks/use-sse.test.ts > useSSE > calls onEvent callback for message events 53ms
       + src/hooks/use-sse.test.ts > useSSE > reconnects after error 2ms
       + src/hooks/use-sse.test.ts > useSSE > cleans up EventSource on unmount 2ms
       + src/hooks/use-sse.test.ts > useSSE > reconnects with new EventSource when postId changes 2ms
       + src/hooks/use-sse.test.ts > useSSE > ignores malformed JSON in messages 53ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > opens the first connection with no anchor, because it has missed nothing 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > puts the last delivered event's id on the URL of the next EventSource 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > takes the anchor from a named event too, not only from an unnamed one 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > advances the anchor rather than accumulating parameters across two reconnects 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > keeps the previous anchor when a frame arrives without an id 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > advances the anchor on a frame whose data does not parse, as the browser's own buffer does 1ms
       + src/hooks/use-sse.test.ts > useSSE replay anchor > does not carry an anchor across a postId change, which is a different feed 1ms
       Test Files  1 passed (1)
            Tests  17 passed (17)
      ```

      (`+` above transcribes the check mark vitest prints for a passing test.)

      **Six negative controls.** Each is one edit to the shipped hook, run against the
      unmodified test file and reverted afterwards. Every one fails the test that
      describes it and nothing else, except control 2, which is caught by two
      pre-existing url assertions as well:

      ```
      --- anchor hoisted out of the effect, so it survives a postId change
          x does not carry an anchor across a postId change, which is a different feed 3ms
         Tests  1 failed | 16 passed (17)
      --- parameter appended unconditionally, so the first connection asks for a replay
          x connects to global SSE endpoint when no postId 9ms
          x connects to post-specific SSE endpoint 3ms
          x opens the first connection with no anchor, because it has missed nothing 1ms
          x does not carry an anchor across a postId change, which is a different feed 1ms
         Tests  4 failed | 13 passed (17)
      --- anchor overwritten by an id-less frame
          x keeps the previous anchor when a frame arrives without an id 3ms
         Tests  1 failed | 16 passed (17)
      --- anchor tracked after the JSON parse, so an unreadable frame does not advance it
          x advances the anchor on a frame whose data does not parse, as the browser's own buffer does 3ms
         Tests  1 failed | 16 passed (17)
      --- named events not tracked, only unnamed ones
          x takes the anchor from a named event too, not only from an unnamed one 3ms
         Tests  1 failed | 16 passed (17)
      --- parameter concatenated onto the effect's url instead of a fresh string
          x advances the anchor rather than accumulating parameters across two reconnects 3ms
         Tests  1 failed | 16 passed (17)
      ```

      **Test-output noise.** The seven new tests advance fake timers inside `act()`, so
      none of them emits React's "not wrapped in act(...)" warning. One such warning
      remains in this file, from the pre-existing `reconnects after error` test, which
      advances its first timer outside `act()`. It is untouched and pre-existing:

      ```
      $ cd web && pnpm vitest run src/hooks/use-sse.test.ts 2>&1 | grep -c "not wrapped in act"
      1
      ```

      ### Gates

      ```
      $ cd web && pnpm exec tsc --noEmit
      tsc exit=0

      $ cd web && pnpm lint
      > content-pipeline-dashboard@0.1.0 lint
      > eslint
      lint exit=0

      $ cd web && pnpm test
       Test Files  2 failed | 92 passed (94)
            Tests  9 failed | 1728 passed | 7 skipped (1744)

      $ cd web && pnpm build
      build exit=0

      $ set -a && . ./.env && set +a && cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 14.98s
      ```

      `pnpm test`'s 9 failures are the Phase 0 baseline exactly (the 6 known
      `image-preview` failures plus the 3 in the same pair of files); pytest matches
      item 5.5e-ii's numbers to the test, which is expected because this iteration
      changed no Python and no shared TypeScript: `git diff --stat` is
      `web/src/hooks/use-sse.test.ts` and `web/src/hooks/use-sse.ts` only.

      **Not covered.** No browser drives this. The proof is jsdom plus a mock
      `EventSource`, which is the right level for "what URL does the second connection
      use", but it does not prove a real Chrome reconnect recovers a real run's trace.
      That check belongs to Phase 8, where item 8.1's run-trace view is exercised
      against a live run with `chrome-devtools-axi`.

## 5.6


  `api/src/api/rules.py` is 57 lines over three endpoints and has no database, no
  queue and no service layer: it lists, reads and writes the six `rules/*.md`
  files behind the settings page's rule editor. The port is
  `web/src/app/api/rules/route.ts` (list), `web/src/app/api/rules/[name]/route.ts`
  (read and write) and `web/src/app/api/rules/rule-files.ts` (the allowlist and
  path resolution `_rule_path()` held).

  **The contract.** `web/src/lib/api.ts` calls all three: `rules.list()` returns
  `RuleFile[]` (`name`, `filename`, `exists`, `size`), `rules.get(name)` and
  `rules.update(name, content)` return `RuleContent` (`name`, `content`). Nothing
  in those shapes changed.

  **The allowlist is derived, not transcribed.** Python spelled out a literal
  `ALLOWED_FILES` set of six names. `RULE_NAMES` is instead
  `Object.values(STAGE_RULES_MAP)` with `.md` stripped and sorted, so the files
  the settings page can edit and the files `web/src/mastra/prompts.ts` actually
  loads for a stage cannot drift apart. The derived list is pinned against
  Python's literal by its own test, so the coupling is checked rather than
  assumed. `rulesDir()` is imported from `prompts.ts` too, which keeps the
  `RULES_DIR` override (set to `/app/rules` by both `docker-compose.yml`
  services) working for the handlers as well as the pipeline.

  **Deviation 1, authentication.** The Python `rules` router carried no session
  dependency on any of its three endpoints, which made `PUT /api/rules/{name}` an
  unauthenticated write to the product's prompt IP for every tenant at once. This
  is the same gap item 5.5d-i found in the events router and it is closed the same
  way: all three handlers require a session. There is no ownership scoping to add
  on top, because `rules/*.md` are installation-wide files and not rows with an
  owner, so the only new response is the 401.

  **Deviation 2, one `stat` instead of `exists()` then `stat()`.** Python's list
  endpoint called `Path.exists()` and then `Path.stat().st_size`, two syscalls with
  a window between them in which a file can vanish and make the second raise. The
  port reads one `stat` and treats `ENOENT` as "missing, size 0", which answers
  the same two questions without the window. `GET /{name}` collapses the same
  pair the same way: `readFile` with `ENOENT` mapped to the 404.

  **Behaviours preserved on purpose.** Both of Python's 404s stay distinct: an
  unallowlisted name is `Unknown rule: <name>` from `_rule_path()`, an allowlisted
  name with no file on disk is `Rule file not found`, and only `GET` can reach the
  second because `PUT` creates the file. `PUT` on a name whose file does not exist
  still creates it rather than 404ing. The allowlist is what keeps `..` and
  absolute paths out of `path.join`, exactly as in Python, and there is no second
  containment check because a name that is not one of the six never reaches the
  filesystem.

  **Validation order was read off the running app, not the source.** FastAPI
  solves dependencies, then validates the request, then calls the endpoint, so the
  `_rule_path()` 404 is raised after body validation. That is observable and it was
  observed rather than assumed:

  ```
  $ cd api && PYTHONPATH=. uv run python rules_order_probe.py
  PUT bogus + missing content -> 422 {'detail': [{'type': 'missing', 'loc': ['body', 'content'], 'msg': 'Field required', 'input': {}}]}
  PUT bogus + valid body     -> 404 {'detail': 'Unknown rule: bogus'}
  PUT valid name + bad json  -> 422 {'detail': [{'type': 'json_invalid', 'loc': ['body', 1], 'msg': 'JSON decode error', 'input': {}, 'ctx': {'error': 'Expecting property name enclosed in double quotes'}}]}
  PUT bogus name + bad json  -> 422 {'detail': [{'type': 'json_invalid', 'loc': ['body', 1], 'msg': 'JSON decode error', 'input': {}, 'ctx': {'error': 'Expecting property name enclosed in double quotes'}}]}
  PUT content=5              -> 422 {'detail': [{'type': 'string_type', 'loc': ['body', 'content'], 'msg': 'Input should be a valid string', 'input': 5}]}
  GET list ->  200 ['blog-edit', 'blog-images', 'blog-outline', 'blog-ready', 'blog-research', 'blog-write'] {'name': 'blog-edit', 'filename': 'blog-edit.md', 'exists': True, 'size': 15448}
  GET bogus -> 404 {'detail': 'Unknown rule: bogus'}
  ```

  (The probe file was a scratch script mounting the real router on a bare
  `FastAPI()` under `TestClient`; it was deleted after the run and is not
  committed.) So `PUT` parses and validates the body before it looks at the path
  name, and the shared `invalidJsonBody()` / `unprocessableBody()` helpers from
  `web/src/app/api/pydantic.ts` reproduce all three error bodies. The one
  difference is `loc: ["body", 0]` where Python reports the character offset of the
  decode error, which is the choice `pydantic.ts` already made in an earlier item.

  **There is no pytest coverage to port.** `grep -rn "api/rules" api/tests` returns
  nothing, so this router has never had a test in either stack. The 22 tests in
  `web/src/app/api/rules/rules.test.ts` are the first, and they run against the real
  database and real BetterAuth sessions with `RULES_DIR` pointed at a scratch
  directory, so `PUT` never touches the real `rules/*.md`.

  Failing first, with the three implementation files moved aside:

  ```
  $ cd web && npx vitest run src/app/api/rules/rules.test.ts
   FAIL  src/app/api/rules/rules.test.ts [ src/app/api/rules/rules.test.ts ]
  Error: Cannot find module './[name]/route' imported from '.../web/src/app/api/rules/rules.test.ts'
   Test Files  1 failed (1)
        Tests  no tests
  ```

  Passing, with the implementation restored (`+` transcribes vitest's pass glyph):

  ```
  $ cd web && npx vitest run src/app/api/rules/rules.test.ts --reporter=verbose
   + the rule allowlist > is Python's ALLOWED_FILES, sorted 1ms
   + the rule allowlist > resolves every name inside the rules directory 1ms
   + GET /api/rules > 401s without a session 3ms
   + GET /api/rules > lists the six rules in sorted order with their filenames 12ms
   + GET /api/rules > reports a missing file as exists false with size 0 3ms
   + GET /api/rules > reports size in bytes, not characters 3ms
   + GET /api/rules > ignores files in the directory that are not on the allowlist 2ms
   + GET /api/rules/{name} > 401s without a session 1ms
   + GET /api/rules/{name} > 404s an unknown rule with the name echoed back 2ms
   + GET /api/rules/{name} > 404s a traversing name before touching the filesystem 2ms
   + GET /api/rules/{name} > 404s an allowlisted rule whose file is missing, with the other message 2ms
   + GET /api/rules/{name} > returns the file content verbatim, decoded as utf-8 2ms
   + PUT /api/rules/{name} > 401s without a session 1ms
   + PUT /api/rules/{name} > overwrites an existing file and echoes the content back 2ms
   + PUT /api/rules/{name} > creates a file that was not there, so the next GET stops 404ing 3ms
   + PUT /api/rules/{name} > writes utf-8 bytes, matching Python's write_text(encoding='utf-8') 2ms
   + PUT /api/rules/{name} > accepts an empty string, truncating the file 2ms
   + PUT /api/rules/{name} > 404s an unknown rule and writes nothing 1ms
   + PUT /api/rules/{name} > 422s a missing content field with pydantic's shape 2ms
   + PUT /api/rules/{name} > 422s a non-string content with pydantic's string_type 1ms
   + PUT /api/rules/{name} > 422s a body that is not JSON at all 1ms
   + PUT /api/rules/{name} > validates the body before the path, as FastAPI did 1ms
   Test Files  1 passed (1)
        Tests  22 passed (22)
     Duration  601ms
  ```

  Negative controls, each applied to the implementation, measured, then reverted
  (`x` transcribes vitest's failure glyph):

  ```
  # 1. drop the session check from PUT
  Tests  1 failed | 21 passed (22)
    x PUT > 401s without a session

  # 2. drop the isRuleName check from GET /{name}, so a bad name falls through to the read
  Tests  2 failed | 20 passed (22)
    x GET /{name} > 404s an unknown rule with the name echoed back
    x GET /{name} > 404s a traversing name before touching the filesystem

  # 3. report size as readFile(...,"utf8").length instead of stat().size
  Tests  1 failed | 21 passed (22)
    x GET /api/rules > reports size in bytes, not characters

  # 4. drop the .sort() from RULE_NAMES
  Tests  4 failed | 18 passed (22)
    x the rule allowlist > is Python's ALLOWED_FILES, sorted
    x GET /api/rules > lists the six rules in sorted order with their filenames
    x GET /api/rules > reports a missing file as exists false with size 0
    x GET /api/rules > ignores files in the directory that are not on the allowlist

  # 5. move the isRuleName check ahead of the body parse in PUT
  Tests  1 failed | 21 passed (22)
    x PUT > validates the body before the path, as FastAPI did

  # 6. answer a missing file with unknownRule(name) instead of "Rule file not found"
  Tests  1 failed | 21 passed (22)
    x GET /{name} > 404s an allowlisted rule whose file is missing, with the other message
  ```

  Control 4 is the informative one: dropping the sort fails four tests, three of
  which never mention ordering, because `RULE_NAMES` is also the iteration order of
  the list response. Control 2 confirms the allowlist is the only thing standing
  between a path segment and `path.join`: without it the traversing name reaches
  the filesystem and comes back as the wrong 404.

  Gates:

  ```
  $ cd web && npx tsc --noEmit
  TSC EXIT=0
  (no output)

  $ cd web && npx eslint
  LINT EXIT=0
  (no output)

  $ cd web && npx vitest run
   Test Files  3 failed | 92 passed (95)
        Tests  10 failed | 1749 passed | 7 skipped (1766)

  $ cd web && npx next build
  BUILD EXIT=0
  |- f /api/rules
  |- f /api/rules/[name]
  # The BetterAuth "default secret" lines are the pre-existing, environment-driven
  # warning recorded under item 1.2 and are filtered out of this paste.

  $ cd api && uv run pytest -q            # with the repo .env sourced first
  120 failed, 241 passed, 25 errors in 15.03s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 131 files already formatted
  ```

  **The failure count, measured on both sides.** This iteration's 22 tests are all
  additions and no existing file changed, so the honest delta needed HEAD measured
  now rather than read off a previous entry. Six full runs, three with the new
  router present and three with `web/src/app/api/rules/` moved aside:

  ```
  HEAD          9 failed | 1728 passed (1744)
  HEAD          9 failed | 1728 passed (1744)
  HEAD         10 failed | 1727 passed (1744)
  with 5.6     10 failed | 1749 passed (1766)
  with 5.6     10 failed | 1749 passed (1766)
  with 5.6     10 failed | 1749 passed (1766)
  ```

  The tenth failure is always the same one,
  `src/mastra/workflows/scaffold-check.test.ts > emits the workflow lifecycle events
  the trace view will read`, already recorded three times in `todo.md` as cross-file
  interference on the shared Redis `workflows` topic. It reproduces at HEAD (run 3
  above) so it is not introduced here, it passes standalone
  (`npx vitest run src/mastra/workflows/scaffold-check.test.ts` -> 5 passed), and
  the 9 baseline failures are the recorded `image-preview` six plus the
  `PostDetail` three. What this iteration adds is a frequency datum: the flake went
  from 1 of 3 HEAD runs to 3 of 3 with this file present, while a minimal
  placeholder test file with the same environment and imports left it at 1 of 3
  (9 failed | 1729 passed). So the trigger is scheduling pressure specific to this
  file's shape, not the mere presence of one more file. That is appended to the
  `todo.md` entry; fixing it belongs to item 9.1, which cannot be signed off while
  a full run is nondeterministic.

  pytest reads 120 failed / 241 passed against the 125 / 236 pasted in item
  5.3c-iii-a, on the same 386 collected. No Python changed this iteration
  (`git status` is `web/src/app/api/rules/` and nothing else), so five tests moved
  from failing to passing on their own; the Phase 0 baseline is a ceiling on
  failures and this is below it.

  **Not covered.** No browser drives the settings page against these handlers. The
  proof is direct handler calls, which is the right level for status codes, error
  bodies and what lands on disk, but it does not prove the rule editor's tab list
  and save button work end to end against them. That check belongs to Phase 8 item
  8.7, where `/settings` gets its four states and screenshots.

## 5.7


  Ported to `web/src/app/api/profiles/[id]/links/route.ts` (`GET` and `POST`) and
  `web/src/app/api/profiles/[id]/links/[link_id]/route.ts` (`DELETE`), with
  `serialize.ts` (the `LinkRead` wire shape), `validation.ts` (`LinkCreate`) and
  `params.ts` (the two path uuids, the list query string and their 422s).
  `web/src/lib/api.ts` needed no change: `PaginatedLinks` and `InternalLink`
  already match what the two read endpoints return.

  **Deviation 1: `DELETE` is scoped to the caller.** `delete_link()` was the one
  endpoint in `api/src/api/links.py` that never called `_get_profile_or_404()`.
  It matched on `link_id` and `profile_id` alone, so any authenticated user who
  knew both ids could delete another tenant's link. Porting that verbatim would
  have shipped a cross-tenant write, so the delete carries the same
  `website_profiles.user_id` predicate the other two endpoints use, as a
  correlated `EXISTS`. Another user's link answers the same
  `404 {"detail": "Link not found"}` as one that does not exist, so the boundary
  leaks nothing. Logged in `todo.md` as a live defect in the Python stack until
  Phase 7 deletes it.

  **Deviation 2: a null `source` or `keywords` returns the pydantic default
  instead of a 500.** Same narrow divergence already recorded for `PostRead` in
  5.3a: pydantic raises rather than substituting a default for an attribute that
  is present and `None`, and FastAPI turned that into a 500. `serializeLink()`
  returns `"sitemap"` and `[]`. Both columns carry a server default, so only a
  row written with an explicit null reaches the branch. `created_at` is the
  exception, as it was for posts: pydantic required it with no default to
  invent, so the null carries through.

  **Deviation 3: `?page=` and `?per_page=` accept two more strings than they
  did.** `parseInt422` (moved from `posts/query.ts` into `pydantic.ts` in this
  iteration, since both routers declare the same `Query(..., ge=, le=)`) tested
  `/^\s*[+-]?\d+\s*$/`, which is narrower than pydantic's lax int parse.
  Probed against the installed pydantic 2.12:

  ```
  $ cd api && PYTHONPATH=. uv run python -c "
  from pydantic import TypeAdapter
  ta = TypeAdapter(int)
  for v in ['2.0','2.00','2.5','1e3','  2  ','0x10','2_0','1_0_0','_2','2_','1__0','+2','2.','.0','2.01','2.0_0','1_0.0']:
      try:
          print(repr(v), '->', ta.validate_python(v))
      except Exception as e:
          print(repr(v), '-> ERR', e.errors()[0]['type'])
  "
  '2.0' -> 2
  '2.00' -> 2
  '2.5' -> ERR int_parsing
  '1e3' -> ERR int_parsing
  '  2  ' -> 2
  '0x10' -> ERR int_parsing
  '2_0' -> 20
  '1_0_0' -> 100
  '_2' -> ERR int_parsing
  '2_' -> ERR int_parsing
  '1__0' -> ERR int_parsing
  '+2' -> 2
  '2.' -> ERR int_parsing
  '.0' -> ERR int_parsing
  '2.01' -> ERR int_parsing
  '2.0_0' -> ERR int_parsing
  '1_0.0' -> 10
  ```

  The grammar is therefore optional whitespace, an optional sign, digits with
  single `_` separators between digits, an optional `.` followed by nothing but
  zeros, optional whitespace, and `PYDANTIC_INT` is now
  `/^\s*[+-]?\d+(?:_\d+)*(?:\.0+)?\s*$/`. This widens `GET /api/posts` too,
  which is a move toward parity, not away from it: nothing in `posts/route.test.ts`
  asserted that `"2.0"` was rejected. The residual gap is that Python's `\s` and
  JavaScript's `\s` cover slightly different character sets, the same difference
  already recorded under 5.3d-i.

  **FastAPI reports path, query and body errors in one 422, path first.** This
  router is the first ported one with more than one validated parameter, so the
  ordering had to be settled rather than assumed. Probed by mounting the real
  router on a bare `FastAPI()` with `get_current_user` and `get_session`
  overridden:

  ```
  $ cd api && PYTHONPATH=. uv run python /tmp/probe_links_5_7.py
  === LinkRead field order ===
  ['url', 'title', 'slug', 'keywords', 'id', 'profile_id', 'source', 'post_id', 'created_at']

  === LinkCreate extras and coercions ===
  {"url": "u", "source": "sitemap", "post_id": "4468d733-...", "id": "x"} -> {'url': 'u', 'title': None, 'slug': None, 'keywords': []}
  {"url": "u", "keywords": ["a", 1]} -> ERR [{"type": "string_type", "loc": ["keywords", 1], "msg": "Input should be a valid string", "input": 1, ...}]
  {"url": "u", "keywords": "a"} -> ERR [{"type": "list_type", "loc": ["keywords"], "msg": "Input should be a valid list", "input": "a", ...}]
  {"url": 5} -> ERR [{"type": "string_type", "loc": ["url"], "msg": "Input should be a valid string", "input": 5, ...}]
  {"title": "t"} -> ERR [{"type": "missing", "loc": ["url"], "msg": "Field required", "input": {"title": "t"}, ...}]

  === path/query 422s ===
  GET /api/profiles/not-a-uuid/links?page=0&per_page=999 -> 422
    [{"type": "uuid_parsing", "loc": ["path", "profile_id"], ...},
     {"type": "greater_than_equal", "loc": ["query", "page"], ...},
     {"type": "less_than_equal", "loc": ["query", "per_page"], ...}]
  GET /api/profiles/<uuid>/links?page=abc -> 422
    [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "abc"}]
  GET /api/profiles/<uuid>/links?page=1&page=3 -> 404 {"detail": "Profile not found"}
  DELETE /api/profiles/bad/links/nope -> 422
    [{"type": "uuid_parsing", "loc": ["path", "profile_id"], ...},
     {"type": "uuid_parsing", "loc": ["path", "link_id"], ...}]
  POST /api/profiles/bad/links {'url': 5} -> 422
    [{"type": "uuid_parsing", "loc": ["path", "profile_id"], ...},
     {"type": "string_type", "loc": ["body", "url"], "msg": "Input should be a valid string", "input": 5}]
  ```

  A body FastAPI could not decode is the exception and short-circuits the rest:

  ```
  $ cd api && PYTHONPATH=. uv run python /tmp/probe_links_5_7b.py
  bad path + malformed json:
  422 {"detail": [{"type": "json_invalid", "loc": ["body", 1], "msg": "JSON decode error", "input": {}, "ctx": {"error": "Expecting property name enclosed in double quotes"}}]}
  body is a list:
  422 {"detail": [{"type": "model_attributes_type", "loc": ["body"], "msg": "Input should be a valid dictionary or object to extract fields from", "input": [1]}]}
  ```

  The path error is dropped there because the body is read before the parameters
  are solved. The handler reproduces that by parsing the body first and returning
  `invalidJsonBody()` on its own. That helper's existing `loc: ["body", 0]` is
  kept rather than made position-accurate: the real value is the character offset
  of the JSON error and nothing in `web/src/lib/api.ts` reads it.

  **Not deviations, deliberately preserved.** The `q` pattern is still
  `%{q}%` with no escaping, so a `%` or `_` in a search term is a wildcard; the
  duplicate check is still a read before the insert, so the ordinary duplicate is
  a 409 while a concurrent one still hits `uq_internal_links_profile_url` and
  surfaces as a 500; `source` is always `"manual"`, because `LinkCreate` has no
  field a client could use to claim otherwise; and `pages` is
  `(total + per_page - 1) // per_page if total > 0 else 0`, so an empty result
  reports 0 pages rather than 1.

  The tests are the TypeScript replacement for
  `api/tests/phase2/test_internal_links.py` (13 tests), against the real database
  and real BetterAuth sessions. Before the handlers existed:

  ```
  $ cd web && npx vitest run "src/app/api/profiles/[id]/links/links.test.ts"
   FAIL  src/app/api/profiles/[id]/links/links.test.ts [ src/app/api/profiles/[id]/links/links.test.ts ]
  Error: Cannot find module './[link_id]/route' imported from '.../links/links.test.ts'
   Test Files  1 failed (1)
        Tests  no tests
  ```

  And after (transcribed with `+` for vitest's check glyph):

  ```
  $ cd web && npx vitest run "src/app/api/profiles/[id]/links/links.test.ts" --reporter=verbose
   + GET /api/profiles/{profile_id}/links > 401s without a session 4ms
   + GET /api/profiles/{profile_id}/links > answers a malformed path uuid with FastAPI's 422 12ms
   + GET /api/profiles/{profile_id}/links > 404s for a profile that does not exist 4ms
   + GET /api/profiles/{profile_id}/links > 404s for another user's profile rather than listing its links 4ms
   + GET /api/profiles/{profile_id}/links > returns the empty page shape for a profile with no links 4ms
   + GET /api/profiles/{profile_id}/links > emits exactly LinkRead's field set, in its order 5ms
   + GET /api/profiles/{profile_id}/links > orders newest first and counts every match 5ms
   + GET /api/profiles/{profile_id}/links > excludes another profile's links from the count and the page 4ms
   + GET /api/profiles/{profile_id}/links > paginates with per_page and page, reporting the page count 7ms
   + GET /api/profiles/{profile_id}/links > searches url and title case-insensitively, the way ilike did 8ms
   + GET /api/profiles/{profile_id}/links > matches a link with a null title on the url alone 3ms
   + GET /api/profiles/{profile_id}/links > treats an empty ?q= as absent, the way a falsy Python string was 3ms
   + GET /api/profiles/{profile_id}/links > answers ?page=0 with FastAPI's Query() 422 2ms
   + GET /api/profiles/{profile_id}/links > answers ?per_page=201 with FastAPI's Query() 422 2ms
   + GET /api/profiles/{profile_id}/links > answers ?page=abc with FastAPI's Query() 422 1ms
   + GET /api/profiles/{profile_id}/links > answers ?per_page= with FastAPI's Query() 422 1ms
   + GET /api/profiles/{profile_id}/links > reports the path uuid and both bad query parameters in one 422, path first 2ms
   + GET /api/profiles/{profile_id}/links > accepts ?per_page=2.0, which pydantic's lax int parse accepts 3ms
   + GET /api/profiles/{profile_id}/links > accepts ?per_page=+2, which pydantic's lax int parse accepts 3ms
   + GET /api/profiles/{profile_id}/links > accepts ?per_page=%202%20, which pydantic's lax int parse accepts 3ms
   + GET /api/profiles/{profile_id}/links > accepts ?per_page=1_0, which pydantic's lax int parse accepts 3ms
   + GET /api/profiles/{profile_id}/links > keeps the last value of a repeated ?page=, as Starlette's QueryParams does 3ms
   + POST /api/profiles/{profile_id}/links > 401s without a session 1ms
   + POST /api/profiles/{profile_id}/links > creates a link with source manual and echoes LinkRead 4ms
   + POST /api/profiles/{profile_id}/links > fills LinkCreate's defaults for a url-only body 3ms
   + POST /api/profiles/{profile_id}/links > ignores extra keys, so source and post_id cannot be claimed by a client 3ms
   + POST /api/profiles/{profile_id}/links > 409s on a duplicate url for the same profile 5ms
   + POST /api/profiles/{profile_id}/links > allows the same url under a different profile 3ms
   + POST /api/profiles/{profile_id}/links > 404s for a profile that does not exist 1ms
   + POST /api/profiles/{profile_id}/links > 404s for another user's profile, writing nothing 2ms
   + POST /api/profiles/{profile_id}/links > answers a missing url with pydantic's missing error 1ms
   + POST /api/profiles/{profile_id}/links > reports a bad keyword by its index, as pydantic did 1ms
   + POST /api/profiles/{profile_id}/links > reports the path uuid and the body error in one 422, path first 1ms
   + POST /api/profiles/{profile_id}/links > answers a body it cannot decode with json_invalid alone, even on a bad path 1ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > 401s without a session, leaving the row 1ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > deletes the link and answers 204 with no body 2ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > 404s for a link that does not exist 1ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > 404s when the link belongs to another profile of the same user 3ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > 404s for another user's link and leaves it in place 2ms
   + DELETE /api/profiles/{profile_id}/links/{link_id} > reports both malformed path uuids in one 422 1ms
   Test Files  1 passed (1)
        Tests  40 passed (40)
  ```

  **Negative controls**, each applied alone against the passing suite and then
  reverted:

  | # | Break | Result |
  | --- | --- | --- |
  | 1 | Drop the `EXISTS` ownership predicate from the `DELETE` | 1 failed, 39 passed: `404s for another user's link and leaves it in place` |
  | 2 | `Math.floor` instead of `Math.ceil` for `pages` | 1 failed, 39 passed: `paginates with per_page and page, reporting the page count` |
  | 3 | `if (query.q !== null)` instead of the Python truthiness test | **40 passed, no failure** |
  | 4 | `params.get("page")` instead of `getAll("page").at(-1)` | 1 failed, 39 passed: `keeps the last value of a repeated ?page=` |
  | 5 | Push the path uuid issue after the query issues | 1 failed, 39 passed: `reports the path uuid and both bad query parameters in one 422, path first` |
  | 6 | Drop `source: "manual"` from the insert, leaving the column default | 3 failed, 37 passed: the three `POST` success-path tests |
  | 7 | Revert `PYDANTIC_INT` to `/^\s*[+-]?\d+\s*$/` | 2 failed, 38 passed: `accepts ?per_page=2.0` and `accepts ?per_page=1_0` |
  | 8 | Drop the `ownedProfile()` check from `POST` | 2 failed, 38 passed: `404s for a profile that does not exist` and `404s for another user's profile, writing nothing` |

  **Control 3 is the honest gap in this item.** The empty-`q` test has no teeth,
  and it cannot be given any: `url ilike '%%'` matches every row, `url` is
  `NOT NULL`, so the filtered and unfiltered queries return the same set for
  `q=""` no matter what is in the table. Python's `if q:` and a `q !== null` test
  are indistinguishable through the wire. The test is kept as a statement of
  intent, and the branch is recorded here as unverifiable rather than verified.

  Gates. `pnpm -C web <cmd>` does not work in this worktree, so these run from
  inside `web/` with the repo `.env` sourced:

  ```
  $ cd web && npx tsc --noEmit ; echo $?
  0

  $ cd web && npx eslint ; echo $?
  0

  $ cd web && npx vitest run
   Test Files  2 failed | 94 passed (96)
        Tests  9 failed | 1790 passed | 7 skipped (1806)

  $ cd web && npx vitest run          # second run, after the fixture-scoping fix below
   Test Files  3 failed | 93 passed (96)
        Tests  10 failed | 1789 passed | 7 skipped (1806)
  ```

  Both runs are pasted because they disagree. Nine of the failures are the
  recorded baseline in either case: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`, all pre-existing. The tenth on the second run is
  `scaffold-check.test.ts > emits the workflow lifecycle events the trace view
  will read`, the load-sensitive discrepancy recorded under 5.5e-ii and 5.6 that
  also fires at HEAD.

  **The fixture-scoping fix, worth recording because the first version of this
  item's test file was wrong.** `clearLinks()` originally deleted every
  `internal_links` row whose url started with `http://127.0.0.1:9/`, the loopback
  host every route-handler suite uses for fixtures. That made
  `posts/update-delete.test.ts > detaches internal links rather than deleting
  them, per Alembic 006's SET NULL` fail when the two files ran concurrently,
  while both passed alone:

  ```
  $ cd web && npx vitest run src/app/api/posts src/app/api/profiles
       x detaches internal links rather than deleting them, per Alembic 006's SET NULL 12ms
   Test Files  1 failed | 10 passed (11)
        Tests  1 failed | 376 passed (377)

  $ cd web && npx vitest run src/app/api/posts/update-delete.test.ts
   Test Files  1 passed (1)
        Tests  28 passed (28)
  ```

  Fixture urls now live under a `links-route-test/` path segment of their own and
  the cleanup matches that prefix, so it can only reach rows this file wrote:

  ```
  $ cd web && npx vitest run src/app/api/posts src/app/api/profiles
   Test Files  11 passed (11)
        Tests  377 passed (377)
  ```

  ```
  $ cd web && npx next build
   Compiled successfully in 4.1s
  Route (app)
  ├ ƒ /api/profiles/[id]/links
  ├ ƒ /api/profiles/[id]/links/[link_id]
  $ echo $?
  0
  ```

  `api/` is untouched by this item (`git status --short` lists only files under
  `web/`), and its gates are unchanged:

  ```
  $ cd api && uv run pytest -q     # .env sourced
  120 failed, 241 passed, 25 errors in 15.09s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 131 files already formatted
  ```

  The pytest split moved from the `125 failed, 236 passed` recorded under 5.2c to
  `120 failed, 241 passed` on the same 25 errors without any Python changing in
  between, so that suite's failure count is state-dependent and is not a
  trustworthy delta on its own.

  **Not covered.** No browser drives `/profiles/[id]` against these handlers.
  The proof is direct handler calls, which is the right level for status codes,
  error bodies and row-level ownership, but it does not prove the internal-links
  panel's search box, its infinite scroll (`page < data.pages`) or its delete
  button work end to end against them. That check belongs to Phase 8 item 8.6.

## 5.8a


    Ported to `web/src/app/api/analytics/dashboard/route.ts`. Five independent
    aggregates, all inner-joining `website_profiles` on `user_id`, assembled into the
    `DashboardStats` shape `web/src/lib/api.ts` already declares. `api.ts` needed no
    change: every field and type already matched what the handler returns.

    The five queries were compiled off the real SQLAlchemy rather than read off the
    Python, because two of them build their FROM implicitly:

    ```
    $ cd api && PYTHONPATH=. uv run python -c "
    <the five selects from dashboard_stats(), compiled with the postgresql dialect>
    "
    --- by_status
    SELECT anon_1.current_stage, count(anon_1.id) AS count_1
    FROM (SELECT ... FROM posts JOIN website_profiles ON posts.profile_id = website_profiles.id
    WHERE website_profiles.user_id = %(user_id_1)s) AS anon_1 GROUP BY anon_1.current_stage
    --- avg
    SELECT avg(EXTRACT(epoch FROM posts.completed_at) - EXTRACT(epoch FROM posts.created_at)) AS avg_1
    FROM posts JOIN website_profiles ON posts.profile_id = website_profiles.id
    WHERE website_profiles.user_id = %(user_id_1)s AND posts.completed_at IS NOT NULL
    --- by_profile
    SELECT website_profiles.name, count(posts.id) AS count
    FROM posts JOIN website_profiles ON posts.profile_id = website_profiles.id
    WHERE website_profiles.user_id = %(user_id_1)s GROUP BY website_profiles.name ORDER BY count(posts.id) DESC
     LIMIT %(param_1)s
    --- over_time
    SELECT CAST(posts.created_at AS DATE) AS date, count(posts.id) AS count
    FROM posts JOIN website_profiles ON posts.profile_id = website_profiles.id
    WHERE website_profiles.user_id = %(user_id_1)s AND posts.created_at >= %(created_at_1)s GROUP BY date ORDER BY date
    --- today
    SELECT count(posts.id) AS count_1
    FROM posts JOIN website_profiles ON posts.profile_id = website_profiles.id
    WHERE website_profiles.user_id = %(user_id_1)s AND posts.created_at >= %(created_at_1)s
    ```

    The `by_status` subquery selects every `Post` column and then counts one of them, so
    the port reads `current_stage` and `count(id)` off `posts` directly; the grouped
    result is identical and the 44-column projection is not.

    **`days` filters only `over_time`.** `by_status`, the average, `by_profile` and the
    completion rate all read the caller's whole history, which is not what the parameter
    name suggests but is what the monitor page's overview tab has always shown. Pinned by
    the "excludes posts older than the days window" test, which asserts the same row is
    absent from `over_time` and present in `total`.

    **Four Python arithmetic details preserved, each with its own test.**

    - `total` is `sum(by_status.values())`, every group, not the sum of named buckets. A
      post with a null or unrecognised `current_stage` is in the denominator of
      `completion_rate`.
    - `json.dumps` renders a `None` dict key as the string `"null"`, so a post whose
      stage was never written appears under that key rather than being dropped:

      ```
      $ cd api && uv run python -c "
      import json
      from fastapi.encoders import jsonable_encoder
      print(json.dumps(jsonable_encoder({None: 3, 'pending': 1})))
      "
      {"null": 3, "pending": 1}
      ```

    - `round()` is half to even. `completion_rate` uses `pythonRound(x, 1)`, the helper
      item 3.x added for `analytics.py`, not `Math.round`: 1 complete of 16 posts is
      exactly 6.25 and reports 6.2.
    - `avg_duration_s` is tested for truthiness *before* rounding
      (`round(v, 0) if v else None`), so an average of exactly zero reports `null` and
      not `0`.

    **`avg_duration_s` is an integer on the wire, and the reason is FastAPI's encoder.**
    `EXTRACT(epoch FROM ...)` returns `numeric` on Postgres 17, so the average reached
    asyncpg as a `Decimal`, and FastAPI's `decimal_encoder` returns an `int` for a
    Decimal whose exponent is `>= 0`:

    ```
    $ set -a && . .env && set +a && cd api && PYTHONPATH=. uv run python -c "
    <run the avg select through get_session(), then func.version() and current_setting('TimeZone')>
    "
    avg type: <class 'decimal.Decimal'> Decimal('303.1177400000000000')
    PostgreSQL 17.8 on aarch64-unknown-linux-musl, ...
    tz: UTC
    ```

    ```
    $ cd api && uv run python -c "
    import json
    from decimal import Decimal
    from fastapi.encoders import jsonable_encoder
    print(json.dumps(jsonable_encoder(round(Decimal('1234.6'), 0))))
    print(json.dumps(jsonable_encoder(round(1234.6, 0))))
    "
    1235
    1235.0
    ```

    `pg` hands the same `numeric` back as a string, so the handler calls `Number()` on it
    before rounding. The one thing that cannot survive is a tie beyond double precision:
    `Decimal` rounds the exact value where the port rounds its nearest double. An average
    of epoch differences would have to be an exact `.5` at the 17th significant digit to
    diverge, which no real duration is.

    **Deviation: `?days=` repeated keeps the last value, not the first.** Same divergence
    recorded under 5.3c-i: Starlette's `QueryParams.get()` returns the last value of a
    repeated key and `URLSearchParams.get()` returns the first, so the handler reads
    `getAll("days").at(-1)`. Unlike `?stage=`, `days` is a required `int` once present,
    so `?days=` is an `int_parsing` 422 rather than a fallback to 30.

    **Not a deviation, measured: the `over_time` date needs no `::text` cast.** Bare `pg`
    parses a `date` (OID 1082) into a `Date` at the *local* midnight, which would have
    put an ISO timestamp where Python put `str(datetime.date)`. drizzle's node-postgres
    driver replaces that parser with the identity, so the column arrives as
    `YYYY-MM-DD` already:

    ```
    $ cd web && node -e "
    const {Pool}=require('pg');
    const p=new Pool({connectionString:process.env.DATABASE_URL_SYNC});
    p.query(\"select current_setting('TimeZone') as tz, avg(1.5::numeric) as a, cast(now() as date) as d, cast(now() as date)::text as dt from posts\")
     .then(r=>console.log(r.rows[0])).finally(()=>p.end());
    "
    { tz: 'UTC', a: '1.5000000000000000', d: 2026-08-23T05:00:00.000Z, dt: '2026-08-23' }

    $ npx vitest run src/app/api/analytics/probe-date.test.ts   # drizzle, throwaway probe
    typeof d string "2026-08-23"
    typeof t string "2026-08-23"
    ```

    The cast was written first and then removed, because negative control 5 below proved
    it changed nothing. The `over_time` test pins the string, so a driver upgrade that
    dropped the override fails a test rather than shipping ISO timestamps. The cast
    itself resolves in the session time zone, which is `UTC` on this server for both
    drivers, so the two stacks bucket a post into the same day.

    Note the one place the two halves of the response can disagree with each other, in
    both stacks: `over_time` buckets by the *session* time zone while `posts_today`
    counts from a UTC midnight computed in the application. They agree only because the
    server's TimeZone is UTC.

    Pre-implementation, with the handler stubbed to `Response.json({})`:

    ```
    $ cd web && npx vitest run src/app/api/analytics/dashboard.test.ts
     Test Files  1 failed (1)
          Tests  23 failed (23)
    ```

    The 23 tests run against the real database and real BetterAuth sessions:

    ```
    $ cd web && npx vitest run src/app/api/analytics/dashboard.test.ts --reporter=verbose
     + GET /api/analytics/dashboard > rejects an unauthenticated request 4ms
     + GET /api/analytics/dashboard > answers an empty history with zeros and a null average 17ms
     + ... > the days query parameter > answers a non-numeric value with pydantic's int_parsing 422 3ms
     + ... > the days query parameter > answers an empty value with a 422 rather than falling back to 30 2ms
     + ... > the days query parameter > enforces ge=1 with pydantic's ctx bound 2ms
     + ... > the days query parameter > enforces le=365 with pydantic's ctx bound 2ms
     + ... > the days query parameter > keeps the last value of a repeated key, as Starlette's QueryParams did 11ms
     + ... > by_status and the totals > buckets by current_stage and sums every group into total 8ms
     + ... > by_status and the totals > counts a null current_stage under the "null" key, as json.dumps did 6ms
     + ... > by_status and the totals > rounds completion_rate half to even, not half up 8ms
     + ... > by_status and the totals > reports a completion rate of 0 rather than dividing by zero 4ms
     + ... > avg_duration_s > averages completed_at minus created_at and rounds to a whole number 7ms
     + ... > avg_duration_s > emits a number, not the numeric string pg hands back 5ms
     + ... > avg_duration_s > reports null when nothing has completed 5ms
     + ... > avg_duration_s > reports null for an average of exactly zero, as Python's truthiness test did 5ms
     + ... > by_profile > orders by post count descending 9ms
     + ... > by_profile > limits the list to ten rows 26ms
     + ... > by_profile > groups by profile name, so two profiles sharing a name are one row 8ms
     + ... > over_time and posts_today > groups by UTC date, ascending, within the days window 7ms
     + ... > over_time and posts_today > excludes posts older than the days window 5ms
     + ... > over_time and posts_today > counts posts_today from UTC midnight, not from the days window 6ms
     + ... > scoping > excludes another user's posts from every aggregate 9ms
     + ... > scoping > excludes a post whose profile_id is null, through the inner join 5ms

     Test Files  1 passed (1)
          Tests  23 passed (23)
       Duration  710ms
    ```

    (vitest writes its pass glyph as a check mark; transcribed as `+` here.)

    Negative controls, each reverted after measuring. Nine were run; the fifth is the
    interesting one, because it had no teeth and that is what removed the cast:

    | # | Mutation | Result |
    | --- | --- | --- |
    | 1 | `pythonRound(rate, 1)` becomes `Math.round(rate * 1000) / 10` | 1 failed, 22 passed |
    | 2 | truthiness check becomes `avgSeconds === null` | 1 failed, 22 passed |
    | 3 | drop `Number()` and use the string `pg` returned | 3 failed, 20 passed |
    | 4 | skip the null `current_stage` bucket instead of keying it `"null"` | 1 failed, 22 passed |
    | 5 | drop the `::text` cast on the `over_time` date | **23 passed, no teeth** |
    | 6 | `getAll("days").at(-1)` becomes `get("days")` | 1 failed, 22 passed |
    | 7 | `by_profile` groups by `name, id` instead of `name` | 1 failed, 22 passed |
    | 8 | drop the ten-profile `limit` | 1 failed, 22 passed |
    | 9 | exclude the null bucket from `total` | 1 failed, 22 passed |

    ```
    ### 1. half-up rounding for completion_rate
           x rounds completion_rate half to even, not half up 13ms
          Tests  1 failed | 22 passed (23)
    ### 2. null-check instead of Python truthiness
           x reports null for an average of exactly zero, as Python's truthiness test did 7ms
          Tests  1 failed | 22 passed (23)
    ### 3. leave the numeric as the string pg returned
           x averages completed_at minus created_at and rounds to a whole number 9ms
           x emits a number, not the numeric string pg hands back 6ms
           x reports null for an average of exactly zero, as Python's truthiness test did 5ms
          Tests  3 failed | 20 passed (23)
    ### 4. drop the null current_stage bucket
           x counts a null current_stage under the "null" key, as json.dumps did 10ms
          Tests  1 failed | 22 passed (23)
    ### 5. drop the ::text cast on the over_time date
          Tests  23 passed (23)
    ### 6. first value of a repeated ?days= instead of the last
           x keeps the last value of a repeated key, as Starlette's QueryParams did 8ms
          Tests  1 failed | 22 passed (23)
    ### 7. group by_profile by id as well as name
           x groups by profile name, so two profiles sharing a name are one row 11ms
          Tests  1 failed | 22 passed (23)
    ### 8. drop the ten-profile cap
           x limits the list to ten rows 27ms
          Tests  1 failed | 22 passed (23)
    ### 9. exclude the null bucket from total
           x counts a null current_stage under the "null" key, as json.dumps did 8ms
          Tests  1 failed | 22 passed (23)
    RESTORED CLEAN
    ```

    Gates (run from inside `web/`, per the invocation note under 5.5e-iii, with the repo
    `.env` sourced):

    ```
    $ npx tsc --noEmit
    TSC EXIT=0
    (no output)

    $ npx eslint
    LINT EXIT=0
    (no output)

    $ npx vitest run
     Test Files  2 failed | 95 passed (97)
          Tests  9 failed | 1813 passed | 7 skipped (1829)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx. The scaffold-check lifecycle-event flake recorded under
    # 5.6 did not fire on this run. Passing count 1790 -> 1813 (+23).

    $ npx next build
    BUILD EXIT=0
    v Compiled successfully in 4.2s
    |- f /api/analytics/dashboard
    # The BetterAuth "default secret" lines are the pre-existing, environment-driven
    # warning recorded under item 1.2.

    $ cd api && uv run pytest -q
    120 failed, 241 passed, 25 errors in 15.08s
    # Baseline under 5.3c-iii-a was 125 failed, 236 passed, 25 errors, so this is five
    # fewer failures. No Python file changed in this iteration (`git status` lists only
    # the two new TypeScript files), so the move is environmental; it was not
    # investigated, and it is a move in the safe direction.

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

    **Not covered.** No browser drives `/monitor`'s overview tab against this handler.
    The proof is direct handler calls, which is the right level for the aggregation and
    the scoping, but it does not prove the tab's charts render the payload. That check
    belongs to Phase 8 item 8.8. The `days` selector on that tab is also never exercised
    end to end: `analytics.dashboard()` is called with no argument, so the dashboard only
    ever requests `?days=30`.

## 5.8b


    Ported to `web/src/app/api/analytics/costs/route.ts`. One row per
    `(post, stage_logs key)` pair out of a `jsonb_each` unroll, aggregated in
    the handler into the `CostAnalytics` shape `web/src/lib/api.ts` already
    declares. `api.ts` needed no change.

    **The Python endpoint being ported has never run.** Its SQL puts the
    `website_profiles` join inside the second `FROM` item, where the `posts`
    alias is not in scope, and `JOIN` binds tighter than the comma:

    ```
    $ cd api && PYTHONPATH=. uv run python - <<'PY'
    <the exact sql_str from cost_analytics(), executed through
     src.database.async_session against the real dev database>
    PY
    RAISED ProgrammingError
    (sqlalchemy.dialects.postgresql.asyncpg.ProgrammingError) <class 'asyncpg.exceptions.UndefinedTableError'>: invalid reference to FROM-clause entry for table "p"
    ```

    ```
    $ docker exec ...-db-1 psql -U pipeline -d content_pipeline -c "<the same SELECT>"
    ERROR:  invalid reference to FROM-clause entry for table "p"
    LINE 14:         JOIN website_profiles wp ON p.profile_id = wp.id
                                                 ^
    DETAIL:  There is an entry for table "p", but it cannot be referenced from this part of the query.
    ```

    Postgres rejects the statement before a parameter is bound, so every call
    answers 500 on every input. `git log` shows the file was added already in
    this state:

    ```
    $ git log --oneline -- api/src/api/analytics.py
    5f31ca4 saas updates
    $ git show --name-status 5f31ca4 -- api/src/api/analytics.py
    A	api/src/api/analytics.py
    ```

    The ten pytest cases in `api/tests/phase12/test_analytics.py::TestCosts`
    never caught it because they all fail earlier, on authentication, and have
    done since the multi-tenancy change:

    ```
    $ cd api && uv run pytest tests/phase12/test_analytics.py -q -k TestCosts
    E       AssertionError: assert 'model_costs_reference' in {'detail': 'Not authenticated'}
    10 failed, 22 deselected in 0.70s
    ```

    **Deviation 1, the join.** The join is moved onto `posts` so the endpoint
    does what it was written to do. Porting the 500 faithfully would ship a
    monitor page tab that cannot work, and there is no observable behaviour to
    preserve. Logged in `todo.md` as `[confirmed]`, because the Python route is
    still the one serving until Phase 7.

    ```
    $ docker exec ...-db-1 psql -U pipeline -d content_pipeline -c "<SELECT with
      the join moved onto posts>"
     stage_name | model | coalesce | post_id | profile_id | completed_at
    ------------+-------+----------+---------+------------+--------------
    (0 rows)
    ```

    **Deviation 2, `profile_id`.** Python declared it `str | None`, so pydantic
    passed anything through and a non-uuid reached the `uuid` column raw, which
    would surface as a 500. Validated here instead, with the same `uuid_parsing`
    422 body `GET /api/posts` answers for its own `profile_id`. An *empty* value
    is still not a filter at all: Python's guard is `if profile_id:`.

    **Deviation 3, wire types.** Python's per-bucket `tokens_in` starts as an
    `int` and accumulates a `float`, so a whole count serialises as `100.0`
    where JavaScript writes `100`. Both parse to the same number and
    `web/src/lib/api.ts` types the field as `number`, so no caller can tell.

    The arithmetic is done in the handler rather than pushed into SQL because
    Python's is order and type sensitive in ways Postgres aggregates are not,
    and each of the five behaviours has its own test:

    - `total_tokens_in` / `total_tokens_out` are float sums truncated by
      `int()`, not rounded, so 1000.9 reports as 1000;
    - `total_cost`, each `by_model` and `by_stage` bucket, each `cost_over_time`
      point and each `by_profile` row are rounded to six places with Python's
      half-to-even `round()`, via the existing `pythonRound` helper;
    - `avg_cost_per_post` rounds to *four* places and divides the *unrounded*
      total, by the count of distinct posts rather than the number of stage
      rows, and reports the integer `0` when there are none;
    - a stage row with no `model` is counted in `by_stage` and in the totals but
      gets no `by_model` bucket, so the two breakdowns need not sum alike;
    - `by_profile` is sorted by cost descending with a stable sort, so equal
      profiles keep first-seen order, exactly as Python's
      `sorted(..., reverse=True)` does.

    `sl.key NOT LIKE '\_%'` excludes keys beginning with a literal underscore,
    which is how the dead-letter path's `_error` key stays out of the totals.
    The backslash is `LIKE`'s default escape character, so it is the underscore
    that is escaped and not a wildcard:

    ```
    $ docker exec ...-db-1 psql -U pipeline -d content_pipeline -c \
      "select k, k not like '\_%' as kept from (values ('_error'),('research'),('xerror'),('a_b')) t(k)"
        k     | kept
    ----------+------
     _error   | f
     research | t
     xerror   | t
     a_b      | t
    ```

    `completed_at` is a `timestamptz` and Python called `.date()` on the
    UTC-aware datetime asyncpg returned, so the `cost_over_time` key is the UTC
    date whatever the session time zone is. Rendered as
    `to_char(p.completed_at at time zone 'UTC', 'YYYY-MM-DD')` so that stays
    true and so the value does not depend on which `pg` type parser is
    installed for OID 1184. This server's sessions are in UTC
    (`show TimeZone` -> `UTC`, `show server_version` -> `17.8`), which is why
    negative control 5 below has no teeth.

    `MODEL_COSTS` is ported to `web/src/mastra/model-costs.ts` value for value.
    It is deliberately *not* the two rates `web/src/mastra/execution-log.ts`
    carries: Python had the same split, one table used by
    `log_stage_execution()` and the analytics reference, one pair of Opus rates
    hardcoded in `worker.py`'s `stage_complete` entry, and both halves are
    served through the API.

    `parseDays()` and `DAY_MS` moved out of the dashboard handler into
    `web/src/app/api/analytics/days.ts`, since three of this router's four
    endpoints declare `days: int = Query(30, ge=1, le=365)` identically.

    Pre-implementation, with `costs/route.ts` moved aside:

    ```
    $ npx vitest run src/app/api/analytics/costs.test.ts
     FAIL  src/app/api/analytics/costs.test.ts [ src/app/api/analytics/costs.test.ts ]
    Error: Cannot find module './costs/route' imported from '.../web/src/app/api/analytics/costs.test.ts'
     Test Files  1 failed (1)
          Tests  no tests
    ```

    The 30 tests are in `web/src/app/api/analytics/costs.test.ts`, against the
    real database and real BetterAuth sessions. Pass and fail glyphs transcribed
    as `+` and `x`:

    ```
    $ npx vitest run src/app/api/analytics/costs.test.ts --reporter=verbose
     + GET /api/analytics/costs > rejects an unauthenticated request
     + GET /api/analytics/costs > answers an empty history with zeros and empty breakdowns
     + GET /api/analytics/costs > serves the model price table as the cost reference
     + aggregation > sums tokens and cost across every stage of every post
     + aggregation > breaks the totals down by model with a call count
     + aggregation > breaks the totals down by stage name
     + aggregation > rounds each breakdown's cost to six places after summing, as Python does
     + aggregation > counts a stage with no model in by_stage but not in by_model
     + aggregation > treats a missing token or cost field as zero rather than dropping the row
     + aggregation > truncates a fractional token total the way Python's int() does
     + aggregation > excludes keys that begin with an underscore, which is how _error stays out
     + aggregation > keeps a stage whose name merely contains an underscore
     + aggregation > ignores a post with no stage logs at all
     + avg_cost_per_post > divides the total by the number of distinct posts, not the number of stages
     + avg_cost_per_post > rounds to four places the way Python's round() does, half to even
     + cost_over_time > buckets by the UTC date the post completed, ascending and rounded
     + cost_over_time > uses UTC rather than the session time zone for the date boundary
     + cost_over_time > omits a post that has not completed, while still counting its cost
     + by_profile > resolves profile names and orders them by cost, most expensive first
     + by_profile > keeps two profiles with the same cost as separate rows
     + scoping > never reports another user's costs
     + scoping > is blind to a post whose profile_id is null
     + filters > windows on created_at with days
     + filters > restricts to one profile with profile_id
     + filters > restricts to one model with model
     + filters > treats an empty profile_id or model as no filter, matching Python's `if value:`
     + filters > answers a profile_id that is not a uuid with pydantic's uuid_parsing 422
     + filters > answers a non-numeric days with pydantic's int_parsing 422
     + filters > answers days=0 with pydantic's greater_than_equal 422
     + filters > answers days=366 with pydantic's less_than_equal 422
     Test Files  1 passed (1)
          Tests  30 passed (30)
    ```

    Negative controls, each applied to a pristine copy of the handler, measured,
    and reverted. Three rounds: the first found three controls with no teeth,
    two of which were fixed by strengthening the fixtures and re-measured.

    | # | Control | Result |
    | --- | --- | --- |
    | 1 | drop the `sl.key not like '\_%'` filter | 1 failed: `excludes keys that begin with an underscore` |
    | 2 | round `avg_cost_per_post` with `toFixed(4)` | 1 failed: `rounds to four places ... half to even` |
    | 3 | drop the `wp.user_id` predicate | 1 failed: `never reports another user's costs` |
    | 4 | make the `website_profiles` join a `left join` | 30 passed, **no teeth** (see below) |
    | 5 | bucket `cost_over_time` in the session time zone | 30 passed, **no teeth** (see below) |
    | 6 | divide by the row count instead of distinct posts | 1 failed: `divides the total by the number of distinct posts` |
    | 7 | drop the six-place rounding of `by_model` / `by_stage` | first round 30 passed; after the fixture fix, 1 failed: `rounds each breakdown's cost to six places` |
    | 8 | leave `cost_over_time` in first-seen order | 1 failed: `buckets by the UTC date ... ascending` |
    | 9 | drop `Math.trunc` from the token totals | 1 failed: `truncates a fractional token total` |
    | 10 | sort `by_profile` ascending | 1 failed: `resolves profile names and orders them by cost` |
    | 11 | bucket a null model under `""` instead of skipping it | 1 failed: `counts a stage with no model in by_stage but not in by_model` |
    | 12 | treat an empty `profile_id` as a filter (`!== null`) | 1 failed: `treats an empty profile_id or model as no filter` |
    | 13 | drop the six-place rounding of `cost_over_time` | first round 30 passed; after the fixture fix, 1 failed: `buckets by the UTC date ... and rounded` |

    Controls 7 and 13 passed on the first round because the fixtures happened to
    use costs whose sums are exact doubles: `0.01 + 0.02` *is* the double
    nearest 0.03 (`node -e '0.01+0.02===0.03'` prints `true`), so nothing needed
    rounding. Both fixtures were changed to `0.1 + 0.2`, which is
    `0.30000000000000004`, and both controls then fail. The half-to-even control
    needed the same treatment: an exact tie at four places requires a value of
    the form `odd / 2**k`, so the fixture is two posts at `0.03125` each rather
    than a decimal that merely looks like a tie.

    Control 4 has no teeth and cannot: `wp.user_id = <id>` is NULL for an
    unmatched row under a `left join` too, so the `WHERE` clause drops it either
    way. Python's inner join is reproduced because the statement is a port, but
    the behaviour under test belongs to the predicate, and the test is named for
    the predicate now rather than the join.

    Control 5 has no teeth on this server because its sessions run in UTC, so
    the handler cannot be made to disagree with itself through a request. The
    test instead runs both expressions side by side on a dedicated pooled
    connection set to `Pacific/Kiritimati` (UTC+14) and asserts they differ,
    which is what makes the `at time zone 'UTC'` load bearing rather than
    decorative.

    Gates:

    ```
    $ npx tsc --noEmit
    TSC EXIT=0
    (no output)

    $ npx eslint
    LINT EXIT=0
    (no output)

    $ npx vitest run          # run 1
     Test Files  3 failed | 95 passed (98)
          Tests  10 failed | 1842 passed | 7 skipped (1859)

    $ npx vitest run          # run 2
     Test Files  2 failed | 96 passed (98)
          Tests  9 failed | 1843 passed | 7 skipped (1859)
    # 9 failed is the recorded baseline: 6 in image-preview.test.tsx and 3 in
    # PostDetail.test.tsx. The tenth on run 1 is scaffold-check.test.ts >
    # "emits the workflow lifecycle events the trace view will read", the
    # load-sensitive discrepancy recorded under 5.6 and 5.5e-ii; it fired on one
    # of the two runs. Passing count 1813 -> 1843 (+30), total 1829 -> 1859.

    $ npx next build
    BUILD EXIT=0
    v Compiled successfully in 4.1s
    |- f /api/analytics/costs
    # The 15 BetterAuth "default secret" lines are the pre-existing,
    # environment-driven warning recorded under item 1.2.

    $ cd api && uv run pytest -q
    120 failed, 241 passed, 25 errors in 15.07s
    # Unchanged from the count recorded under 5.8a.

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

    **Not covered.** No browser drives `/monitor`'s costs tab against this
    handler, so nothing here proves the charts render the payload; that check
    belongs to Phase 8 item 8.8. The `model` filter is also never exercised
    end to end, because `web/src/lib/api.ts`'s `analytics.costs()` is called
    with no arguments from the dashboard, so only `?days=30` is ever requested
    in practice.

## 5.8c


    Ported to `web/src/app/api/analytics/models/route.ts`. Three independent
    queries (a `stage_logs` unroll grouped by model, the same unroll grouped by
    stage key, a `stage_status` unroll pivoted in the handler), assembled into
    the `ModelAnalytics` shape `web/src/lib/api.ts` already declares. `api.ts`
    needed no change: every field and type already matched what the handler
    returns.

    **The FROM clause was probed before porting, because 5.8b's was broken.**
    `/costs` put its `website_profiles` join inside the second `FROM` item and
    answered 500 on every call. `/models` looks the same at a glance but is not:
    its join sits *ahead* of the comma, so `posts JOIN website_profiles` is the
    first item and `jsonb_each(p.stage_logs)` is an implicitly `LATERAL` second
    one. Executed against the live database rather than assumed:

    ```
    $ cd web && PROBE_URL="<DATABASE_URL_SYNC from .env>" node probe_models_sql.mjs
    OK rowCount= 0
    FIELDS model:25 call_count:20 avg:701 avg:701 avg:701 sum:701
    ```

    (`probe_models_sql.mjs` ran the endpoint's first query verbatim, with a
    `user_id` nobody owns. It parses, plans and executes, so no correction is
    needed here and none was made.)

    That output also settled the wire types. `call_count` is OID 20, `bigint`,
    and `pg` decodes `bigint` to a **string** rather than risk a lossy `Number`.
    Python's asyncpg decoded it to an `int`. Confirmed through the same drizzle
    client the handler uses, because drizzle installs its own type-parser
    overrides:

    ```
    $ cd web && npx vitest run src/probe_types.test.ts
    stdout | src/probe_types.test.ts > probe > types
    [{"call_count":"2","a":1.5,"s":5}] [ [ 'call_count=string', 'a=number', 's=number' ] ]
     ✓ src/probe_types.test.ts (1 test) 18ms
    ```

    So every count on this endpoint is converted with `Number()` or it goes out
    quoted; `AVG`/`SUM` over the `::float` casts are OID 701 `double precision`
    and arrive as numbers already. (This is the opposite of 5.8a, where the
    average came back as `numeric` and took FastAPI's `decimal_encoder` int
    path.)

    **Failing first.** The handler was replaced by a stub returning
    `{models: [], stage_performance: [], stage_success_rates: []}` and the suite
    run against it:

    ```
    $ cd web && npx vitest run src/app/api/analytics/models.test.ts
     Test Files  1 failed (1)
          Tests  26 failed | 2 passed (28)
    ```

    The two that passed are the 401 (no database work) and the empty
    `stage_logs` case (an empty `models` array is what the stub returns).

    **Passing.**

    ```
    $ cd web && npx vitest run src/app/api/analytics/models.test.ts --reporter=verbose
     + GET /api/analytics/models > rejects an unauthenticated request 3ms
     + GET /api/analytics/models > answers an empty history with no models, no stages and six zeroed rates 19ms
     + models > averages tokens and duration and sums cost across every call of a model 6ms
     + models > reports call_count as a number, not the string pg decodes bigint to 5ms
     + models > groups by model and orders by call count descending 8ms
     + models > excludes a call that recorded no model, while stage_performance keeps it 5ms
     + models > treats a missing numeric key as zero rather than dropping the call 4ms
     + models > rounds the token averages half to even, where Math.round would round up 4ms
     + models > rounds avg_duration_s half to even at one place, where toFixed rounds away 4ms
     + models > rounds total_cost half to even at six places 4ms
     + models > filters both rollups by model, leaving the success rates alone 4ms
     + models > treats an empty model parameter as no filter at all 4ms
     + models > takes the last value of a repeated model parameter, as Starlette does 4ms
     + models > answers no rows for a model nobody used 4ms
     + stage_performance > groups by stage key and orders by that key, not by pipeline order 4ms
     + stage_performance > averages duration and sums cost across every post that ran the stage 4ms
     + stage_performance > reports runs as a number, not the string pg decodes bigint to 4ms
     + excluded rows > excludes keys beginning with an underscore from both rollups 4ms
     + excluded rows > keeps a stage whose name merely contains an underscore 4ms
     + excluded rows > excludes a post with an empty stage_logs object 4ms
     + excluded rows > excludes another user's posts from every rollup 7ms
     + excluded rows > excludes a post with no profile, which has no owner to scope by 4ms
     + stage_success_rates > counts complete and failed separately and totals every status 5ms
     + stage_success_rates > reports every stage in pipeline order, zeroed when it never ran 3ms
     + stage_success_rates > rounds the success rate half to even, where toFixed rounds away 12ms
     + stage_success_rates > ignores a stage_status key that is not a pipeline stage 3ms
     + stage_success_rates > excludes a post with an empty stage_status object 3ms
     + stage_success_rates > counts a stage_status entry even when the post logged no stages 3ms

     Test Files  1 passed (1)
          Tests  28 passed (28)
    ```

    (vitest's pass glyph is a check mark; transcribed as `+` here. The full
    test names are prefixed with the file path in the real output and are
    trimmed to the describe path above.)

    **Cross-stack parity against the running Python endpoint.** Unlike 5.8b,
    this endpoint executes, so parity was measured rather than argued. A probe
    wrote one profile and seventeen posts with deliberately awkward fixtures (an
    exact `0.25` duration, a `0.0078125` cost, a stage with no `model`, a stage
    with only `model` and `cost_usd` set, an `_error` key, an empty
    `stage_logs`, a `stage_status` key outside `STAGES`, and enough `research`
    rows for an exact `6.25` success rate), then called the TypeScript handler.
    The Python router was then mounted on a bare `FastAPI()` under `TestClient`
    with `get_current_user` overridden to the same user id and `get_session`
    bound to the real dev database, and called on the same rows:

    ```
    $ cd api && PYTHONPATH=. uv run python /tmp/probe_models_py.py
    STATUS 200
    {"models":[{"model":"claude-opus-4-6","call_count":2,"avg_tokens_in":8.0,...
    ```

    ```
    $ diff <(python3 -c "import json;print(json.dumps(json.load(open('/tmp/models-py.json')),sort_keys=True,indent=1))") \
           <(python3 -c "import json;print(json.dumps(json.load(open('/tmp/models-ts.json')),sort_keys=True,indent=1))")
    5,6c5,6
    <    "avg_tokens_in": 8.0,
    <    "avg_tokens_out": 4.0,
    ---
    >    "avg_tokens_in": 8,
    >    "avg_tokens_out": 4,
    ... (11 hunks, every one of this form)
    86c86
    <    "success_rate": 100.0,
    ---
    >    "success_rate": 100,
    ```

    ```
    $ python3 -c "
    import json
    py=json.load(open('/tmp/models-py.json')); ts=json.load(open('/tmp/models-ts.json'))
    print('deep equal after parse:', py==ts)
    for r in py['stage_success_rates']:
        print(r['stage'], repr(r['success_rate']), type(r['success_rate']).__name__)
    "
    deep equal after parse: True
    research 13.3 float
    outline 0.0 float
    write 0.0 float
    edit 0 int
    images 0.0 float
    ready 100.0 float
    ```

    Every number agrees exactly, including the two half-to-even ties Python's
    `round()` decides differently from `Math.round` and `toFixed`. The only
    textual difference is trailing-zero rendering.

    **Deviation 1, recorded: whole-number floats render without `.0`.** Python
    `round(float, n)` returns a `float`, so `8.0`, `3.0`, `0.0` and `100.0` go
    out with a decimal point. JavaScript has one number type, so the same values
    render `8`, `3`, `0`, `100`. `JSON.parse` produces the identical `number`
    from both, `web/src/lib/api.ts` types every one of these fields as `number`,
    and the diff above is the complete extent of it. Notice Python is not even
    self-consistent here: `success_rate` is a `float` for a stage that ran and
    an `int` (`0`) for one that did not, because the `else 0` branch returns an
    `int` literal. Nothing can depend on the distinction.

    **Deviation 2, recorded: the repeated-parameter rule.** Starlette's
    `QueryParams.get()` returns the *last* value of a repeated key where
    `URLSearchParams.get()` returns the first, so `model` is read off
    `getAll("model").at(-1)`. This matches Python; it is the ported `/costs`
    handler from 5.8b that does not, and that is logged in `todo.md` rather than
    fixed here so this iteration stays one ledger item.

    **What is preserved deliberately, each with its own test:**

    - `sl.key NOT LIKE '\_%'` excludes keys starting with a literal underscore
      (`_error` from the dead-letter path) from both `stage_logs` rollups, and
      applies to neither `stage_status` nor a key that merely contains an
      underscore.
    - `sl.value->>'model' IS NOT NULL` drops unmodelled calls from `models`
      while `stage_performance` keeps them, so the two rollups need not agree on
      their call totals.
    - The `model` filter applies to `models` and `stage_performance` and *not*
      to `stage_success_rates`, which reads `stage_status` where no model is
      recorded.
    - Python's guard is `if model:`, so `?model=` is not a filter at all.
    - `ss.value::text` renders a jsonb string with its quotes; Python stripped
      them with `str.strip('"')`, which removes every leading and trailing quote
      rather than one from each end, and *assigns* rather than accumulates, so
      two jsonb values stripping to the same key keep only the last.
    - `stage_success_rates` is projected over `STAGES` in pipeline order, so all
      six rows are always present and a `stage_status` key outside `STAGES` is
      dropped, whereas `stage_performance` is ordered by the key Postgres sorted
      on.
    - `round(completed / total_runs * 100, 1) if total_runs > 0 else 0` reports
      an unrun stage as `0` rather than dividing by zero.

    **Negative controls.** Each was applied to the handler, the suite run, then
    reverted.

    | # | Control | Result |
    | --- | --- | --- |
    | 1 | `call_count` left as the string `pg` decodes `bigint` to | 6 failed, 22 passed |
    | 2 | `Math.round` for the token averages | 1 failed, 27 passed |
    | 3 | `toFixed(1)` for `avg_duration_s` | 1 failed, 27 passed |
    | 4 | `toFixed(6)` for `total_cost` | 1 failed, 27 passed |
    | 5 | `sl.key not like '\_%'` dropped from the models query | 1 failed, 27 passed |
    | 6 | `sl.value->>'model' is not null` dropped | 1 failed, 27 passed |
    | 7 | first repeated `model` value instead of last | 1 failed, 27 passed |
    | 8 | `model !== undefined` instead of truthiness | 1 failed, 27 passed |
    | 9 | `model` filter also applied to the `stage_status` query | 3 failed, 25 passed |
    | 10 | jsonb quotes not stripped off the status | 5 failed, 23 passed |
    | 11 | `wp.user_id = <caller>` replaced with `wp.user_id is not null` | 1 failed, 27 passed |
    | 12 | rates projected over the seen keys instead of `STAGES` | 7 failed, 21 passed |
    | 13 | `totalRuns > 0` guard dropped from `success_rate` | 5 failed, 23 passed |
    | 14 | `order by call_count desc` replaced with `order by model` | **28 passed, no teeth** |

    Control 14 exposed a weak test rather than confirming a strong one. The
    ordering test used `claude-opus-4-6` (3 calls) and `sonar-pro` (1 call), and
    those two happen to sort the same way by count descending and by name
    ascending, so the assertion could not tell the orderings apart. The test now
    adds a second round in which `sonar-pro` reaches 4 calls, making the count
    order the reverse of the alphabet, and the control was re-run:

    ```
    CONTROL 14 (retry) order by call_count desc dropped =>       Tests  1 failed | 27 passed (28)
    ```

    **Gates.**

    ```
    $ cd web && npx tsc --noEmit
    (no output)
    tsc exit=0

    $ cd web && npx eslint
    (no output)
    eslint exit=0

    $ cd web && npx next build
    exit=0
    ✓ Compiled successfully in 4.1s
    ├ ƒ /api/analytics/models
    ```

    The build also prints 15 `[Error [BetterAuthError]: You are using the
    default secret ...]` lines while collecting page data for the 15 prerendered
    `/auth/[path]` routes. This is pre-existing and environmental, not a
    regression: `BETTER_AUTH_SECRET` is absent from the repo `.env`
    (`grep -c BETTER_AUTH_SECRET ../.env` answers `0`), and a build with this
    item's route directory moved aside prints the same 15 lines and also exits
    0. Logged in `todo.md`.

    ```
    $ cd web && npx vitest run          # whole suite, three runs
     Test Files  3 failed | 96 passed (99)
          Tests  10 failed | 1870 passed | 7 skipped (1887)
     Tests  9 failed | 1871 passed | 7 skipped (1887)
     Tests  9 failed | 1871 passed | 7 skipped (1887)

    $ cd web && npx vitest run          # same, with this item's two files moved aside
     Test Files  2 failed | 96 passed (98)
          Tests  9 failed | 1843 passed | 7 skipped (1859)
    ```

    Both sides measured, as the standing `todo.md` entry requires. The floor is
    the 9 known failures (6 in `image-preview.test.tsx`, 3 in
    `PostDetail.test.tsx`). The tenth, `scaffold-check.test.ts > emits the
    workflow lifecycle events the trace view will read`, is the recorded
    load-sensitive flake: it fired on 1 of the 3 runs with this item's files
    present and on 0 of 1 without them, which is the same 1-in-3 rate recorded
    at HEAD under 5.6 and is not attributable to this change.

    ```
    $ cd api && uv run pytest -q
    120 failed, 241 passed, 25 errors in 14.99s

    $ cd api && uv run ruff check .
    Found 32 errors.
    [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 131 files already formatted
    ```

    Unchanged from the counts recorded under 5.8a and 5.8b. No Python changed in
    this iteration.

    **Not covered.** No browser drives `/monitor`'s models tab against this
    handler, so nothing here proves the charts render the payload; that check
    belongs to Phase 8 item 8.8. The `model` filter is never exercised end to
    end either, because `web/src/lib/api.ts`'s `analytics.models()` is called
    with no arguments from the dashboard.

## 5.8d-i


      `web/src/app/api/analytics/from-isoformat.ts` exports `fromIsoFormat()` (the
      round trip, or `null` where CPython raises `ValueError`) and
      `toPythonUtcIsoFormat()` (`datetime.now(UTC).isoformat()` for a JavaScript
      `Date`, which is how the default 90-day lower bound is rendered).

      **This is load-bearing, not cosmetic.** Both bounds are compared as *text*
      against `log_entry->>'ts'`, which is itself `datetime.now(UTC).isoformat()`
      (`api/src/pipeline/helpers.py:112`), so the two strings have to be in the same
      shape or the comparison is nonsense. The dashboard sends
      `new Date(...).toISOString()` (`web/src/app/monitor/_components/logs-tab.tsx:78`),
      which ends in `Z` with three fractional digits; CPython rewrites that to `+00:00`
      with six. `Z` is 0x5A and `+` is 0x2B, so a bound that kept its `Z` would sort
      above every stored timestamp in the same second and silently drop those rows.

      The grammar was pinned by running candidates through the CPython that serves the
      router, not read from a specification, because CPython's parser is looser than
      ISO 8601 in ways that reach this endpoint:

      ```
      $ cd api && uv run python -c "
      from datetime import datetime
      import sys
      print(sys.version)
      for c in ['2026-08-23T12:34:56.789Z','2026-08-23X12:34:56','2026-W34-7',
                '20260823T123456','2026-08-23T12:34.5','2026-08-23T12:34:56z',
                '2026-08-23T12:34:56+05:99','2026-08-23T12:34:56-00:00:00.500000',
                '2026-08-23T12:34:56-00:00:01.500000','2026-0823','2025-W53-1']:
          try: print(repr(c),'->',repr(datetime.fromisoformat(c).isoformat()))
          except Exception as e: print(repr(c),'-> ERR',e)
      "
      3.13.12 (main, Feb 12 2026, 01:06:02) [Clang 21.1.4 ]
      '2026-08-23T12:34:56.789Z' -> '2026-08-23T12:34:56.789000+00:00'
      '2026-08-23X12:34:56' -> '2026-08-23T12:34:56'
      '2026-W34-7' -> '2026-08-23T00:00:00'
      '20260823T123456' -> '2026-08-23T12:34:56'
      '2026-08-23T12:34.5' -> '2026-08-23T12:34:00.500000'
      '2026-08-23T12:34:56z' -> ERR Invalid isoformat string: '2026-08-23T12:34:56z'
      '2026-08-23T12:34:56+05:99' -> '2026-08-23T12:34:56+06:39'
      '2026-08-23T12:34:56-00:00:00.500000' -> '2026-08-23T12:34:56+00:00'
      '2026-08-23T12:34:56-00:00:01.500000' -> '2026-08-23T12:34:56-00:00:01.500000'
      '2026-0823' -> ERR Invalid isoformat string: '2026-0823'
      '2025-W53-1' -> ERR Invalid isoformat string: '2025-W53-1'
      ```

      Six behaviours out of that, each of which the port reproduces:

      1. The date/time separator is any single character, not just `T`.
      2. Basic and extended forms are both accepted, but a component may not mix
         them, which is why `2026-0823` is rejected.
      3. Week dates are accepted (`2026-W34-7`, `2026W347`); ordinal dates
         (`2026-002`) are not. A week 53 that the ISO year does not have is
         rejected, so `2025-W53-1` fails while `2026-W53-1` resolves to
         `2026-12-28`.
      4. A `[.,]` fraction is microseconds appended after whichever component came
         last, so `12:34.5` is `12:34:00.500000` rather than half a minute.
      5. `Z` is accepted only uppercase and only as the final character.
      6. An offset is rejected only for magnitude, never for its minute or second
         component: `+05:99` is a valid `+06:39`. And CPython's
         `tzinfo_from_isoformat_results()` returns UTC whenever the *whole-second*
         offset is zero, discarding a sub-second remainder, which is why
         `-00:00:00.500000` reads back as `+00:00` while `-00:00:01.500000` keeps
         its half second. That asymmetry was found by probing, not by reading.

      The oracle is `web/src/app/api/analytics/data/from-isoformat-parity.json`, 128
      cases (45 of them rejections) generated by running each string through that same
      CPython. It is committed because `api/` is deleted in Phase 7 and the table
      cannot be regenerated afterwards. The generator:

      ```
      $ cd api && uv run python - <<'PY' > ../web/src/app/api/analytics/data/from-isoformat-parity.json
      import json, sys
      from datetime import datetime
      CASES = [...]   # the 128 strings, in the order the committed file lists them
      rows = []
      for case in CASES:
          try:
              rows.append({"in": case, "out": datetime.fromisoformat(case).isoformat()})
          except ValueError:
              rows.append({"in": case, "out": None})
      json.dump({"python": sys.version.split()[0], "generator": "...", "cases": rows},
                sys.stdout, indent=2)
      PY

      $ python3 -c "import json;d=json.load(open('web/src/app/api/analytics/data/from-isoformat-parity.json'));print(d['python'], len(d['cases']), 'cases,', sum(1 for c in d['cases'] if c['out'] is None), 'rejected')"
      3.13.12 128 cases, 45 rejected
      ```

      Failing first, before the module existed:

      ```
      $ cd web && npx vitest run src/app/api/analytics/from-isoformat.test.ts
       2  |  import { fromIsoFormat, toPythonUtcIsoFormat } from "./from-isoformat";
          |                                                       ^
       Test Files  1 failed (1)
            Tests  no tests
      ```

      Passing, 134 tests (the 128 oracle rows plus 6 hand-written):

      ```
      $ cd web && npx vitest run src/app/api/analytics/from-isoformat.test.ts --reporter=verbose
       ✓ fromIsoFormat > reads the oracle table CPython generated 0ms
       ✓ fromIsoFormat > normalises to 2026-08-23T12:34:56.789000+00:00: "2026-08-23T12:34:56.789Z" 0ms
       ✓ fromIsoFormat > normalises to 2026-08-23T00:00:00+00:00: "2026-08-23T00:00:00.000Z" 0ms
       ...
       ✓ fromIsoFormat > rejects: "2026-08-23Z" 0ms
       ✓ fromIsoFormat > normalises to 2026-08-23T05:30:00: "2026-08-23+05:30" 0ms
       ✓ fromIsoFormat > normalises the exact string the logs tab sends 0ms
       ✓ fromIsoFormat > keeps a normalised value orderable against a stored ts 0ms
       ✓ toPythonUtcIsoFormat > renders an aware UTC datetime the way Python does 0ms
       ✓ toPythonUtcIsoFormat > omits the fraction when the millisecond is zero, as Python omits microsecond 0 0ms
       ✓ toPythonUtcIsoFormat > round-trips through fromIsoFormat unchanged 0ms

       Test Files  1 passed (1)
            Tests  134 passed (134)
      ```

      134 of 134 passing on the first run is exactly the shape a toothless table test
      has, so every rule the implementation encodes was mutated and re-run. Each
      mutation was checked with `cmp` against a saved copy first, because the file is
      untracked and `git diff --quiet` reports no change for an untracked file, which
      silently turned the first attempt at this table into eight "did not apply" rows.

      ```
      CONTROL 1 Z suffix not rewritten to +00:00                  Tests 5 failed | 129 passed (134)
      CONTROL 2 fraction rendered with 3 digits not 6             Tests 21 failed | 113 passed (134)
      CONTROL 3 extended date tolerates a missing dash            Tests 1 failed | 133 passed (134)
      CONTROL 4 tzoffset==0 no longer collapses to UTC            Tests 4 failed | 130 passed (134)
      CONTROL 5 week 53 accepted in a 52-week year                Tests 1 failed | 133 passed (134)
      CONTROL 6 offset bound of 24 hours dropped                  Tests 2 failed | 132 passed (134)
      CONTROL 7 time separators made optional per component       Tests 4 failed | 130 passed (134)
      CONTROL 8 default lower bound rendered with Z               Tests 3 failed | 131 passed (134)
      ```

      Controls 3 and 5 kill exactly one test each, which is correct rather than weak:
      each rule has one oracle row (`2026-0823`, `2025-W53-1`) and killing the rule
      kills that row.

      **Deviation: `toPythonUtcIsoFormat()` loses sub-millisecond precision.** A
      JavaScript `Date` carries milliseconds where a `datetime` carries microseconds,
      so the default lower bound always ends `.NNN000` where Python's ends `.NNNNNN`.
      The value is only ever a `>=` bound on a 90-day window and both stacks compute it
      from the current clock, so it cannot change which rows match. Recorded rather
      than chased.

      **Not covered.** Nothing here touches the database or the handler: this item is
      the parser alone, and the SQL that consumes its output belongs to 5.8d-ii. The
      Python endpoint's own behaviour on a string CPython rejects is a 500, verified
      below and logged in `todo.md`; 5.8d-ii decides what the port answers instead.

      ```
      $ cd api && PYTHONPATH=. uv run python /tmp/probe_logs_500_5_8d.py
      ?since=nope -> 500 Internal Server Error
      ?until=nope -> 500 Internal Server Error
      ?since=2026-13-01 -> 500 Internal Server Error
      ?page=0 -> 422 {"detail":[{"type":"greater_than_equal","loc":["query","page"],...
      ?per_page=201 -> 422 {"detail":[{"type":"less_than_equal","loc":["query","per_page"],...
      ```

      Gates. The frontend suite floor is the recorded 9 (6 in `image-preview.test.tsx`,
      3 in `PostDetail.test.tsx`); passing count 1871 -> 2005, which is exactly the 134
      added.

      ```
      $ cd web && npx tsc --noEmit
      (no output, exit 0)

      $ cd web && npx eslint
      (no output, exit 0)

      $ cd web && npx vitest run
       Test Files  2 failed | 98 passed (100)
            Tests  9 failed | 2005 passed | 7 skipped (2021)

      $ cd web && npx vitest run src/components/__tests__/image-preview.test.tsx src/app/posts/PostDetail.test.tsx src/mastra/workflows/scaffold-check.test.ts
       ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed) 30ms
       ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed) 3327ms
       Test Files  2 failed | 1 passed (3)
            Tests  9 failed | 20 passed (29)

      $ cd web && npx next build
      ✓ Compiled successfully in 4.1s
      build exit=0
      (plus the standing 15 BetterAuthError lines, count unchanged)

      $ cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.15s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

      Unchanged from the counts recorded under 5.8a to 5.8c. No Python changed in this
      iteration.

## 5.8d-ii


      Ported to `web/src/app/api/analytics/logs/route.ts`. `execution_logs` is
      unrolled with `jsonb_array_elements`, filtered by up to six optional
      predicates plus the caller's `user_id` and the `since` lower bound, counted,
      then fetched a page at a time. The `PaginatedLogs` and `LogEntry` shapes
      `web/src/lib/api.ts` already declares needed no change: every field and type
      already matched what the handler returns.

      The `FROM` clause is the working shape, the same one `/models` uses:
      `posts JOIN website_profiles` is the first item and
      `jsonb_array_elements(p.execution_logs)` an implicitly `LATERAL` second one.
      Probed rather than inferred, because `/costs` reads almost identically and
      its join sits inside the second item where the `posts` alias is out of scope.

      **Validation order, probed off the real router.** FastAPI validates every
      declared parameter before the endpoint body runs, so a bad `page` is
      reported even when `since` is also unparseable, and the two `int` parameters
      are reported together in declaration order:

      ```
      $ cd api && PYTHONPATH=. uv run python /tmp/probe_logs_order.py
      ?page=0 422 {"detail": [{"type": "greater_than_equal", "loc": ["query", "page"], "msg": "Input should be greater than or equal to 1", "input": "0", "ctx": {"ge": 1}}]}
      ?page=abc&per_page=999 422 {"detail": [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "abc"}, {"type": "less_than_equal", "loc": ["query", "per_page"], "msg": "Input should be less than or equal to 200", "input": "999", "ctx": {"le": 200}}]}
      ?per_page=201 422 {"detail": [{"type": "less_than_equal", "loc": ["query", "per_page"], "msg": "Input should be less than or equal to 200", "input": "201", "ctx": {"le": 200}}]}
      ?page=2.0 200 {"items": [], "total": 0, "page": 2, "per_page": 50, "pages": 0}
      ?page=abc&since=nonsense 422 {"detail": [{"type": "int_parsing", "loc": ["query", "page"], "msg": "Input should be a valid integer, unable to parse string as an integer", "input": "abc"}]}
      ?level=a&level=b 200 {"items": [], "total": 0, "page": 1, "per_page": 50, "pages": 0}
      ?page=1&page=3 200 {"items": [], "total": 0, "page": 3, "per_page": 50, "pages": 0}
      ```

      `?page=1&page=3` answering `3` confirms Starlette's `QueryParams.get()` takes
      the *last* value of a repeated key, so every parameter here is read off
      `getAll(name).at(-1)` rather than `URLSearchParams.get()`.

      **The two 500s, confirmed.** With `page` valid, an unparseable bound escapes
      the handler:

      ```
      $ cd api && PYTHONPATH=. uv run python /tmp/probe_500.py
      ?since=nonsense 500 Internal Server Error
      ?until=nonsense 500 Internal Server Error
      ?since= 200 {"items":[],"total":0,"page":1,"per_page":50,"pages":0}
      ?since=2026-08-23T00:00:00Z 200 {"items":[],"total":0,"page":1,"per_page":50,"pages":0}
      ```

      `?since=` is a 200: Python's guard is `if not since:`, so an empty value
      falls back to the default 90-day window rather than being parsed. Same for
      every other optional filter, all of which use `if <value>:`.

      **The `= ANY(:levels)` binding needed a different shape.** drizzle's `sql`
      template expands a JS array into one placeholder per element, which parses as
      a record, so neither the bare array nor a cast works:

      ```
      $ cd web && npx vitest run src/app/api/analytics/probe-array.test.ts
      Caused by: error: op ANY/ALL (array) requires array on right side     # any(${levels})
      Caused by: error: cannot cast type record to text[]                   # any(${levels}::text[])
      ```

      Building the array in SQL with `sql.join` does work, and quotes correctly:

      ```
      ["info","error"] -> ["info","error"]
      ["a,b"]          -> ["a,b"]
      [""]             -> [""]
      ["it's"]         -> ["it's"]
      ["{x}"]          -> ["{x}"]
      ["A"]            -> []
      ```

      **Failing first.** The test file was written before the handler:

      ```
      $ cd web && npx vitest run src/app/api/analytics/logs.test.ts
       FAIL  src/app/api/analytics/logs.test.ts [ src/app/api/analytics/logs.test.ts ]
      Error: Cannot find module './logs/route' imported from '.../logs.test.ts'
       Test Files  1 failed (1)
            Tests  no tests
      ```

      **Passing.** 39 tests against the real database and real BetterAuth sessions:

      ```
      $ cd web && npx vitest run src/app/api/analytics/logs.test.ts --reporter=verbose
      + GET /api/analytics/logs > rejects an unauthenticated request 3ms
      + GET /api/analytics/logs > answers an empty history with an empty page and no pages 15ms
      + GET /api/analytics/logs > projects the nine fields of one entry, with data as a parsed object 5ms
      + GET /api/analytics/logs > reports a missing key as null rather than dropping the entry 4ms
      + GET /api/analytics/logs > unrolls every entry of every post into its own row 5ms
      + GET /api/analytics/logs > orders entries by timestamp descending 4ms
      + GET /api/analytics/logs scoping > excludes a post whose execution_logs is the empty array 4ms
      + GET /api/analytics/logs scoping > excludes another user's posts 7ms
      + GET /api/analytics/logs scoping > excludes a post with no profile, which has no owner to scope by 4ms
      + GET /api/analytics/logs filters > filters by a single level 3ms
      + GET /api/analytics/logs filters > splits a comma-separated level list and strips whitespace around each 3ms
      + GET /api/analytics/logs filters > treats an empty level as no filter at all 3ms
      + GET /api/analytics/logs filters > filters by an exact stage, not a prefix 3ms
      + GET /api/analytics/logs filters > filters by profile_id 4ms
      + GET /api/analytics/logs filters > treats an empty profile_id as no filter at all 3ms
      + GET /api/analytics/logs filters > searches the message case-insensitively as a substring 4ms
      + GET /api/analytics/logs filters > passes a wildcard in q through to ILIKE unescaped, as Python does 4ms
      + GET /api/analytics/logs filters > combines every filter with AND 3ms
      + GET /api/analytics/logs time bounds > includes an entry exactly on the since bound 4ms
      + GET /api/analytics/logs time bounds > excludes an entry one second before the since bound 3ms
      + GET /api/analytics/logs time bounds > includes an entry exactly on the until bound 3ms
      + GET /api/analytics/logs time bounds > excludes an entry one second after the until bound 3ms
      + GET /api/analytics/logs time bounds > normalises a Z-suffixed bound to +00:00 so the boundary second still matches 5ms
      + GET /api/analytics/logs time bounds > defaults to a ninety-day window when since is absent 3ms
      + GET /api/analytics/logs time bounds > treats an empty since as absent and falls back to the default window 3ms
      + GET /api/analytics/logs time bounds > applies no upper bound when until is absent 3ms
      + GET /api/analytics/logs time bounds > treats an empty until as no upper bound 3ms
      + GET /api/analytics/logs pagination > rolls the page count up and reports the requested page 3ms
      + GET /api/analytics/logs pagination > reports zero pages rather than one when nothing matches 2ms
      + GET /api/analytics/logs pagination > answers an empty page past the end 3ms
      + GET /api/analytics/logs validation > rejects page below its minimum 1ms
      + GET /api/analytics/logs validation > rejects per_page above its maximum 1ms
      + GET /api/analytics/logs validation > reports page and per_page in declaration order in one response 1ms
      + GET /api/analytics/logs validation > accepts pydantic's lax integer forms 2ms
      + GET /api/analytics/logs validation > takes the last value of a repeated parameter, as Starlette does 5ms
      + GET /api/analytics/logs validation > rejects a since it cannot parse instead of raising 1ms
      + GET /api/analytics/logs validation > rejects an until it cannot parse instead of raising 1ms
      + GET /api/analytics/logs validation > reports a bad page before a bad since, because FastAPI validated first 1ms
      + GET /api/analytics/logs validation > rejects a profile_id that is not a uuid instead of reaching the column 1ms

       Test Files  1 passed (1)
            Tests  39 passed (39)
      ```

      (vitest's pass glyph is a check mark; transcribed as `+` here. The full test
      names are prefixed with the file path in the real output and are trimmed to
      the describe path above.)

      **Cross-stack parity against the running Python endpoint.** This endpoint
      executes, so parity was measured rather than argued. A probe wrote three
      profiles across two users and five posts with deliberately awkward fixtures
      (an entry holding only `ts`, an entry with `data` explicitly `null`, an entry
      with a deeply nested `data`, messages `b-m boom` / `bxxm BOOM` / `nothing` so
      an unescaped `%` and a case-insensitive match are distinguishable, a
      `.500000` sub-second timestamp on the boundary, an empty `execution_logs`, a
      post with no profile, and a post belonging to another user), then called the
      TypeScript handler on twelve queries. The Python router was then mounted on a
      bare `FastAPI()` under `TestClient` with `get_current_user` overridden to the
      same user id and `get_session` bound to the real dev database, and called on
      the same rows:

      ```
      $ cd api && PYTHONPATH=. uv run python /tmp/probe_logs_py.py
      done 12

      $ python3 -c "
      import json
      py=json.load(open('/tmp/logs-py.json')); ts=json.load(open('/tmp/logs-ts.json'))
      print('deep equal:', py==ts)
      for q in py: print(('OK ' if py[q]==ts[q] else 'DIFF'), q, py[q]['body']['total'])
      "
      deep equal: True
      OK   6
      OK  ?per_page=3 6
      OK  ?per_page=3&page=2 6
      OK  ?level=error 3
      OK  ?level=%20info%20,%20error%20 4
      OK  ?stage=write 4
      OK  ?q=b%25m 2
      OK  ?q=BOOM 2
      OK  ?since=2026-08-20T12:00:00Z 5
      OK  ?since=2026-01-01&until=2026-08-20T12:00:01Z 4
      OK  ?since=2026-01-01&until=2026-08-20T12:00:00.5 2
      OK  ?level=error&stage=write&q=boom 1
      ```

      Byte-for-byte equal on all twelve, including the page-2 slice, the descending
      text ordering across a `.500000` sub-second tie, the unescaped `%` in `q`,
      the trimmed comma list, both `Z`-suffixed bounds and a nested `data` object.
      Unlike `/models` there is not even a trailing-zero difference to record: this
      endpoint does no arithmetic beyond the pagination rollup, so every value on
      the wire is a string, a `null` or an integer in both stacks.

      The fixtures were deleted afterwards; no probe file is committed.

      **Deviation 1, recorded: an unparseable `since` or `until` answers 422, not
      500.** Both are declared `str | None`, so pydantic never looked at them and
      `datetime.fromisoformat()` raised straight out of the handler. Every value it
      rejects is a 500 in Python, on a parameter the caller controls; this is
      logged in `todo.md` as a confirmed defect against the still-serving Python
      route. The port answers pydantic's own `datetime_from_date_parsing`, the
      error a `datetime` query parameter would have produced, probed off the
      installed pydantic 2.12:

      ```
      $ cd api && uv run python -c "<TypeAdapter(datetime).validate_python on three bad values>"
      'nonsense' [{'type': 'datetime_from_date_parsing', ..., 'msg': 'Input should be a valid datetime or date, input is too short', 'ctx': {'error': 'input is too short'}}]
      '2026-13-01' [{'type': 'datetime_from_date_parsing', ..., 'msg': 'Input should be a valid datetime or date, month value is outside expected range of 1-12', ...}]
      '' [{'type': 'datetime_from_date_parsing', ..., 'msg': 'Input should be a valid datetime or date, input is too short', ...}]
      ```

      The message drops pydantic's `ctx.error` tail. That tail names the specific
      failure and comes from speedate, a different parser from `fromisoformat` with
      different failure modes, so reproducing it would mean inventing text.
      `pathUuidIssue` already drops the same kind of tail for the same reason.

      **Deviation 2, recorded: a `profile_id` that is not a uuid answers 422, not
      500.** Identical to the deviation recorded under 5.8b, for the identical
      reason: the parameter is declared `str | None` and the raw value reached a
      `uuid` column. The error is the `uuid_parsing` 422 `GET /api/posts` already
      answers. An empty value is still no filter at all.

      **Negative controls**, twenty mutations, each applied to
      `logs/route.ts` alone and verified with `cmp` against a saved good copy
      before the suite was run (an earlier iteration found `git diff --quiet` gives
      a false negative for an untracked file):

      | Mutation | Result | First failing tests |
      | --- | --- | --- |
      | `since` bound made exclusive (`>=` to `>`) | 1 failed | includes an entry exactly on the since bound |
      | `until` bound made exclusive (`<=` to `<`) | 1 failed | includes an entry exactly on the until bound |
      | Ordering flipped to ascending | 2 failed | orders entries by timestamp descending; rolls the page count up |
      | `level` list not trimmed | 1 failed | splits a comma-separated level list and strips whitespace |
      | `level` not split on commas at all | 1 failed | splits a comma-separated level list and strips whitespace |
      | Empty `level` becomes a filter (`if (level)` to `!== undefined`) | 1 failed | treats an empty level as no filter at all |
      | First repeated value taken instead of last | 1 failed | takes the last value of a repeated parameter |
      | `since` not normalised through `fromIsoFormat` | 2 failed | normalises a Z-suffixed bound; rejects a since it cannot parse |
      | `until` not normalised through `fromIsoFormat` | 1 failed | rejects an until it cannot parse |
      | `count(*)` left as the string `pg` returns | 27 failed | answers an empty history; projects the nine fields; unrolls every entry |
      | Page count truncates instead of rolling up | 3 failed | projects the nine fields; answers an empty page past the end; rolls the page count up |
      | Offset off by one page (`page * perPage`) | 11 failed | orders entries by timestamp descending; projects the nine fields; reports a missing key as null |
      | Profile join widened to a `left join` | **0 failed** | (analysed below) |
      | Message search made case sensitive (`ilike` to `like`) | 1 failed | searches the message case-insensitively as a substring |
      | `p.execution_logs != '[]'::jsonb` guard dropped | **0 failed** | (analysed below) |
      | Bound errors reported before page errors | 1 failed | reports a bad page before a bad since |
      | `wp.user_id` scoping predicate dropped | 1 failed | excludes another user's posts |
      | `data` projected with `->>` instead of `->` | 1 failed | projects the nine fields of one entry, with data as a parsed object |
      | `stage` filter made a prefix match | 1 failed | filters by an exact stage, not a prefix |
      | `q` wildcards escaped before the `ILIKE` | 1 failed | passes a wildcard in q through to ILIKE unescaped |

      **The two controls with no teeth are both dead code, not untested code.**
      Widening the join to a `left join` changes nothing because
      `wp.user_id = :user_id` is `NULL` for a post with no profile and a `NULL`
      predicate is not `true`: the scoping is carried entirely by the predicate,
      and the inner join is redundant to it. (Dropping the predicate instead does
      fail, which is the row above it.) Dropping the
      `p.execution_logs != '[]'::jsonb` guard changes nothing because
      `jsonb_array_elements('[]')` yields zero rows, so the guard is a planner
      hint, not a filter. Both are kept because both are what the Python does, and
      the second does let Postgres skip the unroll.

      **Not covered.** No browser drives `/monitor`'s logs tab against this
      handler, so nothing here proves the table and its filter controls render the
      payload; that check belongs to Phase 8 item 8.8. `web/src/lib/api.ts`'s
      `analytics.logs()` never sends `until`, so the upper bound is exercised only
      by this suite and never end to end. The text ordering of `log_entry->>'ts'`
      is only correct because every writer renders the timestamp through
      `datetime.now(UTC).isoformat()`; nothing in either stack enforces that, and
      an entry written with a different offset or a `Z` suffix would sort wrongly
      in both.

      **Gates.**

      ```
      $ cd web && npx tsc --noEmit
      (no output, exit 0)

      $ cd web && npx eslint
      (no output, exit 0)

      $ cd web && npx vitest run          # three runs with this item present
       Test Files  3 failed | 98 passed (101)
            Tests  10 failed | 2043 passed | 7 skipped (2060)
       Test Files  2 failed | 99 passed (101)
            Tests  9 failed | 2044 passed | 7 skipped (2060)
       Test Files  2 failed | 99 passed (101)
            Tests  9 failed | 2044 passed | 7 skipped (2060)

      $ cd web && npx vitest run          # this item's two files moved aside
       Test Files  2 failed | 98 passed (100)
            Tests  9 failed | 2005 passed | 7 skipped (2021)
      ```

      Both sides sit at 9 (6 `image-preview` + 3 `PostDetail`). The tenth on the
      first run is `scaffold-check.test.ts > emits the workflow lifecycle events
      the trace view will read`, the load-sensitive flake already recorded in
      `todo.md`: it fired once in three runs with this item present and not at all
      in the HEAD-side run. 39 new tests, 2005 to 2044 passing.

      ```
      $ cd web && npx next build
      ✓ Compiled successfully in 4.2s
      ├ ƒ /api/analytics/costs
      ├ ƒ /api/analytics/dashboard
      ├ ƒ /api/analytics/logs
      ├ ƒ /api/analytics/models
      build exit=0
      (plus the standing 15 BetterAuthError lines, count unchanged)

      $ cd api && uv run pytest -q
      120 failed, 241 passed, 25 errors in 15.32s

      $ cd api && uv run ruff check .
      Found 32 errors.
      [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 131 files already formatted
      ```

      Python counts unchanged from those recorded under 5.8a to 5.8d-i. No Python
      changed in this iteration.

## 5.9a


    Ported to `web/src/mastra/wordpress/index.ts`: `WordPressError`, the constructor's
    URL normalisation and Basic credential, `_request`'s error grammar, and
    `test_connection`, `list_categories` and `list_users` with their pagination.

    **`upload_media`, `create_post` and `update_post` are deliberately not ported.**
    Their only caller is `api/src/pipeline/publish.py`, which ledger item 5.3c-iii-b
    owns, and porting a method with no consumer is speculative. The module comment
    records this so the gap is not mistaken for an oversight.

    **The oracle is a live-server capture, not a reading of the Python.**
    `api/scripts/export_wordpress_parity.py` stands up a local HTTP server, runs the
    real `WordPressClient` against it, and records for every scenario the routing
    table, every request the server saw (path, raw query string and `Authorization`),
    and the value returned or the `WordPressError` raised. It also exports a
    constructor table over 27 spellings of a site URL. This matters because
    `api/tests/phase10/test_wordpress_service.py` replaces `client._client.request`
    with an `AsyncMock`, so nothing in the pytest suite has ever exercised the
    pagination query string, the `>= 400` error grammar or the non-JSON branch against
    a real response. Nothing is mocked on either side of this oracle.

    ```
    $ cd api && uv run python scripts/export_wordpress_parity.py
    local server on http://127.0.0.1:56402
      test-connection-success: 1 request(s), returned {"name": "Test Site", "description": "Just another site", "u
      test-connection-through-stripped-wp-admin: 1 request(s), returned {"name": "Stripped"}
      test-connection-subdirectory-install: 1 request(s), returned {"name": "Blog"}
      test-connection-401-with-message: 1 request(s), raised WordPress API error: You are not currently logged in.
      test-connection-404-long-html: 1 request(s), raised WordPress API error: <html><body>nginx 404 not found. nginx 404 not found. nginx 404 not found.  [...truncated in this paste at 150 of 275 chars; the committed oracle holds it in full...]
      test-connection-400-json-without-message: 1 request(s), raised WordPress API error: {"code": "rest_bad", "data": {}}
      test-connection-500-json-array: 1 request(s), raised WordPress API error: ["boom", "again"]
      test-connection-500-long-json-array: 1 request(s), raised WordPress API error: ["error number 0", "error number 1", "error number 2", "error number  [...truncated in this paste at 150 of 281 chars; the committed oracle holds it in full...]
      test-connection-500-json-null: 1 request(s), raised WordPress API error: null
      test-connection-200-json-null: 1 request(s), returned null
      test-connection-403-empty-body: 1 request(s), raised WordPress API error: 
      test-connection-200-non-json: 1 request(s), raised WordPress returned non-JSON response — check that the site URL is correct
      test-connection-200-json-array: 1 request(s), returned [1, 2, 3]
      test-connection-200-json-with-html-content-type: 1 request(s), returned {"name": "Sniffed"}
      categories-single-page: 1 request(s), returned [{"id": 1, "name": "Category 1", "slug": "category-1", "coun
      categories-empty: 1 request(s), returned []
      categories-two-pages: 2 request(s), returned [{"id": 1, "name": "Category 1", "slug": "category-1", "coun
      categories-full-page-then-empty: 2 request(s), returned [{"id": 1, "name": "Category 1", "slug": "category-1", "coun
      categories-error-on-second-page: 2 request(s), raised WordPress API error: Internal server error
      categories-through-subdirectory-install: 1 request(s), returned [{"id": 7, "name": "Category 7", "slug": "category-7", "coun
      users-default-roles: 1 request(s), returned [{"id": 1, "name": "Author 1", "slug": "author-1", "link": "
      users-custom-roles: 1 request(s), returned [{"id": 5, "name": "Author 5", "slug": "author-5", "link": "
      users-empty-roles-list: 1 request(s), returned [{"id": 9, "name": "Author 9", "slug": "author-9", "link": "
      users-two-pages: 2 request(s), returned [{"id": 1, "name": "Author 1", "slug": "author-1", "link": "
      users-401: 1 request(s), raised WordPress API error: Sorry, you are not allowed to list users.
    wrote /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web/src/mastra/wordpress/data/wordpress-parity.json (25 scenarios)
    ```

    **The exact wire format the port has to reproduce**, dumped out of the same oracle:

    ```
    $ python3 -c "import json; d=json.load(open('web/src/mastra/wordpress/data/wordpress-parity.json')); [print(s['name'],'|',r['path'],'|',repr(r['query'])) for s in d['scenarios'] for r in s['requests']]" | tail -8
    categories-through-subdirectory-install | /blog/wp-json/wp/v2/categories | 'per_page=100&page=1'
    users-default-roles | /wp-json/wp/v2/users | 'per_page=100&page=1&roles=administrator%2Ceditor%2Cauthor'
    users-custom-roles | /wp-json/wp/v2/users | 'per_page=100&page=1&roles=subscriber'
    users-empty-roles-list | /wp-json/wp/v2/users | 'per_page=100&page=1&roles='
    users-two-pages | /wp-json/wp/v2/users | 'per_page=100&page=1&roles=administrator%2Ceditor%2Cauthor'
    users-two-pages | /wp-json/wp/v2/users | 'per_page=100&page=2&roles=administrator%2Ceditor%2Cauthor'
    users-401 | /wp-json/wp/v2/users | 'per_page=100&page=1&roles=administrator%2Ceditor%2Cauthor'
    ```

    `per_page` before `page` before `roles`, and the role separator percent-encoded.
    `URLSearchParams` reproduces both when the keys are set in that order. `roles=[]` is
    not the same as a missing argument: Python's default only applies to `roles is None`,
    so an explicitly empty list sends `roles=`, and the port's
    `roles: string[] = DEFAULT_ROLES` default matches that exactly.

    **Deviation 1: one whole-request deadline instead of per-phase timeouts.**
    `httpx.Timeout(30.0, read=120.0)` is per connect/read/write/pool phase, where
    `AbortSignal.timeout` is a deadline over the whole request. The port uses the read
    value, the larger of the two, so it is the more patient of the pair on connect and
    the less patient only on a response that takes over two minutes in total. The same
    tradeoff is already recorded for the `link_validator` and `sitemap` ports.

    **Deviation 2: `resp.text[:200]` slices code points, `String.slice` slices UTF-16
    code units.** Observable only for an error body carrying astral characters inside
    its first 200.

    **Deviation 3: `json.loads` accepts `NaN`, `Infinity` and `-Infinity`; `JSON.parse`
    rejects all three.** A WordPress install emitting one would be a non-JSON response
    here and a parsed one in Python. No real install emits them.

    **Deviation 4: a paginated `< 400` body that is a JSON object.**
    `results.extend(data)` extends the list with that object's *keys* in Python;
    spreading a non-iterable throws here. Only a `< 400` response reaches that line and
    every paginated WordPress collection endpoint answers with an array, so it is
    unreachable through a real install.

    **The em dash in `"WordPress returned non-JSON response — check that the site URL is
    correct"` is copied from the Python source string, not authored.**
    `GET /wordpress/test` hands that string to the dashboard as `error`, so changing its
    punctuation would change what a user sees.

    **Redundancy found, not a gap.** The `_STRIP_SUFFIXES` tuple order is unobservable:
    the four suffixes are mutually exclusive as `endswith` tests, because a string ending
    in `/wp-json/wp/v2` does not end in `/wp-json`. The negative control that reorders
    them fails nothing, and that is the correct result. The `break` is *not* redundant,
    and needed a case the first oracle did not have:
    `https://example.com/wp-json/wp-admin` strips to `https://example.com/wp-json` with
    the `break` and to `https://example.com` without it, because `/wp-admin` is earlier
    in the tuple than `/wp-json`. That case was added to the constructor table once the
    control exposed the hole, and three more scenarios (`test-connection-500-json-null`,
    `test-connection-200-json-null`, `test-connection-500-long-json-array`) were added
    for the same reason.

    **`Array.isArray` was removed from `errorDetail` because a control proved it dead.**
    Python needs the guard, since `[].get` raises `AttributeError`. JavaScript does not:
    a JSON array can never carry a `message` property, so it reaches the same raw-body
    fallback anyway. `parsed === null` is a different matter and is load bearing, since
    reading a property off `null` throws; the `test-connection-500-json-null` scenario
    added above is what covers it.

    **Confirmed defect, ported faithfully rather than fixed** (recorded in `todo.md`):
    the constructor appends its REST paths to the raw URL after nothing but a
    trailing-slash strip and a suffix strip, so `https://example.com/?a=1` yields
    `api_url = https://example.com/?a=1/wp-json/wp/v2`. That row is in the oracle as
    `keeps-query-string`, so the port reproduces it deliberately. The fix belongs with
    the profile form's `wp_url` validation, not with the client.

    Failing first, with the implementation moved aside:

    ```
    $ cd web && mv src/mastra/wordpress/index.ts /tmp/ && npx vitest run src/mastra/wordpress/wordpress.test.ts
     ❯ src/mastra/wordpress/wordpress.test.ts (0 test)
    ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
     FAIL  src/mastra/wordpress/wordpress.test.ts [ src/mastra/wordpress/wordpress.test.ts ]
    Error: Cannot find module './index' imported from
    '/Users/cody/.../web/src/mastra/wordpress/wordpress.test.ts'
     Test Files  1 failed (1)
          Tests  no tests
    ```

    Passing, with every case named (the repeated
    `src/mastra/wordpress/wordpress.test.ts > ` prefix vitest prints on each line is
    elided here for width, and nothing else is changed):

    ```
    $ cd web && npx vitest run src/mastra/wordpress/wordpress.test.ts --reporter=verbose
     ✓ WordPressClient constructor > derives the same urls and credential as Python for plain-origin 1ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for one-trailing-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for many-trailing-slashes 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for subdirectory-install 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for subdirectory-trailing-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-admin 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-admin-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-admin-uppercase 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-admin-mixed-case 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-login 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-json 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-json-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-json-wp-v2 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-wp-json-wp-v2-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-one-suffix-only 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for strips-one-suffix-only-reversed 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for leaves-unslashed-lookalike 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for leaves-inner-occurrence 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for subdirectory-with-wp-json 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for empty-url 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for bare-slash 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for no-scheme 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for keeps-query-string 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for empty-password 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for colon-in-password 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for empty-username 0ms
     ✓ WordPressClient constructor > derives the same urls and credential as Python for non-ascii-credentials 0ms
     ✓ WordPressClient constructor > strips at most one suffix, leaving the one underneath 0ms
     ✓ WordPressClient constructor > requires the suffix to start at a path segment 0ms
     ✓ WordPressClient against a live server > matches Python for test-connection-success 11ms
     ✓ WordPressClient against a live server > matches Python for test-connection-through-stripped-wp-admin 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-subdirectory-install 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-401-with-message 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-404-long-html 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-400-json-without-message 0ms
     ✓ WordPressClient against a live server > matches Python for test-connection-500-json-array 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-500-long-json-array 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-500-json-null 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-200-json-null 1ms
     ✓ WordPressClient against a live server > matches Python for test-connection-403-empty-body 0ms
     ✓ WordPressClient against a live server > matches Python for test-connection-200-non-json 0ms
     ✓ WordPressClient against a live server > matches Python for test-connection-200-json-array 0ms
     ✓ WordPressClient against a live server > matches Python for test-connection-200-json-with-html-content-type 0ms
     ✓ WordPressClient against a live server > matches Python for categories-single-page 0ms
     ✓ WordPressClient against a live server > matches Python for categories-empty 0ms
     ✓ WordPressClient against a live server > matches Python for categories-two-pages 1ms
     ✓ WordPressClient against a live server > matches Python for categories-full-page-then-empty 1ms
     ✓ WordPressClient against a live server > matches Python for categories-error-on-second-page 0ms
     ✓ WordPressClient against a live server > matches Python for categories-through-subdirectory-install 0ms
     ✓ WordPressClient against a live server > matches Python for users-default-roles 0ms
     ✓ WordPressClient against a live server > matches Python for users-custom-roles 0ms
     ✓ WordPressClient against a live server > matches Python for users-empty-roles-list 0ms
     ✓ WordPressClient against a live server > matches Python for users-two-pages 1ms
     ✓ WordPressClient against a live server > matches Python for users-401 0ms
     ✓ behaviour the oracle cannot cover > lets a transport failure out unwrapped, as Python lets httpx errors out 0ms
     ✓ behaviour the oracle cannot cover > reports the status the non-JSON body arrived with, not 200 by assumption 0ms
     ✓ behaviour the oracle cannot cover > sends the Basic credential on every page of a paginated call 2ms
     Test Files  1 passed (1)
          Tests  57 passed (57)
    ```

    **Negative controls.** Each mutates `web/src/mastra/wordpress/index.ts`, checks with
    `cmp` that the file actually changed (the trap iteration 103 recorded), runs the
    file, and restores from a saved copy. Twenty controls, nineteen with teeth:

    | Control | Result |
    | --- | --- |
    | drop the suffix strip entirely | 14 of 57 tests failed |
    | strip every matching suffix instead of one | 1 of 57 tests failed |
    | compare the suffix case-sensitively | 2 of 57 tests failed |
    | strip only one trailing slash | 1 of 57 tests failed |
    | reorder the strip suffixes so `/wp-json` comes last | 0 of 57 tests failed |
    | encode the credential as latin1 | 1 of 57 tests failed |
    | treat 400 itself as a success | 1 of 57 tests failed |
    | keep the whole error body instead of 200 characters | 2 of 57 tests failed |
    | read `.message` off a JSON null too | 1 of 57 tests failed |
    | drop the missing-message fallback | 3 of 57 tests failed |
    | reword the non-JSON error | 2 of 57 tests failed |
    | report no status on the non-JSON error | 2 of 57 tests failed |
    | stop paginating only on an empty page | 7 of 57 tests failed |
    | ask for 50 per page | 12 of 57 tests failed |
    | order the query as page then per_page | 11 of 57 tests failed |
    | join roles with a comma and a space | 3 of 57 tests failed |
    | drop author from the default roles | 3 of 57 tests failed |
    | treat an empty roles list as unset | 1 of 57 tests failed |
    | test the connection against the v2 root | 15 of 57 tests failed |
    | send no Authorization header | 26 of 57 tests failed |

    The single zero is analysed above: `_STRIP_SUFFIXES`' order genuinely cannot be
    observed. A first pass of the same twenty had **four** zeros; the other three
    (`strip every matching suffix`, `keep the whole error body`, and a control on the
    JSON-array branch) were real holes, and each was closed by adding an oracle case or,
    for the array branch, by deleting the dead guard. Both fixes are described above.

    Gates:

    ```
    $ cd web && npx tsc --noEmit
    (no output, exit 0)

    $ cd web && npx eslint
    (no output, exit 0)

    $ cd web && npx vitest run                 # three consecutive runs, this item present
     Test Files  2 failed | 100 passed (102)
          Tests  9 failed | 2101 passed | 7 skipped (2117)
     Test Files  4 failed | 98 passed (102)
          Tests  11 failed | 2099 passed | 7 skipped (2117)
     Test Files  2 failed | 100 passed (102)
          Tests  9 failed | 2101 passed | 7 skipped (2117)

    $ cd web && npx vitest run                 # this item's directory moved aside
     Test Files  3 failed | 98 passed (101)
          Tests  10 failed | 2043 passed | 7 skipped (2060)

    $ cd web && npx next build
    build exit=0
    (plus the standing 15 BetterAuthError lines, count unchanged)

    $ set -a && . ./.env && set +a && cd api && uv run pytest -q
    120 failed, 241 passed, 25 errors in 15.23s

    $ cd api && uv run ruff check .
    Found 32 errors.
    [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 132 files already formatted
    ```

    Both sides of the frontend suite sit at the recorded 9 (6 `image-preview` +
    3 `PostDetail`). Runs 1 and 3 hit exactly those; run 2 added the two load-sensitive
    flakes already in `todo.md` (`scaffold-check > emits the workflow lifecycle events`
    and `pipeline-events > carries Python's log payload and nothing else`), and the
    HEAD-side run hit one of them. 57 new tests, 2043 to 2101 passing.

    Python counts unchanged: 120/241/25 and 32 ruff errors are the recorded baseline.
    `ruff format --check` moves from 131 to 132 already-formatted files, which is this
    item's export script and nothing else.

    **The pytest baseline only reproduces with the repo `.env` sourced.** Without it,
    `uv run pytest -q` answers `4 failed, 205 passed, 177 errors` with
    `asyncpg.exceptions.InvalidPasswordError: password authentication failed for user
    "pipeline"`, because `api/tests/conftest.py` falls back to defaults that no longer
    match the running container. Recorded in `todo.md` as `[investigate]`; every earlier
    ledger entry that pastes a pytest count depends on the caller remembering this.

## 5.9b


    Ported to `web/src/app/api/profiles/[id]/wordpress/{test,categories,authors}/route.ts`
    over `web/src/app/api/profiles/[id]/wordpress/client.ts`, which is
    `_get_user_profile` and `_get_wp_client` folded into one lookup because both read
    the same row. The order is unchanged: the profile is resolved against the caller
    first, so another user's profile is a 404 and no request is made to their
    WordPress install, and only then are the credentials examined.

    `resolveWpClient` answers a three-way union rather than throwing, because the three
    callers disagree about what the credential failures mean. `/test` reports both of
    them, and every `WordPressError`, as a 200 carrying `{connected: false, error}`;
    `/categories` and `/authors` catch nothing at all, so the same two failures are
    400s and a `WordPressError` from the install escapes as a 500.

    **The oracle is a live-server capture of the real endpoint coroutines.**
    `api/scripts/export_wordpress_router_parity.py` drives `test_connection`,
    `list_categories` and `list_authors` themselves, with a stubbed session standing in
    for the `_get_user_profile` query and a local HTTP server standing in for the
    WordPress install, and records per scenario the profile row, every request the
    stand-in saw, and the value returned or the exception raised. `api/tests/phase10/`
    has no coverage of this router at all, so all 36 scenarios are new on both sides.
    The Fernet key in the oracle is a throwaway generated for the file (32 bytes of
    0x07); no real credential is involved.

    ```
    $ cd api && uv run python scripts/export_wordpress_router_parity.py
    local server on {BASE}
      test-success: 1 request(s), returned {"connected": true, "site_name": "Test Site"}
      test-success-name-absent: 1 request(s), returned {"connected": true, "site_name": ""}
      test-success-name-null: 1 request(s), returned {"connected": true, "site_name": null}
      test-success-name-not-a-string: 1 request(s), returned {"connected": true, "site_name": 1234}
      test-success-through-stripped-wp-admin: 1 request(s), returned {"connected": true, "site_name": "Stripped"}
      test-401-message-swallowed: 1 request(s), returned {"connected": false, "error": "WordPress API error: You are not curren
      test-404-html-swallowed: 1 request(s), returned {"connected": false, "error": "WordPress API error: <html><body>nginx:
      test-non-json-200-swallowed: 1 request(s), returned {"connected": false, "error": "WordPress returned non-JSON response \u
      test-root-returns-json-array: 1 request(s), unhandled AttributeError: 'list' object has no attribute 'get'
      test-root-returns-json-null: 1 request(s), unhandled AttributeError: 'NoneType' object has no attribute 'get'
      test-root-returns-json-string: 1 request(s), unhandled AttributeError: 'str' object has no attribute 'get'
      test-profile-not-found: 0 request(s), HTTPException 404: Profile not found
      test-no-url: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-empty-url: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-no-username: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-empty-username: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-no-password: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-empty-password: 0 request(s), returned {"connected": false, "error": "WordPress credentials not configured on
      test-undecryptable-password: 0 request(s), returned {"connected": false, "error": "Failed to decrypt WordPress app passwor
      test-unset-encryption-key: 0 request(s), returned {"connected": false, "error": "Failed to decrypt WordPress app passwor
      categories-success: 1 request(s), returned [{"id": 1, "name": "Uncategorized", "slug": "uncategorized", "count":
      categories-count-absent-defaults-to-zero: 1 request(s), returned [{"id": 3, "name": "No Count", "slug": "no-count", "count": 0}]
      categories-count-null-is-not-defaulted: 1 request(s), returned [{"id": 5, "name": "Null Count", "slug": "null-count", "count": null}]
      categories-count-not-an-int-passes-through: 1 request(s), returned [{"id": 4, "name": "Stringy", "slug": "stringy", "count": "9"}]
      categories-empty: 1 request(s), returned []
      categories-missing-id-raises: 1 request(s), unhandled KeyError: 'id'
      categories-401-escapes: 1 request(s), unhandled WordPressError: WordPress API error: Sorry, you are not allowed to do that.
      categories-profile-not-found: 0 request(s), HTTPException 404: Profile not found
      categories-no-credentials: 0 request(s), HTTPException 400: WordPress credentials not configured on this profile
      categories-undecryptable-password: 0 request(s), HTTPException 400: Failed to decrypt WordPress app password [em dash] check WP_ENCRYPTION_KEY
      authors-success: 1 request(s), returned [{"id": 1, "name": "Site Admin", "slug": "admin"}, {"id": 5, "name": "
      authors-empty: 1 request(s), returned []
      authors-missing-slug-raises: 1 request(s), unhandled KeyError: 'slug'
      authors-403-escapes: 1 request(s), unhandled WordPressError: WordPress API error: Sorry, you are not allowed to list users.
      authors-profile-not-found: 0 request(s), HTTPException 404: Profile not found
      authors-no-password: 0 request(s), HTTPException 400: WordPress credentials not configured on this profile
    wrote .../web/src/app/api/profiles/data/wordpress-router-parity.json (36 scenarios)
    ```

    (The one `[em dash]` above stands in for the literal character in the Python
    detail string; the ledger keeps no em dashes, the code copies it verbatim.)

    **Four decisions the Python forces, each pinned by its own scenario:**

    - **`c.get("count", 0)` defaults an absent key and nothing else.** An explicit
      `"count": null` comes back as `null`, and `"count": "9"` comes back as the
      string. `count: "count" in item ? item.count : 0` reproduces both;
      `item.count ?? 0` would not, and the `categories-count-null-is-not-defaulted`
      scenario exists to make that distinguishable.
    - **`c["id"]` is a subscript, not a `.get`.** Python raised `KeyError` for an item
      missing `id`, `name` or `slug`, nothing caught it, and the request became a 500
      with no partial list. JavaScript would read `undefined` and `Response.json`
      would drop the key, answering 200 with items that do not match `WPCategory` or
      `WPAuthor`, so `requireField()` reproduces the exception rather than the
      expression.
    - **`info.get("name", "")` is not a safe read either.** A `/wp-json` root that
      answers with a JSON array, `null` or a string raised `AttributeError` in Python,
      which `except WordPressError` did not catch. `siteName()` throws for the same
      three inputs instead of quietly reporting `connected: true` with an empty name.
      All three are captured as scenarios.
    - **`if not profile.wp_url` treats an empty string as missing.** All three fields
      are falsy tests, not null checks, so `""` is as unconfigured as `NULL`. Six
      scenarios cover the null and empty spelling of each field.

    **The two detail strings are copied byte for byte, em dash included**, because
    `/test` hands them to the dashboard as `error` and `web/src/lib/api.ts` surfaces
    the `detail` of the other two. The same precedent was set in 5.9a for
    `"WordPress returned non-JSON response ... check that the site URL is correct"`.

    **No deviations recorded.** Every one of the 36 scenarios matches, including the
    two that end in an uncaught exception on both sides.

    Failing first, with the three handlers replaced by 501 stubs:

    ```
    $ pnpm -C web vitest run 'src/app/api/profiles/[id]/wordpress/wordpress.test.ts' --reporter=dot
     Test Files  1 failed (1)
          Tests  70 failed | 15 passed (85)
    ```

    Passing, against the real database, real BetterAuth sessions and a real socket:

    ```
    $ pnpm -C web vitest run 'src/app/api/profiles/[id]/wordpress/wordpress.test.ts' --reporter=verbose
     v .../wordpress.test.ts > the exported oracle > carries every scenario the export script ran 3ms
     v 'test': 'test-success' > answers 200 with the value Python returned 28ms
     v 'test': 'test-success' > issues the same requests Python's client issued 5ms
     v 'test': 'test-success-name-absent' > answers 200 with the value Python returned 4ms
     v 'test': 'test-success-name-null' > answers 200 with the value Python returned 4ms
     v 'test': 'test-success-name-not-a-string' > answers 200 with the value Python returned 4ms
     v 'test': 'test-success-through-stripped-wp-admin' > answers 200 with the value Python returned 4ms
     v 'test': 'test-401-message-swallowed' > answers 200 with the value Python returned 3ms
     v 'test': 'test-404-html-swallowed' > answers 200 with the value Python returned 3ms
     v 'test': 'test-non-json-200-swallowed' > answers 200 with the value Python returned 3ms
     v 'test': 'test-root-returns-json-array' > lets the AttributeError out, as Python did 3ms
     v 'test': 'test-root-returns-json-null' > lets the AttributeError out, as Python did 3ms
     v 'test': 'test-root-returns-json-string' > lets the AttributeError out, as Python did 3ms
     v 'test': 'test-profile-not-found' > answers 404 with Python's detail 3ms
     v 'test': 'test-no-url' > answers 200 with the value Python returned 3ms
     v 'test': 'test-empty-url' > answers 200 with the value Python returned 3ms
     v 'test': 'test-no-username' > answers 200 with the value Python returned 3ms
     v 'test': 'test-empty-username' > answers 200 with the value Python returned 3ms
     v 'test': 'test-no-password' > answers 200 with the value Python returned 3ms
     v 'test': 'test-empty-password' > answers 200 with the value Python returned 3ms
     v 'test': 'test-undecryptable-password' > answers 200 with the value Python returned 3ms
     v 'test': 'test-unset-encryption-key' > answers 200 with the value Python returned 3ms
     v 'categories': 'categories-success' > answers 200 with the value Python returned 9ms
     v 'categories': 'categories-count-absent-defaults-to-z...' > answers 200 with the value Python returned 3ms
     v 'categories': 'categories-count-null-is-not-defaulted' > answers 200 with the value Python returned 3ms
     v 'categories': 'categories-count-not-an-int-passes-th...' > answers 200 with the value Python returned 3ms
     v 'categories': 'categories-empty' > answers 200 with the value Python returned 3ms
     v 'categories': 'categories-missing-id-raises' > lets the KeyError out, as Python did 3ms
     v 'categories': 'categories-401-escapes' > lets the WordPressError out, as Python did 3ms
     v 'categories': 'categories-profile-not-found' > answers 404 with Python's detail 2ms
     v 'categories': 'categories-no-credentials' > answers 400 with Python's detail 2ms
     v 'categories': 'categories-undecryptable-password' > answers 400 with Python's detail 3ms
     v 'authors': 'authors-success' > answers 200 with the value Python returned 3ms
     v 'authors': 'authors-empty' > answers 200 with the value Python returned 3ms
     v 'authors': 'authors-missing-slug-raises' > lets the KeyError out, as Python did 3ms
     v 'authors': 'authors-403-escapes' > lets the WordPressError out, as Python did 3ms
     v 'authors': 'authors-profile-not-found' > answers 404 with Python's detail 2ms
     v 'authors': 'authors-no-password' > answers 400 with Python's detail 2ms
     v cases the oracle cannot reach > test rejects an unauthenticated request 1ms
     v cases the oracle cannot reach > categories rejects an unauthenticated request 1ms
     v cases the oracle cannot reach > authors rejects an unauthenticated request 1ms
     v cases the oracle cannot reach > test answers a malformed path uuid with FastAPI's 422 1ms
     v cases the oracle cannot reach > categories answers a malformed path uuid with FastAPI's 422 1ms
     v cases the oracle cannot reach > authors answers a malformed path uuid with FastAPI's 422 3ms
     v cases the oracle cannot reach > test answers a profile that does not exist with a 404 2ms
     v cases the oracle cannot reach > categories answers a profile that does not exist with a 404 2ms
     v cases the oracle cannot reach > authors answers a profile that does not exist with a 404 1ms
     v cases the oracle cannot reach > test answers another user's fully configured profile with a 404, contacting nothing 2ms
     v cases the oracle cannot reach > categories answers another user's profile with the same 404 as a missing one 2ms
     v cases the oracle cannot reach > sends the Basic credential built from the decrypted app password 3ms

     Test Files  1 passed (1)
          Tests  85 passed (85)
    ```

    (Every scenario also has a second `issues the same requests Python's client issued`
    test asserting the method, path, raw query string and `Authorization` header of
    every request the stand-in saw; those 36 rows are elided above for length.)

    **Negative controls.** Each mutation was applied to the implementation, checked
    against a saved copy to prove it actually landed, the suite was run, and the file
    was restored. 23 of 24 were caught.

    | # | Mutation | Result |
    | --- | --- | --- |
    | 1 | drop the `user_id` predicate from the profile lookup | caught, 5 failed |
    | 2 | treat an empty `wp_url` as configured (`=== null` instead of `!`) | caught, 1 failed |
    | 3 | stop checking `wp_username` | caught, 4 failed |
    | 4 | stop checking `wp_app_password` | caught, 3 failed |
    | 5 | change the missing-credentials detail | caught, 8 failed |
    | 6 | replace the em dash in the decrypt detail with a hyphen | caught, 3 failed |
    | 7 | let a decrypt failure escape instead of becoming a 400 | caught, 3 failed |
    | 8 | read a missing projection key as `undefined` instead of raising | caught, 2 failed |
    | 9 | drop the `.limit(1)` on the profile lookup | **passed** |
    | 10 | answer the credential 400s from `/test` instead of reporting them | caught, 8 failed |
    | 11 | always report an empty `site_name` | caught, 7 failed |
    | 12 | use `?? ""` instead of a key test for `site_name` | caught, 1 failed |
    | 13 | swallow every error from `/test`, not just `WordPressError` | caught, 6 failed |
    | 14 | accept a JSON array as the site root | caught, 1 failed |
    | 15 | let `WordPressError` escape `/test` instead of reporting it | caught, 3 failed |
    | 16 | skip the path uuid check on `/test` | caught, 1 failed |
    | 17 | drop the authentication check on `/categories` | caught, 1 failed |
    | 18 | always report a category `count` of zero | caught, 3 failed |
    | 19 | default an absent category `count` to `null` rather than 0 | caught, 1 failed |
    | 20 | return the credential failure as a 200 body from `/categories` | caught, 2 failed |
    | 21 | pass the whole WordPress category through instead of projecting | caught, 2 failed |
    | 22 | add a `count` to the author projection | caught, 1 failed |
    | 23 | ask for every role rather than the default three | caught, 6 failed |
    | 24 | answer a missing profile from `/authors` with a 400 instead of a 404 | caught, 2 failed |

    **Control 9 is genuinely redundant, not untested code.** `website_profiles.id` is
    the primary key (`id: uuid().defaultRandom().primaryKey().notNull()` in
    `web/src/db/schema.ts`), so the predicate matches at most one row and `rows[0]`
    picks it whether or not the planner is told to stop at one. The `.limit(1)` stays
    for consistency with the other profile-scoped handlers, but no behaviour rests on
    it. Controls 12 and 19 are the pair that only bite because the oracle carries the
    `null` scenarios added for exactly that purpose; without them both mutations pass.

    `NEXT_PUBLIC_API_URL` still points the dashboard at the Python API on :8055, so
    there is no per-router UI check here either; it flips to same-origin once Phase 5
    finishes, as recorded under 5.1b.

    Gates, both stacks:

    ```
    $ pnpm -C web tsc --noEmit
    TSC EXIT=0

    $ pnpm -C web lint
    LINT EXIT=0

    $ pnpm -C web test
     Test Files  2 failed | 101 passed (103)
          Tests  9 failed | 2186 passed | 7 skipped (2202)
    (the Phase 0 baseline: 6 in image-preview.test.tsx and 3 in PostDetail.test.tsx.
    An earlier run of the same suite also failed
    `scaffold-check.test.ts > emits the workflow lifecycle events the trace view will
    read` for a total of 10; that file passes 5/5 in isolation and this change touches
    nothing under `src/mastra/workflows/`. Logged in todo.md as a flake.)

    $ pnpm -C web build
    BUILD EXIT=0
    v Compiled successfully in 4.3s
    |- f /api/profiles/[id]/wordpress/authors
    |- f /api/profiles/[id]/wordpress/categories
    |- f /api/profiles/[id]/wordpress/test

    $ cd api && uv run pytest -q          # with the repo .env sourced
    120 failed, 241 passed, 25 errors in 15.06s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 133 files already formatted
    ```

## 5.10


  Ported to `web/src/app/api/profiles/[id]/nextjs/test/route.ts`, over
  `web/src/lib/hmac-signing.ts` (`sign_payload`) and
  `web/src/app/api/profiles/[id]/nextjs/detail.ts` (the error grammar). The router is one
  endpoint, `POST /api/profiles/{profile_id}/nextjs/test`, and reuses the
  `web/src/app/api/profiles/params.ts` helpers for the 422 and the user-scoped 404 that
  the profiles and wordpress handlers already share. `profiles.nextjsTest()` in
  `web/src/lib/api.ts` already declared `{connected, error?}` and needed no change, and
  its only caller, `web/src/app/profiles/[id]/page.tsx:366`, reads exactly those two
  fields.

  **The bytes on the wire are the contract, not just the JSON.**
  `packages/create-mdx-blog/src/adapters/delivery/webhook.ts` recomputes
  `createHmac("sha256", secret).update(rawBody)` over the raw body before parsing it, so
  the payload is assembled to match Python's `json.dumps` separators (`", "` and `": "`)
  and `datetime.now(UTC).isoformat()` (microseconds, `+00:00` rather than `Z`, and no
  fractional part at all when the microsecond is zero) rather than left to
  `JSON.stringify` and `toISOString`. Both of those are load-bearing: swapping the
  payload builder for `JSON.stringify` fails 20 tests, and swapping the timestamp for
  `toISOString()` fails 20.

  **Two `httpx` defaults had to be asked for explicitly**, because `fetch` defaults the
  other way. `httpx` does not follow redirects, so a 302 is reported as
  `Webhook returned 302: ...` rather than followed to a 200: `redirect: "manual"`.
  `httpx.AsyncClient(timeout=10.0)` becomes `AbortSignal.timeout(10_000)`; the timeout is
  set but not covered by a test, because the value is hardcoded and a real test would
  cost ten seconds of wall clock.

  **`verify_signature` is deliberately not ported.** `grep -rn` over `api/src` finds no
  caller: verification is the receiver's half of the contract and `create-mdx-blog`
  already implements it. Its four tests in `api/tests/phase_nextjs/test_hmac_signing.py`
  reduce to the signing half here, and the last test in `nextjs.test.ts` checks the two
  halves against each other by recomputing the digest with the receiver's own
  `createHmac(...).update(body).digest("hex")` rather than with `signPayload`.

  **The oracle is a live-server capture of the real endpoint coroutine.**
  `api/scripts/export_nextjs_router_parity.py` drives `test_nextjs_connection` itself,
  with a stubbed session standing in for the `_get_user_profile` lookup and a local HTTP
  server standing in for the Next.js blog, and records per scenario the profile row, the
  request the stand-in saw (body, content type and `X-Jena-Signature` included) and the
  value returned or the exception raised. `api/tests/phase_nextjs/` covers
  `sign_payload`/`verify_signature` but has no coverage of the router at all, so all 29
  router scenarios are new on both sides. The Fernet key in the oracle is a throwaway
  generated for the file (32 bytes of 0x0b); no real credential is involved.

  **Two documented divergences**, both asserted explicitly in the test rather than
  papered over:

  * `connection-refused`: Python reports `str(exc)` for an `httpx.RequestError`, which is
    `All connection attempts failed`. Node's `fetch` says `fetch failed`. The test asserts
    `connected === false` with a non-empty message and pins Python's wording alongside it.
  * `502-error-key-is-an-integral-float`: `{"error": 1.0}` renders `1.0` in Python and `1`
    here, because JSON has one number type and `JSON.parse` erases the int/float split
    `str()` reads. Every other number, including one with a fractional part, matches.

  Everything else matches byte for byte, including the six shapes `str()` renders
  differently from `JSON.stringify` (`None`, `True`, `False`, and the `repr` quoting of
  nested lists, dicts and strings, which switches to double quotes for a string that
  contains an apostrophe and no double quote).

  ```
  $ cd api && uv run python scripts/export_nextjs_router_parity.py     # .env sourced
  stand-in Next.js blog on http://127.0.0.1:63653
    success-200-json: 1 request(s), returned {"connected": true}
    success-200-empty-body: 1 request(s), returned {"connected": true}
    success-200-not-json: 1 request(s), returned {"connected": true}
    created-201-is-a-failure: 1 request(s), returned {"connected": false, "error": "Webhook returned 201: {\"ok\": true}"}
    no-content-204-is-a-failure: 1 request(s), returned {"connected": false, "error": "Webhook returned 204: "}
    redirect-302-is-not-followed: 1 request(s), returned {"connected": false, "error": "Webhook returned 302: moved"}
    401-json-error-key: 1 request(s), returned {"connected": false, "error": "Webhook returned 401: Invalid signature"}
    500-json-without-error-key: 1 request(s), returned {"connected": false, "error": "Webhook returned 500: {\"message\": \"boom\", \"code\": 17}"}
    404-long-html-truncated-to-200-chars: 1 request(s), returned {"connected": false, "error": "Webhook returned 404: <html><body>vercel: this deployment i...
    400-json-array-body: 1 request(s), returned {"connected": false, "error": "Webhook returned 400: [{\"error\": \"not reached\"}]"}
    400-json-null-body: 1 request(s), returned {"connected": false, "error": "Webhook returned 400: null"}
    400-json-string-body: 1 request(s), returned {"connected": false, "error": "Webhook returned 400: \"just a string\""}
    502-error-key-is-null: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: None"}
    502-error-key-is-true: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: True"}
    502-error-key-is-an-int: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: 42"}
    502-error-key-is-an-integral-float: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: 1.0"}
    502-error-key-is-a-list: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: ['a', 1, None]"}
    502-error-key-is-a-list-of-quoted-strings: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: [\"it's\", 'say \"hi\"', ...
    502-error-key-is-an-object: 1 request(s), returned {"connected": false, "error": "Webhook returned 502: {'why': 'nested'}"}
    503-empty-body: 1 request(s), returned {"connected": false, "error": "Webhook returned 503: "}
    connection-refused: 0 request(s), returned {"connected": false, "error": "All connection attempts failed"}
    profile-not-found: 0 request(s), HTTPException 404: Profile not found
    profile-owned-by-another-user: 0 request(s), HTTPException 404: Profile not found
    no-webhook-url: 0 request(s), returned {"connected": false, "error": "Webhook URL or secret not configured"}
    empty-webhook-url: 0 request(s), returned {"connected": false, "error": "Webhook URL or secret not configured"}
    no-webhook-secret: 0 request(s), returned {"connected": false, "error": "Webhook URL or secret not configured"}
    empty-webhook-secret: 0 request(s), returned {"connected": false, "error": "Webhook URL or secret not configured"}
    undecryptable-webhook-secret: 0 request(s), returned {"connected": false, "error": "Failed to decrypt webhook secret"}
    unset-encryption-key: 0 request(s), returned {"connected": false, "error": "Failed to decrypt webhook secret"}
  wrote 29 scenarios to .../web/src/app/api/profiles/data/nextjs-router-parity.json

  $ pnpm -C web vitest run "src/app/api/profiles/[id]/nextjs/nextjs.test.ts"
   v src/app/api/profiles/[id]/nextjs/nextjs.test.ts (63 tests) 224ms
   Test Files  1 passed (1)
        Tests  63 passed (63)
  ```

  Fourteen negative controls, each reverted after measuring. `Tests N failed` is the
  count out of 63:

  | Mutation | Result |
  | --- | --- |
  | `redirect: "manual"` becomes `"follow"` | 2 failed |
  | `response.status === 200` becomes `< 300` | 2 failed |
  | payload built with `JSON.stringify` | 20 failed |
  | timestamp built with `toISOString()` | 20 failed |
  | `pythonStr(record.error)` becomes `String(record.error)` | 5 failed |
  | `text.slice(0, 200)` becomes `slice(0, 300)` | 1 failed |
  | `repr` always single-quotes | 1 failed |
  | `pythonStr` sends strings through `repr` too | 1 failed |
  | `eq(websiteProfiles.userId, user.id)` dropped from the `where` | 3 failed |
  | `!profile.url \|\| !profile.secret` becomes `== null` | 2 failed |
  | `signPayload(payload, secret)` becomes `signPayload("", secret)` | 21 failed |
  | decrypt failure reuses the not-configured message | 2 failed |
  | `Content-Type: application/json` header dropped | 20 failed |
  | `if (!user) return unauthorized()` disabled | 1 failed |

  **One control had no teeth, and the code it covered was removed rather than kept.**
  Deleting the `Array.isArray(parsed)` guard from `webhookDetail` failed nothing, because
  a JSON array can never carry an `error` key, so `"error" in record` sends it to the same
  truncated-text fallback the guard did. The guard was dead code and is gone; the comment
  in `detail.ts` records why only `null` still needs its own branch.

  `web/src/lib/api.ts` still points at the Python origin, so there is no per-router UI
  check here either; it flips to same-origin once Phase 5 finishes, as recorded under
  5.1b. Phase 5's one remaining item is 5.3c-iii-b, the two publish paths.

  Gates, both stacks:

  ```
  $ pnpm -C web tsc --noEmit
  TSC EXIT=0

  $ pnpm -C web lint
  LINT EXIT=0

  $ pnpm -C web test
   Test Files  3 failed | 101 passed (104)
        Tests  10 failed | 2248 passed | 7 skipped (2265)
  (the Phase 0 baseline of 9: 6 in image-preview.test.tsx and 3 in PostDetail.test.tsx,
  plus the known scaffold-check.test.ts flake already logged in todo.md. That file
  passes 5/5 in isolation:
    $ pnpm -C web vitest run src/mastra/workflows/scaffold-check.test.ts
     Test Files  1 passed (1))

  $ pnpm -C web build
  BUILD EXIT=0
  v Compiled successfully in 4.2s
  |- f /api/profiles/[id]/nextjs/test

  $ cd api && uv run pytest -q          # with the repo .env sourced
  120 failed, 241 passed, 25 errors in 15.06s

  $ cd api && uv run ruff check .
  Found 32 errors.

  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 134 files already formatted
  ```

`auth` is out of scope; BetterAuth already owns it.

## 5.3c-iii-b-2-b

Ported to `web/src/mastra/nextjs/apply-mapping-to-content.ts`, on top of a port of
PyYAML itself in `web/src/mastra/nextjs/pyyaml/` (`load.ts`, `dump.ts`, `values.ts`).

`_apply_mapping_to_content` is sixteen lines, and fourteen of them are the two PyYAML
calls it makes. Those calls decide the bytes in the reader's blog repo, so the bytes are
the contract:

- `yaml.safe_load` is a YAML **1.1** reader. `yes` is a bool, `017` is octal, `1:30` is
  sexagesimal, `2026-08-23` is a `datetime.date`, and `1e3` is a *string*, because
  PyYAML's float pattern needs both a dot and a signed exponent.
- `yaml.dump(..., default_flow_style=False, allow_unicode=True)` never emits a block
  scalar, folds at column 80, indents a sequence at its parent's level, sorts keys when
  they are mutually comparable, and picks plain, then single-quoted, then double-quoted.

**No JavaScript YAML library produces those bytes**, which is the finding that shaped the
item. Measured against `yaml.dump` over 22 representative values:

```
js-yaml 4.1.1  (sortKeys: true, lineWidth: 80)                   12 of 22 identical
yaml 2.9.0     (blockQuote: false, indentSeq: false, ...)        10 of 22 identical
```

Both prefer `|`/`>` blocks for multi-line and long strings, indent sequences under their
key, and differ on `''` keys; the `yaml` package also prefers `"` over `'` and folds one
column early. So `representer.py`, `serializer.py` and the block half of `emitter.py` are
transcribed in `pyyaml/dump.ts`, and `resolver.py` plus `SafeConstructor` in
`pyyaml/load.ts`. The `yaml` package is now a direct dependency of `web/`
(`pnpm -C web add yaml@2.9.0`) and is used for **syntax only**: `parseAllDocuments` gives
the node tree, every scalar keeps its text and its style, and the tag resolution and
construction on top of it are PyYAML's.

**Four behaviours the port preserves**, each of which an obvious implementation loses:

- `content.split("---", 2)` splits on the *substring*. `----` is two splits with an empty
  middle, `------` produces `---\n{}\n---`, and a `---` inside the body is what closes the
  block. Fewer than three parts returns the content untouched.
- `yaml.safe_load(parts[1]) or {}` replaces any *falsy* load with an empty dict, so an
  empty block, a comment-only block, `[]`, `{}`, `0` and `''` all emit `{}`. A truthy
  non-dict is **not** replaced, and `apply_frontmatter_mapping` then runs `in`, `[]` and
  `.get` against a string or a list: `TypeError: string indices must be integers, not
  'str'`, `AttributeError: 'str' object has no attribute 'get'`. `publish_to_nextjs`
  catches neither, so a body whose first line is `---` fails the publish, and the port
  fails it the same way rather than publishing something Python refused.
- `represent_mapping` wraps `sorted(mapping.items())` in `try/except TypeError`, so key
  order is sorted for mutually comparable keys and insertion order otherwise. Only the
  keys are ever compared (a tuple comparison reaches the value only for equal keys, which
  a dict cannot hold), and for two or more keys of mixed comparability classes every
  element is compared with at least one other, so "mixed classes" is the same test as
  "did Python's sort raise". A lone `None` key sorts; a `None` key beside a string does
  not.
- A repeated object gets an `&id001` anchor and an `*id001` reference, because
  `SafeRepresenter.ignore_aliases` covers only the immutable scalars. Two mapping entries
  reading one aliased list, or a `date` reached twice, both hit this.

**Three divergences, deliberate, all recorded as tests:**

1. **Error wording.** A document PyYAML refuses raises here too, but with the `yaml`
   package's message, not PyYAML's scanner's. Sixteen oracle cases assert only that a
   `yaml.YAMLError` subclass is raised. `Reader.check_printable` *is* ported, so a literal
   NUL, ESC, DEL or C1 control fails the publish here exactly as it does in Python.
2. **NEL, LS and PS as line breaks.** YAML 1.1 counts U+0085/2028/2029 as line breaks; the
   `yaml` package counts only CR and LF. A literal one inside a scalar stays content here
   where PyYAML folds it. Rewriting them to newlines was tried and is worse: the `yaml`
   package rejects a quoted scalar whose continuation is not indented past its parent,
   which PyYAML accepts, so the rewrite failed documents Python reads fine. The escaped
   forms (`"\N"`, `"\L"`, `"\P"`) are content in both and do agree.
3. **A surrogate pair escape.** `"🎉"` is two lone surrogates in Python, which
   are not printable and come back out escaped. A JavaScript string cannot hold that pair
   as anything but the astral character it encodes. Written as the character itself, which
   is what real frontmatter holds, the two agree.

Also fixed here, in the module the previous item left behind: `applyFrontmatterMapping`
looked its source field up with `Map.has`/`Map.get`, which cannot see that Python hashes
`True` with `1` and that two equal `date`s are one key. It now goes through `pyDictHas`
/`pyDictGet`, and `setResultKey`'s hand-rolled true/1 twin lookup is the shared
`pyDictSet`. Item 5.3c-iii-b-2-a's 61 tests still pass unchanged.

The oracle is `web/src/mastra/nextjs/data/nextjs-mapping-to-content-parity.json`, written
by `api/scripts/export_mapping_to_content_parity.py`, which asserts the eight lines it is
describing are still in the real function (`inspect.getsource`) before running it:

```
$ cd api && uv run python scripts/export_mapping_to_content_parity.py
wrote 201 cases (16 raising) to .../web/src/mastra/nextjs/data/nextjs-mapping-to-content-parity.json

$ pnpm -C web vitest run src/mastra/nextjs/apply-mapping-to-content.test.ts
 ✓ src/mastra/nextjs/apply-mapping-to-content.test.ts (205 tests) 22ms

 Test Files  1 passed (1)
      Tests  205 passed (205)
   Duration  392ms

$ pnpm -C web vitest run src/mastra/nextjs/
 Test Files  2 passed (2)
      Tests  266 passed (266)
```

**A randomised differential run** on top of the oracle, because a hand-picked corpus
cannot cover an emitter: 600 documents per seed, generated from a grammar of nested maps,
sequences and 60 adversarial scalars (indicators, long lines, control characters, unicode,
trailing spaces, block scalars) crossed with random mappings, run through the real Python
function and the port and compared byte for byte. Four seeds, 2400 documents:

```
seed 20260823   600 cases (459 output, 141 raising in both)   mismatches: 0
seed 7          600 cases (480 output, 120 raising in both)   mismatches: 0
seed 99         600 cases (474 output, 126 raising in both)   mismatches: 0
seed 4242       600 cases (477 output, 123 raising in both)   mismatches: 0
```

The generator lives at `/tmp/fuzz_gen.py` and is not committed: it is a measurement, not a
fixture, and it needs the Python side to run. It is what found divergences 2 and 3 above,
and the `Reader.check_printable` gap: before that check was ported, 27 of the first 600
cases published content Python had refused.

Twenty-eight mutations, each applied alone and reverted after measuring, counted against
`pnpm -C web vitest run src/mastra/nextjs/` (266 tests). Twenty-five are killed:

```
1  split fence guard (--- becomes --)                 apply-mapping-to-content.ts   1 failed
2  split maxsplit 2 becomes 3                         apply-mapping-to-content.ts   4 failed
3  parts length guard 3 becomes 2                     apply-mapping-to-content.ts   2 failed
4  the `or {}` truthiness becomes `?? {}`             apply-mapping-to-content.ts   3 failed
5  the rebuilt fence gains a newline                  apply-mapping-to-content.ts 183 failed
6  the non-dict `.get` AttributeError is dropped      apply-mapping-to-content.ts   1 failed
7  `in` against a string always misses                apply-mapping-to-content.ts   1 failed
8  the resolver's first-character list is ignored     load.ts                     SURVIVED
9  yaml 1.1 on/off drop out of the bool pattern       load.ts                       2 failed
10 a leading zero is decimal rather than octal        load.ts                       1 failed
11 sexagesimal ints use base 10                       load.ts                       1 failed
12 a timestamp without a time is still a datetime     load.ts                       4 failed
13 merged pairs are appended rather than prepended    load.ts                       1 failed
14 a scalar's text is always its source               load.ts                     SURVIVED
15 mixed key classes no longer raise                  dump.ts                       2 failed
16 a lone key is compared                             dump.ts                     SURVIVED
17 single-quoted style is never chosen                dump.ts                      42 failed
18 a line break no longer forbids block plain         dump.ts                       8 failed
19 write_indent's column test becomes >=              dump.ts                     167 failed
20 best_width 80 becomes 100                          dump.ts                       7 failed
21 represent_float's `.0e` fixup is dropped           dump.ts                       2 failed
22 the prepared tag is never written                  dump.ts                       4 failed
23 the anchor template pads to 2 rather than 3        dump.ts                       7 failed
24 expect_scalar's extra indent level is dropped      dump.ts                      41 failed
25 a scalar node is never recorded for aliasing       dump.ts                       1 failed
26 Reader.check_printable is skipped                  load.ts                       5 failed
27 the printable range admits the C1 controls         load.ts                       1 failed
28 the source field is looked up with Map.has         frontmatter-mapping.ts        1 failed
```

The three survivors are equivalent mutants:

- **8** drops the first-character filter in front of the implicit resolvers. Every pattern
  is anchored and can only match a scalar whose first character is already in its own
  registration list (`yYnNtTfFoO` for bool, `-+0123456789.` for float, `~nN` plus the
  empty string for null), so the filter cannot change which pattern matches first.
- **14** makes `scalarText` always return `Scalar.source`. In `yaml` 2.9.0 `source` holds
  the *normalised* scalar text (folded for a multi-line plain scalar, unescaped for a
  quoted one) and differs from `.value` only when the library resolved the value to a
  non-string, in which case the port re-resolves the same text itself. Verified by
  printing both for plain, folded, single-quoted, double-quoted and literal scalars.
- **16** lowers `pythonSorted`'s early return from two items to one. With one item there
  is nothing to compare and both branches return the same one-item order.

Gates:

```
$ pnpm -C web tsc --noEmit
(exit 0)

$ pnpm -C web lint
(exit 0)

$ pnpm -C web test
 Test Files  3 failed | 119 passed (122)
      Tests  10 failed | 4215 passed | 7 skipped (4232)
(the Phase 0 baseline of 9: 6 in image-preview.test.tsx and 3 in PostDetail.test.tsx,
plus the known scaffold-check.test.ts flake. A second run of the same suite reported 11,
the extra being pipeline-completion.test.ts, which passes 14/14 in isolation:
  $ pnpm -C web vitest run src/mastra/workflows/pipeline-completion.test.ts
   Tests  14 passed (14))

$ pnpm -C web build
(exit 0, compiled successfully)

$ cd api && uv run pytest -q          # with the repo .env exported, see the note below
120 failed, 241 passed, 25 errors in 13.14s   # the recorded baseline, unchanged

$ cd api && uv run ruff check scripts/export_mapping_to_content_parity.py
All checks passed!

$ cd api && uv run ruff format --check scripts/export_mapping_to_content_parity.py
1 file already formatted
```

Note for the next iteration: `source ../.env` is not enough to reproduce the pytest
baseline. `.env` has no `export` lines, so the variables stay shell-local and pytest still
reaches the compose default port; `set -a; source ../.env; set +a` is what exports them.
Without it the run answers `4 failed, 205 passed, 177 errors`, and with only a partial
export, `InvalidPasswordError` against whatever else is listening on 5433.

## 5.3c-iii-b-2-c

The Next.js webhook payload: `post.ready_content or post.final_md_content or ""`, the
`image_manifest` walk that base64-encodes each image off disk, and the `json.dumps` whose
exact bytes the HMAC signature covers.

Ported in `web/src/mastra/nextjs/payload.ts` (the block) and
`web/src/mastra/nextjs/json-dumps.ts` (`json.dumps` with CPython's defaults). Two helpers
already written for the WordPress branch are exported rather than re-spelled:
`pythonTypeName` from `web/src/mastra/wordpress/media-upload.ts` (with its unreachable
`default` arm corrected from `object` to `dict`) and `statOrAbsent` from
`web/src/mastra/wordpress/media-walk.ts`, which is `pathlib._IGNORED_ERRNOS` behind
`is_file()`. `pyTruthy` is exported out of `apply-mapping-to-content.ts` with an arm added
for a decoded JSON object, which `yaml.safe_load` never returns but the `image_manifest`
and `nextjs_frontmatter_map` columns do.

### Why `JSON.stringify` is not the port

`json.dumps` differs from `JSON.stringify` on ordinary article content, not on edge cases:

- `ensure_ascii` defaults to true, so every character outside `\x20`-`\x7e` becomes a
  `\uXXXX` escape. That is every accented letter, CJK character and emoji in the post, and
  it includes `\x7f`, which `JSON.stringify` emits literally.
- With no `indent` the separators are `", "` and `": "`, not `","` and `":"`.

Both are covered by the oracle and by direct `JSON.stringify` comparisons in the test.

### Preserved behaviours

1. `manifest.get`, `img.get`, `"/" in url` and `url.rsplit` are Python attribute lookup and
   membership over a JSONB column holding model output. A manifest that is a string, an
   `images` that is `null`, or an entry that is a list raises `AttributeError` or
   `TypeError` out of `publish_to_nextjs`, which catches neither, so the publish fails
   rather than skipping the entry. Twelve oracle cases record the raise and its message.
2. `.get` reads a stored `null` as the value rather than as a missing key, so
   `{"alt_text": null}` yields `null` in the payload where a `??` fallback would yield `""`.
3. `post.image_manifest or {"images": []}` is Python truthiness: an empty dict, an empty
   list and a stored `0` all take the default, and a stored `[]` therefore succeeds where a
   JavaScript truthiness test would reach `[].get` and raise.
4. `Path.is_file()` swallows `ENOENT`, `ENOTDIR`, `EBADF`, `ELOOP` and the `ValueError`
   from an embedded NUL and lets everything else through, so a `url` ending in `..`, naming
   a directory, or naming a file that is not there all record `"data": null`, while a name
   too long for the filesystem raises `OSError` out of the publish.

### Divergences

1. **`OSError` message.** Node reports a symbolic code where CPython reports
   `[Errno N] <strerror>`, and the numbering is platform specific (36 on Linux, 63 on
   macOS). `PyOSError` preserves the code and the path only. The oracle's message is
   asserted to contain `File name too long`; the port's is matched against
   `/^ENAMETOOLONG: '.*\/media\/post-1\/a{300}\.webp'$/`.
2. **Int versus float, and integers past 2^53.** Python reads a JSON number without a
   fraction or exponent as an `int` and any other as a `float`, and re-emits them
   differently (`1.0` stays `1.0`, `1e2` becomes `100.0`). The `pg` driver parses a JSONB
   column with `JSON.parse`, which erases the tag before this module sees it, and loses
   digits past 2^53. Eleven `dumps` cases are listed in `PARSE_DIVERGENCES` in the test with
   the value the port actually produces, asserted both to equal that and to differ from
   Python's. Not reachable from the payload's own seven keys or an image record's five,
   which are fixed, non-numeric and string valued.
3. **Object key order.** JavaScript reorders integer-like keys to the front of an object,
   so a nested `{"2": …, "a": …, "1": …}` inside `alt_text` emits in a different order than
   Python's insertion-ordered dict. Same root cause as (2), same reachability.
4. **Timestamp precision.** `datetime.now(UTC).isoformat()` prints microseconds; a `Date`
   only carries milliseconds, so `isoformatUtc` always ends `000+00:00`. It reproduces
   Python's rule of omitting the fractional part entirely when the microseconds are zero.

Divergences 2 and 3 are recorded in `todo.md`.

### The oracle

`api/scripts/export_nextjs_payload_parity.py` asserts via `inspect.getsource` that the
twenty-five lines it describes are still in `publish_to_nextjs`, extracts the block between
`content = post.ready_content …` and `signature = sign_payload(…)`, dedents it, compiles it
and executes it against stubs for `post`, `profile`, `settings`, `uuid` and `datetime`, so
the recorded answers cannot drift from the block they describe without the export raising.
It runs inside the deployed image, matching the practice set in 5.3c-iii-b-1-c-ii-3.

```
$ docker run --rm -v "$PWD/api/scripts:/app/scripts:ro" \
    -v "$PWD/web/src/mastra/nextjs/data:/out" jena-api-oracle \
    python scripts/export_nextjs_payload_parity.py /out/nextjs-payload-parity.json
wrote 78 cases and 30 dumps cases to /out/nextjs-payload-parity.json
```

78 payload cases (66 returning the exact `json.dumps` string, 12 raising) plus 30
`json.dumps` cases recorded as raw JSON literals so the int/float distinction survives the
file format.

```
$ pnpm -C web vitest run src/mastra/nextjs/payload.test.ts
 Test Files  1 passed (1)
      Tests  121 passed (121)
```

### Mutations

Thirty-four mutations, each applied to `payload.ts` or `json-dumps.ts` alone with the
oracle test re-run and the file restored. Thirty-one killed, three survive with an
equivalence argument.

| Mutation | Verdict | Failing tests |
| --- | --- | --- |
| payload: `??` instead of Python `or` for content | killed | 2 |
| payload: JS truthiness for the manifest default | killed | 1 |
| payload: subscript instead of `.get` for images | killed | 3 |
| payload: JS truthiness for url | SURVIVED | 0 |
| payload: drop the slash membership test | killed | 4 |
| payload: drop the empty-filename guard | killed | 4 |
| payload: `??` instead of `hasOwn` in `.get` | killed | 3 |
| payload: wrong alt default | killed | 15 |
| payload: wrong placement default | killed | 19 |
| payload: `split` instead of `rsplit` | killed | 26 |
| payload: image key order | killed | 23 |
| payload: `base64url` instead of `base64` | killed | 16 |
| payload: exists instead of `is_file` | killed | 3 |
| payload: JS truthiness for the frontmatter map | killed | 1 |
| payload: media dir without the post id | killed | 18 |
| payload: iterating a string as one item | killed | 1 |
| payload: iterating a dict as its values | killed | 1 |
| payload: wrong event name | killed | 66 |
| payload: no `+00:00` offset | killed | 1 |
| payload: `null` instead of `""` as the url default | SURVIVED | 0 |
| payload: list membership always false | killed | 1 |
| payload: iterating a string by code unit | SURVIVED | 0 |
| payload: let the embedded-NUL `ValueError` through | killed | 1 |
| dumps: leave U+007F literal | killed | 3 |
| dumps: escape only above U+00FF | killed | 9 |
| dumps: no space after the array comma | killed | 5 |
| dumps: no space after the key colon | killed | 70 |
| dumps: no space after the object comma | killed | 69 |
| dumps: unpadded escape | killed | 11 |
| dumps: uppercase hex escape | killed | 11 |
| dumps: `String()` for every number | killed | 3 |
| dumps: `String()` instead of `BigInt` for an int | killed | 4 |
| dumps: no backspace shortcut | killed | 3 |
| dumps: `-0.0` for negative zero | killed | 2 |

Equivalence proofs for the three survivors:

- **JS truthiness for url.** The only JSON values on which Python and JavaScript truthiness
  disagree are `{}` and `[]`. Both then fail `"/" in url` (`hasOwn` on an empty object,
  `includes` on an empty array), produce an empty `actual_filename` and hit the next
  `continue`, so the entry is skipped either way. Every other value (`0`, `false`, `""`,
  `null`) is falsy in both languages.
- **`null` instead of `""` as the url default.** Both defaults are falsy, and the guard on
  the very next line skips the entry, so the default is never observable.
- **Iterating a string by code unit rather than code point.** They differ only on an astral
  character, and every element of either iteration is a `str`, which raises the same
  `AttributeError: 'str' object has no attribute 'get'` on the next line.

Two mutations found real gaps rather than equivalences and were fixed by adding oracle
cases rather than controls, as in 5.3c-iii-b-1-c-ii-3: `{"images": ""}` and
`{"images": {}}` are both iterable and both yield nothing, which is what separates
iterating a string from wrapping it. Two more found dead code in the first draft: the
`index === -1` arm of `rsplit` is unreachable behind the membership guard (`slice` from
`lastIndexOf(…) + 1` is `rsplit`'s whole semantics with no branch), and the `1e21`
threshold on the integral arm of `encodeNumber` is inert because `String(n)` and
`BigInt(n).toString()` agree for every integral value below it. Both were removed.

### Gates

```
$ pnpm -C web tsc --noEmit
(exit 0)

$ pnpm -C web lint
(exit 0)

$ pnpm -C web test
 Test Files  2 failed | 121 passed (123)
      Tests  9 failed | 4337 passed | 7 skipped (4353)
(the Phase 0 baseline of 9: 6 in image-preview.test.tsx and 3 in PostDetail.test.tsx)

$ pnpm -C web build
(exit 0, compiled successfully)

$ cd api && uv run pytest -q          # with `set -a; source ../.env; set +a`
120 failed, 241 passed, 25 errors in 12.81s   # the recorded baseline, unchanged

$ cd api && uv run ruff check .
Found 32 errors.                              # all pre-existing; the new script is clean

$ cd api && uv run ruff check scripts/export_nextjs_payload_parity.py
All checks passed!

$ cd api && uv run ruff format --check scripts/export_nextjs_payload_parity.py
1 file already formatted
```

## 5.3c-iii-b-2-d

The Mastra step and workflow for `publish_to_nextjs` (`api/src/services/nextjs_publish.py`):
the profile, webhook-configuration and decrypt guards, the `nextjs_publish_status`
transitions with `nextjs_published_at`, the webhook `POST` with `X-Jena-Signature` and its
200 check, and the `publish_start` / `publish_complete` / `publish_error` events with
`_fail`.

- `web/src/mastra/steps/nextjs-publish.ts`: the step.
- `web/src/mastra/workflows/nextjs-publish.ts`: the one-step workflow, registered as
  `nextjsPublish` in `web/src/mastra/index.ts`.

The three content transforms it composes were ported and pinned in the three preceding
sub-items (`applyFrontmatterMapping`, `applyMappingToContent`, `buildNextjsPayload`) and the
signature in `web/src/lib/hmac-signing.ts`, so what is new here is only the part with no
pure oracle.

Two housekeeping changes the ledger item called for, both done:

- `web/src/db/schema.ts` widens `nextjs_frontmatter_map` from `Record<string, string>` to
  `Record<string, unknown>`. A mapping target is stored as either a bare field name or a
  dict of options (`{key, default, transform}`), so the narrower type contradicted the
  column; `web/src/lib/api.ts` and `web/src/app/api/profiles/serialize.ts` already described
  it as `unknown`.
- `web/src/mastra/no-next-imports.test.ts` gains `yaml`. Registering this workflow is what
  first pulls `web/src/mastra/nextjs/pyyaml/` into the entry point's import graph. The test
  failed with exactly that one-package diff before the list was updated, which is the
  negative control for the change.

### Preserved behaviours

1. **The payload build is outside the `try`.** Python wraps only the `httpx` call. An
   `AttributeError` out of the manifest walk, a `TypeError` out of the frontmatter mapping
   or an `OSError` off the filesystem all propagate out of the job, leaving the row reading
   `publishing` and letting ARQ retry. Reproduced by letting the exception leave the step,
   with `retryConfig: { attempts: MAX_ATTEMPTS - 1 }` on the workflow standing in for
   `max_tries = 3` (one fewer because the evented engine counts retries after the first
   execution). Its WordPress sibling deliberately catches everything and carries no
   `retryConfig`; the two are asserted against each other in `index.test.ts`.
2. **`_fail` writes no execution log.** The WordPress hook's does. Copying that here would
   put an entry in `GET /posts/{id}/logs` that Python never wrote. Asserted empty on both
   the success path and the three guard failures.
3. **Only 200 is success.** No `raise_for_status()` and no `< 300`: a receiver answering
   `201 Created` fails the publish with `Webhook returned 201: …`, and the row says
   `failed`.
4. **The guards are truthiness, not null checks.** `if not profile.nextjs_webhook_url or
   not profile.nextjs_webhook_secret` treats the empty string the profile form saves for a
   cleared field as missing.
5. **`{"target": "nextjs"}` is the whole event payload**, where the WordPress events carry
   human-readable `message` fields. `web/src/hooks/use-sse.ts` forwards what arrives, so the
   difference is visible in the dashboard and is preserved.
6. **`_fail` logs before it writes the column**, which is the opposite order from the
   WordPress hook's. Kept as written: nothing depends on the ordering, and reordering to
   match its sibling would be a change with no reason behind it.

### Divergences

1. **`response.text[:200]` slices code points.** `String.prototype.slice` counts UTF-16
   units, so an astral character in a webhook's error body would be cut in half and the
   recorded message would end in a lone surrogate. `sliceCodePoints` slices by code point;
   the test drives a 260-character body led by U+1F41D and asserts both the correct result
   and that it differs from the naive slice.
2. **Body decoding.** `httpx` decodes using the charset from `Content-Type` and falls back
   to charset detection; `Response.text()` is always UTF-8. A receiver answering
   `text/plain; charset=latin-1` therefore produces a different recorded message. Not worth
   a decoder: the failure and its status code are what the dashboard shows.
3. **`Webhook request failed: {exc}`** interpolates the `httpx` exception's `str`. `fetch`
   reports Node's. The prefix is asserted; the tail is matched with a regex.

### The test

`web/src/mastra/steps/nextjs-publish.test.ts`, 19 tests, nothing mocked: the receiving blog
is a Node `http.Server` on a loopback port that records every request, the images are real
files under a real `MEDIA_DIR`, the rows are real rows in the dev database, the secret is a
real Fernet token, and the signature is recomputed from the bytes the server received rather
than from the bytes the step thought it sent. `publishing` is observed from inside the
server's handler, which is the only place that transient value exists.

```
$ set -a; source .env; set +a
$ pnpm -C web exec vitest run src/mastra/steps/nextjs-publish.test.ts
 Test Files  1 passed (1)
      Tests  19 passed (19)

$ pnpm -C web exec vitest run src/mastra/index.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ pnpm -C web exec vitest run src/mastra/no-next-imports.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

### Mutations

Thirty-two mutations, each applied to `nextjs-publish.ts` alone with
`nextjs-publish.test.ts` and `index.test.ts` re-run and the file restored. A control run of
the unmutated file exits 0 first, per the iteration-128 finding that a broken vitest
invocation reads as perfect coverage.

| Mutation | Verdict |
| --- | --- |
| missing post: `fail` instead of the bare return | killed |
| no-profile message text | killed |
| unconfigured message text | killed |
| url/secret guard: `&&` instead of `\|\|` | killed |
| url guard: null check instead of truthiness | killed |
| decrypt failure message | killed |
| skip the `publishing` write | killed |
| `publish_start` payload has no `target` | killed |
| `publish_start` not sent | killed |
| frontmatter map not passed | killed |
| content selection reversed | killed |
| sign the payload with the ciphertext | killed |
| signature header renamed | killed |
| `Content-Type` dropped | killed |
| `GET` instead of `POST` | killed |
| status check accepts any 2xx | killed |
| slice by UTF-16 units | killed |
| slice limit 100 | killed |
| request-failure prefix reworded | killed |
| non-200 message drops the status code | killed |
| `nextjs_published_at` not written | killed |
| status left `publishing` on success | killed |
| `publish_complete` not sent | killed |
| `_fail` does not write the column | killed |
| `_fail` does not publish the event | killed |
| `_fail` event `target` dropped | killed |
| payload build wrapped so it cannot throw | killed |
| missing-image log callback dropped | killed |
| `_fail` writes an execution log | killed |
| `mediaDir` ignores `MEDIA_DIR` | killed |
| `delivery_id` constant | killed |
| `slug` not sent | killed |

32/32. Four survived the first pass and all four were real test gaps rather than
equivalences, fixed by strengthening the test:

- the two guard messages were only asserted through the exported constants, which mutate
  with the implementation. Both are now asserted as literals as well.
- nothing exercised a 2xx that is not 200, so `!== 200` and `>= 300` were
  indistinguishable. A `201 Created` case was added.
- the "writes no execution log" assertion covered only the success path, so a `_fail` that
  appended one survived. The three guard failures now assert it too.

### Gates

```
$ pnpm -C web tsc --noEmit
(exit 0)

$ pnpm -C web lint
(exit 0)

$ pnpm -C web test
 Test Files  2 failed | 122 passed (124)
      Tests  9 failed | 4357 passed | 7 skipped (4373)
(the Phase 0 baseline of 9, confirmed by running the two files alone:
 6 in src/components/__tests__/image-preview.test.tsx and 3 in src/app/posts/PostDetail.test.tsx)

$ pnpm -C web build
(exit 0, compiled successfully)
```

No Python file is touched by this item (`git status --porcelain` lists only files under
`web/`), so the pytest and ruff baselines recorded under 5.3c-iii-b-2-c stand unchanged.
