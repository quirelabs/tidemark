import type postgres from "postgres";
import type {
  CellChange,
  CellValue,
  ColumnChangeStat,
  DiffColumn,
  RowChange,
  TableDataDiff,
  ValueTransition,
} from "../artifact/schema.ts";
import { captureSchemaSnapshot } from "../schema/snapshot.ts";
import type { SchemaSnapshot, TableSchema } from "../schema/types.ts";
import {
  columnList,
  keyJoin,
  qualify,
  quoteIdent,
  rowDistinct,
} from "./identifiers.ts";

/**
 * The snapshot backend copies tracked tables into a shadow schema at capture
 * start, then diffs old against new in SQL. The copy lives in Postgres rather
 * than in Node so before-values survive without holding a table in memory, and
 * so the comparison is a set operation instead of a loop.
 *
 * This is also the correctness oracle the replication backend is checked against.
 */

export const DEFAULT_SHADOW_SCHEMA = "tidemark_snapshot";
export const DEFAULT_ROW_THRESHOLD = 50;
export const DEFAULT_SAMPLE_SIZE = 10;
/** Above this many distinct new values a column reports a count, not a list. */
const MAX_TRANSITIONS = 5;

export interface SnapshotCaptureOptions {
  schemas?: string[];
  rowThreshold?: number;
  sampleSize?: number;
  shadowSchema?: string;
}

export interface SnapshotCaptureHandle {
  startedAt: string;
  schemaBefore: SchemaSnapshot;
  shadowSchema: string;
  rowThreshold: number;
  sampleSize: number;
  schemas: string[];
}

export interface SnapshotCaptureResult {
  stoppedAt: string;
  schemaBefore: SchemaSnapshot;
  schemaAfter: SchemaSnapshot;
  tables: TableDataDiff[];
}

export async function startSnapshotCapture(
  sql: postgres.Sql,
  options: SnapshotCaptureOptions = {},
): Promise<SnapshotCaptureHandle> {
  const shadowSchema = options.shadowSchema ?? DEFAULT_SHADOW_SCHEMA;
  const schemas = options.schemas ?? ["public"];

  const schemaBefore = await captureSchemaSnapshot(sql, { schemas });

  await sql.unsafe(
    `drop schema if exists ${quoteIdent(shadowSchema)} cascade;
     create schema ${quoteIdent(shadowSchema)}`,
  );

  for (const table of capturableTables(schemaBefore)) {
    // CTAS rather than a logical copy: no constraints, no indexes, no triggers,
    // so copying cannot fail on a table the agent is about to break.
    await sql.unsafe(
      `create table ${qualify(shadowSchema, shadowName(table))}
       as table ${qualify(table.schema, table.name)}`,
    );
  }

  return {
    startedAt: new Date().toISOString(),
    schemaBefore,
    shadowSchema,
    rowThreshold: options.rowThreshold ?? DEFAULT_ROW_THRESHOLD,
    sampleSize: options.sampleSize ?? DEFAULT_SAMPLE_SIZE,
    schemas,
  };
}

export async function stopSnapshotCapture(
  sql: postgres.Sql,
  handle: SnapshotCaptureHandle,
): Promise<SnapshotCaptureResult> {
  const schemaAfter = await captureSchemaSnapshot(sql, {
    schemas: handle.schemas,
  });

  const before = new Map(
    capturableTables(handle.schemaBefore).map((t) => [tableKey(t), t]),
  );

  const tables: TableDataDiff[] = [];
  for (const table of capturableTables(schemaAfter)) {
    const diff = await diffTable(
      sql,
      handle,
      table,
      before.get(tableKey(table)) ?? null,
    );
    if (diff !== null) tables.push(diff);
  }

  return {
    stoppedAt: new Date().toISOString(),
    schemaBefore: handle.schemaBefore,
    schemaAfter,
    tables,
  };
}

export async function dropShadowSchema(
  sql: postgres.Sql,
  shadowSchema = DEFAULT_SHADOW_SCHEMA,
): Promise<void> {
  await sql.unsafe(`drop schema if exists ${quoteIdent(shadowSchema)} cascade`);
}

