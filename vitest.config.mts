import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcDirectory = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyTestShim = fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": srcDirectory,
      "server-only": serverOnlyTestShim,
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
