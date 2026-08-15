#!/usr/bin/env node
import { parseArgs, styleText } from "node:util";

const USAGE = `
${styleText("bold", "tidemark")} ${styleText("dim", "0.0.1")}

  ${styleText("dim", "Capture database mutations and render them as a reviewable state diff.")}

${styleText("bold", "Commands")}
  snapshot     Record a baseline and start capture
  diff         Stop capture, build the artifact, render to the terminal
  report       Render an existing artifact  ${styleText("dim", "--format json|md|html")}
  branch       Create a scratch database from a template

${styleText("bold", "Flags")}
  -h, --help       Show this help
  -v, --version    Show the version
`;

// Commands land in phase 3. Phase 0 only proves the binary resolves and runs.
const COMMANDS = new Set(["snapshot", "diff", "report", "branch"]);

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values["version"]) {
    console.log("0.0.1");
    return 0;
  }

  const command = positionals[0];
  if (values["help"] || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values["help"] ? 1 : 0;
  }

  if (!COMMANDS.has(command)) {
    console.error(`tidemark: unknown command "${command}"`);
    console.error(`Run ${styleText("bold", "tidemark --help")} for usage.`);
    return 1;
  }

  console.error(`tidemark: "${command}" is not implemented yet (phase 3).`);
  return 1;
}

process.exitCode = run(process.argv.slice(2));
