import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SCHEMA_VERSION,
  type Artifact,
  type RowLevelDiff,
  type TableDataDiff,
} from "../src/artifact/schema.ts";
import type { TidemarkConfig } from "../src/config/types.ts";
import { redactArtifact, redactionFor } from "../src/redaction/redact.ts";

const SECRET = "hunter2-the-actual-password";
const TOKEN = "ghp_liveTokenValueThatMustNeverLeak";

function artifact(tables: TableDataDiff[]): Artifact {
  return {
    meta: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      tidemarkVersion: "0.0.1",
      backend: "snapshot",
      capturedFrom: "2026-08-15T11:00:00.000Z",
      capturedTo: "2026-08-15T11:05:00.000Z",
      database: "shop_ci",
      postgresVersion: "17",
      rowThreshold: 50,
      redactions: [],
    },
    schema: { tablesAdded: [], tablesRemoved: [], tablesAltered: [] },
    tables,
    warnings: [],
  };
}

function users(): RowLevelDiff {
  return {
    schema: "public",
    name: "users",
    detail: "rows",
    primaryKey: ["id"],
    columns: [
      { name: "id", dataType: "integer" },
      { name: "email", dataType: "text" },
      { name: "password_hash", dataType: "text" },
      { name: "api_key", dataType: "text" },
    ],
    counts: { inserted: 1, updated: 1, deleted: 0 },
    rowsBefore: 3,
    rows: [
      {
        op: "insert",
        key: [51],
        cells: [
          { column: "email", after: "ada@example.com" },
          { column: "password_hash", after: SECRET },
          { column: "api_key", after: TOKEN },
        ],
      },
      {
        op: "update",
        key: [7],
        cells: [{ column: "password_hash", before: SECRET, after: "new-secret" }],
      },
    ],
  };
}

const ref = { schema: "public", name: "users" };

describe("default posture", () => {
  it("masks credential columns without being configured", () => {
    const result = redactArtifact(artifact([users()]));
    const table = result.tables[0];
    if (table?.detail !== "rows") throw new Error("expected row level diff");

    const cells = table.rows[0]?.cells ?? [];
    expect(cells.find((c) => c.column === "password_hash")).toEqual({
      column: "password_hash",
      after: null,
      redacted: "mask",
    });
    expect(cells.find((c) => c.column === "api_key")?.redacted).toBe("mask");
  });

  it("leaves contact PII visible, which is the documented trade", () => {
    const result = redactArtifact(artifact([users()]));
    const table = result.tables[0];
    if (table?.detail !== "rows") throw new Error("expected row level diff");

    const email = table.rows[0]?.cells.find((c) => c.column === "email");
    expect(email?.after).toBe("ada@example.com");
    expect(email?.redacted).toBeUndefined();
  });

  it("records what it withheld", () => {
    const result = redactArtifact(artifact([users()]));
    expect(result.meta.redactions).toEqual([
      { table: ref, column: "api_key", mode: "mask" },
      { table: ref, column: "password_hash", mode: "mask" },
    ]);
  });
});

describe("rule precedence", () => {
  const table = ref;

  it("allow beats the built in patterns", () => {
    const config: TidemarkConfig = { allow: [{ column: "api_key" }] };
    expect(redactionFor(table, "api_key", config)).toBeNull();
  });

  it("an explicit rule beats allow", () => {
    const config: TidemarkConfig = {
      allow: [{ column: "api_key" }],
      redact: [{ column: "api_key", mode: "hash" }],
    };
    expect(redactionFor(table, "api_key", config)).toBe("hash");
  });

  it("the last matching rule wins", () => {
    const config: TidemarkConfig = {
      redact: [
        { column: "*", mode: "mask" },
        { column: "email", mode: "truncate" },
      ],
    };
    expect(redactionFor(table, "email", config)).toBe("truncate");
    expect(redactionFor(table, "nickname", config)).toBe("mask");
  });

  it("scopes rules to a table when asked", () => {
    const config: TidemarkConfig = {
      redact: [{ table: "public.orders", column: "note" }],
    };
    expect(redactionFor(table, "note", config)).toBeNull();
    expect(
      redactionFor({ schema: "public", name: "orders" }, "note", config),
    ).toBe("mask");
  });

  it("matches a bare table name in any schema", () => {
    const config: TidemarkConfig = { redact: [{ table: "users", column: "note" }] };
    expect(redactionFor({ schema: "billing", name: "users" }, "note", config)).toBe(
      "mask",
    );
  });

  it("globs column names", () => {
    const config: TidemarkConfig = { redact: [{ column: "stripe_*" }] };
    expect(redactionFor(table, "stripe_customer", config)).toBe("mask");
    expect(redactionFor(table, "customer", config)).toBeNull();
  });
});

describe("modes", () => {
  const withMode = (mode: "hash" | "truncate") =>
    redactArtifact(artifact([users()]), {
      redact: [{ column: "password_hash", mode }],
    });

  it("hash is stable and distinguishes changed from unchanged", () => {
    const result = withMode("hash");
    const table = result.tables[0];
    if (table?.detail !== "rows") throw new Error("expected row level diff");

    const update = table.rows[1]?.cells[0];
    expect(String(update?.before)).toMatch(/^#[0-9a-f]{12}$/);
    expect(update?.before).not.toBe(update?.after);

    const insert = table.rows[0]?.cells.find((c) => c.column === "password_hash");
    // Same input, same hash, so an unchanged secret still reads as unchanged.
    expect(insert?.after).toBe(update?.before);
  });

  it("truncate keeps almost nothing", () => {
    const result = withMode("truncate");
    const table = result.tables[0];
    if (table?.detail !== "rows") throw new Error("expected row level diff");
    expect(table.rows[1]?.cells[0]?.before).toBe("hunt…");
  });
});

describe("no bypass", () => {
  it("redacts a value hiding in the primary key", () => {
    const table = users();
    table.primaryKey = ["api_key"];
    table.rows[0]!.key = [TOKEN];

    const result = redactArtifact(artifact([table]));
    const redacted = result.tables[0];
    if (redacted?.detail !== "rows") throw new Error("expected row level diff");
    expect(redacted.rows[0]?.key).toEqual([null]);
  });

  it("redacts aggregate transitions but keeps their counts", () => {
    const aggregate: TableDataDiff = {
      schema: "public",
      name: "users",
      detail: "aggregate",
      primaryKey: ["id"],
      columns: [{ name: "api_key", dataType: "text" }],
      counts: { inserted: 0, updated: 900, deleted: 0 },
      rowsBefore: 900,
      sample: [],
      columnStats: [
        {
          column: "api_key",
          changed: 900,
          transitions: [{ before: TOKEN, after: "rotated", count: 900 }],
        },
      ],
    };

    const result = redactArtifact(artifact([aggregate]));
    const table = result.tables[0];
    if (table?.detail !== "aggregate") throw new Error("expected aggregate diff");

    const stat = table.columnStats[0];
    expect(stat?.changed).toBe(900);
    expect(stat?.transitions[0]?.count).toBe(900);
    expect(stat?.transitions[0]?.before).toBeNull();
  });

  it("never lets a redacted value reach the serialized artifact", () => {
    const result = redactArtifact(artifact([users()]));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(TOKEN);
    // The email was deliberately not redacted, so it must still be there.
    expect(serialized).toContain("ada@example.com");
  });

  it("holds for hash and truncate too", () => {
    for (const mode of ["hash", "truncate"] as const) {
      const result = redactArtifact(artifact([users()]), {
        redact: [{ column: "*_key", mode }],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});
