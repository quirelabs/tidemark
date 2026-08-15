import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  MissingConnectionError,
  resolveConnection,
} from "../src/config.ts";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "tidemark-config-"));
}

describe("loadConfig", () => {
  it("returns defaults when there is no config anywhere", async () => {
    const dir = await workspace();
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.config).toEqual({});
    expect(loaded.path).toBeNull();
  });

  it("imports a TypeScript config with no loader dependency", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "tidemark.config.ts"),
      `import type { TidemarkConfig } from "@quirelabs/tidemark-core";
       const config: TidemarkConfig = {
         rowThreshold: 25,
         redact: [{ column: "email", mode: "hash" }],
       };
       export default config;
      `,
      "utf8",
    );

    const loaded = await loadConfig(undefined, dir);
    expect(loaded.config.rowThreshold).toBe(25);
    expect(loaded.config.redact).toEqual([{ column: "email", mode: "hash" }]);
    expect(loaded.path).toBe(join(dir, "tidemark.config.ts"));
  });

  it("walks up from a nested directory", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "tidemark.config.ts"),
      "export default { rowThreshold: 7 };",
      "utf8",
    );
    const nested = join(dir, "packages", "app");
    await mkdir(nested, { recursive: true });

    const loaded = await loadConfig(undefined, nested);
    expect(loaded.config.rowThreshold).toBe(7);
  });

  it("rejects a config with no default export", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "tidemark.config.ts"),
      "export const somethingElse = { rowThreshold: 5 };",
      "utf8",
    );

    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/no default export/);
  });

  it("rejects a config that is not an object", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "tidemark.config.ts"),
      "export default 42;",
      "utf8",
    );
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/must export an object/);
  });

  it("reports the file when it fails to parse", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "tidemark.config.ts"), "export default {", "utf8");
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
  });

  it("fails loudly when an explicit path does not exist", async () => {
    const dir = await workspace();
    await expect(loadConfig("nope.config.ts", dir)).rejects.toThrow(/No config file at/);
  });
});

describe("resolveConnection", () => {
  it("prefers the flag, then config, then the environment", () => {
    expect(resolveConnection("flag", { connection: "config" }, { DATABASE_URL: "env" }))
      .toBe("flag");
    expect(resolveConnection(undefined, { connection: "config" }, { DATABASE_URL: "env" }))
      .toBe("config");
    expect(resolveConnection(undefined, {}, { DATABASE_URL: "env" })).toBe("env");
  });

  it("explains itself when there is nothing to connect to", () => {
    expect(() => resolveConnection(undefined, {}, {})).toThrow(MissingConnectionError);
    expect(() => resolveConnection(undefined, {}, {})).toThrow(/--connection/);
  });
});
