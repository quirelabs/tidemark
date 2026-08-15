/**
 * GitHub passes inputs as INPUT_<NAME> environment variables, so reading them
 * needs no library. Keeping this pure also makes it testable without a runner.
 */

export type FailOn = "none" | "warnings" | "danger";

export interface ActionInputs {
  connection: string;
  /** Shell script run between snapshot and diff. Empty means capture nothing. */
  run: string | null;
  config: string | null;
  failOn: FailOn;
  comment: boolean;
  workingDirectory: string;
  token: string | null;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function input(env: NodeJS.ProcessEnv, name: string): string | null {
  // Spaces become underscores, hyphens do not. Matching the runner exactly
  // matters: get this wrong and every hyphenated input reads as absent.
  const key = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = input(env, name);
  if (value === null) return fallback;
  if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  throw new InputError(`Input "${name}" must be true or false, got "${value}"`);
}

const FAIL_ON: readonly FailOn[] = ["none", "warnings", "danger"];

export function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const connection = input(env, "connection") ?? env["DATABASE_URL"] ?? null;
  if (connection === null) {
    throw new InputError(
      'Input "connection" is required, or set DATABASE_URL in the job environment.',
    );
  }

  const failOnRaw = input(env, "fail-on") ?? "none";
  if (!FAIL_ON.includes(failOnRaw as FailOn)) {
    throw new InputError(
      `Input "fail-on" must be one of ${FAIL_ON.join(", ")}, got "${failOnRaw}"`,
    );
  }

  return {
    connection,
    run: input(env, "run"),
    config: input(env, "config"),
    failOn: failOnRaw as FailOn,
    comment: boolean(env, "comment", true),
    workingDirectory: input(env, "working-directory") ?? process.cwd(),
    token: input(env, "github-token") ?? env["GITHUB_TOKEN"] ?? null,
  };
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  issueNumber: number;
}

/**
 * Only the numbers and names we need, read from the event payload rather than
 * interpolated into a command. Nothing from the payload is ever passed to a
 * shell, which is where workflow injection normally happens.
 */
export function pullRequestContext(
  env: NodeJS.ProcessEnv,
  payload: unknown,
): PullRequestContext | null {
  const repository = env["GITHUB_REPOSITORY"];
  if (repository === undefined) return null;

  const [owner, repo] = repository.split("/");
  if (owner === undefined || repo === undefined) return null;

  const event = payload as
    | { pull_request?: { number?: unknown }; number?: unknown }
    | null;
  const raw = event?.pull_request?.number ?? event?.number;
  const issueNumber = typeof raw === "number" ? raw : Number(raw);

  return Number.isInteger(issueNumber) && issueNumber > 0
    ? { owner, repo, issueNumber }
    : null;
}
