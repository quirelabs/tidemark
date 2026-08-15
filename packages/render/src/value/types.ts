/**
 * Tidemark renders values that an AI agent may have written moments earlier, to
 * a terminal and to a public pull request comment. Those bytes are untrusted
 * input, not text. A value that can move the cursor, hide a line, reverse a
 * string or render as another string can forge the very review the tool exists
 * to provide.
 *
 * Everything here exists so that no value can change the meaning of anything
 * around it, and so that two values that differ always look different.
 */

export type HazardType =
  /** ESC, the entry point for cursor movement, screen clears and hidden text. */
  | "ansi_escape"
  /** Other C0/C1 controls, including NUL, BEL and DEL. */
  | "control_char"
  /** CR or LF, which can forge extra rows or warning lines. */
  | "line_break"
  /** Bidi overrides and isolates, the Trojan Source class. */
  | "bidi_control"
  /** Zero width characters, which make distinct values look identical. */
  | "zero_width"
  /** Private use area, where a patched font can draw anything at all. */
  | "private_use"
  /** Lone surrogate, which is not valid text and breaks naive consumers. */
  | "unpaired_surrogate";

export interface Hazard {
  type: HazardType;
  /** How many code points of this class were found. */
  count: number;
}

export type ValueKind =
  | "null"
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "bytes";

export interface RenderedValue {
  /** Display safe, always single line, quoted when quoting removes ambiguity. */
  text: string;
  /** Terminal columns that text occupies. */
  width: number;
  kind: ValueKind;
  /** Empty when the raw value was ordinary. Non-empty is worth surfacing. */
  hazards: Hazard[];
  /** True when text was cut to fit maxWidth. */
  truncated: boolean;
}

export type GlyphMode = "unicode" | "ascii";

export interface ValueRenderOptions {
  /** Column budget. Defaults to no limit. */
  maxWidth?: number;
  /**
   * "unicode" reveals controls with the Control Pictures block, which reads
   * better in a terminal. "ascii" uses escapes like \n, for fonts and pipes
   * that cannot be trusted with U+24xx.
   */
  glyphs?: GlyphMode;
}
