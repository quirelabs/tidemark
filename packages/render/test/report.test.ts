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
    const summary = lines.findIndex((l) => l.includes("schema changes"));
    const data = lines.findIndex((l) => l === "DATA");
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(data);
  });

  it("puts warnings above the schema and data sections", () => {
    const lines = text().split("\n");
    const warnings = lines.indexOf("WARNINGS");
    const schema = lines.indexOf("SCHEMA");
    const data = lines.indexOf("DATA");
    expect(warnings).toBeGreaterThan(-1);
    expect(warnings).toBeLessThan(schema);
    expect(schema).toBeLessThan(data);
  });

  it("counts everything in the summary line", () => {
    const summary = text()
      .split("\n")
      .find((l) => l.includes("schema changes")) as string;
    expect(summary).toContain("2 tables");
    expect(summary).toContain("+2");
    expect(summary).toContain("~14,204");
    expect(summary).toContain("−1");
    expect(summary).toContain("7 schema changes");
    expect(summary).toContain("4 warnings");
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
    expect(out).toContain("character varying(20) → character varying(10)");
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
    expect(out).toContain("aggregated");
    expect(out).toContain("14,203 rows");
    expect(out).toContain("pending → processed");
    expect(out).toContain("14,203 distinct values");
    expect(out).toContain("sample, 2 of 14,203 rows");
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
