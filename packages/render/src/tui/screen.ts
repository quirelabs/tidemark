/**
 * Terminal control, hand rolled because the alternatives are a dependency tree
 * for what amounts to a dozen escape sequences.
 *
 * The one non-obvious piece is frame diffing. Repainting every line on every
 * keystroke flickers badly over SSH and in slow terminals, so a frame is
 * compared against the previous one and only changed rows are rewritten.
 */

const ESC = "\u001b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J`;
const CLEAR_LINE = `${ESC}[K`;

export interface Size {
  columns: number;
  rows: number;
}

export interface ScreenOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class Screen {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private previous: string[] = [];
  private active = false;
  private onResize: (() => void) | null = null;

  constructor(options: ScreenOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  get size(): Size {
    return {
      columns: this.output.columns ?? 80,
      rows: this.output.rows ?? 24,
    };
  }

  start(onResize: () => void): void {
    if (this.active) return;
    this.active = true;
    this.onResize = onResize;

    this.output.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.output.on("resize", this.handleResize);
  }

  /** Idempotent, because it runs from both the normal exit path and signals. */
  stop(): void {
    if (!this.active) return;
    this.active = false;

    this.output.off("resize", this.handleResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.output.write(CURSOR_SHOW + ALT_SCREEN_OFF);
    this.previous = [];
  }

  private handleResize = (): void => {
    // Everything is invalid at a new size, so the next frame repaints in full.
    this.previous = [];
    this.onResize?.();
  };

  /** Writes only the rows that changed since the last frame. */
  render(frame: readonly string[]): void {
    if (!this.active) return;

    const { rows } = this.size;
    let out = "";

    for (let row = 0; row < rows; row++) {
      const next = frame[row] ?? "";
      if (this.previous[row] === next) continue;
      out += `${ESC}[${row + 1};1H${next}${CLEAR_LINE}`;
    }

    if (out !== "") this.output.write(out);
    this.previous = [...frame].slice(0, rows);
  }

  onKey(handler: (data: Buffer) => void): () => void {
    const listener = (chunk: Buffer): void => handler(chunk);
    this.input.on("data", listener);
    return () => this.input.off("data", listener);
  }
}
