import type { Artifact } from "@quirelabs/tidemark-core";
import type { Capabilities } from "../style/capabilities.ts";
import { emitLine, span, type Line, type Span } from "../style/style.ts";
import { glyphsFor } from "../report/glyphs.ts";
import { codePointWidth } from "../text/width.ts";
import { parseKeys, type Key } from "./keys.ts";
import { buildOutline, visibleRows, type OutlineNode, type VisibleRow } from "./outline.ts";
import { Screen, type Size } from "./screen.ts";

const NUMBER = new Intl.NumberFormat("en-US");
const MIN_LIST = 26;
const MAX_LIST = 52;

type Filter = "all" | "danger" | "data";

interface State {
  nodes: OutlineNode[];
  selected: number;
  listScroll: number;
  detailScroll: number;
  filter: Filter;
  query: string;
  searching: boolean;
  help: boolean;
}

export interface TuiOptions {
  screen?: Screen;
  capabilities: Capabilities;
}

/**
 * Cuts a line to a column budget without splitting a surrogate pair or losing a
 * span's styling, then pads it so every frame row is exactly the same width.
 * Uniform width is what lets the frame differ compare rows cheaply.
 */
export function fitLine(line: Line, width: number): Line {
  const out: Line = [];
  let used = 0;

  for (const piece of line) {
    if (used >= width) break;
    let taken = "";
    for (const character of piece.text) {
      const cost = codePointWidth(character.codePointAt(0) ?? 0);
      if (used + cost > width) break;
      taken += character;
      used += cost;
    }
    if (taken !== "") out.push(piece.style === undefined ? { text: taken } : { text: taken, style: piece.style });
  }

  if (used < width) out.push({ text: " ".repeat(width - used) });
  return out;
}

function join(left: Line, divider: Line, right: Line): Line {
  return [...left, ...divider, ...right];
}

export class TidemarkTui {
  private readonly artifact: Artifact;
  private readonly capabilities: Capabilities;
  private readonly screen: Screen;
  private state: State;
  private rows: VisibleRow[] = [];
  private builtFor = -1;

  constructor(artifact: Artifact, options: TuiOptions) {
    this.artifact = artifact;
    this.capabilities = options.capabilities;
    this.screen = options.screen ?? new Screen();

    this.state = {
      nodes: [],
      selected: 0,
      listScroll: 0,
      detailScroll: 0,
      filter: "all",
      query: "",
      searching: false,
      help: false,
    };
  }

  /** Resolves when the user quits. */
  async run(): Promise<void> {
    this.rebuild(this.screen.size);
    this.builtFor = this.screen.size.columns;
    this.screen.start(() => {
      this.rebuild(this.screen.size);
      this.builtFor = this.screen.size.columns;
      this.draw();
    });
    this.draw();

    await new Promise<void>((resolve) => {
      const off = this.screen.onKey((data) => {
        for (const key of parseKeys(data)) {
          if (this.handle(key)) {
            off();
            this.screen.stop();
            resolve();
            return;
          }
        }
        this.draw();
      });
    });
  }

  /**
   * Feeds raw key bytes in, exactly as the terminal would. Frames can then be
   * rendered without a TTY, which is what makes the interface testable at all.
   * Returns true when the input asked to quit.
   */
  press(data: string, size?: Size): boolean {
    if (size !== undefined) {
      this.rebuild(size);
      this.builtFor = size.columns;
    }
    this.rows = this.visible();
    for (const key of parseKeys(Buffer.from(data, "utf8"))) {
      if (this.handle(key)) return true;
      this.rows = this.visible();
    }
    return false;
  }

  /**
   * Detail lines are laid out for a specific width, so a resize has to rebuild
   * the outline. Expansion state is carried across by id, because losing what
   * you had opened every time you resized the window would be maddening.
   */
  private rebuild(size: Size): void {
    const expanded = new Set<string>();
    const remember = (nodes: readonly OutlineNode[]): void => {
      for (const node of nodes) {
        if (node.expanded) expanded.add(node.id);
        remember(node.children);
      }
    };
    remember(this.state.nodes);

    const listWidth = this.listWidth(size.columns);
    this.state.nodes = buildOutline(this.artifact, {
      glyphs: glyphsFor(this.capabilities.glyphs),
      ascii: this.capabilities.glyphs === "ascii",
      detailWidth: Math.max(20, size.columns - listWidth - 3),
    });

    if (expanded.size === 0) return;
    const restore = (nodes: readonly OutlineNode[]): void => {
      for (const node of nodes) {
        node.expanded = expanded.has(node.id);
        restore(node.children);
      }
    };
    restore(this.state.nodes);
  }

