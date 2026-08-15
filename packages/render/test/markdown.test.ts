import { redactArtifact, type Artifact } from "@quirelabs/tidemark-core";
import { describe, expect, it } from "vitest";
import { COMMENT_MARKER, renderMarkdown } from "../src/index.ts";
import { AGENT_GONE_WRONG, NO_CHANGES } from "./fixtures/artifact.ts";

const md = (artifact: Artifact = AGENT_GONE_WRONG, options = {}) =>
  renderMarkdown(artifact, options);

describe("structure", () => {
  it("starts with the marker the sticky comment looks for", () => {
    expect(md().startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("can be rendered without the marker", () => {
    expect(md(AGENT_GONE_WRONG, { marker: false })).not.toContain(COMMENT_MARKER);
  });

  it("leads with a summary line", () => {
    const out = md();
    expect(out).toContain("2 tables");
    expect(out).toContain("**~14,204**");
    expect(out).toContain("**4 warnings**");
  });

  it("puts warnings in a table above the data", () => {
    const out = md();
    expect(out.indexOf("### Warnings")).toBeLessThan(out.indexOf("<details>"));
    expect(out).toContain("| **danger** | UPDATE without WHERE on public.orders | 14,203 |");
  });

  it("renders schema as a diff fence so it reads like a migration", () => {
    const out = md();
    expect(out).toContain("```diff");
    expect(out).toContain("+ CREATE TABLE public.audit_log");
    expect(out).toContain("- DROP TABLE public.temp_import");
    expect(out).toContain("-   DROP COLUMN legacy_ref");
    expect(out).toContain("!   ALTER COLUMN status");
  });

  it("collapses each table so a comment is not a wall of rows", () => {
    const out = md();
    expect(out).toContain("<details>");
    expect(out).toContain("<summary><b>public.users — +2 ~1 −1</b></summary>");
  });

  it("says so when nothing changed", () => {
    expect(md(NO_CHANGES)).toContain("No changes.");
  });

  it("links the workflow run when it knows it", () => {
    const out = md(AGENT_GONE_WRONG, { runUrl: "https://github.com/a/b/actions/runs/1" });
    expect(out).toContain("[Workflow run](https://github.com/a/b/actions/runs/1)");
  });
});

describe("hostile values cannot escape markdown", () => {
  /** Only the hostile value, so nothing we emit ourselves can mask a failure. */
  function withValue(value: string): Artifact {
    return {
      ...AGENT_GONE_WRONG,
      schema: { tablesAdded: [], tablesRemoved: [], tablesAltered: [] },
      warnings: [],
      tables: [
        {
          schema: "public",
          name: "notes",
          detail: "rows",
          primaryKey: ["id"],
          columns: [
            { name: "id", dataType: "integer" },
            { name: "body", dataType: "text" },
          ],
          counts: { inserted: 1, updated: 0, deleted: 0 },
          rowsBefore: 0,
          rows: [{ op: "insert", key: [1], cells: [{ column: "body", after: value }] }],
        },
      ],
    };
  }

  /**
   * Markdown only escapes HTML inside a code span, and entity references are
   * literal text there, so a value cannot be HTML-escaped and still read
   * correctly. Safety therefore rests on two structural facts, which is what
   * these assert: a value always sits inside a code span, and a value can never
   * begin a line, so it can never open an HTML block.
   */
  const OUR_TAGS = /^(<details>|<\/details>|<summary>|<sub>|<!-- tidemark)/;

  function linesStartingWithMarkup(out: string): string[] {
    return out
      .split("\n")
      .filter((line) => line.startsWith("<") && !OUR_TAGS.test(line));
  }

  function isInsideCodeSpan(out: string, value: string): boolean {
    const line = out.split("\n").find((l) => l.includes(value));
    if (line === undefined) return false;
    const before = line.slice(0, line.indexOf(value));
    const after = line.slice(line.indexOf(value) + value.length);
    return before.includes("`") && after.includes("`");
  }

  it("keeps an HTML tag inert inside a code span", () => {
    const out = renderMarkdown(withValue("<img src=x onerror=alert(1)>"));
    expect(isInsideCodeSpan(out, "<img src=x onerror=alert(1)>")).toBe(true);
    expect(linesStartingWithMarkup(out)).toEqual([]);
  });

  it("cannot close the details block it sits in", () => {
    const out = renderMarkdown(withValue("</details><script>bad()</script>"));
    // Only the closing tag we wrote may ever start a line.
    expect(linesStartingWithMarkup(out)).toEqual([]);
    expect(out.split("\n").filter((l) => l === "</details>")).toHaveLength(1);
    expect(isInsideCodeSpan(out, "</details><script>bad()</script>")).toBe(true);
  });

  it("never lets a value begin a line, whatever it contains", () => {
    for (const hostile of [
      "</details>",
      "<script>x</script>",
      "# heading",
      "| a | b |",
      "```",
      "- item",
    ]) {
      const out = renderMarkdown(withValue(hostile));
      expect(linesStartingWithMarkup(out)).toEqual([]);

      // The value always lands inside a table row, so it is never the first
      // thing on its line and cannot open a block of any kind.
      expect(out.split("\n").some((l) => l.startsWith("| + |"))).toBe(true);
      const offending = out
        .split("\n")
        .filter((l) => l.startsWith(hostile) && !OUR_TAGS.test(l));
      expect(offending).toEqual([]);
    }
  });

  it("cannot break out of a table cell with a pipe", () => {
    const out = renderMarkdown(withValue("a | b | c"));
    expect(out).toContain("a \\| b \\| c");
  });

  it("cannot close a code span with backticks", () => {
    const out = renderMarkdown(withValue("`` ` ``"));
    const row = out.split("\n").find((line) => line.includes("body")) as string;
    // The fence must be longer than the longest backtick run in the value.
    expect(row).toMatch(/`{3,}/);
  });

  it("still reveals control characters, as the terminal does", () => {
    const out = renderMarkdown(withValue("ok\r\n  0 warnings, all reviewed"));
    expect(out).toContain("␍␊");
    expect(out.split("\n").filter((l) => l.includes("0 warnings"))).toHaveLength(1);
  });

  it("keeps a bidi override visible", () => {
    const out = renderMarkdown(withValue("safe‮evil"));
    expect(out).toContain("<RLO>");
  });
});

describe("redaction", () => {
  it("never emits a masked value", () => {
    const SECRET = "hunter2-actual-secret";
    const artifact = redactArtifact({
      ...AGENT_GONE_WRONG,
      tables: [
        {
          schema: "public",
          name: "users",
          detail: "rows",
          primaryKey: ["id"],
          columns: [
            { name: "id", dataType: "integer" },
            { name: "password_hash", dataType: "text" },
          ],
          counts: { inserted: 1, updated: 0, deleted: 0 },
          rowsBefore: 0,
          rows: [
            {
              op: "insert",
              key: [1],
              cells: [{ column: "password_hash", after: SECRET }],
            },
          ],
        },
      ],
    });

    const out = renderMarkdown(artifact);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("_[masked]_");
  });

  it("carries the persistent disclosure", () => {
    const out = md();
    expect(out).toContain("Values shown in full for");
    expect(out).toContain("Configure masking in `tidemark.config.ts`.");
  });
});
