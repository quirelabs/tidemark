import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSupported,
  buildArtifact,
  captureOptionsFrom,
  connect,
  dropShadowSchema,
  loadConfig,
  startSnapshotCapture,
  stopSnapshotCapture,
  type Artifact,
} from "@quirelabs/tidemark-core";
import { COMMENT_MARKER, renderMarkdown } from "@quirelabs/tidemark-render";
import { httpClient, upsertStickyComment } from "./github.ts";
import {
  pullRequestContext,
  readInputs,
  type ActionInputs,
  type FailOn,
} from "./inputs.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_THRESHOLD = 2;

/**
 * The capture runs in this process rather than shelling out to the CLI. A
 * consumer's workflow checks this repository out but never installs it, so
 * anything spawned from source would have no dependencies to resolve. Everything
 * here is bundled into the single committed dist file instead.
 *
 * The only thing spawned is the user's own command.
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<number> {
  const inputs = readInputs(env);
  const cwd = inputs.workingDirectory;
  const { config } = await loadConfig(inputs.config ?? undefined, cwd);

  const sql = connect(inputs.connection);
  try {
    const server = await assertSupported(sql);

    log("tidemark: capturing baseline");
    const handle = await startSnapshotCapture(sql, captureOptionsFrom(config));

    if (inputs.run !== null) {
      log("tidemark: running your command");
      const code = await runUserCommand(inputs.run, cwd, {
        ...env,
        DATABASE_URL: inputs.connection,
        // Colour would only become escape codes in a log file.
        NO_COLOR: "1",
      });
      if (code !== 0) {
        log(`tidemark: your command exited ${code}, capturing the diff anyway`);
      }
    }

    log("tidemark: building diff");
    const capture = await stopSnapshotCapture(sql, handle);
    const artifact = buildArtifact({ handle, capture, server, config });
    await dropShadowSchema(sql, handle.shadowSchema);

    const runUrl = workflowRunUrl(env);
    const markdown = renderMarkdown(artifact, runUrl === null ? {} : { runUrl });

    const artifactPath = await writeArtifactFile(cwd, artifact);
    await writeStepSummary(env, markdown);
    await maybeComment(inputs, env, markdown, log);
    await writeOutputs(env, artifact, artifactPath);

    return exitFor(artifact, inputs.failOn);
  } finally {
    await sql.end();
  }
}

/**
 * The user's command runs through a shell because it is a script, exactly like a
 * `run:` step. It comes from the workflow file, which is trusted code in the
 * repository. Nothing from the event payload is ever placed in it, and the docs
 * say so, because that is where workflow injection normally happens.
 */
async function runUserCommand(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? EXIT_ERROR));
  });
}

function workflowRunUrl(env: NodeJS.ProcessEnv): string | null {
  const server = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  const runId = env["GITHUB_RUN_ID"];
  if (server === undefined || repository === undefined || runId === undefined) {
    return null;
  }
  return `${server}/${repository}/actions/runs/${runId}`;
}

async function writeArtifactFile(
  cwd: string,
  artifact: Artifact,
): Promise<string> {
  const dir = join(cwd, ".tidemark");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "artifact.json");
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

async function writeStepSummary(
  env: NodeJS.ProcessEnv,
  markdown: string,
): Promise<void> {
  const path = env["GITHUB_STEP_SUMMARY"];
  if (path === undefined) return;
  await appendFile(path, `${markdown}\n`, "utf8");
}

async function writeOutputs(
  env: NodeJS.ProcessEnv,
  artifact: Artifact,
  artifactPath: string,
): Promise<void> {
  const path = env["GITHUB_OUTPUT"];
  if (path === undefined) return;

  const dangers = artifact.warnings.filter((w) => w.severity === "danger").length;
  const lines = [
    `warnings=${artifact.warnings.length}`,
    `dangers=${dangers}`,
    `tables=${artifact.tables.length}`,
    `artifact-path=${artifactPath}`,
  ];
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function maybeComment(
  inputs: ActionInputs,
  env: NodeJS.ProcessEnv,
  markdown: string,
  log: (message: string) => void,
): Promise<void> {
  if (!inputs.comment) return;

  if (inputs.token === null) {
    log("tidemark: no github-token, skipping the pull request comment");
    return;
  }

  const payload = await readEventPayload(env);
  const target = pullRequestContext(env, payload);
  if (target === null) {
    log("tidemark: not a pull request, skipping the comment");
    return;
  }

  const client = httpClient(inputs.token, env["GITHUB_API_URL"] ?? undefined);
  const outcome = await upsertStickyComment(
    client,
    target,
    COMMENT_MARKER,
    markdown,
  );
  log(`tidemark: ${outcome} the pull request comment`);
}

async function readEventPayload(env: NodeJS.ProcessEnv): Promise<unknown> {
  const path = env["GITHUB_EVENT_PATH"];
  if (path === undefined) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function exitFor(artifact: Artifact, failOn: FailOn): number {
  if (failOn === "none") return EXIT_OK;
  const relevant =
    failOn === "danger"
      ? artifact.warnings.filter((w) => w.severity === "danger")
      : artifact.warnings;
  return relevant.length > 0 ? EXIT_THRESHOLD : EXIT_OK;
}
