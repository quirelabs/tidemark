import type {
  AlteredColumn,
  CellValue,
  RowChange,
  SchemaDiff,
  TableDataDiff,
  TableRef,
  Warning,
} from "../artifact/schema.ts";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  isSensitiveColumn,
} from "../redaction/patterns.ts";
import { scanHazards } from "../text/safe-text.ts";

/**
 * Turns a diff into the handful of lines a reviewer must not miss. Pure: it
 * reads the diff and nothing else, so it can be tested without a database and
 * reused by any backend.
 *
 * The snapshot backend cannot see statements, so "without WHERE" is inferred
 * from every row in the table having changed. That inference is stated plainly
 * in the message rather than dressed up as certainty.
 */

export interface ClassifyOptions {
  sensitivePatterns?: readonly RegExp[];
}

export function classifyWarnings(
  schema: SchemaDiff,
  tables: readonly TableDataDiff[],
  options: ClassifyOptions = {},
): Warning[] {
  const patterns = options.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  const warnings: Warning[] = [];

  for (const table of schema.tablesRemoved) {
    warnings.push({
      code: "drop_table",
      severity: "danger",
      message: `DROP TABLE ${label(table)}`,
      table,
    });
  }

  for (const table of schema.tablesAltered) {
    const ref: TableRef = { schema: table.schema, name: table.name };
    const rowsBefore = rowsBeforeFor(tables, ref);

    for (const column of table.columnsRemoved) {
      warnings.push({
        code: "drop_column",
        severity: "danger",
        message: `DROP COLUMN ${label(ref)}.${column.name}`,
        table: ref,
        columns: [column.name],
      });
    }

    for (const column of table.columnsAltered) {
      if (isNarrowing(column)) {
        warnings.push({
          code: "type_narrowed",
          severity: "caution",
          message: `${label(ref)}.${column.name} narrowed from ${column.before.dataType} to ${column.after.dataType}`,
          table: ref,
          columns: [column.name],
        });
      }

      if (column.before.nullable && !column.after.nullable) {
        // Row count is only known for tables that also changed data. Without it
        // we still warn, but we do not claim the table was populated.
        const populated = rowsBefore !== null && rowsBefore > 0;
        warnings.push({
          code: "not_null_added_to_populated",
          severity: populated ? "danger" : "caution",
          message: populated
            ? `NOT NULL added to ${label(ref)}.${column.name} on a table holding ${rowsBefore} rows`
            : `NOT NULL added to ${label(ref)}.${column.name}`,
          table: ref,
          columns: [column.name],
          ...(populated ? { rowsAffected: rowsBefore } : {}),
        });
      }
    }
  }

  for (const table of tables) {
    const ref: TableRef = { schema: table.schema, name: table.name };
    warnings.push(...wholeTableWarnings(table, ref));

    const changed = changedColumns(table);
    const sensitive = [...changed].filter((c) => isSensitiveColumn(c, patterns));
    if (sensitive.length > 0) {
      warnings.push({
        code: "sensitive_column_changed",
        severity: "danger",
        message: `credential column changed on ${label(ref)}: ${sensitive.sort().join(", ")}`,
        table: ref,
        columns: sensitive.sort(),
      });
    }

    const deceptive = deceptiveColumns(table);
    if (deceptive.length > 0) {
      warnings.push({
        code: "deceptive_value",
        severity: "danger",
        message: `${label(ref)} contains values that can forge or hide output: ${deceptive.join(", ")}`,
        table: ref,
        columns: deceptive,
      });
    }
  }

  // Danger first, then by how much of the database it touched. A finding that
  // rewrote every row outranks one that dropped a column, and both outrank
  // anything merely cautionary.
  return warnings.sort(
    (a, b) => rank(a) - rank(b) || (b.rowsAffected ?? -1) - (a.rowsAffected ?? -1),
  );
}

function rank(warning: Warning): number {
  return warning.severity === "danger" ? 0 : 1;
}

