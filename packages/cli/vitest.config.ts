import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Container pulls and Postgres boot dominate these timings, not our code.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