  private listWidth(columns: number): number {
    return Math.max(MIN_LIST, Math.min(MAX_LIST, Math.floor(columns * 0.38)));
  }

  private visible(): VisibleRow[] {
    const query = this.state.query.trim().toLowerCase();
    if (query !== "") {
      // Search flattens: matches are what matters, not where they sit.
      const flat: VisibleRow[] = [];
      const walk = (nodes: readonly OutlineNode[]): void => {
        for (const node of nodes) {
          if (node.kind !== "section" && node.search.includes(query)) {
            flat.push({ node, depth: 0 });
          }
          walk(node.children);
        }
      };
      walk(this.state.nodes);
      return flat;
    }

    const filtered = this.state.nodes.filter((node) => {
      if (this.state.filter === "all") return true;
      if (this.state.filter === "danger") return node.id === "danger" || node.id === "caution";
      return node.id === "schema" || node.id === "data";
    });
    return visibleRows(filtered);
  }

  private selectedNode(): OutlineNode | null {
    return this.rows[this.state.selected]?.node ?? null;
  }

  private handle(key: Key): boolean {
    const state = this.state;

    if (state.searching) {
      if (key.name === "escape") {
        state.searching = false;
        state.query = "";
      } else if (key.name === "enter") {
        state.searching = false;
      } else if (key.name === "backspace") {
        state.query = state.query.slice(0, -1);
      } else if (key.name === "char" && !key.ctrl) {
        state.query += key.value ?? "";
      }
      state.selected = 0;
      state.listScroll = 0;
      state.detailScroll = 0;
      return false;
    }

    if (state.help) {
      state.help = false;
      return false;
    }

    if (key.ctrl && key.value === "c") return true;

    switch (key.name) {
      case "up":
        this.move(-1);
        return false;
      case "down":
        this.move(1);
        return false;
      case "pageup":
        this.move(-10);
        return false;
      case "pagedown":
        this.move(10);
        return false;
      case "home":
        state.selected = 0;
        state.detailScroll = 0;
        return false;
      case "end":
        state.selected = Math.max(0, this.rows.length - 1);
        state.detailScroll = 0;
        return false;
      case "left":
        this.collapse();
        return false;
      case "right":
      case "enter":
        this.toggle();
        return false;
      case "tab":
        state.filter = state.filter === "all" ? "danger" : state.filter === "danger" ? "data" : "all";
        state.selected = 0;
        state.listScroll = 0;
        return false;
      case "escape":
        return true;
      default:
        break;
    }

    switch (key.value) {
      case "q":
        return true;
      case "j":
        this.move(1);
        return false;
      case "k":
        this.move(-1);
        return false;
      case "h":
        this.collapse();
        return false;
      case "l":
        this.toggle();
        return false;
      case "g":
        state.selected = 0;
        state.detailScroll = 0;
        return false;
      case "G":
        state.selected = Math.max(0, this.rows.length - 1);
        return false;
      case "J":
        state.detailScroll += 3;
        return false;
      case "K":
        state.detailScroll = Math.max(0, state.detailScroll - 3);
        return false;
      case "/":
        state.searching = true;
        state.query = "";
        return false;
      case "?":
        state.help = true;
        return false;
      default:
        return false;
    }
  }

  private move(delta: number): void {
    const last = Math.max(0, this.rows.length - 1);
    this.state.selected = Math.max(0, Math.min(last, this.state.selected + delta));
    this.state.detailScroll = 0;
  }

  private toggle(): void {
    const node = this.selectedNode();
    if (node !== null && node.children.length > 0) node.expanded = !node.expanded;
  }

  private collapse(): void {
    const node = this.selectedNode();
    if (node !== null && node.expanded && node.children.length > 0) {
      node.expanded = false;
      return;
    }
    // Already collapsed, so jump to the parent, which is the nearest row above
    // at a shallower depth.
    const current = this.rows[this.state.selected];
    if (current === undefined) return;
    for (let index = this.state.selected - 1; index >= 0; index--) {
      if ((this.rows[index]?.depth ?? 0) < current.depth) {
        this.state.selected = index;
        return;
      }
    }
  }

