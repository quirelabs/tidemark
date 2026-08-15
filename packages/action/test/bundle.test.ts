import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A workflow that says `uses: quirelabs/tidemark@v0` gets a checkout of this
 * repository and nothing else. No install runs, so anything the bundle does not
 * contain is simply missing at runtime.
 *
 * These checks exist because that failure only shows up in someone else's CI.
 */
const bundlePath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

async function bundle(): Promise<string> {
  try {
    await stat(bundlePath);
  } catch {
    throw new Error(
      `No bundle at ${bundlePath}. Run \`pnpm build\` before the action tests.`,
    );
  }
  return await readFile(bundlePath, "utf8");
}

describe("action bundle", () => {
  it("exists, because it is committed and shipped", async () => {
    expect((await bundle()).length).toBeGreaterThan(0);
  });

  it("imports nothing but Node builtins", async () => {
    const source = await bundle();
    const specifiers = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1] as string,
    );

    const external = specifiers.filter(
      (specifier) => !specifier.startsWith("node:") && !isBuiltin(specifier),
    );
    expect(external).toEqual([]);
    // Sanity check that the regex is actually finding imports.
    expect(specifiers.length).toBeGreaterThan(3);
  });

  it("carries the database driver, not just a reference to it", async () => {
    const source = await bundle();
    expect(source).not.toContain('from "postgres"');
    // postgres.js opens raw sockets, so its presence is observable.
    expect(source).toMatch(/from "(node:)?net"/);
  });

  it("never shells out to the CLI, which would not resolve", async () => {
    const source = await bundle();
    expect(source).not.toContain("cli/src/cli.ts");
  });
});

const BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs",
  "fs/promises", "http", "http2", "https", "net", "os", "path", "perf_hooks",
  "process", "querystring", "readline", "stream", "string_decoder", "timers",
  "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

function isBuiltin(specifier: string): boolean {
  return BUILTINS.has(specifier);
}
