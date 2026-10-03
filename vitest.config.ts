import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "lib/aiformat/**", "lib/lapilli/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
