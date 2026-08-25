import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcDirectory = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyTestShim = fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url));

/** Only the opt-in local evaluator uses this config; CI keeps the unit config. */
export default defineConfig({
  resolve: {
    alias: { "@": srcDirectory, "server-only": serverOnlyTestShim },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
