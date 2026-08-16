import type { Artifact } from "@quirelabs/tidemark-core";
import { describe, expect, it } from "vitest";
import {
  detectCapabilities,
  emit,
  lineText,
  lineWidth,
  plainCapabilities,
  renderReport,
  type Capabilities,
} from "../src/index.ts";
import { AGENT_GONE_WRONG, NO_CHANGES } from "./fixtures/artifact.ts";

const PLAIN = plainCapabilities(96);
// Written as an escape on purpose. A literal control character in a source file
// is invisible to review and does not survive every editor.
const ESC = "";

function text(capabilities: Capabilities = PLAIN, options = {}): string {
  return emit(renderReport(AGENT_GONE_WRONG, capabilities, options), capabilities);
}

describe("report structure", () => {
  it("leads with the summary before any detail", () => {
    const lines = text().split("\n");
    const summary = lines.findIndex((l) => l.includes("schema"));
    const data = lines.findIndex((l) => l.startsWith("━━ DATA"));
    expect(summary).toBeGreaterThan(-1);
    expect(data).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(data);
  });

  it("puts findings above the schema and data sections", () => {
    const lines = text().split("\n");
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    const danger = at("━━ DANGER");
    const schema = at("━━ SCHEMA");
    const data = at("━━ DATA");

    expect(danger).toBeGreaterThan(-1);
    expect(danger).toBeLessThan(schema);
    expect(schema).toBeLessThan(data);
  });

  it("counts everything in the summary line", () => {
    const summary = text()
      .split("\n")
      .find((l) => l.includes("tables")) as string;
    expect(summary).toContain("2 tables");
    expect(summary).toContain("+2");
    expect(summary).toContain("~14,204");
    expect(summary).toContain("−1");
    expect(summary).toContain("7 schema");
    // Severity is split out, because "4 warnings" hides whether any are fatal.
    expect(summary).toContain("3 danger");
    expect(summary).toContain("1 caution");
  });

  it("renders no changes without inventing sections", () => {
    const out = emit(renderReport(NO_CHANGES, PLAIN), PLAIN);
    expect(out).toContain("no changes");
    expect(out).not.toContain("WARNINGS");
    expect(out).not.toContain("SCHEMA");
    expect(out).not.toContain("DATA");
  });
});

describe("schema rendering", () => {
  it("reads like a migration", () => {
    const out = text();
    expect(out).toContain("+ public.audit_log");
    expect(out).toContain("− public.temp_import");
    expect(out).toContain("~ public.users");
    expect(out).toContain("text not null default 'free'::text");
    // Type and nullability both moved on this column, so both are named and
    // the unchanged default is not restated on either side.
    expect(out).toContain(
      "character varying(20) NULL → character varying(10) NOT NULL",
    );
    expect(out).toContain("users_tier_check");
  });
});

describe("data rendering", () => {
  it("renders row level tables with keys and changed columns", () => {
    const out = text();
    expect(out).toContain("id=51");
    expect(out).toContain("email=ada@example.com");
    expect(out).toContain("email bob@old.com → bob@new.com");
  });

  it("aggregates instead of listing bulk changes", () => {
    const out = text();
    expect(out).toContain("pending → processed");
    expect(out).toContain("14,203 distinct values");
    expect(out).toContain("sample, 2 of 14,203 rows");
    // Proportion is the point: the table heading carries the share it touched.
    expect(out).toContain("100%");
    expect(out).toContain("of 14,203");
  });

  it("never lists more rows than the sample it declares", () => {
    const sampleRows = text()
      .split("\n")
      .filter((l) => l.includes("status pending → processed"));
    expect(sampleRows.length).toBe(1);
  });

  it("shows redaction as a label, never the value", () => {
    const out = text();
    expect(out).toContain("password_hash=[masked]");
    expect(out).toContain("1 column redacted");
    expect(out).toContain("public.users.password_hash (mask)");
  });
});

