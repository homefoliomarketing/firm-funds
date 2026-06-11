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
    // Local Netlify build output (gitignored). These generated, multi-hundred-KB
    // serverless bundles are not source; linting them OOMs eslint and is
    // meaningless. Without this, `npm run lint` crashes (heap out of memory).
    ".netlify/**",
  ]),
]);

export default eslintConfig;
