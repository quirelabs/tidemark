import type {
  AggregateDiff,
  AlteredTable,
  Artifact,
  ColumnChangeStat,
  NamedDefinition,
  RowChange,
  TableDataDiff,
  TableRef,
  Warning,
  WarningSeverity,
} from "@quirelabs/tidemark-core";
import { isNotablePii } from "@quirelabs/tidemark-core";
import type { Capabilities } from "../style/capabilities.ts";
import {
  lineWidth,
  pad,
  span,
  type Line,
  type Span,
  type StyleName,
} from "../style/style.ts";
import { bar, percent, rule } from "../text/bar.ts";
import { stringWidth } from "../text/width.ts";
import { cellSpans, valueSpan, type CellContext } from "./cells.ts";
import { describeColumn, describeColumnChange } from "./columns.ts";
import { glyphsFor, type Glyphs } from "./glyphs.ts";
import { collapseUniformColumns, collapsedNote } from "./sample.ts";

const NUMBER = new Intl.NumberFormat("en-US");
const DEFAULT_HEIGHT = 40;
/** Never collapse below this, otherwise "auto" hides everything on a small term. */
const MIN_DATA_LINES = 10;
/** Cells given to a proportion bar. Wide enough that a 1% slice still shows. */
const SHARE_BAR = 22;
const STAT_BAR = 18;

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
  lines.push(header(artifact, glyphs));
  lines.push([]);
  lines.push(...summary(artifact, glyphs, width));
  lines.push(...findings(artifact, "danger", glyphs, capabilities));
  lines.push(...findings(artifact, "caution", glyphs, capabilities));
  lines.push(...schemaSection(artifact, glyphs, capabilities));

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

function header(artifact: Artifact, glyphs: Glyphs): Line {
  const { meta } = artifact;
  const sep = span(` ${glyphs.separator} `, "muted");
  return [
    span("tidemark", "heading"),
    span("  "),
    span(meta.database),
    sep,
    span(`${meta.backend} backend`, "muted"),
    sep,
    span(meta.capturedTo, "muted"),
  ];
}

function summary(artifact: Artifact, glyphs: Glyphs, width: number): Line[] {
  const counts = totals(artifact);
  const parts: Span[][] = [];

  if (artifact.tables.length > 0) {
    const n = artifact.tables.length;
    parts.push([span(`${NUMBER.format(n)} ${plural(n, "table")}`)]);
  }

  const ops: Span[] = [];
  if (counts.inserted > 0) {
    ops.push(span(`${glyphs.insert}${NUMBER.format(counts.inserted)}`, "insert"));
  }
  if (counts.updated > 0) {
    if (ops.length > 0) ops.push(span(" "));
    ops.push(span(`${glyphs.update}${NUMBER.format(counts.updated)}`, "update"));
  }
  if (counts.deleted > 0) {
    if (ops.length > 0) ops.push(span(" "));
    ops.push(span(`${glyphs.delete}${NUMBER.format(counts.deleted)}`, "delete"));
  }
  if (ops.length > 0) parts.push(ops);

  const schemaChanges = countSchemaChanges(artifact);
  if (schemaChanges > 0) {
    parts.push([span(`${NUMBER.format(schemaChanges)} schema`)]);
  }

  const dangers = artifact.warnings.filter((w) => w.severity === "danger").length;
  const cautions = artifact.warnings.length - dangers;
  const findingSpans: Span[] = [];
  if (dangers > 0) {
    findingSpans.push(span(`${glyphs.warn} ${NUMBER.format(dangers)} danger`, "danger"));
  }
  if (cautions > 0) {
    if (findingSpans.length > 0) findingSpans.push(span(" "));
    findingSpans.push(span(`${NUMBER.format(cautions)} caution`, "caution"));
  }
  if (findingSpans.length > 0) parts.push(findingSpans);

  if (parts.length === 0) return [[span("  "), span("no changes", "muted")]];
  return wrapParts(parts, ` ${glyphs.separator} `, width);
}

