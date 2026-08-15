import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TIDEMARK_VERSION } from "../src/version.ts";

/**
 * The version is stamped into every artifact, so if it drifts from package.json
 * an artifact quietly claims to come from a build that never existed. Releases
 * bump package.json, and nothing else forces the constant to follow, so this is
 * the thing that does.
 */
describe("version", () => {
  it("matches the published package version", async () => {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(path, "utf8")) as { version: string };
    expect(TIDEMARK_VERSION).toBe(pkg.version);
  });
});
