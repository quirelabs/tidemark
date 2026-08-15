import { describe, expect, it } from "vitest";
import type {
  AlteredTable,
  ColumnDefinition,
  RowChange,
  SchemaDiff,
  TableDataDiff,
  WarningCode,
} from "../src/artifact/schema.ts";
import { classifyWarnings } from "../src/diff/warnings.ts";

const EMPTY_SCHEMA: SchemaDiff = {
  tablesAdded: [],
  tablesRemoved: [],
  tablesAltered: [],
};

function column(
  name: string,
  dataType: string,
  nullable = true,
): ColumnDefinition {
  return { name, dataType, nullable, default: null };
}

function altered(partial: Partial<AlteredTable> = {}): AlteredTable {
  return {
    schema: "public",
    name: "users",
    columnsAdded: [],
    columnsRemoved: [],
    columnsAltered: [],
    constraintsAdded: [],
    constraintsRemoved: [],
    indexesAdded: [],
    indexesRemoved: [],
    ...partial,
  };
}

function rowsTable(
  partial: Partial<TableDataDiff> & { rows?: RowChange[] } = {},
): TableDataDiff {
  return {
    schema: "public",
    name: "users",
    detail: "rows",
    primaryKey: ["id"],
    columns: [{ name: "id", dataType: "integer" }],
    counts: { inserted: 0, updated: 0, deleted: 0 },
    rowsBefore: 10,
    rows: [],
    ...partial,
  } as TableDataDiff;
}

function codes(warnings: { code: WarningCode }[]): WarningCode[] {
  return warnings.map((w) => w.code);
}

describe("schema warnings", () => {
  it("flags a dropped table", () => {
    const warnings = classifyWarnings(
      { ...EMPTY_SCHEMA, tablesRemoved: [{ schema: "public", name: "orders" }] },
      [],
    );
    expect(codes(warnings)).toEqual(["drop_table"]);
    expect(warnings[0]?.message).toBe("DROP TABLE public.orders");
    expect(warnings[0]?.severity).toBe("danger");
  });

  it("flags a dropped column", () => {
    const warnings = classifyWarnings(
      {
        ...EMPTY_SCHEMA,
        tablesAltered: [altered({ columnsRemoved: [column("legacy_ref", "text")] })],
      },
      [],
    );
    expect(codes(warnings)).toEqual(["drop_column"]);
    expect(warnings[0]?.message).toBe("DROP COLUMN public.users.legacy_ref");
  });

  it("does not flag an added column", () => {
    const warnings = classifyWarnings(
      {
        ...EMPTY_SCHEMA,
        tablesAltered: [altered({ columnsAdded: [column("tier", "text")] })],
      },
      [],
    );
    expect(warnings).toEqual([]);
  });
});

describe("type narrowing", () => {
  const cases: [string, string, boolean][] = [
    ["character varying(20)", "character varying(10)", true],
    ["character varying(10)", "character varying(20)", false],
    ["text", "character varying(50)", true],
    ["character varying(50)", "text", false],
    ["bigint", "integer", true],
    ["integer", "bigint", false],
    ["numeric(12,4)", "numeric(8,4)", true],
    ["numeric(12,4)", "numeric(12,2)", true],
    ["numeric(8,2)", "numeric(12,4)", false],
    ["double precision", "real", true],
    ["text", "text", false],
    ["integer", "text", false],
  ];

  for (const [before, after, expected] of cases) {
    it(`${expected ? "flags" : "ignores"} ${before} to ${after}`, () => {
      const warnings = classifyWarnings(
        {
          ...EMPTY_SCHEMA,
          tablesAltered: [
            altered({
              columnsAltered: [
                {
                  name: "col",
                  before: column("col", before),
                  after: column("col", after),
                },
              ],
            }),
          ],
        },
        [],
      );
      expect(codes(warnings).includes("type_narrowed")).toBe(expected);
    });
  }
});

