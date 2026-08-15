import type postgres from "postgres";
import type {
  ColumnSchema,
  ConstraintSchema,
  ConstraintType,
  IndexSchema,
  ReplicaIdentity,
  SchemaSnapshot,
  SnapshotOptions,
  TableSchema,
} from "./types.ts";

const DEFAULT_SCHEMAS = ["public"];

// We read pg_catalog rather than information_schema because pg_get_constraintdef
// and pg_get_indexdef hand back canonical text that survives round tripping.
// Reconstructing that from information_schema loses expressions and operator
// classes, and a schema diff that drops detail is worse than no schema diff.

interface TableRow {
  schema_name: string;
  table_name: string;
  partitioned: boolean;
  replica_identity: string;
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  name: string;
  position: number;
  data_type: string;
  nullable: boolean;
  default_expr: string | null;
  identity: boolean;
  generated: boolean;
}

interface ConstraintRow {
  schema_name: string;
  table_name: string;
  name: string;
  contype: string;
  definition: string;
  conkey: number[] | null;
}

interface IndexRow {
  schema_name: string;
  table_name: string;
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}

const CONSTRAINT_TYPES: Record<string, ConstraintType> = {
  p: "primary_key",
  f: "foreign_key",
  u: "unique",
  c: "check",
  x: "exclusion",
  n: "not_null",
};

const REPLICA_IDENTITIES: Record<string, ReplicaIdentity> = {
  d: "default",
  n: "nothing",
  f: "full",
  i: "index",
};

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function groupByTable<T extends { schema_name: string; table_name: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = tableKey(row.schema_name, row.table_name);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

export async function captureSchemaSnapshot(
  sql: postgres.Sql,
  options: SnapshotOptions = {},
): Promise<SchemaSnapshot> {
  const schemas = options.schemas ?? DEFAULT_SCHEMAS;

  const tables = await sql<TableRow[]>`
    select n.nspname as schema_name,
           c.relname as table_name,
           c.relkind = 'p' as partitioned,
           c.relreplident as replica_identity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
    order by n.nspname, c.relname
  `;

  const columns = await sql<ColumnRow[]>`
    select n.nspname as schema_name,
           c.relname as table_name,
           a.attname as name,
           a.attnum as position,
           format_type(a.atttypid, a.atttypmod) as data_type,
           not a.attnotnull as nullable,
           pg_get_expr(d.adbin, d.adrelid) as default_expr,
           a.attidentity <> '' as identity,
           a.attgenerated <> '' as generated
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
      and a.attnum > 0 and not a.attisdropped
    order by n.nspname, c.relname, a.attnum
  `;

  const constraints = await sql<ConstraintRow[]>`
    select n.nspname as schema_name,
           c.relname as table_name,
           con.conname as name,
           con.contype::text as contype,
           pg_get_constraintdef(con.oid) as definition,
           con.conkey as conkey
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
    order by n.nspname, c.relname, con.conname
  `;

  const indexes = await sql<IndexRow[]>`
    select n.nspname as schema_name,
           c.relname as table_name,
           ic.relname as name,
           pg_get_indexdef(i.indexrelid) as definition,
           i.indisunique as is_unique,
           i.indisprimary as is_primary
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
    order by n.nspname, c.relname, ic.relname
  `;

  const columnsByTable = groupByTable(columns);
  const constraintsByTable = groupByTable(constraints);
  const indexesByTable = groupByTable(indexes);

  return {
    capturedAt: new Date().toISOString(),
    scannedSchemas: [...schemas],
    tables: tables.map((table) =>
      buildTable(
        table,
        columnsByTable.get(tableKey(table.schema_name, table.table_name)) ?? [],
        constraintsByTable.get(tableKey(table.schema_name, table.table_name)) ??
          [],
        indexesByTable.get(tableKey(table.schema_name, table.table_name)) ?? [],
      ),
    ),
  };
}

function buildTable(
  table: TableRow,
  columnRows: readonly ColumnRow[],
  constraintRows: readonly ConstraintRow[],
  indexRows: readonly IndexRow[],
): TableSchema {
  const columns: ColumnSchema[] = columnRows.map((row) => ({
    name: row.name,
    position: row.position,
    dataType: row.data_type,
    nullable: row.nullable,
    default: row.default_expr,
    identity: row.identity,
    generated: row.generated,
  }));

  // conkey holds attnums, so resolve through position rather than array index.
  const byPosition = new Map(columns.map((c) => [c.position, c.name]));
  const resolve = (conkey: number[] | null): string[] =>
    (conkey ?? []).flatMap((attnum) => {
      const name = byPosition.get(attnum);
      return name === undefined ? [] : [name];
    });

  const constraints: ConstraintSchema[] = constraintRows.map((row) => ({
    name: row.name,
    type: CONSTRAINT_TYPES[row.contype] ?? "unknown",
    definition: row.definition,
    columns: resolve(row.conkey),
  }));

  const primary = constraints.find((c) => c.type === "primary_key");

  return {
    schema: table.schema_name,
    name: table.table_name,
    partitioned: table.partitioned,
    columns,
    primaryKey: primary && primary.columns.length > 0 ? primary.columns : null,
    constraints,
    indexes: indexRows.map(
      (row): IndexSchema => ({
        name: row.name,
        definition: row.definition,
        unique: row.is_unique,
        primary: row.is_primary,
      }),
    ),
    replicaIdentity: REPLICA_IDENTITIES[table.replica_identity] ?? "default",
  };
}
