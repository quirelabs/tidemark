import { createHash } from "node:crypto";
import type {
  AppliedRedaction,
  Artifact,
  CellChange,
  CellValue,
  ColumnChangeStat,
  RedactionMode,
  RowChange,
  TableDataDiff,
  TableRef,
} from "../artifact/schema.ts";
import type { ColumnMatcher, TidemarkConfig } from "../config/types.ts";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  globMatches,
  isSensitiveColumn,
} from "./patterns.ts";

/**
 * Redaction runs before anything is serialized, so a masked value never reaches
 * the JSON artifact, let alone a terminal or a pull request comment. Redacting
 * at render time would leave the secret sitting in the artifact that gets
 * uploaded as a CI artifact.
 *
 * Primary key values are redacted too when a key column matches. It costs the
 * ability to identify the row, which is the correct trade: a rule that could be
 * bypassed by putting the secret in the key is not a rule.
 */

/** How much of a value a "truncate" rule keeps. Deliberately not much. */
const TRUNCATE_KEEP = 4;

export function redactArtifact(
  artifact: Artifact,
  config: TidemarkConfig = {},
): Artifact {
  const applied = new Map<string, AppliedRedaction>();

  const tables = artifact.tables.map((table) =>
    redactTable(table, config, applied),
  );

  return {
    ...artifact,
    meta: {
      ...artifact.meta,
      redactions: [...applied.values()].sort((a, b) =>
        key(a.table, a.column).localeCompare(key(b.table, b.column)),
      ),
    },
    tables,
  };
}

function key(table: TableRef, column: string): string {
  return `${table.schema}.${table.name}.${column}`;
}

/**
 * Explicit rules beat allow rules, which beat the built in credential patterns.
 * Someone who writes a rule means it.
 */
export function redactionFor(
  table: TableRef,
  column: string,
  config: TidemarkConfig,
): RedactionMode | null {
  const explicit = (config.redact ?? []).filter((rule) =>
    matcherApplies(rule, table, column),
  );
  const last = explicit.at(-1);
  if (last !== undefined) return last.mode ?? "mask";

  if ((config.allow ?? []).some((rule) => matcherApplies(rule, table, column))) {
    return null;
  }

  const patterns = config.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  return isSensitiveColumn(column, patterns) ? "mask" : null;
}

function matcherApplies(
  matcher: ColumnMatcher,
  table: TableRef,
  column: string,
): boolean {
  if (!globMatches(matcher.column, column)) return false;
  if (matcher.table === undefined) return true;

  const qualified = `${table.schema}.${table.name}`;
  return (
    globMatches(matcher.table, qualified) || globMatches(matcher.table, table.name)
  );
}

function redactTable(
  table: TableDataDiff,
  config: TidemarkConfig,
  applied: Map<string, AppliedRedaction>,
): TableDataDiff {
  const ref: TableRef = { schema: table.schema, name: table.name };

  const modes = new Map<string, RedactionMode>();
  for (const column of table.columns) {
    const mode = redactionFor(ref, column.name, config);
    if (mode === null) continue;
    modes.set(column.name, mode);
    applied.set(key(ref, column.name), { table: ref, column: column.name, mode });
  }
  if (modes.size === 0) return table;

  const keyColumns = table.primaryKey ?? [];
  const redactRow = (row: RowChange): RowChange => ({
    ...row,
    key: row.key.map((value, index) => {
      const name = keyColumns[index];
      const mode = name === undefined ? undefined : modes.get(name);
      return mode === undefined ? value : applyMode(value, mode);
    }),
    cells: row.cells.map((cell): CellChange => {
      const mode = modes.get(cell.column);
      if (mode === undefined) return cell;
      return {
        column: cell.column,
        ...(cell.before === undefined ? {} : { before: applyMode(cell.before, mode) }),
        ...(cell.after === undefined ? {} : { after: applyMode(cell.after, mode) }),
        redacted: mode,
      };
    }),
  });

  if (table.detail === "rows") {
    return { ...table, rows: table.rows.map(redactRow) };
  }

  return {
    ...table,
    sample: table.sample.map(redactRow),
    columnStats: table.columnStats.map((stat): ColumnChangeStat => {
      const mode = modes.get(stat.column);
      if (mode === undefined) return stat;
      return {
        ...stat,
        // Transition counts survive, so a reviewer still sees that a credential
        // column changed and on how many rows, without seeing either value.
        transitions: stat.transitions.map((transition) => ({
          before: applyMode(transition.before, mode),
          after: applyMode(transition.after, mode),
          count: transition.count,
        })),
      };
    }),
  };
}

function applyMode(value: CellValue, mode: RedactionMode): CellValue {
  if (mode === "mask") return null;

  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (mode === "hash") {
    // Stable, so a reviewer can still tell "changed" from "unchanged".
    return `#${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  }
  return text.length <= TRUNCATE_KEEP ? text : `${text.slice(0, TRUNCATE_KEEP)}…`;
}
