import type { NextConfig } from "next";

import { applyRepoRootEnv } from "./repo-env";

/**
 * The repo keeps one `.env` at its root, shared by compose, the Mastra CLI and
 * (through `vitest.config.ts`) the tests. Next only reads `.env*` files inside
 * `web/`, so before Phase 5 the dashboard never needed the root file: every
 * piece of data came from the Python API over HTTP. The ported route handlers
 * talk to Postgres directly, so load it here, at import time.
 */
applyRepoRootEnv(__dirname);

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