/**
 * Partitioned parents are skipped because their rows are already counted in the
 * partitions. Counting both would double every change.
 */
function capturableTables(snapshot: SchemaSnapshot): TableSchema[] {
  return snapshot.tables.filter((t) => !t.partitioned);
}

function tableKey(table: { schema: string; name: string }): string {
  return `${table.schema}.${table.name}`;
}

/** Flat name so two schemas with the same table name cannot collide. */
function shadowName(table: { schema: string; name: string }): string {
  return `${table.schema}.${table.name}`;
}

interface Counts {
  inserted: number;
  updated: number;
  deleted: number;
}

async function diffTable(
  sql: postgres.Sql,
  handle: SnapshotCaptureHandle,
  after: TableSchema,
  before: TableSchema | null,
): Promise<TableDataDiff | null> {
  const current = qualify(after.schema, after.name);
  const columns = after.columns.map((c) => c.name);

  // A table created during the capture window has no shadow copy, so every row
  // in it is new.
  if (before === null) {
    return await diffNewTable(sql, handle, after, current, columns);
  }

  const shadow = qualify(handle.shadowSchema, shadowName(after));
  const beforeColumns = new Set(before.columns.map((c) => c.name));
  // Survives ADD COLUMN and DROP COLUMN: only compare what both sides have.
  const common = columns.filter((c) => beforeColumns.has(c));
  const key = usableKey(after, common);

  const counts = await countChanges(sql, current, shadow, common, key);
  const total = counts.inserted + counts.updated + counts.deleted;
  if (total === 0) return null;

  const diffColumns: DiffColumn[] = after.columns
    .filter((c) => common.includes(c.name))
    .map((c) => ({ name: c.name, dataType: c.dataType }));

  if (total <= handle.rowThreshold) {
    return {
      schema: after.schema,
      name: after.name,
      detail: "rows",
      primaryKey: key,
      columns: diffColumns,
      counts,
      rows: await fetchRows(sql, current, shadow, common, key, handle.rowThreshold),
    };
  }

  return {
    schema: after.schema,
    name: after.name,
    detail: "aggregate",
    primaryKey: key,
    columns: diffColumns,
    counts,
    columnStats:
      key === null
        ? []
        : await columnStats(sql, current, shadow, common, key),
    sample: await fetchRows(sql, current, shadow, common, key, handle.sampleSize),
  };
}

