import type {
  SnapshotCaptureHandle,
  SnapshotCaptureResult,
} from "../capture/snapshot-backend.ts";
import type { TidemarkConfig } from "../config/types.ts";
import type { ServerInfo } from "../db.ts";
import { classifyWarnings } from "../diff/warnings.ts";
import { diffSchemas } from "../diff/schema-diff.ts";
import { redactArtifact } from "../redaction/redact.ts";
import { TIDEMARK_VERSION } from "../version.ts";
import { ARTIFACT_SCHEMA_VERSION, type Artifact } from "./schema.ts";

export interface BuildArtifactInput {
  handle: SnapshotCaptureHandle;
  capture: SnapshotCaptureResult;
  server: ServerInfo;
  config?: TidemarkConfig;
}

/**
 * The one place the pipeline is assembled: schema diff, then warnings, then
 * redaction. Order matters. Warnings are classified against real values so a
 * credential column change is still detected, and redaction runs last so no
 * secret survives into the returned artifact.
 */
export function buildArtifact(input: BuildArtifactInput): Artifact {
  const { handle, capture, server, config = {} } = input;

  const schema = diffSchemas(capture.schemaBefore, capture.schemaAfter);
  const warnings = classifyWarnings(schema, capture.tables, {
    ...(config.sensitivePatterns === undefined
      ? {}
      : { sensitivePatterns: config.sensitivePatterns }),
  });

  const artifact: Artifact = {
    meta: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      tidemarkVersion: TIDEMARK_VERSION,
      backend: "snapshot",
      capturedFrom: handle.startedAt,
      capturedTo: capture.stoppedAt,
      database: server.database,
      postgresVersion: server.version,
      rowThreshold: handle.rowThreshold,
      redactions: [],
    },
    schema,
    tables: capture.tables,
    warnings,
  };

  return redactArtifact(artifact, config);
}
