import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureSchemaSnapshot } from "../src/schema/snapshot.ts";
import type { TableSchema } from "../src/schema/types.ts";
import { dockerAvailable } from "./support/docker.ts";
import { startTestDatabase, resetPublicSchema } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

function table(tables: TableSchema[], name: string): TableSchema {
  const found = tables.find((t) => t.name === name);
  if (!found) throw new Error(`no table ${name} in snapshot`);
  return found;
}

describe.skipIf(!dockerAvailable())("captureSchemaSnapshot", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await resetPublicSchema(db.sql);
  });

  it("returns no tables for an empty schema", async () => {
    const snapshot = await captureSchemaSnapshot(db.sql);
    expect(snapshot.tables).toEqual([]);
    expect(snapshot.scannedSchemas).toEqual(["public"]);
    expect(Date.parse(snapshot.capturedAt)).not.toBeNaN();
  });

  it("captures columns with formatted types, nullability and defaults", async () => {
    await db.sql.unsafe(`
      create table users (
        id bigint generated always as identity primary key,
        email varchar(255) not null,
        nickname text,
        balance numeric(10,2) not null default 0,
        created_at timestamptz not null default now()
      )
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    const users = table(tables, "users");

    expect(users.columns.map((c) => c.name)).toEqual([
      "id",
      "email",
      "nickname",
      "balance",
      "created_at",
    ]);

    const byName = new Map(users.columns.map((c) => [c.name, c]));
    expect(byName.get("email")?.dataType).toBe("character varying(255)");
    expect(byName.get("balance")?.dataType).toBe("numeric(10,2)");
    expect(byName.get("email")?.nullable).toBe(false);
    expect(byName.get("nickname")?.nullable).toBe(true);
    expect(byName.get("created_at")?.default).toBe("now()");
    expect(byName.get("id")?.identity).toBe(true);
    expect(byName.get("nickname")?.identity).toBe(false);
  });

  it("captures the primary key in key order", async () => {
    await db.sql.unsafe(`
      create table memberships (
        org_id int not null,
        user_id int not null,
        primary key (user_id, org_id)
      )
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    expect(table(tables, "memberships").primaryKey).toEqual([
      "user_id",
      "org_id",
    ]);
  });

  it("reports no primary key when the table has none", async () => {
    await db.sql.unsafe("create table events (payload jsonb)");
    const { tables } = await captureSchemaSnapshot(db.sql);
    expect(table(tables, "events").primaryKey).toBeNull();
  });

  it("captures foreign keys and checks with canonical definitions", async () => {
    await db.sql.unsafe(`
      create table orgs (id int primary key);
      create table users (
        id int primary key,
        org_id int not null references orgs (id) on delete cascade,
        age int constraint age_sane check (age >= 0)
      )
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    const users = table(tables, "users");

    const fk = users.constraints.find((c) => c.type === "foreign_key");
    expect(fk?.columns).toEqual(["org_id"]);
    expect(fk?.definition).toBe(
      "FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE",
    );

    const check = users.constraints.find((c) => c.name === "age_sane");
    expect(check?.type).toBe("check");
    expect(check?.definition).toBe("CHECK ((age >= 0))");
  });

  it("captures indexes including the primary key index", async () => {
    await db.sql.unsafe(`
      create table users (id int primary key, email text);
      create unique index users_email_key on users (lower(email));
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    const indexes = table(tables, "users").indexes;

    const primary = indexes.find((i) => i.primary);
    expect(primary?.name).toBe("users_pkey");

    const expression = indexes.find((i) => i.name === "users_email_key");
    expect(expression?.unique).toBe(true);
    expect(expression?.definition).toContain("lower(email)");
  });

  it("captures replica identity, which the replication backend depends on", async () => {
    await db.sql.unsafe(`
      create table plain (id int primary key);
      create table tracked (id int primary key);
      alter table tracked replica identity full;
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    expect(table(tables, "plain").replicaIdentity).toBe("default");
    expect(table(tables, "tracked").replicaIdentity).toBe("full");
  });

  it("resolves constraint columns correctly after a dropped column", async () => {
    // DROP COLUMN leaves attnum gaps, so conkey cannot be treated as an index.
    await db.sql.unsafe(`
      create table users (
        legacy_a int,
        legacy_b int,
        tenant_id int not null,
        code int not null,
        unique (tenant_id, code)
      );
      alter table users drop column legacy_a;
      alter table users drop column legacy_b;
    `);

    const { tables } = await captureSchemaSnapshot(db.sql);
    const unique = table(tables, "users").constraints.find(
      (c) => c.type === "unique",
    );
    expect(unique?.columns).toEqual(["tenant_id", "code"]);
  });

  it("only scans the requested schemas", async () => {
    await db.sql.unsafe(`
      create schema billing;
      create table public.in_public (id int primary key);
      create table billing.in_billing (id int primary key);
    `);

    const onlyPublic = await captureSchemaSnapshot(db.sql);
    expect(onlyPublic.tables.map((t) => t.name)).toEqual(["in_public"]);

    const both = await captureSchemaSnapshot(db.sql, {
      schemas: ["public", "billing"],
    });
    expect(both.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "billing.in_billing",
      "public.in_public",
    ]);

    await db.sql.unsafe("drop schema billing cascade");
  });

  it("never returns system catalog tables", async () => {
    await db.sql.unsafe("create table users (id int primary key)");
    const { tables } = await captureSchemaSnapshot(db.sql);
    expect(tables.every((t) => t.schema === "public")).toBe(true);
  });
});