async function diffNewTable(
  sql: postgres.Sql,
  handle: SnapshotCaptureHandle,
  after: TableSchema,
  current: string,
  columns: readonly string[],
): Promise<TableDataDiff | null> {
  const [row] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${current}`,
  );
  const inserted = Number(row?.count ?? 0);
  if (inserted === 0) return null;

  const counts: Counts = { inserted, updated: 0, deleted: 0 };
  const diffColumns: DiffColumn[] = after.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
  }));
  const key = usableKey(after, columns);
  const limit = inserted <= handle.rowThreshold ? handle.rowThreshold : handle.sampleSize;

  const rows = await sql.unsafe<{ after: Record<string, CellValue> }[]>(
    `select to_jsonb(t) as after
     from (select ${columnList("x", columns)} from ${current} x) t
     limit ${limit}`,
  );
  const changes = rows.map((r) => insertChange(r.after, columns, key));

  if (inserted <= handle.rowThreshold) {
    return {
      schema: after.schema,
      name: after.name,
      detail: "rows",
      primaryKey: key,
      columns: diffColumns,
      counts,
      rows: changes,
    };
  }
  return {
    schema: after.schema,
    name: after.name,
    detail: "aggregate",
    primaryKey: key,
    columns: diffColumns,
    counts,
    columnStats: [],
    sample: changes,
  };
}

/** A primary key is only usable if every one of its columns still exists. */
function usableKey(table: TableSchema, common: readonly string[]): string[] | null {
  const key = table.primaryKey;
  if (key === null) return null;
  return key.every((c) => common.includes(c)) ? [...key] : null;
}

async function countChanges(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly string[],
  key: readonly string[] | null,
): Promise<Counts> {
  if (key === null) return await countChangesWithoutKey(sql, current, shadow, common);

  const anchor = quoteIdent(key[0] as string);
  const join = keyJoin("c", "o", key);
  const comparable = common.filter((c) => !key.includes(c));

  const [row] = await sql.unsafe<
    { inserted: string; updated: string; deleted: string }[]
  >(
    `select
       (select count(*) from ${current} c
          left join ${shadow} o on ${join} where o.${anchor} is null)::text as inserted,
       (select count(*) from ${shadow} o
          left join ${current} c on ${join} where c.${anchor} is null)::text as deleted,
       ${
         comparable.length === 0
           ? "'0'"
           : `(select count(*) from ${current} c join ${shadow} o on ${join}
                where ${rowDistinct("c", "o", comparable)})::text`
       } as updated`,
  );

  return {
    inserted: Number(row?.inserted ?? 0),
    updated: Number(row?.updated ?? 0),
    deleted: Number(row?.deleted ?? 0),
  };
}

/**
 * Without a primary key there is nothing to pair an old row to a new one, so a
 * modified row is reported as a delete plus an insert. EXCEPT ALL keeps
 * duplicate rows honest, which EXCEPT would silently collapse.
 */
async function countChangesWithoutKey(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly string[],
): Promise<Counts> {
  if (common.length === 0) return { inserted: 0, updated: 0, deleted: 0 };

  const currentRows = `select ${columnList("c", common)} from ${current} c`;
  const shadowRows = `select ${columnList("o", common)} from ${shadow} o`;

  const [row] = await sql.unsafe<{ inserted: string; deleted: string }[]>(
    `select
       (select count(*) from (${currentRows} except all ${shadowRows}) i)::text as inserted,
       (select count(*) from (${shadowRows} except all ${currentRows}) d)::text as deleted`,
  );

  return {
    inserted: Number(row?.inserted ?? 0),
    updated: 0,
    deleted: Number(row?.deleted ?? 0),
  };
}

interface RowPair {
  before?: Record<string, CellValue>;
  after?: Record<string, CellValue>;
}

async function fetchRows(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly string[],
  key: readonly string[] | null,
  limit: number,
): Promise<RowChange[]> {
  if (key === null) {
    return await fetchRowsWithoutKey(sql, current, shadow, common, limit);
  }

  const anchor = quoteIdent(key[0] as string);
  const join = keyJoin("c", "o", key);
  const order = key.map((c) => `t.${quoteIdent(c)}`).join(", ");
  const comparable = common.filter((c) => !key.includes(c));
  const changes: RowChange[] = [];

  const inserted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as after from (
       select ${columnList("c", common)} from ${current} c
       left join ${shadow} o on ${join} where o.${anchor} is null
       order by ${columnList("c", key)}
     ) t order by ${order} limit ${limit}`,
  );
  for (const row of inserted) {
    if (row.after) changes.push(insertChange(row.after, common, key));
  }

  if (comparable.length > 0) {
    const updated = await sql.unsafe<RowPair[]>(
      `select to_jsonb(c) as after, to_jsonb(o) as before from (
         select ${columnList("c", common)} from ${current} c
         join ${shadow} o on ${join} where ${rowDistinct("c", "o", comparable)}
         order by ${columnList("c", key)} limit ${limit}
       ) c join (select ${columnList("o", common)} from ${shadow} o) o
       on ${keyJoin("c", "o", key)}
       order by ${columnList("c", key)}`,
    );
    for (const row of updated) {
      if (row.before && row.after) {
        changes.push(updateChange(row.before, row.after, common, key));
      }
    }
  }

  const deleted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as before from (
       select ${columnList("o", common)} from ${shadow} o
       left join ${current} c on ${join} where c.${anchor} is null
       order by ${columnList("o", key)}
     ) t order by ${order} limit ${limit}`,
  );
  for (const row of deleted) {
    if (row.before) changes.push(deleteChange(row.before, common, key));
  }

  return changes;
}

async function fetchRowsWithoutKey(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly string[],
  limit: number,
): Promise<RowChange[]> {
  if (common.length === 0) return [];

  const currentRows = `select ${columnList("c", common)} from ${current} c`;
  const shadowRows = `select ${columnList("o", common)} from ${shadow} o`;
  const changes: RowChange[] = [];

  const inserted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as after from (${currentRows} except all ${shadowRows}) t limit ${limit}`,
  );
  for (const row of inserted) {
    if (row.after) changes.push(insertChange(row.after, common, null));
  }

  const deleted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as before from (${shadowRows} except all ${currentRows}) t limit ${limit}`,
  );
  for (const row of deleted) {
    if (row.before) changes.push(deleteChange(row.before, common, null));
  }

  return changes;
}

async function columnStats(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly string[],
  key: readonly string[],
): Promise<ColumnChangeStat[]> {
  const comparable = common.filter((c) => !key.includes(c));
  if (comparable.length === 0) return [];

  const join = keyJoin("c", "o", key);
  const [counted] = await sql.unsafe<Record<string, string>[]>(
    `select ${comparable
      .map(
        (c, i) =>
          `count(*) filter (where c.${quoteIdent(c)} is distinct from o.${quoteIdent(c)})::text as ${quoteIdent(`col_${i}`)}`,
      )
      .join(", ")}
     from ${current} c join ${shadow} o on ${join}`,
  );

  const stats: ColumnChangeStat[] = [];
  for (const [index, column] of comparable.entries()) {
    const changed = Number(counted?.[`col_${index}`] ?? 0);
    if (changed === 0) continue;

    const rows = await sql.unsafe<
      { before: CellValue; after: CellValue; count: string }[]
    >(
      `select to_jsonb(o.${quoteIdent(column)}) as before,
              to_jsonb(c.${quoteIdent(column)}) as after,
              count(*)::text as count
       from ${current} c join ${shadow} o on ${join}
       where c.${quoteIdent(column)} is distinct from o.${quoteIdent(column)}
       group by 1, 2
       order by count(*) desc, 1, 2
       limit ${MAX_TRANSITIONS + 1}`,
    );

    if (rows.length > MAX_TRANSITIONS) {
      const [distinct] = await sql.unsafe<{ count: string }[]>(
        `select count(distinct c.${quoteIdent(column)})::text as count
         from ${current} c join ${shadow} o on ${join}
         where c.${quoteIdent(column)} is distinct from o.${quoteIdent(column)}`,
      );
      stats.push({
        column,
        changed,
        transitions: [],
        distinctAfter: Number(distinct?.count ?? 0),
      });
      continue;
    }

    const transitions: ValueTransition[] = rows.map((r) => ({
      before: r.before,
      after: r.after,
      count: Number(r.count),
    }));
    stats.push({ column, changed, transitions });
  }
  return stats;
}

function keyValues(
  row: Record<string, CellValue>,
  key: readonly string[] | null,
): CellValue[] {
  return key === null ? [] : key.map((c) => row[c] ?? null);
}

function insertChange(
  after: Record<string, CellValue>,
  columns: readonly string[],
  key: readonly string[] | null,
): RowChange {
  return {
    op: "insert",
    key: keyValues(after, key),
    cells: columns
      .filter((c) => key === null || !key.includes(c))
      .map((column): CellChange => ({ column, after: after[column] ?? null })),
  };
}

function deleteChange(
  before: Record<string, CellValue>,
  columns: readonly string[],
  key: readonly string[] | null,
): RowChange {
  return {
    op: "delete",
    key: keyValues(before, key),
    cells: columns
      .filter((c) => key === null || !key.includes(c))
      .map((column): CellChange => ({ column, before: before[column] ?? null })),
  };
}

function updateChange(
  before: Record<string, CellValue>,
  after: Record<string, CellValue>,
  columns: readonly string[],
  key: readonly string[],
): RowChange {
  // Only the columns that actually moved. A 40 column table with one changed
  // field should render as one changed field.
  const cells: CellChange[] = [];
  for (const column of columns) {
    if (key.includes(column)) continue;
    const from = before[column] ?? null;
    const to = after[column] ?? null;
    if (!sameValue(from, to)) cells.push({ column, before: from, after: to });
  }
  return { op: "update", key: keyValues(after, key), cells };
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
