import type { ColumnDefinition } from "@quirelabs/tidemark-core";

/**
 * An altered column rendered as its full definition on both sides forces the
 * reader to diff two long strings by eye to find the one thing that moved. Only
 * the attributes that actually changed are shown.
 */
export interface ColumnChangeText {
  before: string;
  after: string;
}

export function describeColumnChange(
  before: ColumnDefinition,
  after: ColumnDefinition,
): ColumnChangeText {
  const left: string[] = [];
  const right: string[] = [];

  if (before.dataType !== after.dataType) {
    left.push(before.dataType);
    right.push(after.dataType);
  }

  if (before.nullable !== after.nullable) {
    left.push(before.nullable ? "NULL" : "NOT NULL");
    right.push(after.nullable ? "NULL" : "NOT NULL");
  }

  if (before.default !== after.default) {
    left.push(before.default === null ? "no default" : `default ${before.default}`);
    right.push(after.default === null ? "no default" : `default ${after.default}`);
  }

  // Identity or generated flipped without any of the above. Fall back to the
  // full definition rather than rendering an empty change.
  if (left.length === 0) {
    return { before: describeColumn(before), after: describeColumn(after) };
  }

  return { before: left.join(" "), after: right.join(" ") };
}

export function describeColumn(column: ColumnDefinition): string {
  let text = column.dataType;
  if (!column.nullable) text += " not null";
  if (column.default !== null) text += ` default ${column.default}`;
  return text;
}
