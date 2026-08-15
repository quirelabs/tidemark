import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Container pulls and Postgres boot dominate these timings, not our code.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Each suite owns a container, so parallel files would multiply Docker load.
    fileParallelism: false,
  },
});
