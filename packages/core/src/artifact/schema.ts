/**
 * The single source of truth for Tidemark's output. Every renderer and the
 * GitHub Action read this and nothing else from core.
 *
 * Everything here must survive JSON.stringify unchanged, so cell values are
 * already JSON scalars by the time they land: dates are ISO strings, bytea is
 * a \x hex string, numerics stay strings when they exceed a JS number. The
 * column's Postgres type travels alongside so a renderer can still style by
 * type without guessing.
 */

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export type CaptureBackend = "snapshot" | "replication";

export interface Artifact {
  meta: ArtifactMeta;
  schema: SchemaDiff;
  tables: TableDataDiff[];
  /** Ordered most severe first. Renderers put these above everything else. */
  warnings: Warning[];
}

export interface ArtifactMeta {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  tidemarkVersion: string;
  backend: CaptureBackend;
  /** ISO 8601, set at capture start and stop. */
  capturedFrom: string;
  capturedTo: string;
  database: string;
  postgresVersion: string;
  /** Row count above which a table is aggregated rather than listed. */
  rowThreshold: number;
  /** Applied redactions, so the artifact states what it withheld. */
  redactions: AppliedRedaction[];
}

export interface AppliedRedaction {
  table: TableRef;
  column: string;
  mode: RedactionMode;
}

export type RedactionMode = "mask" | "hash" | "truncate";

export interface TableRef {
  schema: string;
  name: string;
}

// Schema diff. Always derived from catalog snapshots, never from the WAL.

export interface SchemaDiff {
  tablesAdded: TableRef[];
  tablesRemoved: TableRef[];
  tablesAltered: AlteredTable[];
}

export interface AlteredTable extends TableRef {
  /** Set when the table kept its identity but changed name. */
  renamedFrom?: TableRef;
  columnsAdded: ColumnDefinition[];
  columnsRemoved: ColumnDefinition[];
  columnsAltered: AlteredColumn[];
  constraintsAdded: NamedDefinition[];
  constraintsRemoved: NamedDefinition[];
  indexesAdded: NamedDefinition[];
  indexesRemoved: NamedDefinition[];
}

export interface ColumnDefinition {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

export interface AlteredColumn {
  name: string;
  before: ColumnDefinition;
  after: ColumnDefinition;
}

export interface NamedDefinition {
  name: string;
  definition: string;
}

// Data diff.

export type CellValue =
  | string
  | number
  | boolean
  | null
  | CellValue[]
  | { [key: string]: CellValue };

export type RowOp = "insert" | "update" | "delete";

/** Detail level is decided at build time against meta.rowThreshold. */
export type TableDataDiff = RowLevelDiff | AggregateDiff;

interface TableDataDiffBase extends TableRef {
  primaryKey: string[] | null;
  /** Column types for the columns that appear in this diff. */
  columns: DiffColumn[];
  counts: RowCounts;
  /**
   * Rows in the table when capture started. Without it a classifier cannot tell
   * "every row was updated" from "some rows were updated", which is the whole
   * difference between an UPDATE with and without a WHERE clause.
   */
  rowsBefore: number;
}

export interface DiffColumn {
  name: string;
  dataType: string;
}

export interface RowCounts {
  inserted: number;
  updated: number;
  deleted: number;
}

export interface RowLevelDiff extends TableDataDiffBase {
  detail: "rows";
  rows: RowChange[];
}

export interface AggregateDiff extends TableDataDiffBase {
  detail: "aggregate";
  /** Never the full set. Capped, and the cap is visible in the render. */
  sample: RowChange[];
  columnStats: ColumnChangeStat[];
  /** Best effort. Absent on the snapshot backend, which cannot attribute SQL. */
  statement?: string;
}

export interface RowChange {
  op: RowOp;
  /** Primary key values in key order. Empty when the table has no key. */
  key: CellValue[];
  /** Changed columns only for updates, the whole row for insert and delete. */
  cells: CellChange[];
}

export interface CellChange {
  column: string;
  /** Absent for an insert. */
  before?: CellValue;
  /** Absent for a delete. */
  after?: CellValue;
  /** Set when a redaction rule replaced the value. */
  redacted?: RedactionMode;
}

export interface ColumnChangeStat {
  column: string;
  changed: number;
  /** Most common transitions, capped. Empty when values are near unique. */
  transitions: ValueTransition[];
  /** Set instead of transitions when the column changed to too many values. */
  distinctAfter?: number;
}

export interface ValueTransition {
  before: CellValue;
  after: CellValue;
  count: number;
}

// Warnings.

export type WarningSeverity = "danger" | "caution";

export type WarningCode =
  | "update_without_where"
  | "delete_without_where"
  | "truncate"
  | "drop_table"
  | "drop_column"
  | "type_narrowed"
  | "not_null_added_to_populated"
  | "orphaned_references"
  | "sensitive_column_changed"
  /** A value carried characters that can forge or hide surrounding output. */
  | "deceptive_value";

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  /** One line, already human readable. Renderers may add context around it. */
  message: string;
  table?: TableRef;
  columns?: string[];
  rowsAffected?: number;
}
