import type {
  AggregateDiff,
  AlteredTable,
  Artifact,
  CellChange,
  ColumnDefinition,
  RowChange,
  TableDataDiff,
  TableRef,
  Warning,
} from "@quirelabs/tidemark-core";
import { isNotablePii } from "@quirelabs/tidemark-core";
import { renderCellValue, type CellContext } from "./cells.ts";
import { describeColumn, describeColumnChange } from "./columns.ts";
import { collapseUniformColumns, collapsedNote } from "./sample.ts";

/**
 * Markdown for a pull request comment, built from the artifact and nothing else.
 *
 * The same rule as the terminal applies and is harder here: a pull request
 * comment renders HTML, so a value must not be able to open a tag, break out of
 * a table cell, or close the <details> block it sits in. Values therefore go
 * inside code spans whose fence is longer than any backtick run they contain,
 * and pipes are escaped even inside those spans because GitHub still splits
 * table cells on them.
 */

/** Hidden marker used to find and replace the comment instead of spamming new ones. */
export const COMMENT_MARKER = "<!-- tidemark:report -->";

const MAX_ROWS_PER_TABLE = 30;
const MAX_SAMPLE_ROWS = 8;
const MAX_VALUE_WIDTH = 80;

export interface MarkdownOptions {
  /** Include the hidden marker. On by default, the sticky comment needs it. */
  marker?: boolean;
  /** Link back to the workflow run, when the Action knows it. */
  runUrl?: string;
}

export function renderMarkdown(
  artifact: Artifact,
  options: MarkdownOptions = {},
): string {
  const blocks: string[] = [];

  if (options.marker !== false) blocks.push(COMMENT_MARKER);
  blocks.push("## Tidemark");
  blocks.push(summary(artifact));

  const warningBlock = warnings(artifact.warnings);
  if (warningBlock !== null) blocks.push(warningBlock);

  const schemaBlock = schema(artifact);
  if (schemaBlock !== null) blocks.push(schemaBlock);

  for (const table of artifact.tables) blocks.push(tableBlock(table));

  blocks.push("---");
  blocks.push(footer(artifact, options.runUrl));
  return `${blocks.join("\n\n")}\n`;
}

// GFM escaping. Values live in code spans, so the only thing that can still
// break out is a pipe inside a table, and a backtick run that closes the span.

function codeSpan(text: string): string {
  if (text === "") return "``";
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function cell(text: string): string {
  return codeSpan(text).replaceAll("|", "\\|");
}

/** For prose, where a code span would be wrong but HTML must still be inert. */
function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|");
}

