import type {
  AggregateDiff,
  AlteredTable,
  Artifact,
  ColumnChangeStat,
  ColumnDefinition,
  NamedDefinition,
  RowChange,
  TableDataDiff,
  TableRef,
  Warning,
} from "@quirelabs/tidemark-core";
import type { Capabilities } from "../style/capabilities.ts";
import { lineWidth, pad, span, type Line, type Span } from "../style/style.ts";
import { stringWidth } from "../text/width.ts";
import { cellSpans, valueSpan, type CellContext } from "./cells.ts";
import { glyphsFor, type Glyphs } from "./glyphs.ts";

const NUMBER = new Intl.NumberFormat("en-US");
const MAX_TRANSITIONS_SHOWN = 2;
const DEFAULT_HEIGHT = 40;
/** Never collapse below this, otherwise "auto" hides everything on a small term. */
const MIN_DATA_LINES = 8;

export interface ReportOptions {
  /**
   * "auto" collapses tables to a summary line once the report outgrows the
   * available height, so the danger signal stays above the fold.
   */
  detail?: "auto" | "summary" | "full";
  /** Lines available. Only consulted by "auto". */
  height?: number;
}

export function renderReport(
  artifact: Artifact,
  capabilities: Capabilities,
  options: ReportOptions = {},
): Line[] {
  const glyphs = glyphsFor(capabilities.glyphs);
  const detail = options.detail ?? "auto";
  const width = capabilities.width;

  const lines: Line[] = [];
  lines.push(...header(artifact, glyphs));
  lines.push([]);
  lines.push(...summary(artifact, glyphs, width));
  lines.push(...warnings(artifact.warnings, glyphs, width));
  lines.push(...schemaSection(artifact, glyphs));

  const budget =
    detail === "auto"
      ? Math.max(MIN_DATA_LINES, (options.height ?? DEFAULT_HEIGHT) - lines.length)
      : Number.POSITIVE_INFINITY;

  lines.push(...dataSection(artifact, capabilities, glyphs, detail, budget));
  lines.push(...footer(artifact, glyphs));
  return lines;
}

