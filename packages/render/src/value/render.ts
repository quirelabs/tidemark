import { stringWidth, truncateToWidth } from "../text/width.ts";
import { makeDisplaySafe } from "./safe-text.ts";
import type {
  GlyphMode,
  RenderedValue,
  ValueKind,
  ValueRenderOptions,
} from "./types.ts";

const NUMERIC_LOOKING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SENTINEL_LOOKING = /^(null|true|false)$/i;

/**
 * Renders one database value for review.
 *
 * Two rules drive everything. A value must never be able to change how the rest
 * of the output reads, and two values that differ must never render the same.
 * The second is why empty strings, padded strings and strings that spell NULL
 * get quotes: without them a reviewer cannot tell them apart from each other or
 * from a real SQL NULL.
 */
export function renderValue(
  value: unknown,
  options: ValueRenderOptions = {},
): RenderedValue {
  const glyphs: GlyphMode = options.glyphs ?? "unicode";
  const maxWidth = options.maxWidth ?? Number.POSITIVE_INFINITY;
  const ellipsis = glyphs === "ascii" ? "..." : "…";

  const { kind, raw, quotable } = classify(value);
  const safe = makeDisplaySafe(raw, glyphs);

  const quoted =
    quotable &&
    (raw.length === 0 ||
      raw !== raw.trim() ||
      SENTINEL_LOOKING.test(raw) ||
      NUMERIC_LOOKING.test(raw) ||
      safe.hazards.length > 0);

  const budget = quoted ? maxWidth - 2 : maxWidth;
  const cut = truncateToWidth(safe.text, budget, ellipsis);
  const text = quoted ? `'${cut.text}'` : cut.text;

  return {
    text,
    width: stringWidth(text),
    kind,
    hazards: safe.hazards,
    truncated: cut.truncated,
  };
}

interface Classified {
  kind: ValueKind;
  raw: string;
  /** Only string-like values are ambiguous enough to earn quotes. */
  quotable: boolean;
}

function classify(value: unknown): Classified {
  if (value === null || value === undefined) {
    return { kind: "null", raw: "NULL", quotable: false };
  }
  if (typeof value === "string") {
    return { kind: "string", raw: value, quotable: true };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", raw: value ? "true" : "false", quotable: false };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return { kind: "number", raw: String(value), quotable: false };
  }
  if (value instanceof Date) {
    const raw = Number.isNaN(value.getTime())
      ? "Invalid Date"
      : value.toISOString();
    return { kind: "date", raw, quotable: false };
  }
  if (value instanceof Uint8Array) {
    return { kind: "bytes", raw: toHex(value), quotable: false };
  }
  return { kind: "json", raw: toJson(value), quotable: false };
}

function toHex(bytes: Uint8Array): string {
  let out = "\\x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or otherwise unserializable. Say so rather than throw mid render.
    return "[unserializable]";
  }
}
