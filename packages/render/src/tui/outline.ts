import type {
  AlteredTable,
  Artifact,
  RowChange,
  TableDataDiff,
  TableRef,
  Warning,
} from "@quirelabs/tidemark-core";
import { span, type Line, type Span, type StyleName } from "../style/style.ts";
import { bar, percent } from "../text/bar.ts";
import { stringWidth } from "../text/width.ts";
import { cellSpans, valueSpan, type CellContext } from "../report/cells.ts";
import { describeColumn, describeColumnChange } from "../report/columns.ts";
import type { Glyphs } from "../report/glyphs.ts";
import { collapseUniformColumns, collapsedNote } from "../report/sample.ts";

const NUMBER = new Intl.NumberFormat("en-US");

export type NodeKind = "section" | "finding" | "schema" | "data";

export interface OutlineNode {
  id: string;
  kind: NodeKind;
  /** Rendered without indent; the list adds it. */
  label: Line;
  children: OutlineNode[];
  expanded: boolean;
  /** Right pane contents. Built once, since an artifact never changes. */
  detail: Line[];
  /** Drives filtering and the accent colour of the row. */
  severity: "danger" | "caution" | "none";
  /** Lowercased haystack for search. */
  search: string;
}

export interface OutlineOptions {
  glyphs: Glyphs;
  /** Width available to the detail pane, for wrapping and value budgets. */
  detailWidth: number;
  ascii: boolean;
}

function text(line: Line): string {
  return line.map((s) => s.text).join("");
}

function node(
  partial: Omit<OutlineNode, "children" | "expanded" | "search"> &
    Partial<Pick<OutlineNode, "children" | "expanded">>,
): OutlineNode {
  const children = partial.children ?? [];
  return {
    ...partial,
    children,
    expanded: partial.expanded ?? false,
    search: [
      text(partial.label),
      ...partial.detail.map(text),
      ...children.map((c) => c.search),
    ]
      .join(" ")
      .toLowerCase(),
  };
}

