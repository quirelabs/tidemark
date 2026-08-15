import { execFileSync } from "node:child_process";

/**
 * Container tests skip loudly rather than silently when Docker is missing, so a
 * green local run never hides the fact that capture correctness went untested.
 */
export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn(
      "\n[tidemark] SKIPPING container tests: Docker is not reachable.\n" +
        "[tidemark] Capture and diff correctness were NOT verified by this run.\n",
    );
    return false;
  }
}