function ref(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

function header(artifact: Artifact, glyphs: Glyphs): Line[] {
  const { meta } = artifact;
  const sep = span(` ${glyphs.separator} `, "muted");
  return [
    [
      span("tidemark", "heading"),
      sep,
      span(meta.database),
      sep,
      span(`${meta.backend} backend`, "muted"),
      sep,
      span(meta.capturedTo, "muted"),
    ],
  ];
}

function summary(artifact: Artifact, glyphs: Glyphs, width: number): Line[] {
  const counts = totals(artifact);
  const parts: Span[][] = [];

  const tableCount = artifact.tables.length;
  if (tableCount > 0) {
    parts.push([span(`${NUMBER.format(tableCount)} ${plural(tableCount, "table")}`)]);
  }
  if (counts.inserted > 0) {
    parts.push([span(`${glyphs.insert}${NUMBER.format(counts.inserted)}`, "insert")]);
  }
  if (counts.updated > 0) {
    parts.push([span(`${glyphs.update}${NUMBER.format(counts.updated)}`, "update")]);
  }
  if (counts.deleted > 0) {
    parts.push([span(`${glyphs.delete}${NUMBER.format(counts.deleted)}`, "delete")]);
  }

  const schemaChanges = countSchemaChanges(artifact);
  if (schemaChanges > 0) {
    parts.push([
      span(`${NUMBER.format(schemaChanges)} schema ${plural(schemaChanges, "change")}`),
    ]);
  }

  const warningCount = artifact.warnings.length;
  if (warningCount > 0) {
    const style = artifact.warnings.some((w) => w.severity === "danger")
      ? "danger"
      : "caution";
    parts.push([
      span(
        `${glyphs.warn} ${NUMBER.format(warningCount)} ${plural(warningCount, "warning")}`,
        style,
      ),
    ]);
  }

  if (parts.length === 0) return [[span("  "), span("no changes", "muted")]];

  // The summary is the one line a reviewer always reads, so it wraps onto a
  // second line rather than running past the edge of the terminal.
  const separator = ` ${glyphs.separator} `;
  const lines: Line[] = [];
  let current: Line = [span("  ")];
  let used = 2;

  for (const part of parts) {
    const partWidth = part.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const needsSeparator = current.length > 1;
    const cost = partWidth + (needsSeparator ? separator.length : 0);

    if (needsSeparator && used + cost > width) {
      lines.push(current);
      current = [span("  ")];
      used = 2;
      current.push(...part);
      used += partWidth;
      continue;
    }

    if (needsSeparator) {
      current.push(span(separator, "muted"));
      used += separator.length;
    }
    current.push(...part);
    used += partWidth;
  }

  lines.push(current);
  return lines;
}

function warnings(list: readonly Warning[], glyphs: Glyphs, width: number): Line[] {
  if (list.length === 0) return [];

  const lines: Line[] = [[], [span("WARNINGS", "heading")]];
  for (const warning of list) {
    const style = warning.severity === "danger" ? "danger" : "caution";
    const right: Line =
      warning.rowsAffected === undefined
        ? []
        : [span(`${NUMBER.format(warning.rowsAffected)} rows`, "muted")];

    // A warning is the most important line in the report, so it wraps rather
    // than truncating. Losing the tail of a danger message is not acceptable.
    const indent = 4;
    const available = width - indent - lineWidth(right) - (right.length > 0 ? 2 : 0);
    const segments = wrapText(warning.message, available);

    segments.forEach((segment, index) => {
      const head: Line =
        index === 0
          ? [span("  "), span(glyphs.warn, style), span(" ")]
          : [span(" ".repeat(indent))];
      const body: Line = [...head, span(segment, style)];
      lines.push(index === 0 ? justify(body, right, width) : body);
    });
  }
  return lines;
}

/** Word wrap. A single word wider than the budget overflows rather than breaks. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (stringWidth(current) + 1 + stringWidth(word) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function schemaSection(artifact: Artifact, glyphs: Glyphs): Line[] {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  if (
    tablesAdded.length === 0 &&
    tablesRemoved.length === 0 &&
    tablesAltered.length === 0
  ) {
    return [];
  }

  const lines: Line[] = [[], [span("SCHEMA", "heading")]];

  for (const table of tablesAdded) {
    lines.push([span("  "), span(glyphs.insert, "insert"), span(` ${ref(table)}`)]);
  }
  for (const table of tablesRemoved) {
    lines.push([span("  "), span(glyphs.delete, "delete"), span(` ${ref(table)}`)]);
  }
  for (const table of tablesAltered) {
    lines.push([span("  "), span(glyphs.update, "update"), span(` ${ref(table)}`)]);
    lines.push(...alteredTableLines(table, glyphs));
  }
  return lines;
}

function alteredTableLines(table: AlteredTable, glyphs: Glyphs): Line[] {
  const lines: Line[] = [];
  const indent = span("      ");

  const columnNames = [
    ...table.columnsAdded.map((c) => c.name),
    ...table.columnsRemoved.map((c) => c.name),
    ...table.columnsAltered.map((c) => c.name),
  ];
  const nameWidth = maxWidth(columnNames);

  for (const column of table.columnsAdded) {
    lines.push([
      indent,
      span(glyphs.insert, "insert"),
      span(" "),
      span(padText(column.name, nameWidth)),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsRemoved) {
    lines.push([
      indent,
      span(glyphs.delete, "delete"),
      span(" "),
      span(padText(column.name, nameWidth)),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsAltered) {
    lines.push([
      indent,
      span(glyphs.update, "update"),
      span(" "),
      span(padText(column.name, nameWidth)),
      span("  "),
      span(describeColumn(column.before), "muted"),
      span(` ${glyphs.arrow} `),
      span(describeColumn(column.after), "muted"),
    ]);
  }

  lines.push(...definitionLines(table.constraintsAdded, glyphs.insert, "insert", indent));
  lines.push(
    ...definitionLines(table.constraintsRemoved, glyphs.delete, "delete", indent),
  );
  lines.push(...definitionLines(table.indexesAdded, glyphs.insert, "insert", indent));
  lines.push(...definitionLines(table.indexesRemoved, glyphs.delete, "delete", indent));
  return lines;
}

function definitionLines(
  definitions: readonly NamedDefinition[],
  glyph: string,
  style: "insert" | "delete",
  indent: Span,
): Line[] {
  return definitions.map((definition) => [
    indent,
    span(glyph, style),
    span(" "),
    span(definition.name),
    span("  "),
    span(definition.definition, "muted"),
  ]);
}

function describeColumn(column: ColumnDefinition): string {
  let text = column.dataType;
  if (!column.nullable) text += " not null";
  if (column.default !== null) text += ` default ${column.default}`;
  return text;
}

function dataSection(
  artifact: Artifact,
  capabilities: Capabilities,
  glyphs: Glyphs,
  detail: "auto" | "summary" | "full",
  budget: number,
): Line[] {
  if (artifact.tables.length === 0) return [];

  const lines: Line[] = [[], [span("DATA", "heading")]];
  let collapsed = 0;

  for (const table of artifact.tables) {
    const head = tableHeading(table, glyphs, capabilities.width);
    if (detail === "summary") {
      lines.push(head);
      continue;
    }

    const body = tableBody(table, capabilities, glyphs);
    if (detail === "auto" && lines.length + body.length + 1 > budget) {
      lines.push(head);
      collapsed++;
      continue;
    }
    lines.push(head, ...body);
  }

  if (collapsed > 0) {
    lines.push([
      span("  "),
      span(
        `${NUMBER.format(collapsed)} ${plural(collapsed, "table")} collapsed to fit, run with --full`,
        "muted",
      ),
    ]);
  }
  return lines;
}

function tableHeading(table: TableDataDiff, glyphs: Glyphs, width: number): Line {
  const left: Line = [span("  "), span(ref(table), "key")];
  const parts: Span[] = [];

  if (table.counts.inserted > 0) {
    parts.push(span(`${glyphs.insert}${NUMBER.format(table.counts.inserted)}`, "insert"));
  }
  if (table.counts.updated > 0) {
    parts.push(span(`${glyphs.update}${NUMBER.format(table.counts.updated)}`, "update"));
  }
  if (table.counts.deleted > 0) {
    parts.push(span(`${glyphs.delete}${NUMBER.format(table.counts.deleted)}`, "delete"));
  }
  if (table.detail === "aggregate") parts.push(span("aggregated", "muted"));

  // Separators between parts only, so every heading ends at the same column.
  const right: Line = parts.flatMap((part, index) =>
    index === 0 ? [part] : [span(" "), part],
  );

  return justify(left, right, width);
}

function tableBody(
  table: TableDataDiff,
  capabilities: Capabilities,
  glyphs: Glyphs,
): Line[] {
  const context: CellContext = {
    columns: table.columns,
    glyphs: capabilities.glyphs,
    // Leave room for the op glyph, key and indentation before the value starts.
    maxWidth: Math.max(12, Math.floor(capabilities.width / 3)),
  };

  if (table.detail === "rows") {
    return rowLines(table.rows, table.primaryKey, context, glyphs);
  }
  return aggregateLines(table, context, glyphs);
}

function aggregateLines(
  table: AggregateDiff,
  context: CellContext,
  glyphs: Glyphs,
): Line[] {
  const lines: Line[] = [];

  if (table.statement !== undefined) {
    lines.push([span("      "), span(table.statement, "muted")]);
  }

  const nameWidth = maxWidth(table.columnStats.map((s) => s.column));
  for (const stat of table.columnStats) {
    lines.push([
      span("      "),
      span(padText(stat.column, nameWidth)),
      span("  "),
      span(`${NUMBER.format(stat.changed)} rows`, "muted"),
      span("  "),
      ...statSpans(stat, context, glyphs),
    ]);
  }

  if (table.sample.length > 0) {
    const total = table.counts.inserted + table.counts.updated + table.counts.deleted;
    lines.push([
      span("      "),
      span(
        `sample, ${NUMBER.format(table.sample.length)} of ${NUMBER.format(total)} rows`,
        "muted",
      ),
    ]);
    lines.push(
      ...rowLines(table.sample, table.primaryKey, context, glyphs, "        "),
    );
  }
  return lines;
}

function statSpans(
  stat: ColumnChangeStat,
  context: CellContext,
  glyphs: Glyphs,
): Span[] {
  if (stat.transitions.length === 0) {
    const distinct = stat.distinctAfter;
    return [
      span(
        distinct === undefined
          ? "values vary"
          : `${NUMBER.format(distinct)} distinct values`,
        "muted",
      ),
    ];
  }

  const spans: Span[] = [];
  const shown = stat.transitions.slice(0, MAX_TRANSITIONS_SHOWN);
  shown.forEach((transition, index) => {
    if (index > 0) spans.push(span(", ", "muted"));
    spans.push(
      valueSpan(transition.before, stat.column, context),
      span(` ${glyphs.arrow} `),
      valueSpan(transition.after, stat.column, context),
    );
  });
  if (stat.transitions.length > shown.length) {
    spans.push(
      span(` and ${NUMBER.format(stat.transitions.length - shown.length)} more`, "muted"),
    );
  }
  return spans;
}

function rowLines(
  rows: readonly RowChange[],
  primaryKey: readonly string[] | null,
  context: CellContext,
  glyphs: Glyphs,
  indent = "    ",
): Line[] {
  const keys = rows.map((row) => keySpans(row, primaryKey, context));
  const keyWidth = Math.max(0, ...keys.map(lineWidth));

  return rows.map((row, index) => {
    const glyph =
      row.op === "insert"
        ? glyphs.insert
        : row.op === "delete"
          ? glyphs.delete
          : glyphs.update;
    const style =
      row.op === "insert" ? "insert" : row.op === "delete" ? "delete" : "update";

    const cells: Span[] = [];
    row.cells.forEach((cell, cellIndex) => {
      if (cellIndex > 0) cells.push(span("  "));
      cells.push(...cellSpans(cell, context, glyphs.arrow));
    });

    return [
      span(indent),
      span(glyph, style),
      span(" "),
      ...pad(keys[index] ?? [], keyWidth),
      span("  "),
      ...cells,
    ];
  });
}

function keySpans(
  row: RowChange,
  primaryKey: readonly string[] | null,
  context: CellContext,
): Span[] {
  if (primaryKey === null || primaryKey.length !== row.key.length || row.key.length === 0) {
    return [span("(no key)", "muted")];
  }

  if (primaryKey.length === 1) {
    const name = primaryKey[0] as string;
    return [span(name, "muted"), span("="), valueSpan(row.key[0], name, context)];
  }

  const spans: Span[] = [span("(")];
  primaryKey.forEach((name, index) => {
    if (index > 0) spans.push(span(", "));
    spans.push(span(name, "muted"), span("="), valueSpan(row.key[index], name, context));
  });
  spans.push(span(")"));
  return spans;
}

function footer(artifact: Artifact, glyphs: Glyphs): Line[] {
  const { redactions } = artifact.meta;
  if (redactions.length === 0) return [];

  const described = redactions
    .map((r) => `${ref(r.table)}.${r.column} (${r.mode})`)
    .join(", ");
  return [
    [],
    [
      span(`${NUMBER.format(redactions.length)} ${plural(redactions.length, "column")} redacted`, "muted"),
      span(`: ${described}`, "muted"),
    ],
  ];
}

function totals(artifact: Artifact) {
  return artifact.tables.reduce(
    (acc, table) => ({
      inserted: acc.inserted + table.counts.inserted,
      updated: acc.updated + table.counts.updated,
      deleted: acc.deleted + table.counts.deleted,
    }),
    { inserted: 0, updated: 0, deleted: 0 },
  );
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

function justify(left: Line, right: Line, width: number): Line {
  if (right.length === 0) return left;
  const gap = width - lineWidth(left) - lineWidth(right);
  return [...left, span(gap > 1 ? " ".repeat(gap) : "  "), ...right];
}

function padText(text: string, width: number): string {
  return text.padEnd(width);
}

function maxWidth(values: readonly string[]): number {
  return Math.max(0, ...values.map((v) => v.length));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