function label(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

function rowsBeforeFor(
  tables: readonly TableDataDiff[],
  ref: TableRef,
): number | null {
  const found = tables.find(
    (t) => t.schema === ref.schema && t.name === ref.name,
  );
  return found === undefined ? null : found.rowsBefore;
}

function wholeTableWarnings(table: TableDataDiff, ref: TableRef): Warning[] {
  const warnings: Warning[] = [];
  const { counts, rowsBefore } = table;

  // One row changing out of one row is not evidence of a missing WHERE clause.
  if (rowsBefore <= 1) return warnings;

  if (counts.updated === rowsBefore) {
    warnings.push({
      code: "update_without_where",
      severity: "danger",
      message: `every row updated on ${label(ref)}, which usually means UPDATE without WHERE`,
      table: ref,
      rowsAffected: counts.updated,
    });
  }

  if (counts.deleted === rowsBefore) {
    warnings.push({
      code: "delete_without_where",
      severity: "danger",
      message: `every row deleted from ${label(ref)}, which usually means DELETE without WHERE or TRUNCATE`,
      table: ref,
      rowsAffected: counts.deleted,
    });
  }

  return warnings;
}

function rowsOf(table: TableDataDiff): readonly RowChange[] {
  return table.detail === "rows" ? table.rows : table.sample;
}

function changedColumns(table: TableDataDiff): Set<string> {
  const columns = new Set<string>();
  for (const row of rowsOf(table)) {
    for (const cell of row.cells) columns.add(cell.column);
  }
  if (table.detail === "aggregate") {
    for (const stat of table.columnStats) columns.add(stat.column);
  }
  return columns;
}

/**
 * Only the rows carried in the diff are scanned. For an aggregated table that is
 * the sample, so absence of a warning is not proof of absence of an attack. The
 * renderer reveals hazards in every value it prints regardless.
 */
function deceptiveColumns(table: TableDataDiff): string[] {
  const columns = new Set<string>();
  for (const row of rowsOf(table)) {
    for (const cell of row.cells) {
      if (isDeceptive(cell.before) || isDeceptive(cell.after)) {
        columns.add(cell.column);
      }
    }
  }
  if (table.detail === "aggregate") {
    for (const stat of table.columnStats) {
      for (const transition of stat.transitions) {
        if (isDeceptive(transition.before) || isDeceptive(transition.after)) {
          columns.add(stat.column);
        }
      }
    }
  }
  return [...columns].sort();
}

function isDeceptive(value: CellValue | undefined): boolean {
  if (typeof value === "string") return scanHazards(value).length > 0;
  // A nested JSON string can carry the same characters.
  if (value !== null && typeof value === "object") {
    return scanHazards(JSON.stringify(value)).length > 0;
  }
  return false;
}

const LENGTH = /\((\d+)(?:,\s*(\d+))?\)\s*$/;
const INT_RANK: Readonly<Record<string, number>> = {
  smallint: 1,
  integer: 2,
  bigint: 3,
};
const FLOAT_RANK: Readonly<Record<string, number>> = {
  real: 1,
  "double precision": 2,
};

function baseType(dataType: string): string {
  return dataType.replace(LENGTH, "").trim().toLowerCase();
}

function sizes(dataType: string): [number, number] | null {
  const match = LENGTH.exec(dataType);
  if (match === null) return null;
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

/** Narrowing is the direction that can silently truncate or reject data. */
function isNarrowing(column: AlteredColumn): boolean {
  const before = column.before.dataType;
  const after = column.after.dataType;
  if (before === after) return false;

  const baseBefore = baseType(before);
  const baseAfter = baseType(after);

  if (baseBefore === baseAfter) {
    const from = sizes(before);
    const to = sizes(after);
    if (from !== null && to !== null) {
      return to[0] < from[0] || to[1] < from[1];
    }
    // Unbounded to bounded, for example varchar to varchar(20).
    return from === null && to !== null;
  }

  if (baseBefore === "text" && sizes(after) !== null) return true;

  const intFrom = INT_RANK[baseBefore];
  const intTo = INT_RANK[baseAfter];
  if (intFrom !== undefined && intTo !== undefined) return intTo < intFrom;

  const floatFrom = FLOAT_RANK[baseBefore];
  const floatTo = FLOAT_RANK[baseAfter];
  if (floatFrom !== undefined && floatTo !== undefined) return floatTo < floatFrom;

  return false;
}
