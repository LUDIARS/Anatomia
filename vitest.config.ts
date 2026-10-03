import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound subprocess contention on shared Windows review hosts.
    maxWorkers: 4,
    exclude: ["**/node_modules/**", "**/dist/**", "lib/aiformat/**", "lib/lapilli/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