  private draw(): void {
    this.screen.render(this.frame(this.screen.size));
  }

  /** Exposed for tests, which render frames without a terminal. */
  frame(size: Size): string[] {
    // The outline depends on width, and a frame can be the first thing anyone
    // asks for, so building it here rather than only in run() keeps the two
    // entry points from disagreeing about what exists.
    if (this.state.nodes.length === 0 || this.builtFor !== size.columns) {
      this.rebuild(size);
      this.builtFor = size.columns;
    }
    this.rows = this.visible();
    if (this.state.selected >= this.rows.length) {
      this.state.selected = Math.max(0, this.rows.length - 1);
    }

    const { columns, rows } = size;
    const bodyHeight = Math.max(1, rows - 4);
    const listWidth = this.listWidth(columns);
    const detailWidth = Math.max(10, columns - listWidth - 3);

    this.clampScroll(bodyHeight);

    const lines: Line[] = [
      this.header(columns),
      this.summary(columns),
      this.divider(columns),
    ];

    const list = this.listPane(listWidth, bodyHeight);
    const detail = this.detailPane(detailWidth, bodyHeight);
    const gap: Line = [span(" "), span(this.capabilities.glyphs === "ascii" ? "|" : "│", "border"), span(" ")];

    for (let row = 0; row < bodyHeight; row++) {
      lines.push(join(list[row] ?? fitLine([], listWidth), gap, detail[row] ?? fitLine([], detailWidth)));
    }

    lines.push(this.footer(columns));

    const frame = this.state.help ? this.withHelp(lines, size) : lines;
    return frame.map((line) => emitLine(fitLine(line, columns), this.capabilities, false));
  }

  private clampScroll(height: number): void {
    const state = this.state;
    if (state.selected < state.listScroll) state.listScroll = state.selected;
    if (state.selected >= state.listScroll + height) {
      state.listScroll = state.selected - height + 1;
    }
    state.listScroll = Math.max(0, Math.min(state.listScroll, Math.max(0, this.rows.length - height)));

    const detail = this.selectedNode()?.detail ?? [];
    state.detailScroll = Math.max(0, Math.min(state.detailScroll, Math.max(0, detail.length - height)));
  }

  private header(width: number): Line {
    const { meta } = this.artifact;
    return fitLine(
      [
        span(" tidemark ", "selected"),
        span("  "),
        span(meta.database, "heading"),
        span(`  ${meta.backend}`, "muted"),
        span(`  ${meta.capturedTo}`, "muted"),
      ],
      width,
    );
  }

  private summary(width: number): Line {
    const totals = this.artifact.tables.reduce(
      (acc, table) => ({
        inserted: acc.inserted + table.counts.inserted,
        updated: acc.updated + table.counts.updated,
        deleted: acc.deleted + table.counts.deleted,
      }),
      { inserted: 0, updated: 0, deleted: 0 },
    );
    const dangers = this.artifact.warnings.filter((w) => w.severity === "danger").length;
    const cautions = this.artifact.warnings.length - dangers;
    const glyphs = glyphsFor(this.capabilities.glyphs);

    const parts: Span[] = [span(" ")];
    parts.push(span(`${NUMBER.format(this.artifact.tables.length)} tables`, "muted"));
    if (totals.inserted > 0) parts.push(span(`  ${glyphs.insert}${NUMBER.format(totals.inserted)}`, "insert"));
    if (totals.updated > 0) parts.push(span(`  ${glyphs.update}${NUMBER.format(totals.updated)}`, "update"));
    if (totals.deleted > 0) parts.push(span(`  ${glyphs.delete}${NUMBER.format(totals.deleted)}`, "delete"));
    if (dangers > 0) parts.push(span(`  ${glyphs.warn} ${dangers} danger`, "danger"));
    if (cautions > 0) parts.push(span(`  ${cautions} caution`, "caution"));

    return fitLine(parts, width);
  }

  private divider(width: number): Line {
    const line = this.capabilities.glyphs === "ascii" ? "-" : "─";
    return [span(line.repeat(width), "border")];
  }

