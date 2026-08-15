import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// We import with explicit .ts extensions so Node can run the source directly,
// but tsc leaves those specifiers untouched in declaration output and consumers
// cannot resolve a .ts path. Rewrite them to .js after emit.
const SPECIFIER = /(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".d.ts")) yield path;
  }
}

const root = process.argv[2] ?? "dist";
for await (const file of walk(root)) {
  const source = await readFile(file, "utf8");
  const fixed = source.replace(SPECIFIER, "$1$2.js$3");
  if (fixed !== source) await writeFile(file, fixed);
}
