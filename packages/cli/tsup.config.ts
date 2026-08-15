import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  // src/cli.ts already carries the shebang so Node can run it directly.
  shims: false,
  // The render package is private and never published, so it has to be bundled
  // in rather than left as an unresolvable dependency.
  noExternal: [/@quirelabs\/tidemark-render/],
});
