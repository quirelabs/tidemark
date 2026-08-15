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

export { diffSchemas } from "./diff/schema-diff.ts";
export { classifyWarnings } from "./diff/warnings.ts";
export type { ClassifyOptions } from "./diff/warnings.ts";

export {
  DEFAULT_SENSITIVE_PATTERNS,
  NOTABLE_PII_PATTERNS,
  globMatches,
  isNotablePii,
  isSensitiveColumn,
} from "./redaction/patterns.ts";
export { redactArtifact, redactionFor } from "./redaction/redact.ts";

export { defineConfig } from "./config/types.ts";
export {
  captureOptionsFrom,
  ConfigError,
  loadConfig,
  MissingConnectionError,
  resolveConnection,
} from "./config/load.ts";
export type { LoadedConfig } from "./config/load.ts";
export type {
  ColumnMatcher,
  RedactionRule,
  TidemarkConfig,
} from "./config/types.ts";

export { makeDisplaySafe, scanHazards } from "./text/safe-text.ts";
export type {
  GlyphMode,
  Hazard,
  HazardType,
  SafeText,
} from "./text/safe-text.ts";

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

export { MIN_POSTGRES_MAJOR, TIDEMARK_VERSION } from "./version.ts";

export {
  assertSupported,
  connect,
  serverInfo,
  UnsupportedPostgresError,
} from "./db.ts";
export type { ServerInfo, Sql } from "./db.ts";

export { buildArtifact } from "./artifact/build.ts";
export type { BuildArtifactInput } from "./artifact/build.ts";
