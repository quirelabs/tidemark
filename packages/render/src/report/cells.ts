import type { CellChange, CellValue, DiffColumn } from "@quirelabs/tidemark-core";
import { renderValue } from "../value/render.ts";
import type { GlyphMode, RenderedValue } from "../value/types.ts";
import { span, type Span, type StyleName } from "../style/style.ts";

const VALUE_STYLES: Readonly<Record<string, StyleName>> = {
  null: "value_null",
  number: "value_number",
  boolean: "value_boolean",
  date: "value_date",
  json: "value_json",
  bytes: "value_bytes",
};

// Cell values arrive as JSON scalars, so a timestamp is indistinguishable from
// a string by shape alone. The column type is what tells them apart.
const DATE_TYPES = /^(timestamp|date|time)/i;
const NUMBER_TYPES = /^(numeric|decimal|money|bigint|integer|smallint|real|double)/i;

export interface CellContext {
  columns: readonly DiffColumn[];
  glyphs: GlyphMode;
  maxWidth: number;
}

const REDACTION_LABELS = {
  mask: "[masked]",
  hash: "[hashed]",
  truncate: "[truncated]",
} as const;

/**
 * Every backend renders values through here, so the terminal and markdown can
 * never disagree about what a value looks like or whether it is hostile.
 */
export function renderCellValue(
  value: CellValue | undefined,
  column: string,
  context: CellContext,
): RenderedValue {
  const dataType = context.columns.find((c) => c.name === column)?.dataType;
  return renderValue(value ?? null, {
    maxWidth: context.maxWidth,
    glyphs: context.glyphs,
    numericColumn: dataType !== undefined && NUMBER_TYPES.test(dataType),
  });
}

export function valueSpan(
  value: CellValue | undefined,
  column: string,
  context: CellContext,
  forceStyle?: StyleName,
): Span {
  const dataType = context.columns.find((c) => c.name === column)?.dataType;
  const rendered = renderCellValue(value, column, context);

  // A value carrying deceptive characters is the point of the whole exercise,
  // so it never inherits the quiet styling of its type.
  if (rendered.hazards.length > 0) return span(rendered.text, "hazard");
  if (forceStyle !== undefined) return span(rendered.text, forceStyle);

  if (dataType !== undefined && rendered.kind === "string") {
    if (DATE_TYPES.test(dataType)) return span(rendered.text, "value_date");
    if (NUMBER_TYPES.test(dataType)) return span(rendered.text, "value_number");
  }

  const style = VALUE_STYLES[rendered.kind];
  return style === undefined ? span(rendered.text) : span(rendered.text, style);
}

/** True when any value in the cell would render with hazards revealed. */
export function cellIsDeceptive(cell: CellChange, context: CellContext): boolean {
  for (const value of [cell.before, cell.after]) {
    if (value === undefined) continue;
    const rendered = renderValue(value, { glyphs: context.glyphs });
    if (rendered.hazards.length > 0) return true;
  }
  return false;
}

export function cellSpans(
  cell: CellChange,
  context: CellContext,
  arrow: string,
): Span[] {
  // A masked value is gone, so there is nothing to render but the fact of it.
  // Hash and truncate leave something readable, which still renders as a value
  // so a reviewer can see whether it changed, only styled as withheld.
  if (cell.redacted === "mask") {
    return [
      span(cell.column),
      span("="),
      span(REDACTION_LABELS.mask, "redacted"),
    ];
  }
  const style: StyleName | undefined =
    cell.redacted === undefined ? undefined : "redacted";

  const hasBefore = cell.before !== undefined;
  const hasAfter = cell.after !== undefined;

  if (hasBefore && hasAfter) {
    return [
      span(cell.column),
      span(" "),
      valueSpan(cell.before, cell.column, context, style),
      span(` ${arrow} `),
      valueSpan(cell.after, cell.column, context, style),
    ];
  }

  const value = hasAfter ? cell.after : cell.before;
  return [
    span(cell.column),
    span("="),
    valueSpan(value, cell.column, context, style),
  ];
}
