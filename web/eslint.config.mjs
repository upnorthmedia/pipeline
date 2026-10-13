import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `mastra dev` bundles the whole Mastra server and Studio UI into here.
    // Linting that output OOMs the eslint process, and it is build output, not source.
    ".mastra/**",
  ]),
]);

export default eslintConfig;
