# Pre-port design documents

Three design documents written before this port, kept verbatim. They describe
the architecture the port replaced: a Python FastAPI service with an ARQ worker
and an Alembic migration chain, talking to the same Next.js dashboard.

They live here rather than under `docs/` because ledger item 7.7 requires that
no reference to the Python stack survives outside `docs/mastra-port/`, and
these documents are exactly that: the record of what was there before. Nothing
in them describes the code as it stands today. For that, read `CLAUDE.md`,
`README.md` and the rest of `docs/mastra-port/`.

| File | Was | Status |
| --- | --- | --- |
| `saas-multi-tenancy-plan.md` | `docs/plans/saas.md` | Implemented, then ported. BetterAuth and the `user_id` columns survive; the FastAPI session validation it describes does not. |
| `nextjs-publishing-plan.md` | `docs/superpowers/plans/2026-04-09-jena-nextjs-publishing.md` | Implemented, then ported to `src/mastra/workflows/nextjs-publish.ts`. The webhook contract with `packages/create-mdx-blog` is unchanged. |
| `nextjs-blog-integration-design.md` | `docs/superpowers/specs/2026-04-09-nextjs-blog-integration-design.md` | The spec behind the plan above. |