  private listPane(width: number, height: number): Line[] {
    const lines: Line[] = [];

    for (let index = 0; index < height; index++) {
      const rowIndex = this.state.listScroll + index;
      const row = this.rows[rowIndex];
      if (row === undefined) {
        lines.push(fitLine([], width));
        continue;
      }

      const selected = rowIndex === this.state.selected;
      const marker =
        row.node.children.length === 0
          ? "  "
          : row.node.expanded
            ? this.capabilities.glyphs === "ascii" ? "- " : "▾ "
            : this.capabilities.glyphs === "ascii" ? "+ " : "▸ ";

      const content: Line = [
        span(" ".repeat(row.depth * 2)),
        span(marker, "muted"),
        ...row.node.label,
      ];

      const fitted = fitLine(content, width);
      lines.push(selected ? [span(fitted.map((s) => s.text).join(""), "selected")] : fitted);
    }

    // A scroll indicator, so a long list never looks like a short one.
    if (this.rows.length > height) {
      const position = Math.floor((this.state.listScroll / Math.max(1, this.rows.length - height)) * (height - 1));
      for (let index = 0; index < height; index++) {
        const glyph = index === position ? (this.capabilities.glyphs === "ascii" ? "#" : "█") : " ";
        const line = lines[index];
        if (line !== undefined) lines[index] = [...fitLine(line, width - 1), span(glyph, "border")];
      }
    }
    return lines;
  }

  private detailPane(width: number, height: number): Line[] {
    const detail = this.selectedNode()?.detail ?? [];
    const lines: Line[] = [];

    for (let index = 0; index < height; index++) {
      const line = detail[this.state.detailScroll + index];
      lines.push(fitLine(line ?? [], width));
    }

    if (detail.length > height) {
      const remaining = detail.length - this.state.detailScroll - height;
      if (remaining > 0) {
        lines[height - 1] = fitLine(
          [span(`  ${NUMBER.format(remaining)} more lines, J to scroll`, "muted")],
          width,
        );
      }
    }
    return lines;
  }

  private footer(width: number): Line {
    if (this.state.searching) {
      return fitLine(
        [span(" search ", "selected"), span(" "), span(this.state.query), span("▏", "accent")],
        width,
      );
    }

    const filter =
      this.state.filter === "all" ? "all" : this.state.filter === "danger" ? "findings" : "changes";
    const hint = (key: string, label: string): Span[] => [
      span(` ${key}`, "accent"),
      span(` ${label}`, "muted"),
    ];

    return fitLine(
      [
        ...hint("↑↓", "move"),
        ...hint("→", "expand"),
        ...hint("J/K", "scroll"),
        ...hint("tab", filter),
        ...hint("/", "search"),
        ...hint("?", "help"),
        ...hint("q", "quit"),
      ],
      width,
    );
  }

  private withHelp(lines: Line[], size: Size): Line[] {
    const help: [string, string][] = [
      ["↑ ↓ j k", "move between entries"],
      ["→ enter l", "expand or collapse"],
      ["← h", "collapse, or jump to parent"],
      ["J K", "scroll the detail pane"],
      ["g G", "first and last entry"],
      ["tab", "cycle all / findings / changes"],
      ["/", "search, enter to apply, esc to clear"],
      ["?", "this help"],
      ["q esc", "quit"],
    ];

    const width = Math.min(52, size.columns - 4);
    const top = Math.max(3, Math.floor((size.rows - help.length - 4) / 2));
    const out = [...lines];

    const box = (content: Line): Line => [
      span("  "),
      span(this.capabilities.glyphs === "ascii" ? "|" : "│", "border"),
      span(" "),
      ...fitLine(content, width),
      span(this.capabilities.glyphs === "ascii" ? "|" : "│", "border"),
    ];

    const rule = this.capabilities.glyphs === "ascii" ? "-" : "─";
    out[top] = box([span(rule.repeat(width), "border")]);
    help.forEach(([keys, label], index) => {
      const row = top + 1 + index;
      if (row < out.length) {
        out[row] = box([span(keys.padEnd(12), "accent"), span(label, "muted")]);
      }
    });
    const bottom = top + help.length + 1;
    if (bottom < out.length) out[bottom] = box([span(rule.repeat(width), "border")]);

    return out;
  }
}

export function isInteractive(capabilities: Capabilities, output = process.stdout): boolean {
  return output.isTTY === true && capabilities.color;
}

