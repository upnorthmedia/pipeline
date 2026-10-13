/**
 * Bundles `scripts/predeploy.ts` into the Next standalone output as one
 * self-contained ESM file.
 *
 * The pre-deploy hook runs beside `server.js` in an image whose
 * `node_modules` holds only what file tracing copied, and nothing it copied is
 * reachable from `/app/scripts`: `better-auth` lands under `.pnpm/` with no
 * top-level entry, and `@better-auth/stripe`, `stripe`, `resend` and
 * `@mastra/pg` are bundled into the server chunks rather than externalised, so
 * they are not packages at all in the image. Ledger item P2.77b-i measured the
 * alternative: naming a package in `outputFileTracingIncludes` copies it once
 * per alias in pnpm's virtual store and took `.next/standalone` from 151MB to
 * 426MB. One 7MB bundle is the cheaper answer, and `drizzle-orm` stays a
 * Dockerfile `COPY` because `scripts/migrate.mjs` runs unbundled.
 *
 * Run through `pnpm build`, which chains it after `next build`, so the tree
 * `pnpm standalone:check` reads and the tree the Dockerfile copies are the same
 * tree. `src/db/predeploy.test.ts` calls `bundlePredeploy()` directly with its
 * own output path, which is why the bundling is a function and not a script
 * body.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import * as esbuild from "esbuild"

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Where the runtime images look for it, relative to `/app`. */
export const predeployBundlePath = path.join("scripts", "predeploy.mjs")

/** The default output: inside the standalone tree the Dockerfile copies wholesale. */
export const standaloneBundleFile = path.join(webDir, ".next", "standalone", predeployBundlePath)

/**
 * `pg` reaches both of these with a bare `require` inside a `try`, and neither
 * is installed. Bundling them in would turn an optional native accelerator into
 * a build failure; leaving them external keeps the `require` a `require`, which
 * `pg` already handles when it throws.
 */
const OPTIONAL_NATIVE = ["pg-native", "pg-cloudflare"]

/**
 * ESM output with CommonJS dependencies in it needs a `require`. Without this
 * the bundle dies on the first `require("events")` inside `pg`, at run time,
 * which is a failure no build step would have shown.
 */
const BANNER =
  'import { createRequire as __createRequire } from "node:module";\n' +
  "const require = __createRequire(import.meta.url);\n"

/**
 * @param {string} [outFile] absolute path to write; defaults to the standalone tree
 * @returns {Promise<{ outFile: string; bytes: number }>}
 */
export async function bundlePredeploy(outFile = standaloneBundleFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(webDir, "scripts", "predeploy.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    // The runtime images are `node:22-alpine`, and the Dockerfile is the only
    // thing that decides that.
    target: "node22",
    external: OPTIONAL_NATIVE,
    banner: { js: BANNER },
    logLevel: "warning",
  })
  return { outFile, bytes: fs.statSync(outFile).size }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const standalone = path.join(webDir, ".next", "standalone")
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    console.error("build-predeploy: .next/standalone is missing; run `next build` first")
    process.exit(1)
  }
  const { outFile, bytes } = await bundlePredeploy()
  console.log(
    `build-predeploy: wrote ${path.relative(webDir, outFile)} (${Math.round(bytes / 1024)} KB)`,
  )
}