describe("hostile values inside a report", () => {
  it("neutralises a forged summary line without dropping the row", () => {
    const out = text();
    expect(out).toContain("␍␊");
    // The forged text must never occupy a line of its own.
    expect(out).not.toMatch(/^\s*0 warnings, all changes reviewed\s*$/m);
  });

  it("emits no escape sequences at all when color is off", () => {
    expect(text()).not.toContain(ESC);
  });

  it("emits no escape sequence that came from the data", () => {
    const colored: Capabilities = { ...PLAIN, color: true };
    const out = emit(renderReport(AGENT_GONE_WRONG, colored, {}), colored);
    // Every ESC must open an SGR sequence we generated, never one from a value.
    for (const match of out.matchAll(/(.)/g)) {
      expect(match[1]).toBe("[");
    }
    expect(out).toContain(`${ESC}[1;35m`);
  });

  it("styles a deceptive value as a hazard rather than as text", () => {
    const lines = renderReport(AGENT_GONE_WRONG, PLAIN, {});
    const noteLine = lines.find((line) => lineText(line).includes("␍␊"));
    expect(noteLine?.some((s) => s.style === "hazard")).toBe(true);
  });
});

describe("density", () => {
  it("collapses tables when the report outgrows the height", () => {
    const out = text(PLAIN, { detail: "auto", height: 26 });
    expect(out).toContain("collapsed to fit, run with --full");
    expect(out).not.toContain("email=ada@example.com");
    // The danger signal survives collapsing, which is the whole point.
    expect(out).toContain("UPDATE without WHERE on public.orders");
  });

  it("shows everything when told to", () => {
    const out = text(PLAIN, { detail: "full", height: 10 });
    expect(out).not.toContain("collapsed to fit");
    expect(out).toContain("email=ada@example.com");
  });

  it("reduces to table headings in summary mode", () => {
    const out = text(PLAIN, { detail: "summary" });
    expect(out).toContain("public.users");
    expect(out).not.toContain("email=ada@example.com");
    expect(out).not.toContain("pending → processed");
  });

  it("keeps right aligned lines inside the terminal width", () => {
    // Table headings and warnings are justified against the width, so they must
    // fit. Constraint definitions are not: truncating a CHECK would hide meaning.
    const narrow = plainCapabilities(60);
    const justified = renderReport(AGENT_GONE_WRONG, narrow, {
      detail: "summary",
    }).filter((line) => {
      const t = lineText(line);
      return t.startsWith("  public.") || t.includes("⚠");
    });

    expect(justified.length).toBeGreaterThan(0);
    for (const line of justified) {
      expect(lineWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});

describe("capability detection", () => {
  it("honours NO_COLOR over a tty", () => {
    expect(detectCapabilities({ env: { NO_COLOR: "1" }, isTty: true }).color).toBe(false);
  });

  it("honours FORCE_COLOR when not a tty", () => {
    expect(detectCapabilities({ env: { FORCE_COLOR: "1" }, isTty: false }).color).toBe(true);
    expect(detectCapabilities({ env: { FORCE_COLOR: "0" }, isTty: true }).color).toBe(false);
  });

  it("disables color for dumb terminals and non ttys", () => {
    expect(detectCapabilities({ env: { TERM: "dumb" }, isTty: true }).color).toBe(false);
    expect(detectCapabilities({ env: {}, isTty: false }).color).toBe(false);
  });

  it("falls back to ascii glyphs for a non utf-8 locale", () => {
    expect(detectCapabilities({ env: { LANG: "C" }, isTty: true }).glyphs).toBe("ascii");
    expect(detectCapabilities({ env: { LANG: "en_US.UTF-8" }, isTty: true }).glyphs).toBe(
      "unicode",
    );
  });

  it("clamps width for very narrow and very wide terminals", () => {
    expect(detectCapabilities({ env: {}, columns: 20 }).width).toBe(40);
    expect(detectCapabilities({ env: {}, columns: 400 }).width).toBe(160);
    expect(detectCapabilities({ env: {}, columns: undefined }).width).toBe(80);
  });
});

describe("ascii mode", () => {
  it("avoids unicode glyphs entirely", () => {
    const ascii: Capabilities = { color: false, glyphs: "ascii", width: 96 };
    const out = emit(renderReport(AGENT_GONE_WRONG, ascii, {}), ascii);
    expect(out).not.toMatch(/[⚠→−·␀-␿…]/);
    expect(out).toContain("->");
    expect(out).toContain("\\r\\n");
  });
});

describe("altered columns", () => {
  it("shows only the attribute that changed, not the whole definition twice", () => {
    const narrowed: Artifact = {
      ...AGENT_GONE_WRONG,
      schema: {
        tablesAdded: [],
        tablesRemoved: [],
        tablesAltered: [
          {
            schema: "public",
            name: "orders",
            columnsAdded: [],
            columnsRemoved: [],
            columnsAltered: [
              {
                name: "status",
                before: {
                  name: "status",
                  dataType: "character varying(20)",
                  nullable: false,
                  default: "'pending'::character varying",
                },
                after: {
                  name: "status",
                  dataType: "character varying(10)",
                  nullable: false,
                  default: "'pending'::character varying",
                },
              },
            ],
            constraintsAdded: [],
            constraintsRemoved: [],
            indexesAdded: [],
            indexesRemoved: [],
          },
        ],
      },
    };

    const out = emit(renderReport(narrowed, PLAIN, { detail: "full" }), PLAIN);
    expect(out).toContain("character varying(20) → character varying(10)");
    // The default and nullability did not move, so they are not restated.
    expect(out).not.toContain("'pending'::character varying");
    expect(out).not.toContain("not null →");
  });

  it("names nullability when that is what moved", () => {
    const madeRequired: Artifact = {
      ...AGENT_GONE_WRONG,
      schema: {
        tablesAdded: [],
        tablesRemoved: [],
        tablesAltered: [
          {
            schema: "public",
            name: "users",
            columnsAdded: [],
            columnsRemoved: [],
            columnsAltered: [
              {
                name: "tier",
                before: { name: "tier", dataType: "text", nullable: true, default: null },
                after: { name: "tier", dataType: "text", nullable: false, default: null },
              },
            ],
            constraintsAdded: [],
            constraintsRemoved: [],
            indexesAdded: [],
            indexesRemoved: [],
          },
        ],
      },
    };

    const out = emit(renderReport(madeRequired, PLAIN, { detail: "full" }), PLAIN);
    expect(out).toContain("NULL → NOT NULL");
    expect(out).not.toContain("text → text");
  });
});

describe("uniform sample columns", () => {
  const STAMP: [string, string] = ["2026-08-15T21:16:10Z", "2026-08-15T21:16:11Z"];

  /** status varies across rows, so only a uniform column can collapse. */
  function bulk(rows: { status: [string, string]; stamp: [string, string] }[]): Artifact {
    return {
      ...AGENT_GONE_WRONG,
      warnings: [],
      schema: { tablesAdded: [], tablesRemoved: [], tablesAltered: [] },
      tables: [
        {
          schema: "public",
          name: "orders",
          detail: "aggregate",
          primaryKey: ["id"],
          columns: [
            { name: "id", dataType: "integer" },
            { name: "status", dataType: "text" },
            { name: "updated_at", dataType: "timestamp with time zone" },
          ],
          counts: { inserted: 0, updated: 14203, deleted: 0 },
          rowsBefore: 14203,
          columnStats: [],
          sample: rows.map((r, index) => ({
            op: "update" as const,
            key: [index + 1],
            cells: [
              { column: "status", before: r.status[0], after: r.status[1] },
              { column: "updated_at", before: r.stamp[0], after: r.stamp[1] },
            ],
          })),
        },
      ],
    };
  }

  const VARIED = [
    { status: ["pending", "processed"] as [string, string], stamp: STAMP },
    { status: ["failed", "processed"] as [string, string], stamp: STAMP },
    { status: ["queued", "processed"] as [string, string], stamp: STAMP },
  ];

  it("folds a timestamp that moved identically, and says so", () => {
    const out = emit(renderReport(bulk(VARIED), PLAIN, { detail: "full" }), PLAIN);

    expect(out).toContain("updated_at moved identically on all 3 sampled rows");
    // The column that actually differs survives on every row.
    expect(out).toContain("status pending → processed");
    expect(out).toContain("status failed → processed");
    // The repeated timestamp is gone from the rows themselves.
    expect(out).not.toContain("updated_at 2026-08-15T21:16:10Z");
  });

  it("leaves the rows alone when nothing is uniform", () => {
    const out = emit(
      renderReport(
        bulk([
          { status: ["pending", "processed"], stamp: STAMP },
          { status: ["failed", "processed"], stamp: ["2026-08-15T21:16:12Z", "2026-08-15T21:16:13Z"] },
        ]),
        PLAIN,
        { detail: "full" },
      ),
      PLAIN,
    );

    expect(out).not.toContain("moved identically");
    expect(out).toContain("updated_at 2026-08-15T21:16:10Z");
  });

  it("never collapses a row level diff, only aggregated tables", () => {
    // public.users in the fixture is row level, under the threshold, so even a
    // column that happens to be uniform stays on every row.
    const out = text(PLAIN, { detail: "full" });
    expect(out).toContain("email=ada@example.com");
    expect(out).not.toContain("moved identically");
  });
});
