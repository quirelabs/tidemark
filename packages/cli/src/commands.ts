import {
  assertSupported,
  buildArtifact,
  connect,
  dropShadowSchema,
  startSnapshotCapture,
  stopSnapshotCapture,
  type Artifact,
  type TidemarkConfig,
} from "@quirelabs/tidemark-core";
import {
  emit,
  renderMarkdown,
  renderReport,
  type Capabilities,
} from "@quirelabs/tidemark-render";
import { loadConfig, resolveConnection } from "./config.ts";
import {
  clearCaptureState,
  readArtifact,
  readCaptureState,
  StateMismatchError,
  writeArtifact,
  writeCaptureState,
} from "./state.ts";

export interface CommandContext {
  cwd: string;
  stateDir: string;
  capabilities: Capabilities;
  out: (text: string) => void;
  err: (text: string) => void;
  connection?: string | undefined;
  configPath?: string | undefined;
  detail?: "auto" | "summary" | "full" | undefined;
  failOn?: "none" | "warnings" | "danger" | undefined;
  keepSnapshot?: boolean | undefined;
  format?: "terminal" | "json" | "md" | undefined;
  artifactPath?: string | undefined;
}

/** Distinct from 1 so CI can tell "tidemark broke" from "tidemark objected". */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_THRESHOLD = 2;

export async function snapshot(context: CommandContext): Promise<number> {
  const { config } = await loadConfig(context.configPath, context.cwd);
  const sql = connect(resolveConnection(context.connection, config));

  try {
    const server = await assertSupported(sql);
    const handle = await startSnapshotCapture(sql, captureOptions(config));
    const path = await writeCaptureState(context.stateDir, server.database, handle);

    const tables = handle.schemaBefore.tables.length;
    context.err(
      `tidemark: baseline captured, ${tables} ${tables === 1 ? "table" : "tables"} in ${server.database}`,
    );
    context.err(`tidemark: state written to ${path}`);
    return EXIT_OK;
  } finally {
    await sql.end();
  }
}

export async function diff(context: CommandContext): Promise<number> {
  const { config } = await loadConfig(context.configPath, context.cwd);
  const state = await readCaptureState(context.stateDir);
  const sql = connect(resolveConnection(context.connection, config));

  try {
    const server = await assertSupported(sql);
    if (server.database !== state.database) {
      throw new StateMismatchError(state.database, server.database);
    }

    const capture = await stopSnapshotCapture(sql, state.handle);
    const artifact = buildArtifact({
      handle: state.handle,
      capture,
      server,
      config,
    });

    const path = await writeArtifact(context.stateDir, artifact);
    render(artifact, context);
    context.err(`tidemark: artifact written to ${path}`);

    if (context.keepSnapshot !== true) {
      await dropShadowSchema(sql, state.handle.shadowSchema);
      await clearCaptureState(context.stateDir);
    }

    return exitFor(artifact, context.failOn ?? "none");
  } finally {
    await sql.end();
  }
}

export async function report(context: CommandContext): Promise<number> {
  const artifact = await readArtifact(context.stateDir, context.artifactPath);
  render(artifact, context);
  return exitFor(artifact, context.failOn ?? "none");
}

/**
 * Convenience for the local workflow: a scratch database from a template, so a
 * capture never runs against the database you actually care about.
 */
export async function branch(
  context: CommandContext,
  name: string,
  template: string,
): Promise<number> {
  const { config } = await loadConfig(context.configPath, context.cwd);
  const sql = connect(resolveConnection(context.connection, config));

  try {
    await assertSupported(sql);
    // CREATE DATABASE cannot run inside a transaction, and the template must
    // have no other sessions attached.
    await sql.unsafe(
      `create database ${quote(name)} template ${quote(template)}`,
    );
    context.err(`tidemark: created ${name} from template ${template}`);
    return EXIT_OK;
  } finally {
    await sql.end();
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function captureOptions(config: TidemarkConfig) {
  return {
    ...(config.schemas === undefined ? {} : { schemas: config.schemas }),
    ...(config.rowThreshold === undefined
      ? {}
      : { rowThreshold: config.rowThreshold }),
    ...(config.sampleSize === undefined ? {} : { sampleSize: config.sampleSize }),
  };
}

function render(artifact: Artifact, context: CommandContext): void {
  if (context.format === "json") {
    context.out(JSON.stringify(artifact, null, 2));
    return;
  }
  if (context.format === "md") {
    context.out(renderMarkdown(artifact));
    return;
  }
  const options =
    context.detail === undefined ? {} : { detail: context.detail };
  context.out(emit(renderReport(artifact, context.capabilities, options), context.capabilities));
}

function exitFor(
  artifact: Artifact,
  failOn: "none" | "warnings" | "danger",
): number {
  if (failOn === "none") return EXIT_OK;
  const relevant =
    failOn === "danger"
      ? artifact.warnings.filter((w) => w.severity === "danger")
      : artifact.warnings;
  return relevant.length > 0 ? EXIT_THRESHOLD : EXIT_OK;
}
