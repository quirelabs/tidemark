/**
 * Terminals deliver keys as bytes, and one chunk can carry several of them when
 * a key repeats faster than the read loop. Parsing returns a list rather than a
 * single key so held arrows never get dropped.
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "space"
  | "char";

export interface Key {
  name: KeyName;
  /** Set when name is "char". */
  value?: string;
  ctrl: boolean;
}

const ESC = "\u001b";

const SEQUENCES: Readonly<Record<string, KeyName>> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[1~": "home",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
};

export function parseKeys(data: Buffer): Key[] {
  const text = data.toString("utf8");
  const keys: Key[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === ESC) {
      const matched = matchSequence(text.slice(index + 1));
      if (matched !== null) {
        keys.push({ name: matched.name, ctrl: false });
        index += 1 + matched.length;
        continue;
      }
      keys.push({ name: "escape", ctrl: false });
      index += 1;
      continue;
    }

    const code = char.codePointAt(0) ?? 0;

    if (char === "\r" || char === "\n") {
      keys.push({ name: "enter", ctrl: false });
    } else if (char === "\t") {
      keys.push({ name: "tab", ctrl: false });
    } else if (code === 127 || code === 8) {
      keys.push({ name: "backspace", ctrl: false });
    } else if (char === " ") {
      keys.push({ name: "space", ctrl: false });
    } else if (code < 32) {
      // Ctrl+letter arrives as the letter's position in the alphabet.
      keys.push({
        name: "char",
        value: String.fromCharCode(code + 96),
        ctrl: true,
      });
    } else {
      keys.push({ name: "char", value: char, ctrl: false });
    }

    index += char.length;
  }

  return keys;
}

function matchSequence(rest: string): { name: KeyName; length: number } | null {
  // Longest first, so "[1~" is not shortened to "[1".
  for (const length of [3, 2]) {
    const candidate = rest.slice(0, length);
    const name = SEQUENCES[candidate];
    if (name !== undefined) return { name, length };
  }
  return null;
}
