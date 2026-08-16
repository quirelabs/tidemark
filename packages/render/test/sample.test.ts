import type { RowChange } from "@quirelabs/tidemark-core";
import { describe, expect, it } from "vitest";
import {
  collapsedNote,
  collapseUniformColumns,
} from "../src/report/sample.ts";

function row(id: number, status: [string, string], stamp: [string, string]): RowChange {
  return {
    op: "update",
    key: [id],
    cells: [
      { column: "status", before: status[0], after: status[1] },
      { column: "updated_at", before: stamp[0], after: stamp[1] },
    ],
  };
}

const STAMP: [string, string] = ["2026-08-15T21:16:10Z", "2026-08-15T21:16:11Z"];

describe("collapseUniformColumns", () => {
  it("folds a column that moved identically on every row", () => {
    const { rows, collapsed } = collapseUniformColumns([
      row(1, ["pending", "processed"], STAMP),
      row(2, ["pending", "processed"], STAMP),
      row(3, ["failed", "processed"], STAMP),
    ]);

    expect(collapsed).toEqual(["updated_at"]);
    expect(rows.every((r) => r.cells.every((c) => c.column === "status"))).toBe(true);
  });

  it("keeps the column that varies and folds the one that does not", () => {
    // Here status is the uniform one, so it folds and the timestamp stays. The
    // rule is about repetition, not about which column seems more interesting.
    const { rows, collapsed } = collapseUniformColumns([
      row(1, ["pending", "processed"], STAMP),
      row(2, ["pending", "processed"], ["a", "b"]),
    ]);
    expect(collapsed).toEqual(["status"]);
    expect(rows[0]?.cells.map((c) => c.column)).toEqual(["updated_at"]);
  });

  it("never collapses everything, which would leave rows saying nothing", () => {
    const { rows, collapsed } = collapseUniformColumns([
      row(1, ["pending", "processed"], STAMP),
      row(2, ["pending", "processed"], STAMP),
    ]);
    expect(collapsed).toEqual([]);
    expect(rows[0]?.cells).toHaveLength(2);
  });

  it("does nothing to a single row, which establishes no pattern", () => {
    const { collapsed } = collapseUniformColumns([row(1, ["a", "b"], STAMP)]);
    expect(collapsed).toEqual([]);
  });

  it("treats a redaction change as part of the signature", () => {
    const masked: RowChange = {
      op: "update",
      key: [1],
      cells: [
        { column: "status", before: "a", after: "b" },
        { column: "token", before: null, after: null, redacted: "mask" },
      ],
    };
    const plain: RowChange = {
      op: "update",
      key: [2],
      cells: [
        { column: "status", before: "c", after: "d" },
        { column: "token", before: null, after: null },
      ],
    };

    expect(collapseUniformColumns([masked, plain]).collapsed).toEqual([]);
  });

  it("reads clearly when several columns collapse", () => {
    expect(collapsedNote(["seen_at", "updated_at"], 8)).toBe(
      "seen_at, updated_at moved identically on all 8 sampled rows",
    );
  });
});
