/**
 * A structural snapshot of the tracked part of a database. Taken at capture
 * start and again at capture stop. Schema diffing is always snapshot based
 * because logical decoding never carries DDL.
 *
 * Every list is ordered deterministically so a diff of two snapshots reflects
 * real change, not catalog ordering.
 */

export interface SchemaSnapshot {
  /** ISO 8601, when the snapshot was taken. */
  capturedAt: string;
  /** Schemas that were scanned, so a diff knows what was in scope. */
  scannedSchemas: string[];
  tables: TableSchema[];
}

export interface TableSchema {
  /**
   * pg_class.oid, as text because an oid can exceed a signed 32 bit int. This
   * is the table's identity across snapshots: a table dropped and recreated
   * under the same name gets a new oid, so its rows are never diffed against
   * the table it replaced.
   */
  oid: string;
  schema: string;
  name: string;
  /** True for partitioned parents, which have no storage of their own. */
  partitioned: boolean;
  columns: ColumnSchema[];
  /** Column names in key order, or null when the table has no primary key. */
  primaryKey: string[] | null;
  constraints: ConstraintSchema[];
  indexes: IndexSchema[];
  /**
   * REPLICA IDENTITY, which decides whether UPDATE and DELETE carry old row
   * values on the wire. The replication backend needs 'full' to report
   * before-values on non-key columns.
   */
  replicaIdentity: ReplicaIdentity;
}

export type ReplicaIdentity = "default" | "nothing" | "full" | "index";

export interface ColumnSchema {
  name: string;
  /** Postgres attnum. Gaps are normal after DROP COLUMN. */
  position: number;
  /** Fully formatted, for example "character varying(255)" or "numeric(10,2)". */
  dataType: string;
  nullable: boolean;
  /** Rendered default expression, or null. */
  default: string | null;
  identity: boolean;
  generated: boolean;
}

export type ConstraintType =
  | "primary_key"
  | "foreign_key"
  | "unique"
  | "check"
  | "exclusion"
  | "not_null"
  | "unknown";

export interface ConstraintSchema {
  name: string;
  type: ConstraintType;
  /** Canonical text from pg_get_constraintdef, the thing we render in a diff. */
  definition: string;
  /** Constrained columns in key order. Empty for expression-only constraints. */
  columns: string[];
}

export interface IndexSchema {
  name: string;
  /** Canonical text from pg_get_indexdef. */
  definition: string;
  unique: boolean;
  primary: boolean;
}

export interface SnapshotOptions {
  /** Defaults to ["public"]. System schemas are always excluded. */
  schemas?: string[];
}
