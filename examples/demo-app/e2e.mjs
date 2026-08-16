/**
 * The end to end demo, and the launch asset.
 *
 * Spins up a real Postgres, seeds a small shop, then hands control to the
 * GitHub Action exactly as a workflow would: the Action captures a baseline,
 * runs the agent's migration through its `run:` input, and builds the diff.
 *
 * This is the only test that exercises the whole pipeline in one process, so it
 * is where a regression in the seams between capture, diff, redaction, render
 * and the Action shows up.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { connect } from "@quirelabs/tidemark-core";
import { main } from "tidemark-action";
import {
  detectCapabilities,
  emit,
  renderReport,
} from "@quirelabs/tidemark-render";

const here = dirname(fileURLToPath(import.meta.url));

function requireDocker() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error("\n[tidemark] e2e needs a running Docker daemon.\n");
    process.exit(1);
  }
}

requireDocker();

console.log("tidemark e2e: starting postgres");
const container = await new PostgreSqlContainer("postgres:17-alpine").start();
const connection = container.getConnectionUri();

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
};

try {
  console.log("tidemark e2e: seeding the shop");
  const sql = connect(connection);
  await sql.unsafe(await readFile(join(here, "sql", "schema.sql"), "utf8"));
  await sql.end();

  const runDir = await mkdtemp(join(tmpdir(), "tidemark-e2e-"));
  const summaryPath = join(runDir, "summary.md");
  const outputPath = join(runDir, "output.txt");
  await writeFile(summaryPath, "", "utf8");
  await writeFile(outputPath, "", "utf8");

  const env = {
    ...process.env,
    PATH: process.env.PATH,
    "INPUT_CONNECTION": connection,
    "INPUT_RUN": "node scripts/apply.mjs sql/agent-migration.sql",
    "INPUT_FAIL-ON": "danger",
    "INPUT_COMMENT": "false",
    "INPUT_WORKING-DIRECTORY": here,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "quirelabs/tidemark",
    GITHUB_RUN_ID: "1",
    NO_COLOR: "1",
  };

  console.log("tidemark e2e: handing over to the action\n");
  const exitCode = await main(env, (m) => console.log(`  ${m}`));

  const summary = await readFile(summaryPath, "utf8");
  const outputs = await readFile(outputPath, "utf8");

  // The terminal renderer is the primary interface, so it leads. Rendered from
  // the artifact the action just wrote, which is the same path `tidemark report`
  // takes.
  const artifact = JSON.parse(
    await readFile(join(here, ".tidemark", "artifact.json"), "utf8"),
  );
  const capabilities = { ...detectCapabilities(), width: 96 };

  console.log("\n--- terminal render, what `tidemark diff` shows ---\n");
  console.log(emit(renderReport(artifact, capabilities, { detail: "full" }), capabilities));

  console.log("\n--- markdown the action would post ---\n");
  // Written raw, not logged, so the demo output is copy-pasteable markdown.
  process.stdout.write(summary);
  console.log("\n--- checks ---");

  check("exits 2 because a danger was found", () => {
    assert.equal(exitCode, 2);
  });

  check("catches the UPDATE with no WHERE clause", () => {
    assert.match(summary, /every row updated on `?public\.orders/);
    assert.match(summary, /14,203/);
  });

  check("catches the dropped column", () => {
    assert.match(summary, /DROP COLUMN public\.users\.legacy_ref/);
  });

  check("catches the narrowed column type", () => {
    assert.match(summary, /narrowed/);
  });

  check("catches the rotated credential", () => {
    assert.match(summary, /credential column changed/);
  });

  check("catches the value that tries to forge a summary line", () => {
    assert.match(summary, /forge or hide output/);
    // The forged text must never appear as its own line.
    for (const line of summary.split("\n")) {
      assert.notEqual(line.trim(), "0 warnings, all changes reviewed");
    }
  });

  check("aggregates the bulk change instead of listing 14,203 rows", () => {
    assert.match(summary, /aggregated/);
    assert.ok(summary.split("\n").length < 120, "report should stay readable");
  });

  check("masks the password hash", () => {
    assert.ok(!summary.includes("argon2id"), "a password hash reached the output");
  });

  check("applies the config file's email rule", () => {
    assert.ok(!summary.includes("@example.com"), "an email reached the output");
  });

  check("carries the persistent disclosure", () => {
    assert.match(summary, /values shown in full/i);
    assert.match(summary, /tidemark\.config\.ts/);
  });

  check("writes action outputs for later steps", () => {
    assert.match(outputs, /warnings=[1-9]/);
    assert.match(outputs, /dangers=[1-9]/);
    assert.match(outputs, /tables=[1-9]/);
  });

  check("marks the comment so it can be updated in place", () => {
    assert.match(summary, /<!--\s*tidemark/);
  });
} finally {
  await container.stop();
}

console.log(
  failures === 0
    ? "\ntidemark e2e: all checks passed"
    : `\ntidemark e2e: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