function ref(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function contextFor(table: TableDataDiff): CellContext {
  return {
    columns: table.columns,
    glyphs: "unicode",
    maxWidth: MAX_VALUE_WIDTH,
  };
}

function valueText(
  value: CellChange["before"],
  column: string,
  context: CellContext,
): string {
  return renderCellValue(value, column, context).text;
}

function summary(artifact: Artifact): string {
  const totals = artifact.tables.reduce(
    (acc, table) => ({
      inserted: acc.inserted + table.counts.inserted,
      updated: acc.updated + table.counts.updated,
      deleted: acc.deleted + table.counts.deleted,
    }),
    { inserted: 0, updated: 0, deleted: 0 },
  );

  const parts: string[] = [];
  if (artifact.tables.length > 0) {
    parts.push(`${count(artifact.tables.length)} tables`);
  }
  if (totals.inserted > 0) parts.push(`**+${count(totals.inserted)}**`);
  if (totals.updated > 0) parts.push(`**~${count(totals.updated)}**`);
  if (totals.deleted > 0) parts.push(`**−${count(totals.deleted)}**`);

  const schemaChanges = countSchemaChanges(artifact);
  if (schemaChanges > 0) {
    parts.push(`${count(schemaChanges)} schema ${schemaChanges === 1 ? "change" : "changes"}`);
  }
  if (artifact.warnings.length > 0) {
    parts.push(`**${count(artifact.warnings.length)} warnings**`);
  }

  return parts.length === 0 ? "No changes." : parts.join(" · ");
}

function warnings(list: readonly Warning[]): string | null {
  if (list.length === 0) return null;

  const rows = list.map((warning) => {
    const severity = warning.severity === "danger" ? "**danger**" : "caution";
    const rows_ = warning.rowsAffected === undefined ? "" : count(warning.rowsAffected);
    return `| ${severity} | ${escapeText(warning.message)} | ${rows_} |`;
  });

  return [
    "### Warnings",
    "",
    "| | What | Rows |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function schema(artifact: Artifact): string | null {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  if (
    tablesAdded.length === 0 &&
    tablesRemoved.length === 0 &&
    tablesAltered.length === 0
  ) {
    return null;
  }

  // A diff fence colours + and - lines, which is exactly the migration reading.
  const lines: string[] = [];
  for (const table of tablesAdded) lines.push(`+ CREATE TABLE ${ref(table)}`);
  for (const table of tablesRemoved) lines.push(`- DROP TABLE ${ref(table)}`);
  for (const table of tablesAltered) lines.push(...alteredLines(table));

  return ["### Schema", "", "```diff", ...lines, "```"].join("\n");
}

function alteredLines(table: AlteredTable): string[] {
  const lines: string[] = [`! ALTER TABLE ${ref(table)}`];
  if (table.renamedFrom !== undefined) {
    lines.push(`!   RENAMED FROM ${ref(table.renamedFrom)}`);
  }
  for (const column of table.columnsAdded) {
    lines.push(`+   ADD COLUMN ${column.name} ${describeColumn(column)}`);
  }
  for (const column of table.columnsRemoved) {
    lines.push(`-   DROP COLUMN ${column.name}`);
  }
  for (const column of table.columnsAltered) {
    const change = describeColumnChange(column.before, column.after);
    lines.push(
      `!   ALTER COLUMN ${column.name} ${change.before} -> ${change.after}`,
    );
  }
  for (const constraint of table.constraintsAdded) {
    lines.push(`+   ADD CONSTRAINT ${constraint.name} ${constraint.definition}`);
  }
  for (const constraint of table.constraintsRemoved) {
    lines.push(`-   DROP CONSTRAINT ${constraint.name}`);
  }
  for (const index of table.indexesAdded) {
    lines.push(`+   CREATE INDEX ${index.name} ${index.definition}`);
  }
  for (const index of table.indexesRemoved) {
    lines.push(`-   DROP INDEX ${index.name}`);
  }
  return lines;
}


function tableBlock(table: TableDataDiff): string {
  const counts: string[] = [];
  if (table.counts.inserted > 0) counts.push(`+${count(table.counts.inserted)}`);
  if (table.counts.updated > 0) counts.push(`~${count(table.counts.updated)}`);
  if (table.counts.deleted > 0) counts.push(`−${count(table.counts.deleted)}`);
  if (table.detail === "aggregate") counts.push("aggregated");

  const heading = `${ref(table)} — ${counts.join(" ")}`;
  const body =
    table.detail === "rows" ? rowTable(table.rows, table) : aggregateBody(table);

  // Collapsed by default: a pull request comment should not be a wall of rows.
  return [
    "<details>",
    `<summary><b>${escapeText(heading)}</b></summary>`,
    "",
    body,
    "",
    "</details>",
  ].join("\n");
}

function aggregateBody(table: AggregateDiff): string {
  const context = contextFor(table);
  const sections: string[] = [];

  if (table.columnStats.length > 0) {
    const rows = table.columnStats.map((stat) => {
      const shape =
        stat.transitions.length > 0
          ? stat.transitions
              .slice(0, 3)
              .map(
                (t) =>
                  `${cell(valueText(t.before, stat.column, context))} → ${cell(valueText(t.after, stat.column, context))}`,
              )
              .join(", ")
          : stat.distinctAfter === undefined
            ? "values vary"
            : `${count(stat.distinctAfter)} distinct values`;
      return `| ${cell(stat.column)} | ${count(stat.changed)} | ${shape} |`;
    });
    sections.push(
      ["| Column | Rows | Change |", "| --- | --- | --- |", ...rows].join("\n"),
    );
  }

  if (table.sample.length > 0) {
    const shown = table.sample.slice(0, MAX_SAMPLE_ROWS);
    const { rows, collapsed } = collapseUniformColumns(shown);

    sections.push(
      `Sample, ${count(shown.length)} of ${count(totalRows(table))} changed rows:`,
    );
    sections.push(rowTable(rows, table));

    if (collapsed.length > 0) {
      sections.push(`_${escapeText(collapsedNote(collapsed, shown.length))}._`);
    }
  }

  return sections.join("\n\n");
}

function totalRows(table: TableDataDiff): number {
  return table.counts.inserted + table.counts.updated + table.counts.deleted;
}

function rowTable(rows: readonly RowChange[], table: TableDataDiff): string {
  const context = contextFor(table);
  const shown = rows.slice(0, MAX_ROWS_PER_TABLE);

  const body = shown.map((row) => {
    const op = row.op === "insert" ? "+" : row.op === "delete" ? "−" : "~";
    const keyText =
      table.primaryKey === null || row.key.length === 0
        ? "—"
        : table.primaryKey
            .map((name, index) => `${name}=${valueText(row.key[index], name, context)}`)
            .join(", ");

    const changes = row.cells
      .map((c) => describeCell(c, context))
      .join("<br>");

    return `| ${op} | ${cell(keyText)} | ${changes} |`;
  });

  const table_ = ["| | Key | Change |", "| --- | --- | --- |", ...body].join("\n");

  return rows.length > shown.length
    ? `${table_}\n\n_${count(rows.length - shown.length)} further rows not shown._`
    : table_;
}

function describeCell(change: CellChange, context: CellContext): string {
  if (change.redacted === "mask") {
    return `${cell(change.column)} = _[masked]_`;
  }

  const hasBefore = change.before !== undefined;
  const hasAfter = change.after !== undefined;

  if (hasBefore && hasAfter) {
    return `${cell(change.column)} ${cell(valueText(change.before, change.column, context))} → ${cell(valueText(change.after, change.column, context))}`;
  }
  const value = hasAfter ? change.after : change.before;
  return `${cell(change.column)} = ${cell(valueText(value, change.column, context))}`;
}

function footer(artifact: Artifact, runUrl?: string): string {
  const redacted = new Set(
    artifact.meta.redactions.map((r) => `${ref(r.table)}.${r.column}`),
  );

  const shown: string[] = [];
  for (const table of artifact.tables) {
    for (const column of table.columns) {
      if (!redacted.has(`${ref(table)}.${column.name}`)) shown.push(column.name);
    }
  }
  const notable = [...new Set(shown.filter(isNotablePii))].sort();

  const parts: string[] = [
    `Values shown in full for ${count(shown.length)} columns` +
      (notable.length > 0 ? `, including ${notable.map(escapeText).join(", ")}` : "") +
      ".",
  ];

  if (artifact.meta.redactions.length > 0) {
    const described = artifact.meta.redactions
      .map((r) => `${ref(r.table)}.${r.column} (${r.mode})`)
      .join(", ");
    parts.push(`${count(artifact.meta.redactions.length)} redacted: ${escapeText(described)}.`);
  }

  parts.push("Configure masking in `tidemark.config.ts`.");
  if (runUrl !== undefined) parts.push(`[Workflow run](${encodeURI(runUrl)})`);

  return `<sub>${parts.join(" ")}</sub>`;
}

function countSchemaChanges(artifact: Artifact): number {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  return (
    tablesAdded.length +
    tablesRemoved.length +
    tablesAltered.reduce(
      (sum, table) =>
        sum +
        table.columnsAdded.length +
        table.columnsRemoved.length +
        table.columnsAltered.length +
        table.constraintsAdded.length +
        table.constraintsRemoved.length +
        table.indexesAdded.length +
        table.indexesRemoved.length,
      0,
    )
  );
}
