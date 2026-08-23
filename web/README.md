# web

The application. Next.js dashboard, route handlers, and the Mastra workflow that runs the
content pipeline.

See the repo root for everything else: [`README.md`](../README.md) for the architecture and
setup, [`CLAUDE.md`](../CLAUDE.md) for the conventions and the traps.

```bash
pnpm -C web dev                                          # dashboard on :3000
pnpm -C web worker:build && pnpm -C web worker            # workflow runner
pnpm -C web studio                                       # Mastra Studio on :4111
```