function ref(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) return [value];
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(" ")) {
    if (current === "") current = word;
    else if (stringWidth(current) + 1 + stringWidth(word) <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function shareStyle(fraction: number): StyleName {
  if (fraction >= 1) return "danger";
  if (fraction >= 0.5) return "caution";
  return "muted";
}

export function buildOutline(
  artifact: Artifact,
  options: OutlineOptions,
): OutlineNode[] {
  const sections: OutlineNode[] = [];

  const dangers = artifact.warnings.filter((w) => w.severity === "danger");
  const cautions = artifact.warnings.filter((w) => w.severity === "caution");

  if (dangers.length > 0) {
    sections.push(
      section("danger", "DANGER", dangers.length, "danger", dangers.map((w, i) =>
        findingNode(w, artifact, options, `danger-${i}`),
      )),
    );
  }
  if (cautions.length > 0) {
    sections.push(
      section("caution", "CAUTION", cautions.length, "caution", cautions.map((w, i) =>
        findingNode(w, artifact, options, `caution-${i}`),
      )),
    );
  }

  const schemaNodes = schemaChildren(artifact, options);
  if (schemaNodes.length > 0) {
    sections.push(section("schema", "SCHEMA", schemaNodes.length, "none", schemaNodes));
  }

  if (artifact.tables.length > 0) {
    sections.push(
      section(
        "data",
        "DATA",
        artifact.tables.length,
        "none",
        artifact.tables.map((t, i) => dataNode(t, options, `data-${i}`)),
      ),
    );
  }

  return sections;
}

function section(
  id: string,
  title: string,
  count: number,
  severity: OutlineNode["severity"],
  children: OutlineNode[],
): OutlineNode {
  const style: StyleName =
    severity === "danger" ? "danger" : severity === "caution" ? "caution" : "heading";
  return node({
    id,
    kind: "section",
    severity,
    expanded: true,
    label: [span(title, style), span(`  ${NUMBER.format(count)}`, "muted")],
    detail: [[span(`${title}, ${NUMBER.format(count)} entries`, "muted")]],
    children,
  });
}

function findingNode(
  warning: Warning,
  artifact: Artifact,
  options: OutlineOptions,
  id: string,
): OutlineNode {
  const style: StyleName = warning.severity === "danger" ? "danger" : "caution";
  const table = artifact.tables.find(
    (t) => warning.table !== undefined && t.schema === warning.table.schema && t.name === warning.table.name,
  );

  const detail: Line[] = [];
  for (const segment of wrap(warning.message, options.detailWidth)) {
    detail.push([span(segment, style)]);
  }
  detail.push([]);

  if (warning.rowsAffected !== undefined && table !== undefined && table.rowsBefore > 0) {
    const fraction = warning.rowsAffected / table.rowsBefore;
    const width = Math.max(8, Math.min(40, options.detailWidth - 24));
    detail.push([
      span(bar(warning.rowsAffected, table.rowsBefore, width, options.ascii ? "ascii" : "unicode"), shareStyle(fraction)),
    ]);
    detail.push([
      span(
        `${NUMBER.format(warning.rowsAffected)} of ${NUMBER.format(table.rowsBefore)} rows`,
        "muted",
      ),
      span("  "),
      span(percent(warning.rowsAffected, table.rowsBefore), shareStyle(fraction)),
    ]);
    detail.push([]);
  }

  detail.push([span("code", "muted"), span(`     ${warning.code}`)]);
  if (warning.table !== undefined) {
    detail.push([span("table", "muted"), span(`    ${ref(warning.table)}`)]);
  }
  if (warning.columns !== undefined && warning.columns.length > 0) {
    detail.push([span("columns", "muted"), span(`  ${warning.columns.join(", ")}`)]);
  }

  const label: Line = [span(warning.message, style)];
  if (warning.rowsAffected !== undefined) {
    label.push(span(`  ${NUMBER.format(warning.rowsAffected)} rows`, "muted"));
  }

  return node({ id, kind: "finding", severity: warning.severity, label, detail });
}

function schemaChildren(artifact: Artifact, options: OutlineOptions): OutlineNode[] {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  const nodes: OutlineNode[] = [];

  tablesAdded.forEach((table, index) => {
    nodes.push(
      node({
        id: `schema-add-${index}`,
        kind: "schema",
        severity: "none",
        label: [span("+ ", "insert"), span(ref(table))],
        detail: [[span(`CREATE TABLE ${ref(table)}`, "insert")]],
      }),
    );
  });

  tablesRemoved.forEach((table, index) => {
    nodes.push(
      node({
        id: `schema-drop-${index}`,
        kind: "schema",
        severity: "danger",
        label: [span("− ", "delete"), span(ref(table))],
        detail: [[span(`DROP TABLE ${ref(table)}`, "delete")]],
      }),
    );
  });

  tablesAltered.forEach((table, index) => {
    nodes.push(
      node({
        id: `schema-alter-${index}`,
        kind: "schema",
        severity: "none",
        label: [span("~ ", "update"), span(ref(table))],
        detail: alteredDetail(table, options),
      }),
    );
  });

  return nodes;
}

function alteredDetail(table: AlteredTable, options: OutlineOptions): Line[] {
  const lines: Line[] = [[span(`ALTER TABLE ${ref(table)}`, "update")], []];

  if (table.renamedFrom !== undefined) {
    lines.push([span("renamed from ", "muted"), span(ref(table.renamedFrom))]);
  }
  for (const column of table.columnsAdded) {
    lines.push([
      span("+ ", "insert"),
      span(column.name),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsRemoved) {
    lines.push([
      span("− ", "delete"),
      span(column.name),
      span("  "),
      span(describeColumn(column), "muted"),
    ]);
  }
  for (const column of table.columnsAltered) {
    const change = describeColumnChange(column.before, column.after);
    lines.push([
      span("~ ", "update"),
      span(column.name),
      span("  "),
      span(change.before, "muted"),
      span(` ${options.glyphs.arrow} `),
      span(change.after, "muted"),
    ]);
  }
  for (const constraint of table.constraintsAdded) {
    lines.push([span("+ ", "insert"), span(constraint.name), span("  "), span(constraint.definition, "muted")]);
  }
  for (const constraint of table.constraintsRemoved) {
    lines.push([span("− ", "delete"), span(constraint.name), span("  "), span(constraint.definition, "muted")]);
  }
  for (const index of table.indexesAdded) {
    lines.push([span("+ ", "insert"), span(index.name), span("  "), span(index.definition, "muted")]);
  }
  for (const index of table.indexesRemoved) {
    lines.push([span("− ", "delete"), span(index.name), span("  "), span(index.definition, "muted")]);
  }
  return lines;
}

function dataNode(
  table: TableDataDiff,
  options: OutlineOptions,
  id: string,
): OutlineNode {
  const glyphs = options.glyphs;
  const touched = table.counts.updated + table.counts.deleted;
  const fraction = table.rowsBefore > 0 ? touched / table.rowsBefore : 0;

  const label: Line = [span(ref(table), "key")];
  const counts: Span[] = [];
  if (table.counts.inserted > 0) counts.push(span(`${glyphs.insert}${NUMBER.format(table.counts.inserted)}`, "insert"));
  if (table.counts.updated > 0) counts.push(span(`${glyphs.update}${NUMBER.format(table.counts.updated)}`, "update"));
  if (table.counts.deleted > 0) counts.push(span(`${glyphs.delete}${NUMBER.format(table.counts.deleted)}`, "delete"));
  for (const [index, part] of counts.entries()) {
    label.push(span(index === 0 ? "  " : " "), part);
  }
  if (table.rowsBefore > 0 && touched > 0) {
    label.push(span("  "), span(percent(touched, table.rowsBefore), shareStyle(fraction)));
  }

  return node({
    id,
    kind: "data",
    severity: fraction >= 1 ? "danger" : "none",
    label,
    detail: dataDetail(table, options),
  });
}

function dataDetail(table: TableDataDiff, options: OutlineOptions): Line[] {
  const glyphs = options.glyphs;
  const mode = options.ascii ? "ascii" : "unicode";
  const context: CellContext = {
    columns: table.columns,
    glyphs: mode,
    maxWidth: Math.max(16, Math.floor(options.detailWidth / 2)),
  };

  const lines: Line[] = [];
  const touched = table.counts.updated + table.counts.deleted;

  if (table.rowsBefore > 0 && touched > 0) {
    const fraction = touched / table.rowsBefore;
    const width = Math.max(8, Math.min(40, options.detailWidth - 24));
    lines.push([span(bar(touched, table.rowsBefore, width, mode), shareStyle(fraction))]);
    lines.push([
      span(`${NUMBER.format(touched)} of ${NUMBER.format(table.rowsBefore)} rows`, "muted"),
      span("  "),
      span(percent(touched, table.rowsBefore), shareStyle(fraction)),
    ]);
    lines.push([]);
  } else if (table.rowsBefore === 0) {
    lines.push([span("new table", "muted")], []);
  }

  if (table.detail === "aggregate") {
    const nameWidth = Math.max(0, ...table.columnStats.map((s) => s.column.length));
    for (const stat of table.columnStats) {
      if (stat.transitions.length === 0) {
        lines.push([
          span(stat.column.padEnd(nameWidth)),
          span("  "),
          span(NUMBER.format(stat.changed).padStart(9), "muted"),
          span("  "),
          span(
            stat.distinctAfter === undefined
              ? "values vary"
              : `${NUMBER.format(stat.distinctAfter)} distinct values`,
            "muted",
          ),
        ]);
        continue;
      }
      stat.transitions.forEach((transition, index) => {
        const drawn = bar(transition.count, stat.changed, 16, mode);
        lines.push([
          span(index === 0 ? stat.column.padEnd(nameWidth) : " ".repeat(nameWidth)),
          span("  "),
          span(NUMBER.format(transition.count).padStart(9), "muted"),
          span("  "),
          span(drawn, "update"),
          span(" ".repeat(Math.max(1, 16 - stringWidth(drawn) + 2))),
          valueSpan(transition.before, stat.column, context),
          span(` ${glyphs.arrow} `),
          valueSpan(transition.after, stat.column, context),
        ]);
      });
    }
    lines.push([]);
  }

  const rows = table.detail === "rows" ? table.rows : table.sample;
  if (rows.length > 0) {
    const total = table.counts.inserted + table.counts.updated + table.counts.deleted;
    const collapsedResult =
      table.detail === "aggregate" ? collapseUniformColumns(rows) : { rows: [...rows], collapsed: [] };

    lines.push([
      span(
        table.detail === "aggregate"
          ? `sample, ${NUMBER.format(rows.length)} of ${NUMBER.format(total)} rows`
          : `${NUMBER.format(rows.length)} ${rows.length === 1 ? "row" : "rows"}`,
        "muted",
      ),
    ]);
    lines.push(...rowLines(collapsedResult.rows, table, context, glyphs));
    if (collapsedResult.collapsed.length > 0) {
      lines.push([span(collapsedNote(collapsedResult.collapsed, rows.length), "muted")]);
    }
  }

  return lines;
}

function rowLines(
  rows: readonly RowChange[],
  table: TableDataDiff,
  context: CellContext,
  glyphs: Glyphs,
): Line[] {
  return rows.map((row) => {
    const glyph =
      row.op === "insert" ? glyphs.insert : row.op === "delete" ? glyphs.delete : glyphs.update;
    const style: StyleName =
      row.op === "insert" ? "insert" : row.op === "delete" ? "delete" : "update";

    const cells: Span[] = [];
    row.cells.forEach((cell, index) => {
      if (index > 0) cells.push(span("  "));
      cells.push(...cellSpans(cell, context, glyphs.arrow));
    });

    const key: Span[] = [];
    const primaryKey = table.primaryKey;
    if (primaryKey !== null && primaryKey.length === row.key.length) {
      primaryKey.forEach((name, index) => {
        if (index > 0) key.push(span(", "));
        key.push(span(name, "muted"), span("="), valueSpan(row.key[index], name, context));
      });
    } else {
      key.push(span("(no key)", "muted"));
    }

    return [span(glyph, style), span(" "), ...key, span("  "), ...cells];
  });
}

/** Depth-first list of what is currently visible, for the list pane. */
export interface VisibleRow {
  node: OutlineNode;
  depth: number;
}

export function visibleRows(nodes: readonly OutlineNode[], depth = 0): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const item of nodes) {
    rows.push({ node: item, depth });
    if (item.expanded && item.children.length > 0) {
      rows.push(...visibleRows(item.children, depth + 1));
    }
  }
  return rows;
}
