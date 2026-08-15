// Applies a SQL file. This is what the Action's `run:` input points at, so the
// demo exercises the real "run the user's command between capture and diff" path.
import { readFile } from "node:fs/promises";
import { connect } from "@quirelabs/tidemark-core";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: apply.mjs <file.sql>");

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("DATABASE_URL is not set");

const sql = connect(url);
try {
  await sql.unsafe(await readFile(file, "utf8"));
  console.log(`applied ${file}`);
} finally {
  await sql.end();
}
