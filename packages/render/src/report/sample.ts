import type { CellChange, RowChange } from "@quirelabs/tidemark-core";

/**
 * A bulk update often moves one column meaningfully and another identically on
 * every row, typically a timestamp. Repeating that second column on every
 * sampled row crowds out the one that matters.
 *
 * So a column whose transition is the same across all sampled rows collapses
 * into a single note. This is the same aggregation the product already applies
 * to rows, applied one level down to columns, and it is a rendering decision
 * only: the artifact keeps every column and every value.
 *
 * Only used for aggregated tables. Under the row threshold the diff is small
 * enough that nothing is drowning out anything, so everything is shown.
 */
export interface CollapsedSample {
  rows: RowChange[];
  /** Columns folded into the note, sorted. Empty when nothing was collapsed. */
  collapsed: string[];
}

function signature(cell: CellChange): string {
  return JSON.stringify([
    cell.before ?? null,
    cell.after ?? null,
    cell.redacted ?? null,
  ]);
}

export function collapseUniformColumns(
  rows: readonly RowChange[],
): CollapsedSample {
  // One row cannot establish that anything is uniform.
  if (rows.length < 2) return { rows: [...rows], collapsed: [] };

  const first = rows[0];
  if (first === undefined) return { rows: [...rows], collapsed: [] };

  const uniform = new Set<string>();
  for (const cell of first.cells) {
    const target = signature(cell);
    const everywhere = rows.every((row) => {
      const match = row.cells.find((c) => c.column === cell.column);
      return match !== undefined && signature(match) === target;
    });
    if (everywhere) uniform.add(cell.column);
  }

  // Collapsing every column would leave rows saying nothing at all, at which
  // point the sample is worse than useless.
  if (uniform.size === 0 || uniform.size === first.cells.length) {
    return { rows: [...rows], collapsed: [] };
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      cells: row.cells.filter((cell) => !uniform.has(cell.column)),
    })),
    collapsed: [...uniform].sort(),
  };
}

export function collapsedNote(collapsed: readonly string[], total: number): string {
  return `${collapsed.join(", ")} moved identically on all ${total} sampled rows`;
}
