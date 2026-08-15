import { stringWidth } from "../text/width.ts";
import type { Capabilities } from "./capabilities.ts";

/**
 * Output is built as styled spans and only turned into bytes at the very end.
 * Layout therefore measures real text, never escape sequences, and the same
 * line model can be emitted with color or without.
 */

export type StyleName =
  | "heading"
  | "muted"
  | "key"
  | "insert"
  | "update"
  | "delete"
  | "danger"
  | "caution"
  | "hazard"
  | "redacted"
  | "value_null"
  | "value_number"
  | "value_boolean"
  | "value_date"
  | "value_json"
  | "value_bytes";

export interface Span {
  text: string;
  style?: StyleName;
}

export type Line = Span[];

const SGR: Readonly<Record<StyleName, string>> = {
  heading: "1",
  muted: "2",
  key: "1",
  insert: "32",
  update: "33",
  delete: "31",
  danger: "1;31",
  caution: "33",
  hazard: "1;35",
  redacted: "2;35",
  value_null: "2;3",
  value_number: "36",
  value_boolean: "35",
  value_date: "34",
  value_json: "36",
  value_bytes: "2",
};

export function span(text: string, style?: StyleName): Span {
  return style === undefined ? { text } : { text, style };
}

export function lineWidth(line: Line): number {
  let width = 0;
  for (const s of line) width += stringWidth(s.text);
  return width;
}

export function lineText(line: Line): string {
  let text = "";
  for (const s of line) text += s.text;
  return text;
}

/** Renders to a string, with SGR codes only when the destination supports it. */
export function emit(lines: readonly Line[], capabilities: Capabilities): string {
  return lines.map((line) => emitLine(line, capabilities)).join("\n");
}

function emitLine(line: Line, capabilities: Capabilities): string {
  if (!capabilities.color) return lineText(line).trimEnd();

  let out = "";
  for (const s of line) {
    if (s.text === "") continue;
    const code = s.style === undefined ? undefined : SGR[s.style];
    out += code === undefined ? s.text : `[${code}m${s.text}[0m`;
  }
  return out;
}

/** Pads a line to a column width. Used to right align trailing detail. */
export function pad(line: Line, width: number): Line {
  const gap = width - lineWidth(line);
  return gap > 0 ? [...line, span(" ".repeat(gap))] : line;
}
