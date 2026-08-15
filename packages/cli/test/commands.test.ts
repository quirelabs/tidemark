import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { connect, type Artifact } from "@quirelabs/tidemark-core";
import { plainCapabilities } from "@quirelabs/tidemark-render";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  branch,
  diff,
  EXIT_OK,
  EXIT_THRESHOLD,
  report,
  snapshot,
  type CommandContext,
} from "../src/commands.ts";
import { NoCaptureError, StateMismatchError } from "../src/state.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn("\n[tidemark] SKIPPING CLI container tests: Docker unreachable.\n");
    return false;
  }
}

describe.skipIf(!dockerAvailable())("cli commands", () => {
  let container: StartedPostgreSqlContainer;
  let connection: string;
  let workdir: string;
  let stdout: string[];
  let stderr: string[];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    connection = container.getConnectionUri();
  });

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "tidemark-cli-"));
    stdout = [];
    stderr = [];

    const sql = connect(connection);
    await sql.unsafe(`
      drop schema if exists public cascade;
      drop schema if exists tidemark_snapshot cascade;
      create schema public;
      create table users (id int primary key, email text not null, tier text not null default 'free');
      insert into users (id, email) values (1,'ada@example.com'), (2,'bob@example.com');
    `);
    await sql.end();
  });

  function context(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      cwd: workdir,
      stateDir: join(workdir, ".tidemark"),
      capabilities: plainCapabilities(100),
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
      connection,
      ...overrides,
    };
  }

  async function mutate(sqlText: string): Promise<void> {
    const sql = connect(connection);
    await sql.unsafe(sqlText);
    await sql.end();
  }

  it("captures a baseline and reports what it recorded", async () => {
    expect(await snapshot(context())).toBe(EXIT_OK);
    expect(stderr.join("\n")).toContain("baseline captured, 1 table");

    const state = JSON.parse(
      await readFile(join(workdir, ".tidemark", "capture.json"), "utf8"),
    ) as { database: string };
    expect(state.database).toBe("test");
  });

  it("renders a diff and writes the artifact", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro' where id = 1");

    expect(await diff(context())).toBe(EXIT_OK);

    const output = stdout.join("\n");
    expect(output).toContain("public.users");
    expect(output).toContain("tier free → pro");

    const artifact = JSON.parse(
      await readFile(join(workdir, ".tidemark", "artifact.json"), "utf8"),
    ) as Artifact;
    expect(artifact.meta.backend).toBe("snapshot");
    expect(artifact.tables[0]?.counts.updated).toBe(1);
  });

  it("refuses to diff without a capture", async () => {
    await expect(diff(context())).rejects.toThrow(NoCaptureError);
  });

  it("refuses to diff against a different database", async () => {
    await snapshot(context());

    const sql = connect(connection);
    await sql.unsafe('create database "other_db"');
    await sql.end();
    const other = connection.replace(/\/[^/]+$/, "/other_db");

    await expect(diff(context({ connection: other }))).rejects.toThrow(
      StateMismatchError,
    );
  });

  it("cleans up the shadow schema and state after a diff", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro'");
    await diff(context());

    const sql = connect(connection);
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from information_schema.schemata
      where schema_name = 'tidemark_snapshot'
    `;
    await sql.end();
    expect(row?.count).toBe("0");

    await expect(diff(context())).rejects.toThrow(NoCaptureError);
  });

  it("leaves everything in place with --keep-snapshot", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro' where id = 1");
    await diff(context({ keepSnapshot: true }));

    // The capture is still live, so a second diff works and sees more change.
    await mutate("update users set tier = 'pro' where id = 2");
    stdout = [];
    expect(await diff(context({ keepSnapshot: true }))).toBe(EXIT_OK);
    expect(stdout.join("\n")).toContain("~2");
  });

  it("exits 2 when --fail-on danger finds a danger", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro'");

    expect(await diff(context({ failOn: "danger" }))).toBe(EXIT_THRESHOLD);
    expect(stdout.join("\n")).toContain("every row updated");
  });

  it("exits 0 with --fail-on danger when nothing is dangerous", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro' where id = 1");
    expect(await diff(context({ failOn: "danger" }))).toBe(EXIT_OK);
  });

  it("emits a parseable artifact on stdout with --format json", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro' where id = 1");
    await diff(context({ format: "json" }));

    const artifact = JSON.parse(stdout.join("\n")) as Artifact;
    expect(artifact.meta.schemaVersion).toBe(1);
    // Progress never pollutes stdout, or piping to a file would break.
    expect(stdout.join("\n")).not.toContain("artifact written");
    expect(stderr.join("\n")).toContain("artifact written");
  });

  it("re-renders a stored artifact without touching the database", async () => {
    await snapshot(context());
    await mutate("update users set tier = 'pro' where id = 1");
    await diff(context());

    stdout = [];
    expect(await report(context())).toBe(EXIT_OK);
    expect(stdout.join("\n")).toContain("tier free → pro");
  });

  it("applies redaction rules from a config file", async () => {
    await writeFile(
      join(workdir, "tidemark.config.ts"),
      `export default { redact: [{ column: "email", mode: "mask" }] };`,
      "utf8",
    );

    await snapshot(context());
    await mutate("insert into users (id, email) values (3, 'carol@example.com')");
    await diff(context());

    const output = stdout.join("\n");
    expect(output).not.toContain("carol@example.com");
    expect(output).toContain("email=[masked]");
    expect(output).toContain("configure masking in tidemark.config.ts");
  });

  it("creates a scratch database from a template", async () => {
    expect(await branch(context(), "scratch_db", "template1")).toBe(EXIT_OK);

    const sql = connect(connection);
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from pg_database where datname = 'scratch_db'
    `;
    await sql.unsafe('drop database "scratch_db"');
    await sql.end();
    expect(row?.count).toBe("1");
  });
});
