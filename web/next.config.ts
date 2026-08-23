import fs from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

/**
 * The repo keeps one `.env` at its root, shared by compose, the Python stack
 * and (through `vitest.config.ts`) the tests. Next only reads `.env*` files
 * inside `web/`, so before Phase 5 the dashboard never needed the root file:
 * every piece of data came from the Python API over HTTP. The ported route
 * handlers talk to Postgres directly, so load it here.
 *
 * Values already in the environment win, which is what makes this safe in
 * production: Railway and compose inject their own and there is no root `.env`
 * in the image.
 */
function loadRepoRootEnv() {
  const file = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

loadRepoRootEnv();

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-auth", "pg"],
  /**
   * File tracing follows `require`/`import`, so it copies sharp's `.node`
   * binding but not the libvips shared object that binding dlopens out of a
   * sibling package. The standalone image then fails at the first image
   * operation with `ERR_DLOPEN_FAILED: libvips-cpp.so`. The glob matches only
   * what the install actually produced, so it is a no-op on a platform whose
   * libvips lives elsewhere.
   */
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*"],
  },
};

export default nextConfig;
