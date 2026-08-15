import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_POSTGRES_MAJOR } from "../src/index.ts";
import { dockerAvailable } from "./support/docker.ts";

describe.skipIf(!dockerAvailable())("postgres testcontainer", () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = postgres(container.getConnectionUri());
  });

  afterAll(async () => {
    await sql?.end();
    await container?.stop();
  });

  it("round trips a query", async () => {
    const rows = await sql<{ answer: number }[]>`select 1 + 1 as answer`;
    expect(rows[0]?.answer).toBe(2);
  });

  it("runs a supported postgres major", async () => {
    const [row] = await sql<{ major: string }[]>`
      select current_setting('server_version_num') as major
    `;
    const major = Math.floor(Number(row?.major) / 10_000);
    expect(major).toBeGreaterThanOrEqual(MIN_POSTGRES_MAJOR);
  });

  it("exposes the catalogs the schema differ depends on", async () => {
    await sql`create table widgets (id int primary key, name text not null)`;
    const columns = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_name = 'widgets'
      order by ordinal_position
    `;
    expect(columns.map((c) => c.column_name)).toEqual(["id", "name"]);
  });
});
