import type { RedactionMode } from "../artifact/schema.ts";

/**
 * Loaded from `tidemark.config.ts`. Node strips types natively, so the config is
 * imported directly with no loader dependency, which is what buys typed
 * autocomplete on redaction rules: the part users most need help getting right.
 */
export interface TidemarkConfig {
  /** Postgres connection string. Falls back to DATABASE_URL. */
  connection?: string;
  /** Schemas to capture. Defaults to ["public"]. */
  schemas?: string[];
  /** Rows changed above which a table is aggregated instead of listed. */
  rowThreshold?: number;
  /** Rows kept in an aggregated table's sample. */
  sampleSize?: number;
  /** Explicit redaction. Wins over everything, including allow. */
  redact?: RedactionRule[];
  /** Columns to show despite matching the built in credential patterns. */
  allow?: ColumnMatcher[];
  /** Replaces the built in credential patterns rather than extending them. */
  sensitivePatterns?: RegExp[];
}

export interface ColumnMatcher {
  /** "schema.table", bare "table" for any schema, or omitted for all tables. */
  table?: string;
  /** Column name. A trailing or leading `*` globs. */
  column: string;
}

export interface RedactionRule extends ColumnMatcher {
  /** Defaults to "mask". */
  mode?: RedactionMode;
}

/** Identity helper that gives config files their types without an import cost. */
export function defineConfig(config: TidemarkConfig): TidemarkConfig {
  return config;
}
