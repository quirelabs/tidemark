export { ARTIFACT_SCHEMA_VERSION } from "./artifact/schema.ts";
export type {
  AggregateDiff,
  AlteredColumn,
  AlteredTable,
  AppliedRedaction,
  Artifact,
  ArtifactMeta,
  CaptureBackend,
  CellChange,
  CellValue,
  ColumnChangeStat,
  ColumnDefinition,
  DiffColumn,
  NamedDefinition,
  RedactionMode,
  RowChange,
  RowCounts,
  RowLevelDiff,
  RowOp,
  SchemaDiff,
  TableDataDiff,
  TableRef,
  ValueTransition,
  Warning,
  WarningCode,
  WarningSeverity,
} from "./artifact/schema.ts";

export {
  DEFAULT_ROW_THRESHOLD,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_SHADOW_SCHEMA,
  dropShadowSchema,
  startSnapshotCapture,
  stopSnapshotCapture,
} from "./capture/snapshot-backend.ts";
export type {
  SnapshotCaptureHandle,
  SnapshotCaptureOptions,
  SnapshotCaptureResult,
} from "./capture/snapshot-backend.ts";

export { captureSchemaSnapshot } from "./schema/snapshot.ts";
export type {
  ColumnSchema,
  ConstraintSchema,
  ConstraintType,
  IndexSchema,
  ReplicaIdentity,
  SchemaSnapshot,
  SnapshotOptions,
  TableSchema,
} from "./schema/types.ts";

/** Lowest Postgres major Tidemark supports. Postgres only, by design. */
export const MIN_POSTGRES_MAJOR = 15;