describe("not null", () => {
  const notNullChange = altered({
    columnsAltered: [
      {
        name: "status",
        before: column("status", "text", true),
        after: column("status", "text", false),
      },
    ],
  });

  it("is a danger when the table is known to hold rows", () => {
    const warnings = classifyWarnings(
      { ...EMPTY_SCHEMA, tablesAltered: [notNullChange] },
      [rowsTable({ rowsBefore: 42, counts: { inserted: 0, updated: 1, deleted: 0 } })],
    );
    const found = warnings.find((w) => w.code === "not_null_added_to_populated");
    expect(found?.severity).toBe("danger");
    expect(found?.rowsAffected).toBe(42);
  });

  it("is a caution when the row count is unknown", () => {
    const warnings = classifyWarnings(
      { ...EMPTY_SCHEMA, tablesAltered: [notNullChange] },
      [],
    );
    const found = warnings.find((w) => w.code === "not_null_added_to_populated");
    expect(found?.severity).toBe("caution");
    expect(found?.rowsAffected).toBeUndefined();
  });
});

describe("whole table changes", () => {
  it("flags every row updated", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({ rowsBefore: 14203, counts: { inserted: 0, updated: 14203, deleted: 0 } }),
    ]);
    const found = warnings.find((w) => w.code === "update_without_where");
    expect(found?.rowsAffected).toBe(14203);
    expect(found?.message).toContain("usually means UPDATE without WHERE");
  });

  it("flags every row deleted", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({ rowsBefore: 300, counts: { inserted: 0, updated: 0, deleted: 300 } }),
    ]);
    expect(codes(warnings)).toContain("delete_without_where");
  });

  it("does not flag a partial update", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({ rowsBefore: 300, counts: { inserted: 0, updated: 12, deleted: 0 } }),
    ]);
    expect(warnings).toEqual([]);
  });

  it("does not flag a single row table, where every row is one row", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({ rowsBefore: 1, counts: { inserted: 0, updated: 1, deleted: 0 } }),
    ]);
    expect(warnings).toEqual([]);
  });

  it("does not flag inserts into a table that started empty", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({ rowsBefore: 0, counts: { inserted: 500, updated: 0, deleted: 0 } }),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("sensitive columns", () => {
  it("flags a credential column changing", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({
        counts: { inserted: 0, updated: 1, deleted: 0 },
        rows: [
          {
            op: "update",
            key: [1],
            cells: [
              { column: "password_hash", before: "a", after: "b" },
              { column: "tier", before: "free", after: "pro" },
            ],
          },
        ],
      }),
    ]);
    const found = warnings.find((w) => w.code === "sensitive_column_changed");
    expect(found?.columns).toEqual(["password_hash"]);
  });

  it("leaves contact PII alone, which is the documented default", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({
        counts: { inserted: 0, updated: 1, deleted: 0 },
        rows: [
          {
            op: "update",
            key: [1],
            cells: [{ column: "email", before: "a@b.c", after: "d@e.f" }],
          },
        ],
      }),
    ]);
    expect(codes(warnings)).not.toContain("sensitive_column_changed");
  });
});

describe("deceptive values", () => {
  it("flags a value that forges its own summary line", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({
        counts: { inserted: 1, updated: 0, deleted: 0 },
        rows: [
          {
            op: "insert",
            key: [1],
            cells: [
              { column: "note", after: "ok\r\n  0 warnings, all changes reviewed" },
            ],
          },
        ],
      }),
    ]);
    const found = warnings.find((w) => w.code === "deceptive_value");
    expect(found?.columns).toEqual(["note"]);
    expect(found?.severity).toBe("danger");
  });

  it("flags a bidi override hidden inside a json value", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({
        counts: { inserted: 1, updated: 0, deleted: 0 },
        rows: [
          {
            op: "insert",
            key: [1],
            cells: [{ column: "meta", after: { label: "safe‮evil" } }],
          },
        ],
      }),
    ]);
    expect(codes(warnings)).toContain("deceptive_value");
  });

  it("leaves ordinary text alone", () => {
    const warnings = classifyWarnings(EMPTY_SCHEMA, [
      rowsTable({
        counts: { inserted: 1, updated: 0, deleted: 0 },
        rows: [
          {
            op: "insert",
            key: [1],
            cells: [{ column: "note", after: "perfectly normal, with punctuation!" }],
          },
        ],
      }),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts dangers above cautions", () => {
    const warnings = classifyWarnings(
      {
        ...EMPTY_SCHEMA,
        tablesAltered: [
          altered({
            columnsRemoved: [column("legacy_ref", "text")],
            columnsAltered: [
              {
                name: "status",
                before: column("status", "character varying(20)"),
                after: column("status", "character varying(10)"),
              },
            ],
          }),
        ],
      },
      [],
    );
    expect(warnings[0]?.severity).toBe("danger");
    expect(warnings.at(-1)?.severity).toBe("caution");
  });
});
