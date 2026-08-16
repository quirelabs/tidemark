import type { GlyphMode } from "@quirelabs/tidemark-core";

/**
 * "14,203 rows changed" means nothing until you know the table holds 14,203
 * rows. Proportion is the signal this product exists to convey, so it gets a
 * visual channel of its own rather than being left in prose.
 *
 * Block elements give eighth-of-a-cell resolution, so a bar reads accurately at
 * terminal widths where a whole cell would round a small slice away to nothing.
 */
const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const FULL = "█";

export function bar(
  value: number,
  total: number,
  width: number,
  glyphs: GlyphMode = "unicode",
): string {
  if (width <= 0 || total <= 0 || value <= 0) return "";

  const fraction = Math.min(1, value / total);

  if (glyphs === "ascii") {
    // No partial cells available, so round up rather than erase a real slice.
    return "#".repeat(Math.max(1, Math.round(fraction * width)));
  }

  const eighths = Math.round(fraction * width * 8);
  const full = Math.floor(eighths / 8);
  const remainder = eighths % 8;

  const drawn = FULL.repeat(full) + (PARTIALS[remainder] ?? "");
  // A non-zero value must never render as nothing. 212 out of 14,203 is still
  // 212 rows, and a blank cell would say it never happened.
  return drawn === "" ? PARTIALS[1] : drawn;
}

/** Percentages a reviewer can act on: never 0% for a real change, never 100% for a near miss. */
export function percent(value: number, total: number): string {
  if (total <= 0) return "";
  if (value <= 0) return "0%";
  if (value >= total) return "100%";

  // Rounding is what makes these two cases dangerous: 99.99% must not read as
  // "everything", and 0.001% must not read as "nothing".
  const rounded = Math.round((value / total) * 100);
  if (rounded >= 100) return ">99%";
  if (rounded < 1) return "<1%";
  return `${rounded}%`;
}

/** A titled horizontal rule. Cheaper on a CI log than a box, and just as clear. */
export function rule(label: string, width: number, glyphs: GlyphMode): string {
  const line = glyphs === "ascii" ? "=" : "━";
  const head = `${line.repeat(2)} ${label} `;
  const remaining = Math.max(3, width - head.length);
  return head + line.repeat(remaining);
}
