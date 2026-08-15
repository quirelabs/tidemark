import type { GlyphMode, Hazard, HazardType } from "./types.ts";

/**
 * Turns arbitrary text into text that cannot alter its surroundings, revealing
 * what it removed rather than silently stripping it. Stripping would be worse
 * than useless here: it hides the evidence that something tried to deceive.
 */

const BIDI_NAMES: Readonly<Record<number, string>> = {
  0x200e: "LRM",
  0x200f: "RLM",
  0x202a: "LRE",
  0x202b: "RLE",
  0x202c: "PDF",
  0x202d: "LRO",
  0x202e: "RLO",
  0x2066: "LRI",
  0x2067: "RLI",
  0x2068: "FSI",
  0x2069: "PDI",
};

const ZERO_WIDTH_NAMES: Readonly<Record<number, string>> = {
  0x200b: "ZWSP",
  0x200c: "ZWNJ",
  0x200d: "ZWJ",
  0x2060: "WJ",
  0xfeff: "BOM",
};

const ASCII_ESCAPES: Readonly<Record<number, string>> = {
  0x00: "\\0",
  0x07: "\\a",
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0b: "\\v",
  0x0c: "\\f",
  0x0d: "\\r",
  0x1b: "\\e",
  0x7f: "\\x7f",
};

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function hex(codePoint: number): string {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

export interface SafeText {
  text: string;
  hazards: Hazard[];
}

export function makeDisplaySafe(
  input: string,
  glyphs: GlyphMode = "unicode",
): SafeText {
  const counts = new Map<HazardType, number>();
  const flag = (type: HazardType) =>
    counts.set(type, (counts.get(type) ?? 0) + 1);

  const points = Array.from(input);
  let out = "";

  for (let i = 0; i < points.length; i++) {
    const character = points[i] as string;
    const cp = character.codePointAt(0) ?? 0;

    // ZWJ between two pictographs is a legitimate emoji join, not an attack.
    if (cp === 0x200d && isEmojiJoin(points, i)) {
      out += character;
      continue;
    }

    const bidi = BIDI_NAMES[cp];
    if (bidi !== undefined) {
      flag("bidi_control");
      out += `<${bidi}>`;
      continue;
    }

    const zeroWidth = ZERO_WIDTH_NAMES[cp];
    if (zeroWidth !== undefined) {
      flag("zero_width");
      out += `<${zeroWidth}>`;
      continue;
    }

    if (cp >= 0xd800 && cp <= 0xdfff) {
      flag("unpaired_surrogate");
      out += hex(cp);
      continue;
    }

    if (isPrivateUse(cp)) {
      flag("private_use");
      out += hex(cp);
      continue;
    }

    if (cp === 0x1b) {
      flag("ansi_escape");
      out += glyphs === "ascii" ? "\\e" : "␛";
      continue;
    }

    if (cp === 0x0a || cp === 0x0d) {
      flag("line_break");
      out += glyphs === "ascii" ? ASCII_ESCAPES[cp] : controlPicture(cp);
      continue;
    }

    if (cp < 0x20 || cp === 0x7f) {
      flag("control_char");
      out +=
        glyphs === "ascii"
          ? (ASCII_ESCAPES[cp] ?? `\\x${cp.toString(16).padStart(2, "0")}`)
          : controlPicture(cp);
      continue;
    }

    if (cp >= 0x80 && cp <= 0x9f) {
      flag("control_char");
      out += hex(cp);
      continue;
    }

    out += character;
  }

  return {
    text: out,
    hazards: [...counts].map(([type, count]) => ({ type, count })),
  };
}

/** U+2400 Control Pictures maps C0 one to one, and U+2421 covers DEL. */
function controlPicture(codePoint: number): string {
  if (codePoint === 0x7f) return "␡";
  return String.fromCodePoint(0x2400 + codePoint);
}

function isEmojiJoin(points: readonly string[], index: number): boolean {
  const before = points[index - 1];
  const after = points[index + 1];
  return (
    before !== undefined &&
    after !== undefined &&
    EXTENDED_PICTOGRAPHIC.test(before) &&
    EXTENDED_PICTOGRAPHIC.test(after)
  );
}
