import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Declarations come from tsc. tsup's dts plugin vendors TS 5.7 and breaks on TS 7.
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
});
