import { describe, expect, it } from "vitest";
import { bar, percent, rule } from "../src/text/bar.ts";
import { stringWidth } from "../src/text/width.ts";

describe("bar", () => {
  it("fills proportionally", () => {
    expect(bar(1, 1, 10)).toBe("██████████");
    expect(bar(1, 2, 10)).toBe("█████");
    expect(stringWidth(bar(1, 4, 20))).toBe(5);
  });

  it("never renders a real change as nothing", () => {
    // 212 of 14,203 rounds to zero cells, but those rows still happened.
    const drawn = bar(212, 14203, 18);
    expect(drawn).not.toBe("");
    expect(stringWidth(drawn)).toBe(1);
  });

  it("renders nothing for nothing", () => {
    expect(bar(0, 100, 10)).toBe("");
    expect(bar(5, 0, 10)).toBe("");
    expect(bar(5, 10, 0)).toBe("");
  });

  it("never exceeds its budget, even when over total", () => {
    for (const width of [1, 5, 8, 22]) {
      expect(stringWidth(bar(999, 100, width))).toBeLessThanOrEqual(width);
    }
  });

  it("uses eighth-cell resolution so small differences stay visible", () => {
    const a = bar(30, 100, 8);
    const b = bar(35, 100, 8);
    expect(a).not.toBe(b);
  });

  it("falls back to ascii without partial cells", () => {
    expect(bar(1, 2, 10, "ascii")).toBe("#####");
    expect(bar(1, 1000, 10, "ascii")).toBe("#");
    expect(bar(0, 10, 10, "ascii")).toBe("");
  });
});

describe("percent", () => {
  it("never rounds a real change down to zero", () => {
    expect(percent(1, 100000)).toBe("<1%");
  });

  it("never rounds a near miss up to everything", () => {
    expect(percent(99999, 100000)).toBe(">99%");
    expect(percent(100, 100)).toBe("100%");
  });

  it("rounds ordinary values", () => {
    expect(percent(50, 100)).toBe("50%");
    expect(percent(1, 3)).toBe("33%");
  });

  it("says nothing about an empty table", () => {
    expect(percent(0, 0)).toBe("");
  });
});

describe("rule", () => {
  it("fills the width exactly", () => {
    expect(stringWidth(rule("DANGER", 40, "unicode"))).toBe(40);
    expect(stringWidth(rule("DATA", 80, "unicode"))).toBe(80);
  });

  it("stays readable when the terminal is too narrow to fill", () => {
    const narrow = rule("SOMETHING LONG", 4, "unicode");
    expect(narrow).toContain("SOMETHING LONG");
  });

  it("uses ascii when unicode is unavailable", () => {
    const line = rule("DANGER", 20, "ascii");
    expect(line).toBe("== DANGER ==========");
    expect(line).not.toMatch(/[━]/);
  });
});
