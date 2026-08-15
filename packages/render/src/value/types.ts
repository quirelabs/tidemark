import type { GlyphMode, Hazard } from "@quirelabs/tidemark-core";

/**
 * Hazard detection lives in core, because whether a value contains a bidi
 * override is a fact about the data rather than about its presentation. These
 * re-exports keep render's public surface intact for consumers.
 */
export type {
  GlyphMode,
  Hazard,
  HazardType,
  SafeText,
} from "@quirelabs/tidemark-core";

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

export interface ValueRenderOptions {
  /** Column budget. Defaults to no limit. */
  maxWidth?: number;
  glyphs?: GlyphMode;
  /**
   * Set when the column's Postgres type is numeric. bigint and numeric travel
   * as strings to keep their precision, so without this they would be quoted as
   * strings that merely look like numbers.
   */
  numericColumn?: boolean;
}
