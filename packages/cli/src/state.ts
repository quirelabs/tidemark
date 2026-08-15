import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, SnapshotCaptureHandle } from "@quirelabs/tidemark-core";

/**
 * `tidemark snapshot` and `tidemark diff` are separate processes, so the capture
 * handle has to survive on disk between them. It holds the schema snapshot taken
 * at capture start, which cannot be recovered afterwards.
 */
export const STATE_DIR = ".tidemark";
const CAPTURE_FILE = "capture.json";
const ARTIFACT_FILE = "artifact.json";

const STATE_VERSION = 1;

export interface CaptureState {
  version: typeof STATE_VERSION;
  /** Guards against starting a capture on one database and stopping on another. */
  database: string;
  handle: SnapshotCaptureHandle;
}

export class NoCaptureError extends Error {
  constructor(dir: string) {
    super(
      `No capture in progress. Expected ${join(dir, CAPTURE_FILE)}. Run \`tidemark snapshot\` first.`,
    );
    this.name = "NoCaptureError";
  }
}

export class StateMismatchError extends Error {
  constructor(expected: string, found: string) {
    super(
      `This capture was started against "${expected}" but you are connected to "${found}". Diffing across databases would be meaningless.`,
    );
    this.name = "StateMismatchError";
  }
}

export async function writeCaptureState(
  dir: string,
  database: string,
  handle: SnapshotCaptureHandle,
): Promise<string> {
  const state: CaptureState = { version: STATE_VERSION, database, handle };
  return await writeJson(dir, CAPTURE_FILE, state);
}

export async function readCaptureState(dir: string): Promise<CaptureState> {
  const path = join(dir, CAPTURE_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new NoCaptureError(dir);
  }

  const state = JSON.parse(raw) as CaptureState;
  if (state.version !== STATE_VERSION) {
    throw new Error(
      `Capture state at ${path} is version ${String(state.version)}, this build expects ${STATE_VERSION}. Run \`tidemark snapshot\` again.`,
    );
  }
  return state;
}

export async function clearCaptureState(dir: string): Promise<void> {
  await rm(join(dir, CAPTURE_FILE), { force: true });
}

export async function writeArtifact(
  dir: string,
  artifact: Artifact,
): Promise<string> {
  return await writeJson(dir, ARTIFACT_FILE, artifact);
}

export async function readArtifact(
  dir: string,
  explicit?: string,
): Promise<Artifact> {
  const path = explicit ?? join(dir, ARTIFACT_FILE);
  try {
    return JSON.parse(await readFile(path, "utf8")) as Artifact;
  } catch {
    throw new Error(
      `No artifact at ${path}. Run \`tidemark diff\` first, or pass a path.`,
    );
  }
}

async function writeJson(
  dir: string,
  file: string,
  value: unknown,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}
