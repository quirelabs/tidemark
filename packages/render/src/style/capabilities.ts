import type { GlyphMode } from "../value/types.ts";

/**
 * What the destination can actually display. Detected once and threaded
 * through, never read from the environment mid render, so the same capabilities
 * produce byte-identical output and tests can pin it.
 */
export interface Capabilities {
  color: boolean;
  glyphs: GlyphMode;
  /** Columns available for layout. */
  width: number;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  columns?: number | undefined;
}

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 40;
const MAX_WIDTH = 160;

export function detectCapabilities(options: DetectOptions = {}): Capabilities {
  const env = options.env ?? process.env;
  const isTty = options.isTty ?? process.stdout.isTTY === true;
  const columns = options.columns ?? process.stdout.columns;

  return {
    color: detectColor(env, isTty),
    glyphs: detectGlyphs(env),
    // Clamped: very wide terminals produce unreadable sprawl, very narrow ones
    // produce unusable columns. CI logs report no width at all.
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, columns ?? DEFAULT_WIDTH)),
  };
}

function detectColor(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  // https://no-color.org, any value counts.
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["TERM"] === "dumb") return false;

  const force = env["FORCE_COLOR"];
  if (force !== undefined) return force !== "0" && force !== "false";

  return isTty;
}

function detectGlyphs(env: NodeJS.ProcessEnv): GlyphMode {
  const locale =
    env["LC_ALL"] ?? env["LC_CTYPE"] ?? env["LANG"] ?? env["LANGUAGE"] ?? "";
  if (/utf-?8/i.test(locale)) return "unicode";
  // Windows Terminal and CI runners are UTF-8 without advertising a locale.
  if (env["WT_SESSION"] !== undefined || env["CI"] !== undefined) {
    return "unicode";
  }
  return locale === "" ? "unicode" : "ascii";
}

/** Non-interactive, no color, fixed width. The baseline every test renders at. */
export function plainCapabilities(width = DEFAULT_WIDTH): Capabilities {
  return { color: false, glyphs: "unicode", width };
}
