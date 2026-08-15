import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  clean: true,
  target: "node22",
  // A GitHub Action runs from a checkout that is never installed, so every
  // dependency has to be bundled into the one committed file.
  noExternal: [/.*/],
});
