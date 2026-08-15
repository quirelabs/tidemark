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
  jsonValue,
  keyJoin,
  needsTextCast,
  qualify,
  quoteIdent,
  rowDistinct,
  selectList,
  type SqlColumn,
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
  // The shadow schema must never be scanned, or its copies would surface as
  // newly created tables the moment anyone captures more than one schema.
  const schemas = (options.schemas ?? ["public"]).filter(
    (s) => s !== shadowSchema,
  );

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

  // Keyed by oid, not by name. A table dropped and recreated under the same
  // name is a different table, and a renamed table is the same one.
  const before = new Map(
    capturableTables(handle.schemaBefore).map((t) => [t.oid, t]),
  );

  const tables: TableDataDiff[] = [];
  for (const table of capturableTables(schemaAfter)) {
    const diff = await diffTable(sql, handle, table, before.get(table.oid) ?? null);
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

/** Flat name so two schemas with the same table name cannot collide. */
function shadowName(table: { schema: string; name: string }): string {
  return `${table.schema}.${table.name}`;
}

interface Counts {
  inserted: number;
  updated: number;
  deleted: number;
}

/** A column present in both snapshots, with the SQL treatment it needs. */
interface CommonColumn extends SqlColumn {
  dataType: string;
}

function commonColumns(after: TableSchema, before: TableSchema): CommonColumn[] {
  const beforeTypes = new Map(before.columns.map((c) => [c.name, c.dataType]));
  const columns: CommonColumn[] = [];

  for (const column of after.columns) {
    const beforeType = beforeTypes.get(column.name);
    if (beforeType === undefined) continue;
    columns.push({
      name: column.name,
      dataType: column.dataType,
      // A retyped column has no operator both sides can use, so compare as text.
      castToText:
        needsTextCast(column.dataType) || beforeType !== column.dataType,
    });
  }
  return columns;
}

async function diffTable(
  sql: postgres.Sql,
  handle: SnapshotCaptureHandle,
  after: TableSchema,
  before: TableSchema | null,
): Promise<TableDataDiff | null> {
  const current = qualify(after.schema, after.name);

  // No shadow copy means the table did not exist at capture start, so every row
  // in it is new.
  if (before === null) return await diffNewTable(sql, handle, after, current);

  // Looked up by the name the table had at capture start, so a rename still
  // finds its own copy.
  const shadow = qualify(handle.shadowSchema, shadowName(before));
  const common = commonColumns(after, before);
  const key = usableKey(after, common);

  const counts = await countChanges(sql, current, shadow, common, key);
  const total = counts.inserted + counts.updated + counts.deleted;
  if (total === 0) return null;

  const [countRow] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${shadow}`,
  );

  const base = {
    schema: after.schema,
    name: after.name,
    primaryKey: key,
    columns: common.map((c): DiffColumn => ({ name: c.name, dataType: c.dataType })),
    counts,
    rowsBefore: Number(countRow?.count ?? 0),
  };

  if (total <= handle.rowThreshold) {
    return {
      ...base,
      detail: "rows",
      rows: await fetchRows(sql, current, shadow, common, key, handle.rowThreshold),
    };
  }

  const stats =
    key === null ? [] : await columnStats(sql, current, shadow, common, key);
  return {
    ...base,
    detail: "aggregate",
    columnStats: stats,
    sample: await fetchSample(sql, current, shadow, common, key, stats, handle.sampleSize),
  };
}

async function diffNewTable(
  sql: postgres.Sql,
  handle: SnapshotCaptureHandle,
  after: TableSchema,
  current: string,
): Promise<TableDataDiff | null> {
  const columns: CommonColumn[] = after.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    castToText: needsTextCast(c.dataType),
  }));

  const [row] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${current}`,
  );
  const inserted = Number(row?.count ?? 0);
  if (inserted === 0) return null;

  const key = usableKey(after, columns);
  const withinThreshold = inserted <= handle.rowThreshold;
  const limit = withinThreshold ? handle.rowThreshold : handle.sampleSize;

  const rows = await sql.unsafe<{ after: Record<string, CellValue> }[]>(
    `select to_jsonb(t) as after
     from (select ${selectList("x", columns)} from ${current} x) t
     limit ${limit}`,
  );
  const changes = rows.map((r) => insertChange(r.after, columns, key));

  const base = {
    schema: after.schema,
    name: after.name,
    primaryKey: key,
    columns: after.columns.map((c): DiffColumn => ({
      name: c.name,
      dataType: c.dataType,
    })),
    counts: { inserted, updated: 0, deleted: 0 },
    rowsBefore: 0,
  };

  return withinThreshold
    ? { ...base, detail: "rows", rows: changes }
    : { ...base, detail: "aggregate", columnStats: [], sample: changes };
}

