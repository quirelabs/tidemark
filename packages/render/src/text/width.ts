/**
 * Terminal column width. Node's util.getStringWidth is internal, so we carry a
 * compact table instead of a dependency.
 *
 * Known limitation: emoji ZWJ sequences (family, flags, skin tone) are measured
 * per component, so a single glyph can over-measure. Terminals disagree about
 * those anyway. Everything else is accurate enough for column layout.
 */

type Range = readonly [number, number];

// Combining marks and format characters that occupy no column of their own.
const ZERO_WIDTH: readonly Range[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];

// East Asian Wide and Fullwidth, plus the emoji blocks terminals render double.
const WIDE: readonly Range[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function inRanges(codePoint: number, ranges: readonly Range[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (!range) break;
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

/** Columns a single code point occupies. Control characters count as zero. */
export function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (inRanges(codePoint, ZERO_WIDTH)) return 0;
  if (inRanges(codePoint, WIDE)) return 2;
  return 1;
}

/** Columns a string occupies. Assumes display-safe text, see makeDisplaySafe. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Cuts to a column budget without splitting a surrogate pair, appending the
 * ellipsis inside the budget rather than past it.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string,
): { text: string; truncated: boolean } {
  if (maxWidth <= 0) return { text: "", truncated: text.length > 0 };
  if (stringWidth(text) <= maxWidth) return { text, truncated: false };

  const budget = maxWidth - stringWidth(ellipsis);
  if (budget <= 0) return { text: ellipsis, truncated: true };

  let width = 0;
  let out = "";
  for (const character of text) {
    const next = codePointWidth(character.codePointAt(0) ?? 0);
    if (width + next > budget) break;
    out += character;
    width += next;
  }
  return { text: out + ellipsis, truncated: true };
}
