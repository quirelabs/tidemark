#!/usr/bin/env node
import { parseArgs, styleText } from "node:util";
import { TIDEMARK_VERSION } from "@quirelabs/tidemark-core";
import { detectCapabilities } from "@quirelabs/tidemark-render";
import {
  branch,
  diff,
  EXIT_ERROR,
  EXIT_OK,
  report,
  snapshot,
  type CommandContext,
} from "./commands.ts";
import { STATE_DIR } from "./state.ts";

const USAGE = `
${styleText("bold", "tidemark")} ${styleText("dim", TIDEMARK_VERSION)}

  ${styleText("dim", "Capture what actually happened to a Postgres database and review it.")}

${styleText("bold", "Commands")}
  snapshot              Record the baseline and start capturing
  diff                  Stop capturing, build the artifact, browse it
  report                Re-render an artifact that already exists
  branch <name> <from>  Create a scratch database from a template

${styleText("bold", "Options")}
  -c, --connection <url>   Postgres connection string, or DATABASE_URL
      --config <path>      Config file, defaults to the nearest tidemark.config.ts
      --format <fmt>       terminal, json or md, default terminal
      --detail <level>     auto, summary or full, default auto
      --fail-on <level>    none, warnings or danger, default none
      --plain              Stream the report instead of opening the browser
      --keep-snapshot      Leave the shadow schema and capture state in place
      --state-dir <path>   Where capture state lives, default ${STATE_DIR}
      --artifact <path>    Artifact to read, for report
  -h, --help               Show this help
  -v, --version            Show the version

${styleText("bold", "Exit codes")}
  0 fine   1 tidemark failed   2 --fail-on threshold met
`;

const FORMATS = ["terminal", "json", "md"] as const;
const DETAILS = ["auto", "summary", "full"] as const;
const FAIL_ON = ["none", "warnings", "danger"] as const;

function oneOf<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  flag: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`--${flag} must be one of ${allowed.join(", ")}, got "${value}"`);
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      connection: { type: "string", short: "c" },
      config: { type: "string" },
      format: { type: "string" },
      detail: { type: "string" },
      "fail-on": { type: "string" },
      "keep-snapshot": { type: "boolean" },
      plain: { type: "boolean" },
      "state-dir": { type: "string" },
      artifact: { type: "string" },
    },
  });

  if (values.version === true) {
    process.stdout.write(`${TIDEMARK_VERSION}\n`);
    return EXIT_OK;
  }

  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return values.help === true ? EXIT_OK : EXIT_ERROR;
  }

  const context: CommandContext = {
    cwd: process.cwd(),
    stateDir: values["state-dir"] ?? STATE_DIR,
    capabilities: detectCapabilities(),
    out: (text) => process.stdout.write(`${text}\n`),
    // Progress goes to stderr so `tidemark diff --format json > out.json` works.
    err: (text) => process.stderr.write(`${styleText("dim", text)}\n`),
    connection: values.connection,
    configPath: values.config,
    format: oneOf(values.format, FORMATS, "format"),
    detail: oneOf(values.detail, DETAILS, "detail"),
    failOn: oneOf(values["fail-on"], FAIL_ON, "fail-on"),
    keepSnapshot: values["keep-snapshot"],
    plain: values.plain,
    artifactPath: values.artifact,
  };

  switch (command) {
    case "snapshot":
      return await snapshot(context);
    case "diff":
      return await diff(context);
    case "report":
      return await report(context);
    case "branch": {
      const name = positionals[1];
      const template = positionals[2];
      if (name === undefined || template === undefined) {
        throw new Error("branch needs a name and a template: tidemark branch <name> <from>");
      }
      return await branch(context, name, template);
    }
    default:
      throw new Error(`unknown command "${command}", run tidemark --help`);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${styleText("red", "tidemark:")} ${message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

await main();