/** A primary key is only usable if every one of its columns still exists. */
function usableKey(
  table: TableSchema,
  common: readonly CommonColumn[],
): string[] | null {
  const key = table.primaryKey;
  if (key === null) return null;
  const names = new Set(common.map((c) => c.name));
  return key.every((c) => names.has(c)) ? [...key] : null;
}

function nonKey(
  common: readonly CommonColumn[],
  key: readonly string[],
): CommonColumn[] {
  return common.filter((c) => !key.includes(c.name));
}

async function countChanges(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly CommonColumn[],
  key: readonly string[] | null,
): Promise<Counts> {
  if (key === null) return await countChangesWithoutKey(sql, current, shadow, common);

  const anchor = quoteIdent(key[0] as string);
  const join = keyJoin("c", "o", key);
  const comparable = nonKey(common, key);

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
  common: readonly CommonColumn[],
): Promise<Counts> {
  if (common.length === 0) return { inserted: 0, updated: 0, deleted: 0 };

  const currentRows = `select ${selectList("c", common)} from ${current} c`;
  const shadowRows = `select ${selectList("o", common)} from ${shadow} o`;

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
  common: readonly CommonColumn[],
  key: readonly string[] | null,
  limit: number,
): Promise<RowChange[]> {
  if (key === null) {
    return await fetchRowsWithoutKey(sql, current, shadow, common, limit);
  }

  const anchor = quoteIdent(key[0] as string);
  const join = keyJoin("c", "o", key);
  const order = key.map((c) => `t.${quoteIdent(c)}`).join(", ");
  const comparable = nonKey(common, key);
  const changes: RowChange[] = [];

  const inserted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as after from (
       select ${selectList("c", common)} from ${current} c
       left join ${shadow} o on ${join} where o.${anchor} is null
     ) t order by ${order} limit ${limit}`,
  );
  for (const row of inserted) {
    if (row.after) changes.push(insertChange(row.after, common, key));
  }

  if (comparable.length > 0) {
    for (const row of await fetchUpdated(
      sql,
      current,
      shadow,
      common,
      key,
      `where ${rowDistinct("c", "o", comparable)}`,
      limit,
    )) {
      changes.push(row);
    }
  }

  const deleted = await sql.unsafe<RowPair[]>(
    `select to_jsonb(t) as before from (
       select ${selectList("o", common)} from ${shadow} o
       left join ${current} c on ${join} where c.${anchor} is null
     ) t order by ${order} limit ${limit}`,
  );
  for (const row of deleted) {
    if (row.before) changes.push(deleteChange(row.before, common, key));
  }

  return changes;
}

async function fetchUpdated(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly CommonColumn[],
  key: readonly string[],
  predicate: string,
  limit: number,
): Promise<RowChange[]> {
  const join = keyJoin("c", "o", key);
  const rows = await sql.unsafe<RowPair[]>(
    `select to_jsonb(c) as after, to_jsonb(o) as before from (
       select ${selectList("c", common)} from ${current} c
       join ${shadow} o on ${join} ${predicate}
       order by ${key.map((k) => `c.${quoteIdent(k)}`).join(", ")} limit ${limit}
     ) c join (select ${selectList("o", common)} from ${shadow} o) o
     on ${join}
     order by ${key.map((k) => `c.${quoteIdent(k)}`).join(", ")}`,
  );

  const changes: RowChange[] = [];
  for (const row of rows) {
    if (row.before && row.after) {
      changes.push(updateChange(row.before, row.after, common, key));
    }
  }
  return changes;
}

/**
 * Stratified rather than the first N by key. A uniform bulk update would
 * otherwise produce ten identical lines, which tells a reviewer nothing about
 * the shape of the change.
 */
async function fetchSample(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly CommonColumn[],
  key: readonly string[] | null,
  stats: readonly ColumnChangeStat[],
  size: number,
): Promise<RowChange[]> {
  if (key === null) {
    return await fetchRowsWithoutKey(sql, current, shadow, common, size);
  }

  const byName = new Map(common.map((c) => [c.name, c]));
  const shapes = stats.flatMap((stat) => {
    const column = byName.get(stat.column);
    return column === undefined
      ? []
      : stat.transitions.map((t) => ({ column, transition: t }));
  });

  if (shapes.length === 0) {
    return await fetchRows(sql, current, shadow, common, key, size);
  }

  // One row per distinct transition first, then top up from anything changed.
  const perShape = Math.max(1, Math.floor(size / shapes.length));
  const seen = new Set<string>();
  const changes: RowChange[] = [];

  for (const shape of shapes) {
    if (changes.length >= size) break;
    const rows = await fetchUpdated(
      sql,
      current,
      shadow,
      common,
      key,
      `where ${jsonValue("o", shape.column)} = ${literalJson(shape.transition.before)}
         and ${jsonValue("c", shape.column)} = ${literalJson(shape.transition.after)}`,
      perShape,
    );
    for (const row of rows) {
      const id = JSON.stringify(row.key);
      if (seen.has(id)) continue;
      seen.add(id);
      changes.push(row);
    }
  }
  return changes.slice(0, size);
}

function literalJson(value: CellValue): string {
  return `${quoteJson(JSON.stringify(value ?? null))}::jsonb`;
}

function quoteJson(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

async function fetchRowsWithoutKey(
  sql: postgres.Sql,
  current: string,
  shadow: string,
  common: readonly CommonColumn[],
  limit: number,
): Promise<RowChange[]> {
  if (common.length === 0) return [];

  const currentRows = `select ${selectList("c", common)} from ${current} c`;
  const shadowRows = `select ${selectList("o", common)} from ${shadow} o`;
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
  common: readonly CommonColumn[],
  key: readonly string[],
): Promise<ColumnChangeStat[]> {
  const comparable = nonKey(common, key);
  if (comparable.length === 0) return [];

  const join = keyJoin("c", "o", key);
  const [counted] = await sql.unsafe<Record<string, string>[]>(
    `select ${comparable
      .map(
        (c, i) =>
          `count(*) filter (where ${rowDistinct("c", "o", [c])})::text as ${quoteIdent(`col_${i}`)}`,
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
      `select ${jsonValue("o", column)} as before,
              ${jsonValue("c", column)} as after,
              count(*)::text as count
       from ${current} c join ${shadow} o on ${join}
       where ${rowDistinct("c", "o", [column])}
       group by 1, 2
       order by count(*) desc, 1, 2
       limit ${MAX_TRANSITIONS + 1}`,
    );

    if (rows.length > MAX_TRANSITIONS) {
      const [distinct] = await sql.unsafe<{ count: string }[]>(
        `select count(distinct ${jsonValue("c", column)})::text as count
         from ${current} c join ${shadow} o on ${join}
         where ${rowDistinct("c", "o", [column])}`,
      );
      stats.push({
        column: column.name,
        changed,
        transitions: [],
        distinctAfter: Number(distinct?.count ?? 0),
      });
      continue;
    }

    stats.push({
      column: column.name,
      changed,
      transitions: rows.map(
        (r): ValueTransition => ({
          before: r.before,
          after: r.after,
          count: Number(r.count),
        }),
      ),
    });
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
  columns: readonly CommonColumn[],
  key: readonly string[] | null,
): RowChange {
  return {
    op: "insert",
    key: keyValues(after, key),
    cells: columns
      .filter((c) => key === null || !key.includes(c.name))
      .map((c): CellChange => ({ column: c.name, after: after[c.name] ?? null })),
  };
}

function deleteChange(
  before: Record<string, CellValue>,
  columns: readonly CommonColumn[],
  key: readonly string[] | null,
): RowChange {
  return {
    op: "delete",
    key: keyValues(before, key),
    cells: columns
      .filter((c) => key === null || !key.includes(c.name))
      .map((c): CellChange => ({ column: c.name, before: before[c.name] ?? null })),
  };
}

function updateChange(
  before: Record<string, CellValue>,
  after: Record<string, CellValue>,
  columns: readonly CommonColumn[],
  key: readonly string[],
): RowChange {
  // Only the columns that actually moved. A 40 column table with one changed
  // field should render as one changed field.
  const cells: CellChange[] = [];
  for (const column of columns) {
    if (key.includes(column.name)) continue;
    const from = before[column.name] ?? null;
    const to = after[column.name] ?? null;
    if (!sameValue(from, to)) cells.push({ column: column.name, before: from, after: to });
  }
  return { op: "update", key: keyValues(after, key), cells };
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
