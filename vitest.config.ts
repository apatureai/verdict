import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // More specific subpath first: Vite alias keys match by prefix.
      "@apatureai/verdict-capture/playwright": fromRoot("./packages/capture/src/playwright-browser.ts"),
      "@apatureai/verdict-types": fromRoot("./packages/types/src/index.ts"),
      "@apatureai/verdict-capture": fromRoot("./packages/capture/src/index.ts"),
      "@apatureai/verdict-critique": fromRoot("./packages/critique/src/index.ts"),
      "@apatureai/verdict-db": fromRoot("./packages/db/src/index.ts"),
      "@apatureai/verdict-redis": fromRoot("./packages/redis/src/index.ts"),
      "@apatureai/verdict-storage": fromRoot("./packages/storage/src/index.ts"),
      "@apatureai/verdict-secrets": fromRoot("./packages/secrets/src/index.ts"),
      "@apatureai/verdict-observability": fromRoot("./packages/observability/src/index.ts"),
      "@apatureai/verdict-jobs": fromRoot("./packages/jobs/src/index.ts"),
      "@apatureai/verdict-api": fromRoot("./packages/api/src/index.ts"),
      "@apatureai/verdict-context": fromRoot("./packages/context/src/index.ts"),
      "@apatureai/verdict-eval": fromRoot("./packages/eval/src/index.ts"),
      "@apatureai/verdict-feedback": fromRoot("./packages/feedback/src/index.ts"),
      "@apatureai/verdict-review": fromRoot("./packages/review/src/index.ts"),
      "@apatureai/verdict-runtime/http": fromRoot("./packages/runtime/src/http.ts"),
      "@apatureai/verdict-runtime/worker": fromRoot("./packages/runtime/src/worker.ts"),
      "@apatureai/verdict-runtime/input": fromRoot("./packages/runtime/src/input.ts"),
      "@apatureai/verdict-runtime": fromRoot("./packages/runtime/src/index.ts"),
      "@apatureai/verdict-evidence": fromRoot("./packages/evidence/src/index.ts"),
      "@apatureai/verdict-cli": fromRoot("./packages/cli/src/index.ts"),
      "@apatureai/verdict-serve": fromRoot("./packages/serve/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // PGlite-backed migration tests can cold-start slowly when Vitest 4 runs the full package matrix.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