/** The summary is the one line always read, so it wraps rather than overflowing. */
function wrapParts(parts: Span[][], separator: string, width: number): Line[] {
  const lines: Line[] = [];
  let current: Line = [span("  ")];
  let used = 2;

  for (const part of parts) {
    const partWidth = part.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const needsSeparator = current.length > 1;

    if (needsSeparator && used + partWidth + separator.length > width) {
      lines.push(current);
      current = [span("  "), ...part];
      used = 2 + partWidth;
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

function findings(
  artifact: Artifact,
  severity: WarningSeverity,
  glyphs: Glyphs,
  capabilities: Capabilities,
): Line[] {
  const list = artifact.warnings.filter((w) => w.severity === severity);
  if (list.length === 0) return [];

  const width = capabilities.width;
  const style: StyleName = severity === "danger" ? "danger" : "caution";
  const lines: Line[] = [
    [],
    [span(rule(severity.toUpperCase(), width, capabilities.glyphs), style)],
  ];

  for (const warning of list) {
    const right: Line =
      warning.rowsAffected === undefined
        ? []
        : [span(`${NUMBER.format(warning.rowsAffected)} rows`, "muted")];

    // A finding never truncates. Losing the tail of a danger message is not an
    // acceptable trade for a tidy column.
    const available = width - 2 - lineWidth(right) - (right.length > 0 ? 2 : 0);
    const segments = wrapText(warning.message, available);

    segments.forEach((segment, index) => {
      const body: Line = [span("  "), span(segment, style)];
      lines.push(index === 0 ? justify(body, right, width) : body);
    });

    const radius = blastRadius(warning, artifact, capabilities);
    if (radius.length > 0) {
      // Set apart, so the bar clearly belongs to the finding above it rather
      // than floating between two of them.
      lines.push(...radius, []);
    }
  }
  return lines;
}

/**
 * The share of the table a finding touched, drawn under the finding itself.
 * Every row of a table changing is categorically different from a hundred rows
 * changing, and that difference should be visible before it is read.
 */
function blastRadius(
  warning: Warning,
  artifact: Artifact,
  capabilities: Capabilities,
): Line[] {
  if (warning.table === undefined || warning.rowsAffected === undefined) return [];

  const table = artifact.tables.find(
    (t) => t.schema === warning.table?.schema && t.name === warning.table.name,
  );
  if (table === undefined || table.rowsBefore <= 0) return [];

  const affected = warning.rowsAffected;
  const drawn = bar(affected, table.rowsBefore, SHARE_BAR, capabilities.glyphs);
  if (drawn === "") return [];

  return [
    [
      span("  "),
      span(drawn, shareStyle(affected / table.rowsBefore)),
      span(" ".repeat(Math.max(1, SHARE_BAR - stringWidth(drawn) + 2))),
      span(
        `${NUMBER.format(affected)} of ${NUMBER.format(table.rowsBefore)} rows`,
        "muted",
      ),
      span("  "),
      span(percent(affected, table.rowsBefore), shareStyle(affected / table.rowsBefore)),
    ],
  ];
}

function shareStyle(fraction: number): StyleName {
  if (fraction >= 1) return "danger";
  if (fraction >= 0.5) return "caution";
  return "muted";
}

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

function schemaSection(
  artifact: Artifact,
  glyphs: Glyphs,
  capabilities: Capabilities,
): Line[] {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  if (
    tablesAdded.length === 0 &&
    tablesRemoved.length === 0 &&
    tablesAltered.length === 0
  ) {
    return [];
  }

  const lines: Line[] = [
    [],
    [span(rule("SCHEMA", capabilities.width, capabilities.glyphs), "muted")],
  ];

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

  const names = [
    ...table.columnsAdded.map((c) => c.name),
    ...table.columnsRemoved.map((c) => c.name),
    ...table.columnsAltered.map((c) => c.name),
  ];
  const nameWidth = maxWidth(names);

  for (const column of table.columnsAdded) {
    lines.push([
      indent,
      span(glyphs.insert, "insert"),
      span(" "),
      span(column.name.padEnd(nameWidth)),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsRemoved) {
    lines.push([
      indent,
      span(glyphs.delete, "delete"),
      span(" "),
      span(column.name.padEnd(nameWidth)),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsAltered) {
    const change = describeColumnChange(column.before, column.after);
    lines.push([
      indent,
      span(glyphs.update, "update"),
      span(" "),
      span(column.name.padEnd(nameWidth)),
      span("  "),
      span(change.before, "muted"),
      span(` ${glyphs.arrow} `),
      span(change.after, "muted"),
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
  style: StyleName,
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

function dataSection(
  artifact: Artifact,
  capabilities: Capabilities,
  glyphs: Glyphs,
  detail: "auto" | "summary" | "full",
  budget: number,
): Line[] {
  if (artifact.tables.length === 0) return [];

  const lines: Line[] = [
    [],
    [span(rule("DATA", capabilities.width, capabilities.glyphs), "muted")],
  ];
  let collapsed = 0;

  for (const table of artifact.tables) {
    const head = tableHeading(table, glyphs, capabilities);
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

/**
 * Name on the left, then what happened, then the share of the table it touched.
 * Inserts are deliberately not part of the share: adding rows to a table is not
 * the same kind of event as rewriting the ones already in it.
 */
function tableHeading(
  table: TableDataDiff,
  glyphs: Glyphs,
  capabilities: Capabilities,
): Line {
  const left: Line = [span("  "), span(ref(table), "key")];
  const right: Line = [];

  if (table.counts.inserted > 0) {
    right.push(span(`${glyphs.insert}${NUMBER.format(table.counts.inserted)}`, "insert"));
  }
  if (table.counts.updated > 0) {
    if (right.length > 0) right.push(span(" "));
    right.push(span(`${glyphs.update}${NUMBER.format(table.counts.updated)}`, "update"));
  }
  if (table.counts.deleted > 0) {
    if (right.length > 0) right.push(span(" "));
    right.push(span(`${glyphs.delete}${NUMBER.format(table.counts.deleted)}`, "delete"));
  }

  const touched = table.counts.updated + table.counts.deleted;
  if (table.rowsBefore > 0 && touched > 0) {
    const fraction = touched / table.rowsBefore;
    right.push(span(` of ${NUMBER.format(table.rowsBefore)}`, "muted"));
    right.push(span("  "));
    right.push(span(percent(touched, table.rowsBefore).padStart(4), shareStyle(fraction)));
    right.push(span(" "));
    right.push(
      span(bar(touched, table.rowsBefore, 8, capabilities.glyphs), shareStyle(fraction)),
    );
  } else if (table.rowsBefore === 0) {
    right.push(span("  new table", "muted"));
  }

  return justify(left, right, capabilities.width);
}

function tableBody(
  table: TableDataDiff,
  capabilities: Capabilities,
  glyphs: Glyphs,
): Line[] {
  const context: CellContext = {
    columns: table.columns,
    glyphs: capabilities.glyphs,
    maxWidth: Math.max(12, Math.floor(capabilities.width / 3)),
  };

  if (table.detail === "rows") {
    return rowLines(table.rows, table.primaryKey, context, glyphs);
  }
  return aggregateLines(table, context, glyphs, capabilities);
}

function aggregateLines(
  table: AggregateDiff,
  context: CellContext,
  glyphs: Glyphs,
  capabilities: Capabilities,
): Line[] {
  const lines: Line[] = [];

  if (table.statement !== undefined) {
    lines.push([span("    "), span(table.statement, "muted")]);
  }

  const nameWidth = maxWidth(table.columnStats.map((s) => s.column));
  const countWidth = Math.max(
    ...table.columnStats.flatMap((s) => [
      NUMBER.format(s.changed).length,
      ...s.transitions.map((t) => NUMBER.format(t.count).length),
    ]),
    1,
  );

  for (const stat of table.columnStats) {
    lines.push(...statLines(stat, nameWidth, countWidth, context, glyphs, capabilities));
  }

  if (table.sample.length > 0) {
    const total = table.counts.inserted + table.counts.updated + table.counts.deleted;
    const { rows, collapsed } = collapseUniformColumns(table.sample);

    lines.push([]);
    lines.push([
      span("    "),
      span(
        `sample, ${NUMBER.format(table.sample.length)} of ${NUMBER.format(total)} rows`,
        "muted",
      ),
    ]);
    lines.push(...rowLines(rows, table.primaryKey, context, glyphs, "      "));

    if (collapsed.length > 0) {
      lines.push([
        span("      "),
        span(collapsedNote(collapsed, table.sample.length), "muted"),
      ]);
    }
  }
  return lines;
}

/**
 * One line per transition, each with a bar scaled within the column. This is
 * where the shape of a bulk change becomes visible: 13,991 rows moving one way
 * and 212 moving another is a different event from 14,203 moving together.
 */
function statLines(
  stat: ColumnChangeStat,
  nameWidth: number,
  countWidth: number,
  context: CellContext,
  glyphs: Glyphs,
  capabilities: Capabilities,
): Line[] {
  const blank = " ".repeat(nameWidth);

  if (stat.transitions.length === 0) {
    const description =
      stat.distinctAfter === undefined
        ? "values vary"
        : `${NUMBER.format(stat.distinctAfter)} distinct values`;
    return [
      [
        span("    "),
        span(stat.column.padEnd(nameWidth)),
        span("  "),
        span(NUMBER.format(stat.changed).padStart(countWidth), "muted"),
        span("  "),
        span(bar(1, 1, STAT_BAR, capabilities.glyphs), "muted"),
        span("  "),
        span(description, "muted"),
      ],
    ];
  }

  return stat.transitions.map((transition, index) => {
    const drawn = bar(transition.count, stat.changed, STAT_BAR, capabilities.glyphs);
    return [
      span("    "),
      span(index === 0 ? stat.column.padEnd(nameWidth) : blank),
      span("  "),
      span(NUMBER.format(transition.count).padStart(countWidth), "muted"),
      span("  "),
      span(drawn, "update"),
      span(" ".repeat(Math.max(1, STAT_BAR - stringWidth(drawn) + 2))),
      valueSpan(transition.before, stat.column, context),
      span(` ${glyphs.arrow} `),
      valueSpan(transition.after, stat.column, context),
    ];
  });
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
    const style: StyleName =
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
  if (
    primaryKey === null ||
    primaryKey.length !== row.key.length ||
    row.key.length === 0
  ) {
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

/**
 * Tidemark shows values by default and masks only what looks like a credential,
 * so every report states what it left visible. A one time notice would be read
 * by whoever ran the install; the person who needs it is the reviewer reading
 * this diff weeks later, who never saw that notice.
 */
function footer(artifact: Artifact, glyphs: Glyphs): Line[] {
  if (artifact.tables.length === 0) return [];

  const { redactions } = artifact.meta;
  const redactedKeys = new Set(redactions.map((r) => `${ref(r.table)}.${r.column}`));

  const shown: string[] = [];
  for (const table of artifact.tables) {
    for (const column of table.columns) {
      if (redactedKeys.has(`${ref(table)}.${column.name}`)) continue;
      shown.push(column.name);
    }
  }

  const notable = [...new Set(shown.filter(isNotablePii))].sort();
  const lines: Line[] = [[]];

  const disclosure =
    `values shown in full for ${NUMBER.format(shown.length)} ` +
    `${plural(shown.length, "column")}` +
    (notable.length > 0 ? `, including ${notable.join(", ")}` : "");
  lines.push([span(disclosure, notable.length > 0 ? "caution" : "muted")]);

  if (redactions.length > 0) {
    const described = redactions
      .map((r) => `${ref(r.table)}.${r.column} (${r.mode})`)
      .join(", ");
    lines.push([
      span(
        `${NUMBER.format(redactions.length)} ${plural(redactions.length, "column")} redacted: ${described}`,
        "muted",
      ),
    ]);
  }

  lines.push([
    span(`${glyphs.separator} configure masking in tidemark.config.ts`, "muted"),
  ]);
  return lines;
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

function maxWidth(values: readonly string[]): number {
  return Math.max(0, ...values.map((v) => v.length));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
