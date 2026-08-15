import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { diffSchemas } from "../src/diff/schema-diff.ts";
import { captureSchemaSnapshot } from "../src/schema/snapshot.ts";
import { dockerAvailable } from "./support/docker.ts";
import { resetPublicSchema, startTestDatabase } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

describe.skipIf(!dockerAvailable())("diffSchemas", () => {
  let db: TestDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await startTestDatabase();
    sql = db.sql;
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await resetPublicSchema(sql);
  });

  /** Snapshots around a DDL statement, the way a real capture window works. */
  async function around(ddl: string) {
    const before = await captureSchemaSnapshot(sql);
    await sql.unsafe(ddl);
    const after = await captureSchemaSnapshot(sql);
    return diffSchemas(before, after);
  }

  async function seed(): Promise<void> {
    await sql.unsafe(`
      create table users (
        id int primary key,
        email varchar(255) not null,
        legacy_ref text,
        status varchar(20)
      );
      create index users_status_idx on users (status);
    `);
  }

  it("reports nothing when the schema did not change", async () => {
    await seed();
    const diff = await around("select 1");
    expect(diff).toEqual({
      tablesAdded: [],
      tablesRemoved: [],
      tablesAltered: [],
    });
  });

  it("reports created and dropped tables", async () => {
    await seed();
    const diff = await around(`
      create table audit_log (id int primary key);
      drop table users;
    `);

    expect(diff.tablesAdded).toEqual([{ schema: "public", name: "audit_log" }]);
    expect(diff.tablesRemoved).toEqual([{ schema: "public", name: "users" }]);
    expect(diff.tablesAltered).toEqual([]);
  });

  it("reports a dropped and recreated table as both, never as unchanged", async () => {
    await seed();
    const diff = await around(`
      drop table users;
      create table users (id int primary key, email varchar(255) not null);
    `);

    expect(diff.tablesAdded).toEqual([{ schema: "public", name: "users" }]);
    expect(diff.tablesRemoved).toEqual([{ schema: "public", name: "users" }]);
  });

  it("reports a rename as one altered table, not a drop and a create", async () => {
    await seed();
    const diff = await around("alter table users rename to accounts");

    expect(diff.tablesAdded).toEqual([]);
    expect(diff.tablesRemoved).toEqual([]);
    expect(diff.tablesAltered).toHaveLength(1);
    expect(diff.tablesAltered[0]?.name).toBe("accounts");
    expect(diff.tablesAltered[0]?.renamedFrom).toEqual({
      schema: "public",
      name: "users",
    });
  });

  it("reports added, removed and altered columns", async () => {
    await seed();
    const diff = await around(`
      alter table users add column tier text not null default 'free';
      alter table users drop column legacy_ref;
      alter table users alter column status type varchar(10);
    `);

    const users = diff.tablesAltered[0];
    expect(users?.columnsAdded).toEqual([
      { name: "tier", dataType: "text", nullable: false, default: "'free'::text" },
    ]);
    expect(users?.columnsRemoved.map((c) => c.name)).toEqual(["legacy_ref"]);
    expect(users?.columnsAltered).toEqual([
      {
        name: "status",
        before: {
          name: "status",
          dataType: "character varying(20)",
          nullable: true,
          default: null,
        },
        after: {
          name: "status",
          dataType: "character varying(10)",
          nullable: true,
          default: null,
        },
      },
    ]);
  });

  it("notices a column becoming NOT NULL", async () => {
    await seed();
    const diff = await around("alter table users alter column status set not null");

    const altered = diff.tablesAltered[0]?.columnsAltered[0];
    expect(altered?.before.nullable).toBe(true);
    expect(altered?.after.nullable).toBe(false);
  });

  it("reports added and removed constraints with canonical text", async () => {
    await seed();
    const diff = await around(`
      alter table users add constraint status_known check (status in ('a','b'));
    `);

    const added = diff.tablesAltered[0]?.constraintsAdded;
    expect(added?.map((c) => c.name)).toContain("status_known");
    expect(added?.[0]?.definition).toContain("CHECK");
  });

  it("reports a redefined index as a removal plus an addition", async () => {
    await seed();
    const diff = await around(`
      drop index users_status_idx;
      create index users_status_idx on users (status, email);
    `);

    const users = diff.tablesAltered[0];
    expect(users?.indexesRemoved.map((i) => i.name)).toEqual(["users_status_idx"]);
    expect(users?.indexesAdded.map((i) => i.name)).toEqual(["users_status_idx"]);
    expect(users?.indexesAdded[0]?.definition).toContain("email");
  });

  it("orders output deterministically", async () => {
    await seed();
    const diff = await around(`
      create table zebra (id int primary key);
      create table alpha (id int primary key);
    `);

    expect(diff.tablesAdded.map((t) => t.name)).toEqual(["alpha", "zebra"]);
  });
});
