import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import type {
  AggregateDiff,
  RowLevelDiff,
  TableDataDiff,
} from "../src/artifact/schema.ts";
import {
  startSnapshotCapture,
  stopSnapshotCapture,
} from "../src/capture/snapshot-backend.ts";
import { dockerAvailable } from "./support/docker.ts";
import { resetPublicSchema, startTestDatabase } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

/**
 * These are the Phase 1 acceptance tests. The snapshot backend is the oracle the
 * replication backend will later be checked against, so it is checked here
 * against hand written expectations instead.
 */

function find(tables: TableDataDiff[], name: string): TableDataDiff {
  const found = tables.find((t) => t.name === name);
  if (!found) throw new Error(`no data diff for ${name}, got ${tables.map((t) => t.name)}`);
  return found;
}

function rowsOf(diff: TableDataDiff): RowLevelDiff {
  if (diff.detail !== "rows") throw new Error(`expected row level diff for ${diff.name}`);
  return diff;
}

function aggregateOf(diff: TableDataDiff): AggregateDiff {
  if (diff.detail !== "aggregate") {
    throw new Error(`expected aggregate diff for ${diff.name}`);
  }
  return diff;
}

describe.skipIf(!dockerAvailable())("snapshot backend", () => {
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
    await sql.unsafe("drop schema if exists tidemark_snapshot cascade");
    await resetPublicSchema(sql);
  });

  /** Runs the given SQL between a capture start and stop. */
  async function capture(
    mutate: string,
    options: Parameters<typeof startSnapshotCapture>[1] = {},
  ) {
    const handle = await startSnapshotCapture(sql, options);
    if (mutate.trim() !== "") await sql.unsafe(mutate);
    return await stopSnapshotCapture(sql, handle);
  }

  async function seedUsers(): Promise<void> {
    await sql.unsafe(`
      create table users (
        id int primary key,
        email text not null,
        tier text not null default 'free',
        visits int not null default 0
      );
      insert into users (id, email) values
        (1, 'ada@example.com'), (2, 'bob@example.com'), (3, 'carol@example.com');
    `);
  }

  it("reports nothing when nothing changed", async () => {
    await seedUsers();
    const result = await capture("");
    expect(result.tables).toEqual([]);
  });

  it("captures a single row insert", async () => {
    await seedUsers();
    const result = await capture(
      "insert into users (id, email) values (4, 'dan@example.com')",
    );

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(diff.primaryKey).toEqual(["id"]);
    expect(diff.rows).toHaveLength(1);

    const row = diff.rows[0];
    expect(row?.op).toBe("insert");
    expect(row?.key).toEqual([4]);
    expect(row?.cells).toContainEqual({ column: "email", after: "dan@example.com" });
    expect(row?.cells).toContainEqual({ column: "tier", after: "free" });
  });

  it("captures a single row update with only the columns that moved", async () => {
    await seedUsers();
    const result = await capture("update users set tier = 'pro' where id = 2");

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 });

    const row = diff.rows[0];
    expect(row?.op).toBe("update");
    expect(row?.key).toEqual([2]);
    // email and visits did not change, so they must not appear.
    expect(row?.cells).toEqual([{ column: "tier", before: "free", after: "pro" }]);
  });

  it("captures a single row delete with its old values", async () => {
    await seedUsers();
    const result = await capture("delete from users where id = 3");

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 0, deleted: 1 });

    const row = diff.rows[0];
    expect(row?.op).toBe("delete");
    expect(row?.key).toEqual([3]);
    expect(row?.cells).toContainEqual({
      column: "email",
      before: "carol@example.com",
    });
  });

  it("captures inserts, updates and deletes together", async () => {
    await seedUsers();
    const result = await capture(`
      insert into users (id, email) values (4, 'dan@example.com');
      update users set tier = 'pro' where id = 1;
      delete from users where id = 3;
    `);

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    expect(diff.rows.map((r) => r.op).sort()).toEqual(["delete", "insert", "update"]);
  });

  it("aggregates a bulk UPDATE without WHERE instead of listing rows", async () => {
    await sql.unsafe(`
      create table orders (id int primary key, status text not null);
      insert into orders (id, status)
      select g, case when g % 100 = 0 then 'failed' else 'pending' end
      from generate_series(1, 14203) g;
    `);

    const result = await capture("update orders set status = 'processed'");
    const diff = aggregateOf(find(result.tables, "orders"));

    expect(diff.counts).toEqual({ inserted: 0, updated: 14203, deleted: 0 });
    expect(diff.sample.length).toBeLessThanOrEqual(10);

    const status = diff.columnStats.find((s) => s.column === "status");
    expect(status?.changed).toBe(14203);
    expect(status?.transitions).toEqual([
      { before: "pending", after: "processed", count: 14061 },
      { before: "failed", after: "processed", count: 142 },
    ]);
  });

  it("reports a count instead of a list when a column takes many values", async () => {
    await sql.unsafe(`
      create table orders (id int primary key, note text);
      insert into orders (id, note) select g, 'old' from generate_series(1, 200) g;
    `);

    const result = await capture("update orders set note = 'n' || id");
    const diff = aggregateOf(find(result.tables, "orders"));

    const note = diff.columnStats.find((s) => s.column === "note");
    expect(note?.transitions).toEqual([]);
    expect(note?.distinctAfter).toBe(200);
  });

  it("captures a bulk DELETE with a WHERE clause", async () => {
    await sql.unsafe(`
      create table orders (id int primary key, status text not null);
      insert into orders (id, status)
      select g, case when g <= 900 then 'stale' else 'fresh' end
      from generate_series(1, 1000) g;
    `);

    const result = await capture("delete from orders where status = 'stale'");
    const diff = aggregateOf(find(result.tables, "orders"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 0, deleted: 900 });
  });

  it("captures TRUNCATE as deletes", async () => {
    await seedUsers();
    const result = await capture("truncate users");

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 0, deleted: 3 });
    expect(diff.rows.every((r) => r.op === "delete")).toBe(true);
  });

  it("produces no data diff for a rolled back transaction", async () => {
    await seedUsers();
    const handle = await startSnapshotCapture(sql);

    // Throwing out of sql.begin aborts the transaction, which is the only way
    // postgres.js will let us roll back on a pooled connection.
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("insert into users (id, email) values (99, 'ghost@example.com')");
        await tx.unsafe("update users set tier = 'pro'");
        await tx.unsafe("delete from users where id = 1");
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const result = await stopSnapshotCapture(sql, handle);
    expect(result.tables).toEqual([]);
  });

  it("survives ADD COLUMN and reports data changes on the columns that persist", async () => {
    await seedUsers();
    const result = await capture(`
      alter table users add column country text;
      update users set tier = 'pro' where id = 1;
    `);

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts.updated).toBe(1);
    // country did not exist in the before snapshot, so it cannot be diffed.
    expect(diff.columns.map((c) => c.name)).not.toContain("country");
    expect(diff.rows[0]?.cells).toEqual([
      { column: "tier", before: "free", after: "pro" },
    ]);
  });

  it("survives DROP COLUMN without reporting every row as changed", async () => {
    await seedUsers();
    const result = await capture(`
      alter table users drop column visits;
      update users set tier = 'pro' where id = 2;
    `);

    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(diff.columns.map((c) => c.name)).not.toContain("visits");
  });

  it("treats a table created during capture as all inserts", async () => {
    await seedUsers();
    const result = await capture(`
      create table audit_log (id int primary key, action text not null);
      insert into audit_log (id, action) values (1, 'created'), (2, 'updated');
    `);

    const diff = rowsOf(find(result.tables, "audit_log"));
    expect(diff.counts).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    expect(diff.rows.map((r) => r.key)).toEqual([[1], [2]]);
  });

  it("leaves a dropped table to the schema diff rather than the data diff", async () => {
    await seedUsers();
    const result = await capture("drop table users");

    expect(result.tables).toEqual([]);
    expect(result.schemaBefore.tables.map((t) => t.name)).toContain("users");
    expect(result.schemaAfter.tables.map((t) => t.name)).not.toContain("users");
  });

  it("pairs rows by a composite primary key", async () => {
    await sql.unsafe(`
      create table memberships (
        org_id int not null,
        user_id int not null,
        role text not null,
        primary key (org_id, user_id)
      );
      insert into memberships values (1, 10, 'member'), (1, 11, 'member');
    `);

    const result = await capture(
      "update memberships set role = 'admin' where org_id = 1 and user_id = 11",
    );
    const diff = rowsOf(find(result.tables, "memberships"));

    expect(diff.primaryKey).toEqual(["org_id", "user_id"]);
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]?.key).toEqual([1, 11]);
    expect(diff.rows[0]?.cells).toEqual([
      { column: "role", before: "member", after: "admin" },
    ]);
  });

  it("reports a keyless table as deletes plus inserts", async () => {
    await sql.unsafe(`
      create table events (payload text not null);
      insert into events values ('a'), ('b'), ('b');
    `);

    const result = await capture("update events set payload = 'c' where payload = 'a'");
    const diff = rowsOf(find(result.tables, "events"));

    expect(diff.primaryKey).toBeNull();
    expect(diff.counts).toEqual({ inserted: 1, updated: 0, deleted: 1 });
    expect(diff.rows).toContainEqual({
      op: "insert",
      key: [],
      cells: [{ column: "payload", after: "c" }],
    });
    expect(diff.rows).toContainEqual({
      op: "delete",
      key: [],
      cells: [{ column: "payload", before: "a" }],
    });
  });

  it("keeps duplicate rows honest in a keyless table", async () => {
    await sql.unsafe(`
      create table events (payload text not null);
      insert into events values ('b'), ('b'), ('b');
    `);

    const result = await capture("delete from events where ctid = (select min(ctid) from events)");
    const diff = rowsOf(find(result.tables, "events"));
    // EXCEPT would collapse the duplicates and report nothing at all.
    expect(diff.counts).toEqual({ inserted: 0, updated: 0, deleted: 1 });
  });

  it("promotes to an aggregate exactly at the threshold boundary", async () => {
    await sql.unsafe(`
      create table t (id int primary key, v int not null);
      insert into t select g, 0 from generate_series(1, 100) g;
    `);

    const atThreshold = await capture("update t set v = 1 where id <= 5", {
      rowThreshold: 5,
    });
    expect(find(atThreshold.tables, "t").detail).toBe("rows");

    const overThreshold = await capture("update t set v = 2 where id <= 6", {
      rowThreshold: 5,
    });
    expect(find(overThreshold.tables, "t").detail).toBe("aggregate");
  });

  it("renders values as JSON scalars the artifact can carry", async () => {
    await sql.unsafe(`
      create table things (
        id int primary key,
        created_at timestamptz not null,
        meta jsonb,
        raw bytea,
        maybe text
      );
    `);

    const result = await capture(`
      insert into things values (
        1, '2026-08-15T10:00:00Z', '{"a": 1}'::jsonb, '\\xdead'::bytea, null
      )
    `);

    const row = rowsOf(find(result.tables, "things")).rows[0];
    const cells = new Map(row?.cells.map((c) => [c.column, c.after]));
    expect(cells.get("created_at")).toBe("2026-08-15T10:00:00+00:00");
    expect(cells.get("meta")).toEqual({ a: 1 });
    expect(cells.get("raw")).toBe("\\xdead");
    expect(cells.get("maybe")).toBeNull();
    expect(() => JSON.stringify(row)).not.toThrow();
  });

  it("treats a dropped and recreated table as a new table, not the old one", async () => {
    await seedUsers();
    const result = await capture(`
      drop table users;
      create table users (id int primary key, email text not null, tier text not null default 'free', visits int not null default 0);
      insert into users (id, email) values (1, 'someone-else@example.com');
    `);

    // Matching by name would diff the new row against the old table and report
    // one update. Matching by oid reports the truth: a different table.
    const diff = rowsOf(find(result.tables, "users"));
    expect(diff.counts).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(diff.rowsBefore).toBe(0);
  });

  it("follows a renamed table, which keeps its oid", async () => {
    await seedUsers();
    const result = await capture(`
      alter table users rename to accounts;
      update accounts set tier = 'pro' where id = 1;
    `);

    const diff = rowsOf(find(result.tables, "accounts"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(diff.rows[0]?.cells).toEqual([
      { column: "tier", before: "free", after: "pro" },
    ]);
  });

  it("preserves bigint precision beyond what a JS number holds", async () => {
    await sql.unsafe(`
      create table ledger (id bigint primary key, amount numeric(20,4) not null);
      insert into ledger values (9007199254740993, 0);
    `);

    const result = await capture(
      "update ledger set amount = 12345678901234.5678 where id = 9007199254740993",
    );
    const diff = rowsOf(find(result.tables, "ledger"));

    // 9007199254740993 is 2^53 + 1, which a JS number rounds to ...992.
    expect(diff.rows[0]?.key).toEqual(["9007199254740993"]);
    expect(diff.rows[0]?.cells).toEqual([
      { column: "amount", before: "0.0000", after: "12345678901234.5678" },
    ]);
  });

  it("compares a retyped column as text rather than failing", async () => {
    await sql.unsafe(`
      create table items (id int primary key, code int not null);
      insert into items values (1, 42), (2, 7);
    `);

    const result = await capture(`
      alter table items alter column code type text;
      update items set code = '99' where id = 2;
    `);

    const diff = rowsOf(find(result.tables, "items"));
    expect(diff.counts).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(diff.rows[0]?.key).toEqual([2]);
    expect(diff.rows[0]?.cells).toEqual([
      { column: "code", before: "7", after: "99" },
    ]);
  });

  it("samples across the shapes of a bulk change, not the first rows by key", async () => {
    await sql.unsafe(`
      create table orders (id int primary key, status text not null);
      insert into orders (id, status)
      select g, case when g % 3 = 0 then 'failed' else 'pending' end
      from generate_series(1, 600) g;
    `);

    const result = await capture(
      "update orders set status = case when status = 'failed' then 'refunded' else 'processed' end",
    );
    const diff = aggregateOf(find(result.tables, "orders"));

    const shapes = new Set(
      diff.sample.map((row) =>
        row.cells.map((c) => `${String(c.before)}->${String(c.after)}`).join(","),
      ),
    );
    // Taking the first N by id would return only pending -> processed.
    expect(shapes).toContain("pending->processed");
    expect(shapes).toContain("failed->refunded");
  });

  it("never captures its own shadow schema", async () => {
    await seedUsers();
    const handle = await startSnapshotCapture(sql, {
      schemas: ["public", "tidemark_snapshot"],
    });
    await sql.unsafe("insert into users (id, email) values (4, 'dan@example.com')");
    const result = await stopSnapshotCapture(sql, handle);

    expect(handle.schemas).not.toContain("tidemark_snapshot");
    expect(result.tables.map((t) => t.schema)).toEqual(["public"]);
  });

  it("tracks more than one table in a single capture", async () => {
    await seedUsers();
    await sql.unsafe(`
      create table orders (id int primary key, total int not null);
      insert into orders values (1, 100);
    `);

    const result = await capture(`
      insert into users (id, email) values (9, 'eve@example.com');
      update orders set total = 200 where id = 1;
    `);

    expect(result.tables.map((t) => t.name).sort()).toEqual(["orders", "users"]);
  });
});
