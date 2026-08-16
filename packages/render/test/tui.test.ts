import { describe, expect, it } from "vitest";
import { parseKeys } from "../src/tui/keys.ts";
import { TidemarkTui } from "../src/tui/app.ts";
import { buildOutline, visibleRows } from "../src/tui/outline.ts";
import { glyphsFor } from "../src/report/glyphs.ts";
import { stringWidth } from "../src/text/width.ts";
import type { Capabilities } from "../src/style/capabilities.ts";
import { AGENT_GONE_WRONG, NO_CHANGES } from "./fixtures/artifact.ts";

const SIZE = { columns: 100, rows: 30 };
const PLAIN: Capabilities = { color: false, glyphs: "unicode", width: 100 };
const ASCII: Capabilities = { color: false, glyphs: "ascii", width: 100 };

function tui(capabilities: Capabilities = PLAIN): TidemarkTui {
  return new TidemarkTui(AGENT_GONE_WRONG, { capabilities });
}

function frameText(app: TidemarkTui, size = SIZE): string {
  return app.frame(size).join("\n");
}

describe("key parsing", () => {
  it("reads arrows and control sequences", () => {
    expect(parseKeys(Buffer.from("\u001b[A"))[0]?.name).toBe("up");
    expect(parseKeys(Buffer.from("\u001b[B"))[0]?.name).toBe("down");
    expect(parseKeys(Buffer.from("\u001b[6~"))[0]?.name).toBe("pagedown");
    expect(parseKeys(Buffer.from("\u001bOA"))[0]?.name).toBe("up");
  });

  it("reads several keys from one chunk, so held keys are not dropped", () => {
    const keys = parseKeys(Buffer.from("\u001b[B\u001b[B\u001b[B"));
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.name === "down")).toBe(true);
  });

  it("distinguishes ctrl combinations", () => {
    const [key] = parseKeys(Buffer.from("\u0003"));
    expect(key?.ctrl).toBe(true);
    expect(key?.value).toBe("c");
  });

  it("reads plain characters and enter", () => {
    expect(parseKeys(Buffer.from("q"))[0]).toEqual({ name: "char", value: "q", ctrl: false });
    expect(parseKeys(Buffer.from("\r"))[0]?.name).toBe("enter");
  });
});

describe("frame geometry", () => {
  it("fills the terminal exactly, every row", () => {
    const frame = tui().frame(SIZE);
    expect(frame).toHaveLength(SIZE.rows);
    for (const line of frame) {
      expect(stringWidth(line)).toBe(SIZE.columns);
    }
  });

  it("holds its shape at awkward sizes", () => {
    for (const size of [
      { columns: 40, rows: 10 },
      { columns: 200, rows: 60 },
      { columns: 61, rows: 13 },
    ]) {
      const frame = tui().frame(size);
      expect(frame).toHaveLength(size.rows);
      for (const line of frame) expect(stringWidth(line)).toBe(size.columns);
    }
  });

  it("renders an artifact with nothing in it", () => {
    const empty = new TidemarkTui(NO_CHANGES, { capabilities: PLAIN });
    const frame = empty.frame(SIZE);
    expect(frame).toHaveLength(SIZE.rows);
    expect(frame.join("\n")).toContain("tidemark");
  });
});

describe("navigation", () => {
  it("moves the selection and shows that entry's detail", () => {
    const app = tui();
    const first = frameText(app);
    app.press("j", SIZE);
    expect(frameText(app)).not.toBe(first);
  });

  it("expands and collapses a section", () => {
    const app = tui();
    // Sections start expanded, so the first collapse hides their children.
    const expanded = frameText(app);
    app.press("l", SIZE);
    const collapsed = frameText(app);
    expect(collapsed).not.toBe(expanded);
    app.press("l", SIZE);
    expect(frameText(app)).toBe(expanded);
  });

  it("cannot select past either end", () => {
    const app = tui();
    app.press("k".repeat(20), SIZE);
    expect(() => app.frame(SIZE)).not.toThrow();
    app.press("j".repeat(200), SIZE);
    expect(() => app.frame(SIZE)).not.toThrow();
  });

  it("quits on q, escape and ctrl-c", () => {
    expect(tui().press("q", SIZE)).toBe(true);
    expect(tui().press("\u001b", SIZE)).toBe(true);
    expect(tui().press("\u0003", SIZE)).toBe(true);
  });
});

describe("filtering and search", () => {
  it("cycles filters with tab", () => {
    const app = tui();
    const all = frameText(app);
    app.press("\t", SIZE);
    const findings = frameText(app);
    expect(findings).not.toBe(all);
    expect(findings).toContain("findings");

    app.press("\t", SIZE);
    expect(frameText(app)).toContain("changes");
    app.press("\t", SIZE);
    expect(frameText(app)).toContain("all");
  });

  it("searches across findings and tables", () => {
    const app = tui();
    app.press("/orders", SIZE);
    const searching = frameText(app);
    expect(searching).toContain("search");
    expect(searching).toContain("orders");

    app.press("\r", SIZE);
    expect(frameText(app)).toContain("orders");
  });

  it("clears a search with escape", () => {
    const app = tui();
    const before = frameText(app);
    app.press("/zzzz", SIZE);
    app.press("\u001b", SIZE);
    expect(frameText(app)).toBe(before);
  });

  it("survives a search that matches nothing", () => {
    const app = tui();
    app.press("/nothingmatchesthis\r", SIZE);
    const frame = app.frame(SIZE);
    expect(frame).toHaveLength(SIZE.rows);
  });
});

describe("help", () => {
  it("opens and closes", () => {
    const app = tui();
    const before = frameText(app);
    app.press("?", SIZE);
    const help = frameText(app);
    expect(help).toContain("expand or collapse");
    expect(help).toContain("quit");

    app.press(" ", SIZE);
    expect(frameText(app)).toBe(before);
  });
});

describe("outline", () => {
  it("groups findings, schema and data", () => {
    const nodes = buildOutline(AGENT_GONE_WRONG, {
      glyphs: glyphsFor("unicode"),
      detailWidth: 60,
      ascii: false,
    });
    expect(nodes.map((n) => n.id)).toEqual(["danger", "caution", "schema", "data"]);
    expect(visibleRows(nodes).length).toBeGreaterThan(nodes.length);
  });

  it("carries a searchable haystack including detail", () => {
    const nodes = buildOutline(AGENT_GONE_WRONG, {
      glyphs: glyphsFor("unicode"),
      detailWidth: 60,
      ascii: false,
    });
    const data = nodes.find((n) => n.id === "data");
    expect(data?.children[0]?.search).toContain("orders");
  });
});

describe("ascii fallback", () => {
  it("uses no box drawing or block characters", () => {
    const app = tui(ASCII);
    app.press("?", { columns: 100, rows: 30 });
    const frame = app.frame({ columns: 100, rows: 30 }).join("\n");
    expect(frame).not.toMatch(/[│─▸▾█▏▎▍▌▋▊▉]/);
  });
});

describe("hostile values in the browser", () => {
  it("never lets a value break the frame", () => {
    const app = tui();
    app.press("\t\t", SIZE);
    for (const line of app.frame(SIZE)) {
      expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
      expect(line.split("\n")).toHaveLength(1);
    }
  });
});
