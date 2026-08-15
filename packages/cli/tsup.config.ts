import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  // src/cli.ts already carries the shebang so Node can run it directly.
  shims: false,
});
