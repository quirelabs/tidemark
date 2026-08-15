import { EXIT_ERROR, main } from "./main.ts";

/**
 * The bundle's entry point, kept separate from main.ts because that module is
 * also imported directly by tests and by the demo, where running on import
 * would be wrong.
 *
 * This file exists so the bundle actually does something when the runner
 * executes it. Without it the action loads, defines everything and exits zero,
 * which looks exactly like success.
 */
try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // GitHub renders ::error:: as an annotation on the job.
  process.stderr.write(`::error::tidemark: ${message}\n`);
  process.exitCode = EXIT_ERROR;
}
