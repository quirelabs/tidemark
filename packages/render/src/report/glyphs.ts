import type { GlyphMode } from "../value/types.ts";

export interface Glyphs {
  warn: string;
  insert: string;
  update: string;
  delete: string;
  arrow: string;
  separator: string;
}

const UNICODE: Glyphs = {
  warn: "⚠",
  insert: "+",
  update: "~",
  // U+2212 minus, which lines up with + at the same width unlike hyphen.
  delete: "−",
  arrow: "→",
  separator: "·",
};

const ASCII: Glyphs = {
  warn: "!",
  insert: "+",
  update: "~",
  delete: "-",
  arrow: "->",
  separator: "-",
};

export function glyphsFor(mode: GlyphMode): Glyphs {
  return mode === "ascii" ? ASCII : UNICODE;
}
