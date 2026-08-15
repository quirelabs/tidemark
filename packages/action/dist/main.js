// src/main.ts
import { spawn } from "child_process";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { join as join2 } from "path";

// ../core/src/artifact/schema.ts
var ARTIFACT_SCHEMA_VERSION = 1;

// ../core/src/schema/snapshot.ts
var DEFAULT_SCHEMAS = ["public"];
var CONSTRAINT_TYPES = {
  p: "primary_key",
  f: "foreign_key",
  u: "unique",
  c: "check",
  x: "exclusion",
  n: "not_null"
};
var REPLICA_IDENTITIES = {
  d: "default",
  n: "nothing",
  f: "full",
  i: "index"
};
function tableKey(schema2, table) {
  return `${schema2}.${table}`;
}
function groupByTable(rows) {
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key2 = tableKey(row.schema_name, row.table_name);
    const bucket = grouped.get(key2);
    if (bucket) bucket.push(row);
    else grouped.set(key2, [row]);
  }
  return grouped;
}
async function captureSchemaSnapshot(sql, options = {}) {
  const schemas = options.schemas ?? DEFAULT_SCHEMAS;
  const tables = await sql`
    select c.oid::text as oid,
           n.nspname as schema_name,
           c.relname as table_name,
           c.relkind = 'p' as partitioned,
           c.relreplident as replica_identity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
    order by n.nspname, c.relname
  `;
  const columns = await sql`
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
  const constraints = await sql`
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
  const indexes = await sql`
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
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scannedSchemas: [...schemas],
    tables: tables.map(
      (table) => buildTable(
        table,
        columnsByTable.get(tableKey(table.schema_name, table.table_name)) ?? [],
        constraintsByTable.get(tableKey(table.schema_name, table.table_name)) ?? [],
        indexesByTable.get(tableKey(table.schema_name, table.table_name)) ?? []
      )
    )
  };
}
function buildTable(table, columnRows, constraintRows, indexRows) {
  const columns = columnRows.map((row) => ({
    name: row.name,
    position: row.position,
    dataType: row.data_type,
    nullable: row.nullable,
    default: row.default_expr,
    identity: row.identity,
    generated: row.generated
  }));
  const byPosition = new Map(columns.map((c) => [c.position, c.name]));
  const resolve2 = (conkey) => (conkey ?? []).flatMap((attnum) => {
    const name = byPosition.get(attnum);
    return name === void 0 ? [] : [name];
  });
  const constraints = constraintRows.map((row) => ({
    name: row.name,
    type: CONSTRAINT_TYPES[row.contype] ?? "unknown",
    definition: row.definition,
    columns: resolve2(row.conkey)
  }));
  const primary = constraints.find((c) => c.type === "primary_key");
  return {
    oid: table.oid,
    schema: table.schema_name,
    name: table.table_name,
    partitioned: table.partitioned,
    columns,
    primaryKey: primary && primary.columns.length > 0 ? primary.columns : null,
    constraints,
    indexes: indexRows.map(
      (row) => ({
        name: row.name,
        definition: row.definition,
        unique: row.is_unique,
        primary: row.is_primary
      })
    ),
    replicaIdentity: REPLICA_IDENTITIES[table.replica_identity] ?? "default"
  };
}

// ../core/src/capture/identifiers.ts
function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
function qualify(schema2, name) {
  return `${quoteIdent(schema2)}.${quoteIdent(name)}`;
}
var EXACT_NUMERIC = /^(bigint|numeric|decimal)/i;
function needsTextCast(dataType) {
  return EXACT_NUMERIC.test(dataType);
}
function columnRef(alias, column) {
  const ref3 = `${alias}.${quoteIdent(column.name)}`;
  return column.castToText ? `${ref3}::text` : ref3;
}
function selectList(alias, columns) {
  return columns.map((c) => `${columnRef(alias, c)} as ${quoteIdent(c.name)}`).join(", ");
}
function keyJoin(left, right, key2) {
  return key2.map((c) => `${left}.${quoteIdent(c)} = ${right}.${quoteIdent(c)}`).join(" and ");
}
function rowDistinct(left, right, columns) {
  const l = columns.map((c) => columnRef(left, c)).join(", ");
  const r = columns.map((c) => columnRef(right, c)).join(", ");
  return `(${l}) is distinct from (${r})`;
}
function jsonValue(alias, column) {
  return `to_jsonb(${columnRef(alias, column)})`;
}

// ../core/src/capture/snapshot-backend.ts
var DEFAULT_SHADOW_SCHEMA = "tidemark_snapshot";
var DEFAULT_ROW_THRESHOLD = 50;
var DEFAULT_SAMPLE_SIZE = 10;
var MAX_TRANSITIONS = 5;
async function startSnapshotCapture(sql, options = {}) {
  const shadowSchema = options.shadowSchema ?? DEFAULT_SHADOW_SCHEMA;
  const schemas = (options.schemas ?? ["public"]).filter(
    (s) => s !== shadowSchema
  );
  const schemaBefore = await captureSchemaSnapshot(sql, { schemas });
  await sql.unsafe(
    `drop schema if exists ${quoteIdent(shadowSchema)} cascade;
     create schema ${quoteIdent(shadowSchema)}`
  );
  for (const table of capturableTables(schemaBefore)) {
    await sql.unsafe(
      `create table ${qualify(shadowSchema, shadowName(table))}
       as table ${qualify(table.schema, table.name)}`
    );
  }
  return {
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    schemaBefore,
    shadowSchema,
    rowThreshold: options.rowThreshold ?? DEFAULT_ROW_THRESHOLD,
    sampleSize: options.sampleSize ?? DEFAULT_SAMPLE_SIZE,
    schemas
  };
}
async function stopSnapshotCapture(sql, handle) {
  const schemaAfter = await captureSchemaSnapshot(sql, {
    schemas: handle.schemas
  });
  const before = new Map(
    capturableTables(handle.schemaBefore).map((t) => [t.oid, t])
  );
  const tables = [];
  for (const table of capturableTables(schemaAfter)) {
    const diff = await diffTable(sql, handle, table, before.get(table.oid) ?? null);
    if (diff !== null) tables.push(diff);
  }
  return {
    stoppedAt: (/* @__PURE__ */ new Date()).toISOString(),
    schemaBefore: handle.schemaBefore,
    schemaAfter,
    tables
  };
}
async function dropShadowSchema(sql, shadowSchema = DEFAULT_SHADOW_SCHEMA) {
  await sql.unsafe(`drop schema if exists ${quoteIdent(shadowSchema)} cascade`);
}
function capturableTables(snapshot) {
  return snapshot.tables.filter((t) => !t.partitioned);
}
function shadowName(table) {
  return `${table.schema}.${table.name}`;
}
function commonColumns(after, before) {
  const beforeTypes = new Map(before.columns.map((c) => [c.name, c.dataType]));
  const columns = [];
  for (const column of after.columns) {
    const beforeType = beforeTypes.get(column.name);
    if (beforeType === void 0) continue;
    columns.push({
      name: column.name,
      dataType: column.dataType,
      // A retyped column has no operator both sides can use, so compare as text.
      castToText: needsTextCast(column.dataType) || beforeType !== column.dataType
    });
  }
  return columns;
}
async function diffTable(sql, handle, after, before) {
  const current = qualify(after.schema, after.name);
  if (before === null) return await diffNewTable(sql, handle, after, current);
  const shadow = qualify(handle.shadowSchema, shadowName(before));
  const common = commonColumns(after, before);
  const key2 = usableKey(after, common);
  const counts = await countChanges(sql, current, shadow, common, key2);
  const total = counts.inserted + counts.updated + counts.deleted;
  if (total === 0) return null;
  const [countRow] = await sql.unsafe(
    `select count(*)::text as count from ${shadow}`
  );
  const base = {
    schema: after.schema,
    name: after.name,
    primaryKey: key2,
    columns: common.map((c) => ({ name: c.name, dataType: c.dataType })),
    counts,
    rowsBefore: Number(countRow?.count ?? 0)
  };
  if (total <= handle.rowThreshold) {
    return {
      ...base,
      detail: "rows",
      rows: await fetchRows(sql, current, shadow, common, key2, handle.rowThreshold)
    };
  }
  const stats = key2 === null ? [] : await columnStats(sql, current, shadow, common, key2);
  return {
    ...base,
    detail: "aggregate",
    columnStats: stats,
    sample: await fetchSample(sql, current, shadow, common, key2, stats, handle.sampleSize)
  };
}
async function diffNewTable(sql, handle, after, current) {
  const columns = after.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    castToText: needsTextCast(c.dataType)
  }));
  const [row] = await sql.unsafe(
    `select count(*)::text as count from ${current}`
  );
  const inserted = Number(row?.count ?? 0);
  if (inserted === 0) return null;
  const key2 = usableKey(after, columns);
  const withinThreshold = inserted <= handle.rowThreshold;
  const limit = withinThreshold ? handle.rowThreshold : handle.sampleSize;
  const rows = await sql.unsafe(
    `select to_jsonb(t) as after
     from (select ${selectList("x", columns)} from ${current} x) t
     limit ${limit}`
  );
  const changes = rows.map((r) => insertChange(r.after, columns, key2));
  const base = {
    schema: after.schema,
    name: after.name,
    primaryKey: key2,
    columns: after.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType
    })),
    counts: { inserted, updated: 0, deleted: 0 },
    rowsBefore: 0
  };
  return withinThreshold ? { ...base, detail: "rows", rows: changes } : { ...base, detail: "aggregate", columnStats: [], sample: changes };
}
function usableKey(table, common) {
  const key2 = table.primaryKey;
  if (key2 === null) return null;
  const names = new Set(common.map((c) => c.name));
  return key2.every((c) => names.has(c)) ? [...key2] : null;
}
function nonKey(common, key2) {
  return common.filter((c) => !key2.includes(c.name));
}
async function countChanges(sql, current, shadow, common, key2) {
  if (key2 === null) return await countChangesWithoutKey(sql, current, shadow, common);
  const anchor = quoteIdent(key2[0]);
  const join3 = keyJoin("c", "o", key2);
  const comparable = nonKey(common, key2);
  const [row] = await sql.unsafe(
    `select
       (select count(*) from ${current} c
          left join ${shadow} o on ${join3} where o.${anchor} is null)::text as inserted,
       (select count(*) from ${shadow} o
          left join ${current} c on ${join3} where c.${anchor} is null)::text as deleted,
       ${comparable.length === 0 ? "'0'" : `(select count(*) from ${current} c join ${shadow} o on ${join3}
                where ${rowDistinct("c", "o", comparable)})::text`} as updated`
  );
  return {
    inserted: Number(row?.inserted ?? 0),
    updated: Number(row?.updated ?? 0),
    deleted: Number(row?.deleted ?? 0)
  };
}
async function countChangesWithoutKey(sql, current, shadow, common) {
  if (common.length === 0) return { inserted: 0, updated: 0, deleted: 0 };
  const currentRows = `select ${selectList("c", common)} from ${current} c`;
  const shadowRows = `select ${selectList("o", common)} from ${shadow} o`;
  const [row] = await sql.unsafe(
    `select
       (select count(*) from (${currentRows} except all ${shadowRows}) i)::text as inserted,
       (select count(*) from (${shadowRows} except all ${currentRows}) d)::text as deleted`
  );
  return {
    inserted: Number(row?.inserted ?? 0),
    updated: 0,
    deleted: Number(row?.deleted ?? 0)
  };
}
async function fetchRows(sql, current, shadow, common, key2, limit) {
  if (key2 === null) {
    return await fetchRowsWithoutKey(sql, current, shadow, common, limit);
  }
  const anchor = quoteIdent(key2[0]);
  const join3 = keyJoin("c", "o", key2);
  const order = key2.map((c) => `t.${quoteIdent(c)}`).join(", ");
  const comparable = nonKey(common, key2);
  const changes = [];
  const inserted = await sql.unsafe(
    `select to_jsonb(t) as after from (
       select ${selectList("c", common)} from ${current} c
       left join ${shadow} o on ${join3} where o.${anchor} is null
     ) t order by ${order} limit ${limit}`
  );
  for (const row of inserted) {
    if (row.after) changes.push(insertChange(row.after, common, key2));
  }
  if (comparable.length > 0) {
    for (const row of await fetchUpdated(
      sql,
      current,
      shadow,
      common,
      key2,
      `where ${rowDistinct("c", "o", comparable)}`,
      limit
    )) {
      changes.push(row);
    }
  }
  const deleted = await sql.unsafe(
    `select to_jsonb(t) as before from (
       select ${selectList("o", common)} from ${shadow} o
       left join ${current} c on ${join3} where c.${anchor} is null
     ) t order by ${order} limit ${limit}`
  );
  for (const row of deleted) {
    if (row.before) changes.push(deleteChange(row.before, common, key2));
  }
  return changes;
}
async function fetchUpdated(sql, current, shadow, common, key2, predicate, limit) {
  const join3 = keyJoin("c", "o", key2);
  const rows = await sql.unsafe(
    `select to_jsonb(c) as after, to_jsonb(o) as before from (
       select ${selectList("c", common)} from ${current} c
       join ${shadow} o on ${join3} ${predicate}
       order by ${key2.map((k) => `c.${quoteIdent(k)}`).join(", ")} limit ${limit}
     ) c join (select ${selectList("o", common)} from ${shadow} o) o
     on ${join3}
     order by ${key2.map((k) => `c.${quoteIdent(k)}`).join(", ")}`
  );
  const changes = [];
  for (const row of rows) {
    if (row.before && row.after) {
      changes.push(updateChange(row.before, row.after, common, key2));
    }
  }
  return changes;
}
async function fetchSample(sql, current, shadow, common, key2, stats, size2) {
  if (key2 === null) {
    return await fetchRowsWithoutKey(sql, current, shadow, common, size2);
  }
  const byName2 = new Map(common.map((c) => [c.name, c]));
  const shapes = stats.flatMap((stat2) => {
    const column = byName2.get(stat2.column);
    return column === void 0 ? [] : stat2.transitions.map((t) => ({ column, transition: t }));
  });
  if (shapes.length === 0) {
    return await fetchRows(sql, current, shadow, common, key2, size2);
  }
  const perShape = Math.max(1, Math.floor(size2 / shapes.length));
  const seen = /* @__PURE__ */ new Set();
  const changes = [];
  for (const shape of shapes) {
    if (changes.length >= size2) break;
    const rows = await fetchUpdated(
      sql,
      current,
      shadow,
      common,
      key2,
      `where ${jsonValue("o", shape.column)} = ${literalJson(shape.transition.before)}
         and ${jsonValue("c", shape.column)} = ${literalJson(shape.transition.after)}`,
      perShape
    );
    for (const row of rows) {
      const id = JSON.stringify(row.key);
      if (seen.has(id)) continue;
      seen.add(id);
      changes.push(row);
    }
  }
  return changes.slice(0, size2);
}
function literalJson(value) {
  return `${quoteJson(JSON.stringify(value ?? null))}::jsonb`;
}
function quoteJson(text) {
  return `'${text.replaceAll("'", "''")}'`;
}
async function fetchRowsWithoutKey(sql, current, shadow, common, limit) {
  if (common.length === 0) return [];
  const currentRows = `select ${selectList("c", common)} from ${current} c`;
  const shadowRows = `select ${selectList("o", common)} from ${shadow} o`;
  const changes = [];
  const inserted = await sql.unsafe(
    `select to_jsonb(t) as after from (${currentRows} except all ${shadowRows}) t limit ${limit}`
  );
  for (const row of inserted) {
    if (row.after) changes.push(insertChange(row.after, common, null));
  }
  const deleted = await sql.unsafe(
    `select to_jsonb(t) as before from (${shadowRows} except all ${currentRows}) t limit ${limit}`
  );
  for (const row of deleted) {
    if (row.before) changes.push(deleteChange(row.before, common, null));
  }
  return changes;
}
async function columnStats(sql, current, shadow, common, key2) {
  const comparable = nonKey(common, key2);
  if (comparable.length === 0) return [];
  const join3 = keyJoin("c", "o", key2);
  const [counted] = await sql.unsafe(
    `select ${comparable.map(
      (c, i) => `count(*) filter (where ${rowDistinct("c", "o", [c])})::text as ${quoteIdent(`col_${i}`)}`
    ).join(", ")}
     from ${current} c join ${shadow} o on ${join3}`
  );
  const stats = [];
  for (const [index, column] of comparable.entries()) {
    const changed = Number(counted?.[`col_${index}`] ?? 0);
    if (changed === 0) continue;
    const rows = await sql.unsafe(
      `select ${jsonValue("o", column)} as before,
              ${jsonValue("c", column)} as after,
              count(*)::text as count
       from ${current} c join ${shadow} o on ${join3}
       where ${rowDistinct("c", "o", [column])}
       group by 1, 2
       order by count(*) desc, 1, 2
       limit ${MAX_TRANSITIONS + 1}`
    );
    if (rows.length > MAX_TRANSITIONS) {
      const [distinct] = await sql.unsafe(
        `select count(distinct ${jsonValue("c", column)})::text as count
         from ${current} c join ${shadow} o on ${join3}
         where ${rowDistinct("c", "o", [column])}`
      );
      stats.push({
        column: column.name,
        changed,
        transitions: [],
        distinctAfter: Number(distinct?.count ?? 0)
      });
      continue;
    }
    stats.push({
      column: column.name,
      changed,
      transitions: rows.map(
        (r) => ({
          before: r.before,
          after: r.after,
          count: Number(r.count)
        })
      )
    });
  }
  return stats;
}
function keyValues(row, key2) {
  return key2 === null ? [] : key2.map((c) => row[c] ?? null);
}
function insertChange(after, columns, key2) {
  return {
    op: "insert",
    key: keyValues(after, key2),
    cells: columns.filter((c) => key2 === null || !key2.includes(c.name)).map((c) => ({ column: c.name, after: after[c.name] ?? null }))
  };
}
function deleteChange(before, columns, key2) {
  return {
    op: "delete",
    key: keyValues(before, key2),
    cells: columns.filter((c) => key2 === null || !key2.includes(c.name)).map((c) => ({ column: c.name, before: before[c.name] ?? null }))
  };
}
function updateChange(before, after, columns, key2) {
  const cells = [];
  for (const column of columns) {
    if (key2.includes(column.name)) continue;
    const from = before[column.name] ?? null;
    const to = after[column.name] ?? null;
    if (!sameValue(from, to)) cells.push({ column: column.name, before: from, after: to });
  }
  return { op: "update", key: keyValues(after, key2), cells };
}
function sameValue(a, b2) {
  if (a === b2) return true;
  if (a === null || b2 === null) return false;
  if (typeof a !== "object" || typeof b2 !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b2);
}

// ../core/src/diff/schema-diff.ts
function diffSchemas(before, after) {
  const beforeByOid = new Map(before.tables.map((t) => [t.oid, t]));
  const afterByOid = new Map(after.tables.map((t) => [t.oid, t]));
  const tablesAdded = [];
  const tablesAltered = [];
  for (const table of after.tables) {
    const previous = beforeByOid.get(table.oid);
    if (previous === void 0) {
      tablesAdded.push(ref(table));
      continue;
    }
    const altered = diffTable2(previous, table);
    if (altered !== null) tablesAltered.push(altered);
  }
  const tablesRemoved = before.tables.filter((t) => !afterByOid.has(t.oid)).map(ref);
  return {
    tablesAdded: sortRefs(tablesAdded),
    tablesRemoved: sortRefs(tablesRemoved),
    tablesAltered: tablesAltered.sort((a, b2) => label(a).localeCompare(label(b2)))
  };
}
function ref(table) {
  return { schema: table.schema, name: table.name };
}
function label(table) {
  return `${table.schema}.${table.name}`;
}
function sortRefs(refs) {
  return refs.sort((a, b2) => label(a).localeCompare(label(b2)));
}
function diffTable2(before, after) {
  const beforeColumns = new Map(before.columns.map((c) => [c.name, c]));
  const afterColumns = new Map(after.columns.map((c) => [c.name, c]));
  const columnsAdded = [];
  const columnsAltered = [];
  for (const column of after.columns) {
    const previous = beforeColumns.get(column.name);
    if (previous === void 0) {
      columnsAdded.push(definition(column));
      continue;
    }
    if (columnChanged(previous, column)) {
      columnsAltered.push({
        name: column.name,
        before: definition(previous),
        after: definition(column)
      });
    }
  }
  const columnsRemoved = before.columns.filter((c) => !afterColumns.has(c.name)).map(definition);
  const constraints = diffNamed(
    before.constraints.map(namedConstraint),
    after.constraints.map(namedConstraint)
  );
  const indexes = diffNamed(
    before.indexes.map(namedIndex),
    after.indexes.map(namedIndex)
  );
  const renamed = before.name !== after.name || before.schema !== after.schema;
  const changed = columnsAdded.length > 0 || columnsRemoved.length > 0 || columnsAltered.length > 0 || constraints.added.length > 0 || constraints.removed.length > 0 || indexes.added.length > 0 || indexes.removed.length > 0;
  if (!changed && !renamed) return null;
  return {
    schema: after.schema,
    name: after.name,
    ...renamed ? { renamedFrom: ref(before) } : {},
    columnsAdded,
    columnsRemoved,
    columnsAltered,
    constraintsAdded: constraints.added,
    constraintsRemoved: constraints.removed,
    indexesAdded: indexes.added,
    indexesRemoved: indexes.removed
  };
}
function columnChanged(before, after) {
  return before.dataType !== after.dataType || before.nullable !== after.nullable || before.default !== after.default || before.identity !== after.identity || before.generated !== after.generated;
}
function definition(column) {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    default: column.default
  };
}
function namedConstraint(constraint) {
  return { name: constraint.name, definition: constraint.definition };
}
function namedIndex(index) {
  return { name: index.name, definition: index.definition };
}
function diffNamed(before, after) {
  const beforeByName = new Map(before.map((d) => [d.name, d]));
  const afterByName = new Map(after.map((d) => [d.name, d]));
  const added = after.filter((d) => {
    const previous = beforeByName.get(d.name);
    return previous === void 0 || previous.definition !== d.definition;
  });
  const removed = before.filter((d) => {
    const next = afterByName.get(d.name);
    return next === void 0 || next.definition !== d.definition;
  });
  return {
    added: added.sort(byName),
    removed: removed.sort(byName)
  };
}
function byName(a, b2) {
  return a.name.localeCompare(b2.name);
}

// ../core/src/redaction/patterns.ts
var DEFAULT_SENSITIVE_PATTERNS = [
  /pass(word|wd|phrase)?(_?hash)?$/i,
  /_?secret$/i,
  /(^|_)secret/i,
  /(^|_)token$/i,
  /api_?key/i,
  /private_?key/i,
  /(^|_)session(_?id)?$/i,
  /credit_?card|card_?number|(^|_)cvv$/i,
  /(^|_)ssn$|social_security/i,
  /(^|_)salt$/i
];
function isSensitiveColumn(column, patterns = DEFAULT_SENSITIVE_PATTERNS) {
  return patterns.some((pattern) => pattern.test(column));
}
var NOTABLE_PII_PATTERNS = [
  /e?mail/i,
  /phone|mobile|msisdn/i,
  /address|street|postcode|zip/i,
  /(^|_)dob$|birth/i,
  /(^|_)ip(_?address)?$/i,
  /passport|national_?id|tax_?id/i
];
function isNotablePii(column) {
  return NOTABLE_PII_PATTERNS.some((pattern) => pattern.test(column));
}
function globMatches(pattern, value) {
  if (pattern === "*") return true;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

// ../core/src/text/safe-text.ts
var BIDI_NAMES = {
  8206: "LRM",
  8207: "RLM",
  8234: "LRE",
  8235: "RLE",
  8236: "PDF",
  8237: "LRO",
  8238: "RLO",
  8294: "LRI",
  8295: "RLI",
  8296: "FSI",
  8297: "PDI"
};
var ZERO_WIDTH_NAMES = {
  8203: "ZWSP",
  8204: "ZWNJ",
  8205: "ZWJ",
  8288: "WJ",
  65279: "BOM"
};
var ASCII_ESCAPES = {
  0: "\\0",
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
  27: "\\e",
  127: "\\x7f"
};
var EXTENDED_PICTOGRAPHIC = new RegExp("\\p{Extended_Pictographic}", "u");
function hex(codePoint) {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}
function isPrivateUse(codePoint) {
  return codePoint >= 57344 && codePoint <= 63743 || codePoint >= 983040 && codePoint <= 1048573 || codePoint >= 1048576 && codePoint <= 1114109;
}
function makeDisplaySafe(input2, glyphs = "unicode") {
  const counts = /* @__PURE__ */ new Map();
  const flag = (type) => counts.set(type, (counts.get(type) ?? 0) + 1);
  const points = Array.from(input2);
  let out = "";
  for (let i = 0; i < points.length; i++) {
    const character = points[i];
    const cp = character.codePointAt(0) ?? 0;
    if (cp === 8205 && isEmojiJoin(points, i)) {
      out += character;
      continue;
    }
    const bidi = BIDI_NAMES[cp];
    if (bidi !== void 0) {
      flag("bidi_control");
      out += `<${bidi}>`;
      continue;
    }
    const zeroWidth = ZERO_WIDTH_NAMES[cp];
    if (zeroWidth !== void 0) {
      flag("zero_width");
      out += `<${zeroWidth}>`;
      continue;
    }
    if (cp >= 55296 && cp <= 57343) {
      flag("unpaired_surrogate");
      out += hex(cp);
      continue;
    }
    if (isPrivateUse(cp)) {
      flag("private_use");
      out += hex(cp);
      continue;
    }
    if (cp === 27) {
      flag("ansi_escape");
      out += glyphs === "ascii" ? "\\e" : "\u241B";
      continue;
    }
    if (cp === 10 || cp === 13) {
      flag("line_break");
      out += glyphs === "ascii" ? ASCII_ESCAPES[cp] : controlPicture(cp);
      continue;
    }
    if (cp < 32 || cp === 127) {
      flag("control_char");
      out += glyphs === "ascii" ? ASCII_ESCAPES[cp] ?? `\\x${cp.toString(16).padStart(2, "0")}` : controlPicture(cp);
      continue;
    }
    if (cp >= 128 && cp <= 159) {
      flag("control_char");
      out += hex(cp);
      continue;
    }
    out += character;
  }
  return {
    text: out,
    hazards: [...counts].map(([type, count2]) => ({ type, count: count2 }))
  };
}
function scanHazards(input2) {
  return makeDisplaySafe(input2).hazards;
}
function controlPicture(codePoint) {
  if (codePoint === 127) return "\u2421";
  return String.fromCodePoint(9216 + codePoint);
}
function isEmojiJoin(points, index) {
  const before = points[index - 1];
  const after = points[index + 1];
  return before !== void 0 && after !== void 0 && EXTENDED_PICTOGRAPHIC.test(before) && EXTENDED_PICTOGRAPHIC.test(after);
}

// ../core/src/diff/warnings.ts
function classifyWarnings(schema2, tables, options = {}) {
  const patterns = options.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  const warnings2 = [];
  for (const table of schema2.tablesRemoved) {
    warnings2.push({
      code: "drop_table",
      severity: "danger",
      message: `DROP TABLE ${label2(table)}`,
      table
    });
  }
  for (const table of schema2.tablesAltered) {
    const ref3 = { schema: table.schema, name: table.name };
    const rowsBefore = rowsBeforeFor(tables, ref3);
    for (const column of table.columnsRemoved) {
      warnings2.push({
        code: "drop_column",
        severity: "danger",
        message: `DROP COLUMN ${label2(ref3)}.${column.name}`,
        table: ref3,
        columns: [column.name]
      });
    }
    for (const column of table.columnsAltered) {
      if (isNarrowing(column)) {
        warnings2.push({
          code: "type_narrowed",
          severity: "caution",
          message: `${label2(ref3)}.${column.name} narrowed from ${column.before.dataType} to ${column.after.dataType}`,
          table: ref3,
          columns: [column.name]
        });
      }
      if (column.before.nullable && !column.after.nullable) {
        const populated = rowsBefore !== null && rowsBefore > 0;
        warnings2.push({
          code: "not_null_added_to_populated",
          severity: populated ? "danger" : "caution",
          message: populated ? `NOT NULL added to ${label2(ref3)}.${column.name} on a table holding ${rowsBefore} rows` : `NOT NULL added to ${label2(ref3)}.${column.name}`,
          table: ref3,
          columns: [column.name],
          ...populated ? { rowsAffected: rowsBefore } : {}
        });
      }
    }
  }
  for (const table of tables) {
    const ref3 = { schema: table.schema, name: table.name };
    warnings2.push(...wholeTableWarnings(table, ref3));
    const changed = changedColumns(table);
    const sensitive = [...changed].filter((c) => isSensitiveColumn(c, patterns));
    if (sensitive.length > 0) {
      warnings2.push({
        code: "sensitive_column_changed",
        severity: "danger",
        message: `credential column changed on ${label2(ref3)}: ${sensitive.sort().join(", ")}`,
        table: ref3,
        columns: sensitive.sort()
      });
    }
    const deceptive = deceptiveColumns(table);
    if (deceptive.length > 0) {
      warnings2.push({
        code: "deceptive_value",
        severity: "danger",
        message: `${label2(ref3)} contains values that can forge or hide output: ${deceptive.join(", ")}`,
        table: ref3,
        columns: deceptive
      });
    }
  }
  return warnings2.sort((a, b2) => rank(a) - rank(b2));
}
function rank(warning) {
  return warning.severity === "danger" ? 0 : 1;
}
function label2(table) {
  return `${table.schema}.${table.name}`;
}
function rowsBeforeFor(tables, ref3) {
  const found = tables.find(
    (t) => t.schema === ref3.schema && t.name === ref3.name
  );
  return found === void 0 ? null : found.rowsBefore;
}
function wholeTableWarnings(table, ref3) {
  const warnings2 = [];
  const { counts, rowsBefore } = table;
  if (rowsBefore <= 1) return warnings2;
  if (counts.updated === rowsBefore) {
    warnings2.push({
      code: "update_without_where",
      severity: "danger",
      message: `every row updated on ${label2(ref3)}, which usually means UPDATE without WHERE`,
      table: ref3,
      rowsAffected: counts.updated
    });
  }
  if (counts.deleted === rowsBefore) {
    warnings2.push({
      code: "delete_without_where",
      severity: "danger",
      message: `every row deleted from ${label2(ref3)}, which usually means DELETE without WHERE or TRUNCATE`,
      table: ref3,
      rowsAffected: counts.deleted
    });
  }
  return warnings2;
}
function rowsOf(table) {
  return table.detail === "rows" ? table.rows : table.sample;
}
function changedColumns(table) {
  const columns = /* @__PURE__ */ new Set();
  for (const row of rowsOf(table)) {
    for (const cell2 of row.cells) columns.add(cell2.column);
  }
  if (table.detail === "aggregate") {
    for (const stat2 of table.columnStats) columns.add(stat2.column);
  }
  return columns;
}
function deceptiveColumns(table) {
  const columns = /* @__PURE__ */ new Set();
  for (const row of rowsOf(table)) {
    for (const cell2 of row.cells) {
      if (isDeceptive(cell2.before) || isDeceptive(cell2.after)) {
        columns.add(cell2.column);
      }
    }
  }
  if (table.detail === "aggregate") {
    for (const stat2 of table.columnStats) {
      for (const transition of stat2.transitions) {
        if (isDeceptive(transition.before) || isDeceptive(transition.after)) {
          columns.add(stat2.column);
        }
      }
    }
  }
  return [...columns].sort();
}
function isDeceptive(value) {
  if (typeof value === "string") return scanHazards(value).length > 0;
  if (value !== null && typeof value === "object") {
    return scanHazards(JSON.stringify(value)).length > 0;
  }
  return false;
}
var LENGTH = /\((\d+)(?:,\s*(\d+))?\)\s*$/;
var INT_RANK = {
  smallint: 1,
  integer: 2,
  bigint: 3
};
var FLOAT_RANK = {
  real: 1,
  "double precision": 2
};
function baseType(dataType) {
  return dataType.replace(LENGTH, "").trim().toLowerCase();
}
function sizes(dataType) {
  const match = LENGTH.exec(dataType);
  if (match === null) return null;
  return [Number(match[1]), match[2] === void 0 ? 0 : Number(match[2])];
}
function isNarrowing(column) {
  const before = column.before.dataType;
  const after = column.after.dataType;
  if (before === after) return false;
  const baseBefore = baseType(before);
  const baseAfter = baseType(after);
  if (baseBefore === baseAfter) {
    const from = sizes(before);
    const to = sizes(after);
    if (from !== null && to !== null) {
      return to[0] < from[0] || to[1] < from[1];
    }
    return from === null && to !== null;
  }
  if (baseBefore === "text" && sizes(after) !== null) return true;
  const intFrom = INT_RANK[baseBefore];
  const intTo = INT_RANK[baseAfter];
  if (intFrom !== void 0 && intTo !== void 0) return intTo < intFrom;
  const floatFrom = FLOAT_RANK[baseBefore];
  const floatTo = FLOAT_RANK[baseAfter];
  if (floatFrom !== void 0 && floatTo !== void 0) return floatTo < floatFrom;
  return false;
}

// ../core/src/redaction/redact.ts
import { createHash } from "crypto";
var TRUNCATE_KEEP = 4;
function redactArtifact(artifact, config = {}) {
  const applied = /* @__PURE__ */ new Map();
  const tables = artifact.tables.map(
    (table) => redactTable(table, config, applied)
  );
  return {
    ...artifact,
    meta: {
      ...artifact.meta,
      redactions: [...applied.values()].sort(
        (a, b2) => key(a.table, a.column).localeCompare(key(b2.table, b2.column))
      )
    },
    tables
  };
}
function key(table, column) {
  return `${table.schema}.${table.name}.${column}`;
}
function redactionFor(table, column, config) {
  const explicit = (config.redact ?? []).filter(
    (rule) => matcherApplies(rule, table, column)
  );
  const last = explicit.at(-1);
  if (last !== void 0) return last.mode ?? "mask";
  if ((config.allow ?? []).some((rule) => matcherApplies(rule, table, column))) {
    return null;
  }
  const patterns = config.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  return isSensitiveColumn(column, patterns) ? "mask" : null;
}
function matcherApplies(matcher, table, column) {
  if (!globMatches(matcher.column, column)) return false;
  if (matcher.table === void 0) return true;
  const qualified = `${table.schema}.${table.name}`;
  return globMatches(matcher.table, qualified) || globMatches(matcher.table, table.name);
}
function redactTable(table, config, applied) {
  const ref3 = { schema: table.schema, name: table.name };
  const modes = /* @__PURE__ */ new Map();
  for (const column of table.columns) {
    const mode = redactionFor(ref3, column.name, config);
    if (mode === null) continue;
    modes.set(column.name, mode);
    applied.set(key(ref3, column.name), { table: ref3, column: column.name, mode });
  }
  if (modes.size === 0) return table;
  const keyColumns = table.primaryKey ?? [];
  const redactRow = (row) => ({
    ...row,
    key: row.key.map((value, index) => {
      const name = keyColumns[index];
      const mode = name === void 0 ? void 0 : modes.get(name);
      return mode === void 0 ? value : applyMode(value, mode);
    }),
    cells: row.cells.map((cell2) => {
      const mode = modes.get(cell2.column);
      if (mode === void 0) return cell2;
      return {
        column: cell2.column,
        ...cell2.before === void 0 ? {} : { before: applyMode(cell2.before, mode) },
        ...cell2.after === void 0 ? {} : { after: applyMode(cell2.after, mode) },
        redacted: mode
      };
    })
  });
  if (table.detail === "rows") {
    return { ...table, rows: table.rows.map(redactRow) };
  }
  return {
    ...table,
    sample: table.sample.map(redactRow),
    columnStats: table.columnStats.map((stat2) => {
      const mode = modes.get(stat2.column);
      if (mode === void 0) return stat2;
      return {
        ...stat2,
        // Transition counts survive, so a reviewer still sees that a credential
        // column changed and on how many rows, without seeing either value.
        transitions: stat2.transitions.map((transition) => ({
          before: applyMode(transition.before, mode),
          after: applyMode(transition.after, mode),
          count: transition.count
        }))
      };
    })
  };
}
function applyMode(value, mode) {
  if (mode === "mask") return null;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (mode === "hash") {
    return `#${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  }
  return text.length <= TRUNCATE_KEEP ? text : `${text.slice(0, TRUNCATE_KEEP)}\u2026`;
}

// ../core/src/config/load.ts
import { stat } from "fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "path";
import { pathToFileURL } from "url";
var CONFIG_NAMES = [
  "tidemark.config.ts",
  "tidemark.config.mts",
  "tidemark.config.js",
  "tidemark.config.mjs"
];
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
async function loadConfig(explicit, cwd = process.cwd()) {
  const path = explicit === void 0 ? await findConfig(cwd) : isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  if (path === null) return { config: {}, path: null };
  if (!await isFile(path)) {
    throw new ConfigError(`No config file at ${path}`);
  }
  return { config: await importConfig(path), path };
}
async function findConfig(cwd) {
  const { root } = parse(cwd);
  let directory = cwd;
  for (; ; ) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) return candidate;
    }
    if (directory === root) return null;
    directory = dirname(directory);
  }
}
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
async function importConfig(path) {
  let loaded;
  try {
    loaded = await import(pathToFileURL(path).href);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Could not load ${path}: ${detail}`);
  }
  const module = loaded;
  const value = module.default ?? module.config;
  if (value === void 0) {
    throw new ConfigError(
      `${path} has no default export. Export your config as default, wrapped in defineConfig().`
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must export an object, got ${typeof value}.`);
  }
  return value;
}
function captureOptionsFrom(config) {
  return {
    ...config.schemas === void 0 ? {} : { schemas: config.schemas },
    ...config.rowThreshold === void 0 ? {} : { rowThreshold: config.rowThreshold },
    ...config.sampleSize === void 0 ? {} : { sampleSize: config.sampleSize }
  };
}

// ../core/src/version.ts
var MIN_POSTGRES_MAJOR = 15;
var TIDEMARK_VERSION = "0.0.1";

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js
import os from "os";
import fs from "fs";

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/query.js
var originCache = /* @__PURE__ */ new Map();
var originStackCache = /* @__PURE__ */ new Map();
var originError = /* @__PURE__ */ Symbol("OriginError");
var CLOSE = {};
var Query = class extends Promise {
  constructor(strings, args, handler, canceller, options = {}) {
    let resolve2, reject;
    super((a, b2) => {
      resolve2 = a;
      reject = b2;
    });
    this.tagged = Array.isArray(strings.raw);
    this.strings = strings;
    this.args = args;
    this.handler = handler;
    this.canceller = canceller;
    this.options = options;
    this.state = null;
    this.statement = null;
    this.resolve = (x) => (this.active = false, resolve2(x));
    this.reject = (x) => (this.active = false, reject(x));
    this.active = false;
    this.cancelled = null;
    this.executed = false;
    this.signature = "";
    this[originError] = this.handler.debug ? new Error() : this.tagged && cachedError(this.strings);
  }
  get origin() {
    return (this.handler.debug ? this[originError].stack : this.tagged && originStackCache.has(this.strings) ? originStackCache.get(this.strings) : originStackCache.set(this.strings, this[originError].stack).get(this.strings)) || "";
  }
  static get [Symbol.species]() {
    return Promise;
  }
  cancel() {
    return this.canceller && (this.canceller(this), this.canceller = null);
  }
  simple() {
    this.options.simple = true;
    this.options.prepare = false;
    return this;
  }
  async readable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  async writable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  cursor(rows = 1, fn) {
    this.options.simple = false;
    if (typeof rows === "function") {
      fn = rows;
      rows = 1;
    }
    this.cursorRows = rows;
    if (typeof fn === "function")
      return this.cursorFn = fn, this;
    let prev;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.executed && !this.active)
            return { done: true };
          prev && prev();
          const promise = new Promise((resolve2, reject) => {
            this.cursorFn = (value) => {
              resolve2({ value, done: false });
              return new Promise((r) => prev = r);
            };
            this.resolve = () => (this.active = false, resolve2({ done: true }));
            this.reject = (x) => (this.active = false, reject(x));
          });
          this.execute();
          return promise;
        },
        return() {
          prev && prev(CLOSE);
          return { done: true };
        }
      })
    };
  }
  describe() {
    this.options.simple = false;
    this.onlyDescribe = this.options.prepare = true;
    return this;
  }
  stream() {
    throw new Error(".stream has been renamed to .forEach");
  }
  forEach(fn) {
    this.forEachFn = fn;
    this.handle();
    return this;
  }
  raw() {
    this.isRaw = true;
    return this;
  }
  values() {
    this.isRaw = "values";
    return this;
  }
  async handle() {
    !this.executed && (this.executed = true) && await 1 && this.handler(this);
  }
  execute() {
    this.handle();
    return this;
  }
  then() {
    this.handle();
    return super.then.apply(this, arguments);
  }
  catch() {
    this.handle();
    return super.catch.apply(this, arguments);
  }
  finally() {
    this.handle();
    return super.finally.apply(this, arguments);
  }
};
function cachedError(xs) {
  if (originCache.has(xs))
    return originCache.get(xs);
  const x = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  originCache.set(xs, new Error());
  Error.stackTraceLimit = x;
  return originCache.get(xs);
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/errors.js
var PostgresError = class extends Error {
  constructor(x) {
    super(x.message);
    this.name = this.constructor.name;
    Object.assign(this, x);
  }
};
var Errors = {
  connection,
  postgres,
  generic,
  notSupported
};
function connection(x, options, socket) {
  const { host, port } = socket || options;
  const error = Object.assign(
    new Error("write " + x + " " + (options.path || host + ":" + port)),
    {
      code: x,
      errno: x,
      address: options.path || host
    },
    options.path ? {} : { port }
  );
  Error.captureStackTrace(error, connection);
  return error;
}
function postgres(x) {
  const error = new PostgresError(x);
  Error.captureStackTrace(error, postgres);
  return error;
}
function generic(code, message) {
  const error = Object.assign(new Error(code + ": " + message), { code });
  Error.captureStackTrace(error, generic);
  return error;
}
function notSupported(x) {
  const error = Object.assign(
    new Error(x + " (B) is not supported"),
    {
      code: "MESSAGE_NOT_SUPPORTED",
      name: x
    }
  );
  Error.captureStackTrace(error, notSupported);
  return error;
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/types.js
var types = {
  string: {
    to: 25,
    from: null,
    // defaults to string
    serialize: (x) => "" + x
  },
  number: {
    to: 0,
    from: [21, 23, 26, 700, 701],
    serialize: (x) => "" + x,
    parse: (x) => +x
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (x) => JSON.stringify(x),
    parse: (x) => JSON.parse(x)
  },
  boolean: {
    to: 16,
    from: 16,
    serialize: (x) => x === true ? "t" : "f",
    parse: (x) => x === "t"
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: (x) => (x instanceof Date ? x : new Date(x)).toISOString(),
    parse: (x) => new Date(x)
  },
  bytea: {
    to: 17,
    from: 17,
    serialize: (x) => "\\x" + Buffer.from(x).toString("hex"),
    parse: (x) => Buffer.from(x.slice(2), "hex")
  }
};
var NotTagged = class {
  then() {
    notTagged();
  }
  catch() {
    notTagged();
  }
  finally() {
    notTagged();
  }
};
var Identifier = class extends NotTagged {
  constructor(value) {
    super();
    this.value = escapeIdentifier(value);
  }
};
var Parameter = class extends NotTagged {
  constructor(value, type, array) {
    super();
    this.value = value;
    this.type = type;
    this.array = array;
  }
};
var Builder = class extends NotTagged {
  constructor(first, rest) {
    super();
    this.first = first;
    this.rest = rest;
  }
  build(before, parameters, types2, options) {
    const keyword = builders.map(([x, fn]) => ({ fn, i: before.search(x) })).sort((a, b2) => a.i - b2.i).pop();
    return keyword.i === -1 ? escapeIdentifiers(this.first, options) : keyword.fn(this.first, this.rest, parameters, types2, options);
  }
};
function handleValue(x, parameters, types2, options) {
  let value = x instanceof Parameter ? x.value : x;
  if (value === void 0) {
    x instanceof Parameter ? x.value = options.transform.undefined : value = x = options.transform.undefined;
    if (value === void 0)
      throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
  }
  return "$" + types2.push(
    x instanceof Parameter ? (parameters.push(x.value), x.array ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value) : x.type) : (parameters.push(x), inferType(x))
  );
}
var defaultHandlers = typeHandlers(types);
function stringify(q, string, value, parameters, types2, options) {
  for (let i = 1; i < q.strings.length; i++) {
    string += stringifyValue(string, value, parameters, types2, options) + q.strings[i];
    value = q.args[i];
  }
  return string;
}
function stringifyValue(string, value, parameters, types2, o) {
  return value instanceof Builder ? value.build(string, parameters, types2, o) : value instanceof Query ? fragment(value, parameters, types2, o) : value instanceof Identifier ? value.value : value && value[0] instanceof Query ? value.reduce((acc, x) => acc + " " + fragment(x, parameters, types2, o), "") : handleValue(value, parameters, types2, o);
}
function fragment(q, parameters, types2, options) {
  q.fragment = true;
  return stringify(q, q.strings[0], q.args[0], parameters, types2, options);
}
function valuesBuilder(first, parameters, types2, columns, options) {
  return first.map(
    (row) => "(" + columns.map(
      (column) => stringifyValue("values", row[column], parameters, types2, options)
    ).join(",") + ")"
  ).join(",");
}
function values(first, rest, parameters, types2, options) {
  const multi = Array.isArray(first[0]);
  const columns = rest.length ? rest.flat() : Object.keys(multi ? first[0] : first);
  return valuesBuilder(multi ? first : [first], parameters, types2, columns, options);
}
function select(first, rest, parameters, types2, options) {
  typeof first === "string" && (first = [first].concat(rest));
  if (Array.isArray(first))
    return escapeIdentifiers(first, options);
  let value;
  const columns = rest.length ? rest.flat() : Object.keys(first);
  return columns.map((x) => {
    value = first[x];
    return (value instanceof Query ? fragment(value, parameters, types2, options) : value instanceof Identifier ? value.value : handleValue(value, parameters, types2, options)) + " as " + escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x);
  }).join(",");
}
var builders = Object.entries({
  values,
  in: (...xs) => {
    const x = values(...xs);
    return x === "()" ? "(null)" : x;
  },
  select,
  as: select,
  returning: select,
  "\\(": select,
  update(first, rest, parameters, types2, options) {
    return (rest.length ? rest.flat() : Object.keys(first)).map(
      (x) => escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x) + "=" + stringifyValue("values", first[x], parameters, types2, options)
    );
  },
  insert(first, rest, parameters, types2, options) {
    const columns = rest.length ? rest.flat() : Object.keys(Array.isArray(first) ? first[0] : first);
    return "(" + escapeIdentifiers(columns, options) + ")values" + valuesBuilder(Array.isArray(first) ? first : [first], parameters, types2, columns, options);
  }
}).map(([x, fn]) => [new RegExp("((?:^|[\\s(])" + x + "(?:$|[\\s(]))(?![\\s\\S]*\\1)", "i"), fn]);
function notTagged() {
  throw Errors.generic("NOT_TAGGED_CALL", "Query not called as a tagged template literal");
}
var serializers = defaultHandlers.serializers;
var parsers = defaultHandlers.parsers;
function firstIsString(x) {
  if (Array.isArray(x))
    return firstIsString(x[0]);
  return typeof x === "string" ? 1009 : 0;
}
var mergeUserTypes = function(types2) {
  const user = typeHandlers(types2 || {});
  return {
    serializers: Object.assign({}, serializers, user.serializers),
    parsers: Object.assign({}, parsers, user.parsers)
  };
};
function typeHandlers(types2) {
  return Object.keys(types2).reduce((acc, k) => {
    types2[k].from && [].concat(types2[k].from).forEach((x) => acc.parsers[x] = types2[k].parse);
    if (types2[k].serialize) {
      acc.serializers[types2[k].to] = types2[k].serialize;
      types2[k].from && [].concat(types2[k].from).forEach((x) => acc.serializers[x] = types2[k].serialize);
    }
    return acc;
  }, { parsers: {}, serializers: {} });
}
function escapeIdentifiers(xs, { transform: { column } }) {
  return xs.map((x) => escapeIdentifier(column.to ? column.to(x) : x)).join(",");
}
var escapeIdentifier = function escape(str) {
  return '"' + str.replace(/"/g, '""').replace(/\./g, '"."') + '"';
};
var inferType = function inferType2(x) {
  return x instanceof Parameter ? x.type : x instanceof Date ? 1184 : x instanceof Uint8Array ? 17 : x === true || x === false ? 16 : typeof x === "bigint" ? 20 : Array.isArray(x) ? inferType2(x[0]) : 0;
};
var escapeBackslash = /\\/g;
var escapeQuote = /"/g;
function arrayEscape(x) {
  return x.replace(escapeBackslash, "\\\\").replace(escapeQuote, '\\"');
}
var arraySerializer = function arraySerializer2(xs, serializer, options, typarray) {
  if (Array.isArray(xs) === false)
    return xs;
  if (!xs.length)
    return "{}";
  const first = xs[0];
  const delimiter = typarray === 1020 ? ";" : ",";
  if (Array.isArray(first) && !first.type)
    return "{" + xs.map((x) => arraySerializer2(x, serializer, options, typarray)).join(delimiter) + "}";
  return "{" + xs.map((x) => {
    if (x === void 0) {
      x = options.transform.undefined;
      if (x === void 0)
        throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
    }
    return x === null ? "null" : '"' + arrayEscape(serializer ? serializer(x.type ? x.value : x) : "" + x) + '"';
  }).join(delimiter) + "}";
};
var arrayParserState = {
  i: 0,
  char: null,
  str: "",
  quoted: false,
  last: 0
};
var arrayParser = function arrayParser2(x, parser, typarray) {
  arrayParserState.i = arrayParserState.last = 0;
  return arrayParserLoop(arrayParserState, x, parser, typarray);
};
function arrayParserLoop(s, x, parser, typarray) {
  const xs = [];
  const delimiter = typarray === 1020 ? ";" : ",";
  for (; s.i < x.length; s.i++) {
    s.char = x[s.i];
    if (s.quoted) {
      if (s.char === "\\") {
        s.str += x[++s.i];
      } else if (s.char === '"') {
        xs.push(parser ? parser(s.str) : s.str);
        s.str = "";
        s.quoted = x[s.i + 1] === '"';
        s.last = s.i + 2;
      } else {
        s.str += s.char;
      }
    } else if (s.char === '"') {
      s.quoted = true;
    } else if (s.char === "{") {
      s.last = ++s.i;
      xs.push(arrayParserLoop(s, x, parser, typarray));
    } else if (s.char === "}") {
      s.quoted = false;
      s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
      break;
    } else if (s.char === delimiter && s.p !== "}" && s.p !== '"') {
      xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
    }
    s.p = s.char;
  }
  s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i + 1)) : x.slice(s.last, s.i + 1));
  return xs;
}
var toCamel = (x) => {
  let str = x[0];
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
};
var toPascal = (x) => {
  let str = x[0].toUpperCase();
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
};
var toKebab = (x) => x.replace(/_/g, "-");
var fromCamel = (x) => x.replace(/([A-Z])/g, "_$1").toLowerCase();
var fromPascal = (x) => (x.slice(0, 1) + x.slice(1).replace(/([A-Z])/g, "_$1")).toLowerCase();
var fromKebab = (x) => x.replace(/-/g, "_");
function createJsonTransform(fn) {
  return function jsonTransform(x, column) {
    return typeof x === "object" && x !== null && (column.type === 114 || column.type === 3802) ? Array.isArray(x) ? x.map((x2) => jsonTransform(x2, column)) : Object.entries(x).reduce((acc, [k, v]) => Object.assign(acc, { [fn(k)]: jsonTransform(v, column) }), {}) : x;
  };
}
toCamel.column = { from: toCamel };
toCamel.value = { from: createJsonTransform(toCamel) };
fromCamel.column = { to: fromCamel };
var camel = { ...toCamel };
camel.column.to = fromCamel;
toPascal.column = { from: toPascal };
toPascal.value = { from: createJsonTransform(toPascal) };
fromPascal.column = { to: fromPascal };
var pascal = { ...toPascal };
pascal.column.to = fromPascal;
toKebab.column = { from: toKebab };
toKebab.value = { from: createJsonTransform(toKebab) };
fromKebab.column = { to: fromKebab };
var kebab = { ...toKebab };
kebab.column.to = fromKebab;

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js
import net from "net";
import tls from "tls";
import crypto from "crypto";
import Stream from "stream";
import { performance } from "perf_hooks";

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/result.js
var Result = class extends Array {
  constructor() {
    super();
    Object.defineProperties(this, {
      count: { value: null, writable: true },
      state: { value: null, writable: true },
      command: { value: null, writable: true },
      columns: { value: null, writable: true },
      statement: { value: null, writable: true }
    });
  }
  static get [Symbol.species]() {
    return Array;
  }
};

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/queue.js
var queue_default = Queue;
function Queue(initial = []) {
  let xs = initial.slice();
  let index = 0;
  return {
    get length() {
      return xs.length - index;
    },
    remove: (x) => {
      const index2 = xs.indexOf(x);
      return index2 === -1 ? null : (xs.splice(index2, 1), x);
    },
    push: (x) => (xs.push(x), x),
    shift: () => {
      const out = xs[index++];
      if (index === xs.length) {
        index = 0;
        xs = [];
      } else {
        xs[index - 1] = void 0;
      }
      return out;
    }
  };
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/bytes.js
var size = 256;
var buffer = Buffer.allocUnsafe(size);
var messages = "BCcDdEFfHPpQSX".split("").reduce((acc, x) => {
  const v = x.charCodeAt(0);
  acc[x] = () => {
    buffer[0] = v;
    b.i = 5;
    return b;
  };
  return acc;
}, {});
var b = Object.assign(reset, messages, {
  N: String.fromCharCode(0),
  i: 0,
  inc(x) {
    b.i += x;
    return b;
  },
  str(x) {
    const length = Buffer.byteLength(x);
    fit(length);
    b.i += buffer.write(x, b.i, length, "utf8");
    return b;
  },
  i16(x) {
    fit(2);
    buffer.writeUInt16BE(x, b.i);
    b.i += 2;
    return b;
  },
  i32(x, i) {
    if (i || i === 0) {
      buffer.writeUInt32BE(x, i);
      return b;
    }
    fit(4);
    buffer.writeUInt32BE(x, b.i);
    b.i += 4;
    return b;
  },
  z(x) {
    fit(x);
    buffer.fill(0, b.i, b.i + x);
    b.i += x;
    return b;
  },
  raw(x) {
    buffer = Buffer.concat([buffer.subarray(0, b.i), x]);
    b.i = buffer.length;
    return b;
  },
  end(at = 1) {
    buffer.writeUInt32BE(b.i - at, at);
    const out = buffer.subarray(0, b.i);
    b.i = 0;
    buffer = Buffer.allocUnsafe(size);
    return out;
  }
});
var bytes_default = b;
function fit(x) {
  if (buffer.length - b.i < x) {
    const prev = buffer, length = prev.length;
    buffer = Buffer.allocUnsafe(length + (length >> 1) + x);
    prev.copy(buffer);
  }
}
function reset() {
  b.i = 0;
  return b;
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js
var connection_default = Connection;
var uid = 1;
var Sync = bytes_default().S().end();
var Flush = bytes_default().H().end();
var SSLRequest = bytes_default().i32(8).i32(80877103).end(8);
var ExecuteUnnamed = Buffer.concat([bytes_default().E().str(bytes_default.N).i32(0).end(), Sync]);
var DescribeUnnamed = bytes_default().D().str("S").str(bytes_default.N).end();
var noop = () => {
};
var retryRoutines = /* @__PURE__ */ new Set([
  "FetchPreparedStatement",
  "RevalidateCachedQuery",
  "transformAssignedExpr"
]);
var errorFields = {
  83: "severity_local",
  // S
  86: "severity",
  // V
  67: "code",
  // C
  77: "message",
  // M
  68: "detail",
  // D
  72: "hint",
  // H
  80: "position",
  // P
  112: "internal_position",
  // p
  113: "internal_query",
  // q
  87: "where",
  // W
  115: "schema_name",
  // s
  116: "table_name",
  // t
  99: "column_name",
  // c
  100: "data type_name",
  // d
  110: "constraint_name",
  // n
  70: "file",
  // F
  76: "line",
  // L
  82: "routine"
  // R
};
function Connection(options, queues = {}, { onopen = noop, onend = noop, onclose = noop } = {}) {
  const {
    sslnegotiation,
    ssl,
    max,
    user,
    host,
    port,
    database,
    parsers: parsers2,
    transform,
    onnotice,
    onnotify,
    onparameter,
    max_pipeline,
    keep_alive,
    backoff: backoff2,
    target_session_attrs
  } = options;
  const sent = queue_default(), id = uid++, backend = { pid: null, secret: null }, idleTimer = timer(end, options.idle_timeout), lifeTimer = timer(end, options.max_lifetime), connectTimer = timer(connectTimedOut, options.connect_timeout);
  let socket = null, cancelMessage, errorResponse = null, result = new Result(), incoming = Buffer.alloc(0), needsTypes = options.fetch_types, backendParameters = {}, statements = {}, statementId = Math.random().toString(36).slice(2), statementCount = 1, closedTime = 0, remaining = 0, hostIndex = 0, retries = 0, length = 0, delay = 0, rows = 0, serverSignature = null, nextWriteTimer = null, terminated = false, incomings = null, results = null, initial = null, ending = null, stream = null, chunk = null, ended = null, nonce = null, query = null, final = null;
  const connection2 = {
    queue: queues.closed,
    idleTimer,
    connect(query2) {
      initial = query2;
      reconnect();
    },
    terminate,
    execute,
    cancel,
    end,
    count: 0,
    id
  };
  queues.closed && queues.closed.push(connection2);
  return connection2;
  async function createSocket() {
    let x;
    try {
      x = options.socket ? await Promise.resolve(options.socket(options)) : new net.Socket();
    } catch (e) {
      error(e);
      return;
    }
    x.on("error", error);
    x.on("close", closed);
    x.on("drain", drain);
    return x;
  }
  async function cancel({ pid, secret }, resolve2, reject) {
    try {
      cancelMessage = bytes_default().i32(16).i32(80877102).i32(pid).i32(secret).end(16);
      await connect2();
      socket.once("error", reject);
      socket.once("close", resolve2);
    } catch (error2) {
      reject(error2);
    }
  }
  function execute(q) {
    if (terminated)
      return queryError(q, Errors.connection("CONNECTION_DESTROYED", options));
    if (stream)
      return queryError(q, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
    if (q.cancelled)
      return;
    try {
      q.state = backend;
      query ? sent.push(q) : (query = q, query.active = true);
      build(q);
      return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn && sent.length < max_pipeline && (!q.options.onexecute || q.options.onexecute(connection2));
    } catch (error2) {
      sent.length === 0 && write(Sync);
      errored(error2);
      return true;
    }
  }
  function toBuffer(q) {
    if (q.parameters.length >= 65534)
      throw Errors.generic("MAX_PARAMETERS_EXCEEDED", "Max number of parameters (65534) exceeded");
    return q.options.simple ? bytes_default().Q().str(q.statement.string + bytes_default.N).end() : q.describeFirst ? Buffer.concat([describe2(q), Flush]) : q.prepare ? q.prepared ? prepared(q) : Buffer.concat([describe2(q), prepared(q)]) : unnamed(q);
  }
  function describe2(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types, q.statement.name),
      Describe("S", q.statement.name)
    ]);
  }
  function prepared(q) {
    return Buffer.concat([
      Bind(q.parameters, q.statement.types, q.statement.name, q.cursorName),
      q.cursorFn ? Execute("", q.cursorRows) : ExecuteUnnamed
    ]);
  }
  function unnamed(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types),
      DescribeUnnamed,
      prepared(q)
    ]);
  }
  function build(q) {
    const parameters = [], types2 = [];
    const string = stringify(q, q.strings[0], q.args[0], parameters, types2, options);
    !q.tagged && q.args.forEach((x) => handleValue(x, parameters, types2, options));
    q.prepare = options.prepare && ("prepare" in q.options ? q.options.prepare : true);
    q.string = string;
    q.signature = q.prepare && types2 + string;
    q.onlyDescribe && delete statements[q.signature];
    q.parameters = q.parameters || parameters;
    q.prepared = q.prepare && q.signature in statements;
    q.describeFirst = q.onlyDescribe || parameters.length && !q.prepared;
    q.statement = q.prepared ? statements[q.signature] : { string, types: types2, name: q.prepare ? statementId + statementCount++ : "" };
    typeof options.debug === "function" && options.debug(id, string, parameters, types2);
  }
  function write(x, fn) {
    chunk = chunk ? Buffer.concat([chunk, x]) : Buffer.from(x);
    if (fn || chunk.length >= 1024)
      return nextWrite(fn);
    nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite));
    return true;
  }
  function nextWrite(fn) {
    const x = socket.write(chunk, fn);
    nextWriteTimer !== null && clearImmediate(nextWriteTimer);
    chunk = nextWriteTimer = null;
    return x;
  }
  function connectTimedOut() {
    errored(Errors.connection("CONNECT_TIMEOUT", options, socket));
    socket.destroy();
  }
  async function secure() {
    if (sslnegotiation !== "direct") {
      write(SSLRequest);
      const canSSL = await new Promise((r) => socket.once("data", (x) => r(x[0] === 83)));
      if (!canSSL && ssl === "prefer")
        return connected();
    }
    const options2 = {
      socket,
      servername: net.isIP(socket.host) ? void 0 : socket.host
    };
    if (sslnegotiation === "direct")
      options2.ALPNProtocols = ["postgresql"];
    if (ssl === "require" || ssl === "allow" || ssl === "prefer")
      options2.rejectUnauthorized = false;
    else if (typeof ssl === "object")
      Object.assign(options2, ssl);
    socket.removeAllListeners();
    socket = tls.connect(options2);
    socket.on("secureConnect", connected);
    socket.on("error", error);
    socket.on("close", closed);
    socket.on("drain", drain);
  }
  function drain() {
    !query && onopen(connection2);
  }
  function data(x) {
    if (incomings) {
      incomings.push(x);
      remaining -= x.length;
      if (remaining > 0)
        return;
    }
    incoming = incomings ? Buffer.concat(incomings, length - remaining) : incoming.length === 0 ? x : Buffer.concat([incoming, x], incoming.length + x.length);
    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1);
      if (length >= incoming.length) {
        remaining = length - incoming.length;
        incomings = [incoming];
        break;
      }
      try {
        handle(incoming.subarray(0, length + 1));
      } catch (e) {
        query && (query.cursorFn || query.describeFirst) && write(Sync);
        errored(e);
      }
      incoming = incoming.subarray(length + 1);
      remaining = 0;
      incomings = null;
    }
  }
  async function connect2() {
    terminated = false;
    backendParameters = {};
    socket || (socket = await createSocket());
    if (!socket)
      return;
    connectTimer.start();
    if (options.socket)
      return ssl ? secure() : connected();
    socket.on("connect", ssl ? secure : connected);
    if (options.path)
      return socket.connect(options.path);
    socket.ssl = ssl;
    socket.connect(port[hostIndex], host[hostIndex]);
    socket.host = host[hostIndex];
    socket.port = port[hostIndex];
    hostIndex = (hostIndex + 1) % port.length;
  }
  function reconnect() {
    setTimeout(connect2, closedTime ? Math.max(0, closedTime + delay - performance.now()) : 0);
  }
  function connected() {
    try {
      statements = {};
      needsTypes = options.fetch_types;
      statementId = Math.random().toString(36).slice(2);
      statementCount = 1;
      lifeTimer.start();
      socket.on("data", data);
      keep_alive && socket.setKeepAlive && socket.setKeepAlive(true, 1e3 * keep_alive);
      const s = StartupMessage();
      write(s);
    } catch (err) {
      error(err);
    }
  }
  function error(err) {
    if (connection2.queue === queues.connecting && options.host[retries + 1])
      return;
    errored(err);
    while (sent.length)
      queryError(sent.shift(), err);
  }
  function errored(err) {
    stream && (stream.destroy(err), stream = null);
    query && queryError(query, err);
    initial && (queryError(initial, err), initial = null);
  }
  function queryError(query2, err) {
    if (query2.reserve)
      return query2.reject(err);
    if (!err || typeof err !== "object")
      err = new Error(err);
    "query" in err || "parameters" in err || Object.defineProperties(err, {
      stack: { value: err.stack + query2.origin.replace(/.*\n/, "\n"), enumerable: options.debug },
      query: { value: query2.string, enumerable: options.debug },
      parameters: { value: query2.parameters, enumerable: options.debug },
      args: { value: query2.args, enumerable: options.debug },
      types: { value: query2.statement && query2.statement.types, enumerable: options.debug }
    });
    query2.reject(err);
  }
  function end() {
    return ending || (!connection2.reserved && onend(connection2), !connection2.reserved && !initial && !query && sent.length === 0 ? (terminate(), new Promise((r) => socket && socket.readyState !== "closed" ? socket.once("close", r) : r())) : ending = new Promise((r) => ended = r));
  }
  function terminate() {
    terminated = true;
    if (stream || query || initial || sent.length)
      error(Errors.connection("CONNECTION_DESTROYED", options));
    clearImmediate(nextWriteTimer);
    if (socket) {
      socket.removeListener("data", data);
      socket.removeListener("connect", connected);
      socket.readyState === "open" && socket.end(bytes_default().X().end());
    }
    ended && (ended(), ending = ended = null);
  }
  async function closed(hadError) {
    incoming = Buffer.alloc(0);
    remaining = 0;
    incomings = null;
    clearImmediate(nextWriteTimer);
    socket.removeListener("data", data);
    socket.removeListener("connect", connected);
    idleTimer.cancel();
    lifeTimer.cancel();
    connectTimer.cancel();
    socket.removeAllListeners();
    socket = null;
    if (initial)
      return reconnect();
    !hadError && (query || sent.length) && error(Errors.connection("CONNECTION_CLOSED", options, socket));
    closedTime = performance.now();
    hadError && options.shared.retries++;
    delay = (typeof backoff2 === "function" ? backoff2(options.shared.retries) : backoff2) * 1e3;
    onclose(connection2, Errors.connection("CONNECTION_CLOSED", options, socket));
  }
  function handle(xs, x = xs[0]) {
    (x === 68 ? DataRow : (
      // D
      x === 100 ? CopyData : (
        // d
        x === 65 ? NotificationResponse : (
          // A
          x === 83 ? ParameterStatus : (
            // S
            x === 90 ? ReadyForQuery : (
              // Z
              x === 67 ? CommandComplete : (
                // C
                x === 50 ? BindComplete : (
                  // 2
                  x === 49 ? ParseComplete : (
                    // 1
                    x === 116 ? ParameterDescription : (
                      // t
                      x === 84 ? RowDescription : (
                        // T
                        x === 82 ? Authentication : (
                          // R
                          x === 110 ? NoData : (
                            // n
                            x === 75 ? BackendKeyData : (
                              // K
                              x === 69 ? ErrorResponse : (
                                // E
                                x === 115 ? PortalSuspended : (
                                  // s
                                  x === 51 ? CloseComplete : (
                                    // 3
                                    x === 71 ? CopyInResponse : (
                                      // G
                                      x === 78 ? NoticeResponse : (
                                        // N
                                        x === 72 ? CopyOutResponse : (
                                          // H
                                          x === 99 ? CopyDone : (
                                            // c
                                            x === 73 ? EmptyQueryResponse : (
                                              // I
                                              x === 86 ? FunctionCallResponse : (
                                                // V
                                                x === 118 ? NegotiateProtocolVersion : (
                                                  // v
                                                  x === 87 ? CopyBothResponse : (
                                                    // W
                                                    /* c8 ignore next */
                                                    UnknownMessage
                                                  )
                                                )
                                              )
                                            )
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    ))(xs);
  }
  function DataRow(x) {
    let index = 7;
    let length2;
    let column;
    let value;
    const row = query.isRaw ? new Array(query.statement.columns.length) : {};
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i];
      length2 = x.readInt32BE(index);
      index += 4;
      value = length2 === -1 ? null : query.isRaw === true ? x.subarray(index, index += length2) : column.parser === void 0 ? x.toString("utf8", index, index += length2) : column.parser.array === true ? column.parser(x.toString("utf8", index + 1, index += length2)) : column.parser(x.toString("utf8", index, index += length2));
      query.isRaw ? row[i] = query.isRaw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
    }
    query.forEachFn ? query.forEachFn(transform.row.from ? transform.row.from(row) : row, result) : result[rows++] = transform.row.from ? transform.row.from(row) : row;
  }
  function ParameterStatus(x) {
    const [k, v] = x.toString("utf8", 5, x.length - 1).split(bytes_default.N);
    backendParameters[k] = v;
    if (options.parameters[k] !== v) {
      options.parameters[k] = v;
      onparameter && onparameter(k, v);
    }
  }
  function ReadyForQuery(x) {
    if (query) {
      if (errorResponse) {
        query.retried ? errored(query.retried) : query.prepared && retryRoutines.has(errorResponse.routine) ? retry(query, errorResponse) : errored(errorResponse);
      } else {
        query.resolve(results || result);
      }
    } else if (errorResponse) {
      errored(errorResponse);
    }
    query = results = errorResponse = null;
    result = new Result();
    connectTimer.cancel();
    if (initial) {
      if (target_session_attrs) {
        if (!backendParameters.in_hot_standby || !backendParameters.default_transaction_read_only)
          return fetchState();
        else if (tryNext(target_session_attrs, backendParameters))
          return terminate();
      }
      if (needsTypes) {
        initial.reserve && (initial = null);
        return fetchArrayTypes();
      }
      initial && !initial.reserve && execute(initial);
      options.shared.retries = retries = 0;
      initial = null;
      return;
    }
    while (sent.length && (query = sent.shift()) && (query.active = true, query.cancelled))
      Connection(options).cancel(query.state, query.cancelled.resolve, query.cancelled.reject);
    if (query)
      return;
    connection2.reserved ? !connection2.reserved.release && x[5] === 73 ? ending ? terminate() : (connection2.reserved = null, onopen(connection2)) : connection2.reserved() : ending ? terminate() : onopen(connection2);
  }
  function CommandComplete(x) {
    rows = 0;
    for (let i = x.length - 1; i > 0; i--) {
      if (x[i] === 32 && x[i + 1] < 58 && result.count === null)
        result.count = +x.toString("utf8", i + 1, x.length - 1);
      if (x[i - 1] >= 65) {
        result.command = x.toString("utf8", 5, i);
        result.state = backend;
        break;
      }
    }
    final && (final(), final = null);
    if (result.command === "BEGIN" && max !== 1 && !connection2.reserved)
      return errored(Errors.generic("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserved or max: 1"));
    if (query.options.simple)
      return BindComplete();
    if (query.cursorFn) {
      result.count && query.cursorFn(result);
      write(Sync);
    }
  }
  function ParseComplete() {
    query.parsing = false;
  }
  function BindComplete() {
    !result.statement && (result.statement = query.statement);
    result.columns = query.statement.columns;
  }
  function ParameterDescription(x) {
    const length2 = x.readUInt16BE(5);
    for (let i = 0; i < length2; ++i)
      !query.statement.types[i] && (query.statement.types[i] = x.readUInt32BE(7 + i * 4));
    query.prepare && (statements[query.signature] = query.statement);
    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false);
  }
  function RowDescription(x) {
    if (result.command) {
      results = results || [result];
      results.push(result = new Result());
      result.count = null;
      query.statement.columns = null;
    }
    const length2 = x.readUInt16BE(5);
    let index = 7;
    let start;
    query.statement.columns = Array(length2);
    for (let i = 0; i < length2; ++i) {
      start = index;
      while (x[index++] !== 0) ;
      const table = x.readUInt32BE(index);
      const number = x.readUInt16BE(index + 4);
      const type = x.readUInt32BE(index + 6);
      query.statement.columns[i] = {
        name: transform.column.from ? transform.column.from(x.toString("utf8", start, index - 1)) : x.toString("utf8", start, index - 1),
        parser: parsers2[type],
        table,
        number,
        type
      };
      index += 18;
    }
    result.statement = query.statement;
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  async function Authentication(x, type = x.readUInt32BE(5)) {
    (type === 3 ? AuthenticationCleartextPassword : type === 5 ? AuthenticationMD5Password : type === 10 ? SASL : type === 11 ? SASLContinue : type === 12 ? SASLFinal : type !== 0 ? UnknownAuth : noop)(x, type);
  }
  async function AuthenticationCleartextPassword() {
    const payload = await Pass();
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  async function AuthenticationMD5Password(x) {
    const payload = "md5" + await md5(
      Buffer.concat([
        Buffer.from(await md5(await Pass() + user)),
        x.subarray(9)
      ])
    );
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  async function SASL() {
    nonce = (await crypto.randomBytes(18)).toString("base64");
    bytes_default().p().str("SCRAM-SHA-256" + bytes_default.N);
    const i = bytes_default.i;
    write(bytes_default.inc(4).str("n,,n=*,r=" + nonce).i32(bytes_default.i - i - 4, i).end());
  }
  async function SASLContinue(x) {
    const res = x.toString("utf8", 9).split(",").reduce((acc, x2) => (acc[x2[0]] = x2.slice(2), acc), {});
    const saltedPassword = await crypto.pbkdf2Sync(
      await Pass(),
      Buffer.from(res.s, "base64"),
      parseInt(res.i),
      32,
      "sha256"
    );
    const clientKey = await hmac(saltedPassword, "Client Key");
    const auth = "n=*,r=" + nonce + ",r=" + res.r + ",s=" + res.s + ",i=" + res.i + ",c=biws,r=" + res.r;
    serverSignature = (await hmac(await hmac(saltedPassword, "Server Key"), auth)).toString("base64");
    const payload = "c=biws,r=" + res.r + ",p=" + xor(
      clientKey,
      Buffer.from(await hmac(await sha256(clientKey), auth))
    ).toString("base64");
    write(
      bytes_default().p().str(payload).end()
    );
  }
  function SASLFinal(x) {
    if (x.toString("utf8", 9).split(bytes_default.N, 1)[0].slice(2) === serverSignature)
      return;
    errored(Errors.generic("SASL_SIGNATURE_MISMATCH", "The server did not return the correct signature"));
    socket.destroy();
  }
  function Pass() {
    return Promise.resolve(
      typeof options.pass === "function" ? options.pass() : options.pass
    );
  }
  function NoData() {
    result.statement = query.statement;
    result.statement.columns = [];
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  function BackendKeyData(x) {
    backend.pid = x.readUInt32BE(5);
    backend.secret = x.readUInt32BE(9);
  }
  async function fetchArrayTypes() {
    needsTypes = false;
    const types2 = await new Query([`
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `], [], execute);
    types2.forEach(({ oid, typarray }) => addArrayType(oid, typarray));
  }
  function addArrayType(oid, typarray) {
    if (!!options.parsers[typarray] && !!options.serializers[typarray]) return;
    const parser = options.parsers[oid];
    options.shared.typeArrayMap[oid] = typarray;
    options.parsers[typarray] = (xs) => arrayParser(xs, parser, typarray);
    options.parsers[typarray].array = true;
    options.serializers[typarray] = (xs) => arraySerializer(xs, options.serializers[oid], options, typarray);
  }
  function tryNext(x, xs) {
    return x === "read-write" && xs.default_transaction_read_only === "on" || x === "read-only" && xs.default_transaction_read_only === "off" || x === "primary" && xs.in_hot_standby === "on" || x === "standby" && xs.in_hot_standby === "off" || x === "prefer-standby" && xs.in_hot_standby === "off" && options.host[retries];
  }
  function fetchState() {
    const query2 = new Query([`
      show transaction_read_only;
      select pg_catalog.pg_is_in_recovery()
    `], [], execute, null, { simple: true });
    query2.resolve = ([[a], [b2]]) => {
      backendParameters.default_transaction_read_only = a.transaction_read_only;
      backendParameters.in_hot_standby = b2.pg_is_in_recovery ? "on" : "off";
    };
    query2.execute();
  }
  function ErrorResponse(x) {
    if (query) {
      (query.cursorFn || query.describeFirst) && write(Sync);
      errorResponse = Errors.postgres(parseError(x));
    } else {
      errored(Errors.postgres(parseError(x)));
    }
  }
  function retry(q, error2) {
    delete statements[q.signature];
    q.retried = error2;
    execute(q);
  }
  function NotificationResponse(x) {
    if (!onnotify)
      return;
    let index = 9;
    while (x[index++] !== 0) ;
    onnotify(
      x.toString("utf8", 9, index - 1),
      x.toString("utf8", index, x.length - 1)
    );
  }
  async function PortalSuspended() {
    try {
      const x = await Promise.resolve(query.cursorFn(result));
      rows = 0;
      x === CLOSE ? write(Close(query.portal)) : (result = new Result(), write(Execute("", query.cursorRows)));
    } catch (err) {
      write(Sync);
      query.reject(err);
    }
  }
  function CloseComplete() {
    result.count && query.cursorFn(result);
    query.resolve(result);
  }
  function CopyInResponse() {
    stream = new Stream.Writable({
      autoDestroy: true,
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
        stream = null;
      }
    });
    query.resolve(stream);
  }
  function CopyOutResponse() {
    stream = new Stream.Readable({
      read() {
        socket.resume();
      }
    });
    query.resolve(stream);
  }
  function CopyBothResponse() {
    stream = new Stream.Duplex({
      autoDestroy: true,
      read() {
        socket.resume();
      },
      /* c8 ignore next 11 */
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
      }
    });
    query.resolve(stream);
  }
  function CopyData(x) {
    stream && (stream.push(x.subarray(5)) || socket.pause());
  }
  function CopyDone() {
    stream && stream.push(null);
    stream = null;
  }
  function NoticeResponse(x) {
    onnotice ? onnotice(parseError(x)) : console.log(parseError(x));
  }
  function EmptyQueryResponse() {
  }
  function FunctionCallResponse() {
    errored(Errors.notSupported("FunctionCallResponse"));
  }
  function NegotiateProtocolVersion() {
    errored(Errors.notSupported("NegotiateProtocolVersion"));
  }
  function UnknownMessage(x) {
    console.error("Postgres.js : Unknown Message:", x[0]);
  }
  function UnknownAuth(x, type) {
    console.error("Postgres.js : Unknown Auth:", type);
  }
  function Bind(parameters, types2, statement = "", portal = "") {
    let prev, type;
    bytes_default().B().str(portal + bytes_default.N).str(statement + bytes_default.N).i16(0).i16(parameters.length);
    parameters.forEach((x, i) => {
      if (x === null)
        return bytes_default.i32(4294967295);
      type = types2[i];
      parameters[i] = x = type in options.serializers ? options.serializers[type](x) : "" + x;
      prev = bytes_default.i;
      bytes_default.inc(4).str(x).i32(bytes_default.i - prev - 4, prev);
    });
    bytes_default.i16(0);
    return bytes_default.end();
  }
  function Parse(str, parameters, types2, name = "") {
    bytes_default().P().str(name + bytes_default.N).str(str + bytes_default.N).i16(parameters.length);
    parameters.forEach((x, i) => bytes_default.i32(types2[i] || 0));
    return bytes_default.end();
  }
  function Describe(x, name = "") {
    return bytes_default().D().str(x).str(name + bytes_default.N).end();
  }
  function Execute(portal = "", rows2 = 0) {
    return Buffer.concat([
      bytes_default().E().str(portal + bytes_default.N).i32(rows2).end(),
      Flush
    ]);
  }
  function Close(portal = "") {
    return Buffer.concat([
      bytes_default().C().str("P").str(portal + bytes_default.N).end(),
      bytes_default().S().end()
    ]);
  }
  function StartupMessage() {
    return cancelMessage || bytes_default().inc(4).i16(3).z(2).str(
      Object.entries(Object.assign(
        {
          user,
          database,
          client_encoding: "UTF8"
        },
        options.connection
      )).filter(([, v]) => v).map(([k, v]) => k + bytes_default.N + v).join(bytes_default.N)
    ).z(2).end(0);
  }
}
function parseError(x) {
  const error = {};
  let start = 5;
  for (let i = 5; i < x.length - 1; i++) {
    if (x[i] === 0) {
      error[errorFields[x[start]]] = x.toString("utf8", start + 1, i);
      start = i + 1;
    }
  }
  return error;
}
function md5(x) {
  return crypto.createHash("md5").update(x).digest("hex");
}
function hmac(key2, x) {
  return crypto.createHmac("sha256", key2).update(x).digest();
}
function sha256(x) {
  return crypto.createHash("sha256").update(x).digest();
}
function xor(a, b2) {
  const length = Math.max(a.length, b2.length);
  const buffer2 = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++)
    buffer2[i] = a[i] ^ b2[i];
  return buffer2;
}
function timer(fn, seconds) {
  seconds = typeof seconds === "function" ? seconds() : seconds;
  if (!seconds)
    return { cancel: noop, start: noop };
  let timer2;
  return {
    cancel() {
      timer2 && (clearTimeout(timer2), timer2 = null);
    },
    start() {
      timer2 && clearTimeout(timer2);
      timer2 = setTimeout(done, seconds * 1e3, arguments);
    }
  };
  function done(args) {
    fn.apply(null, args);
    timer2 = null;
  }
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/subscribe.js
var noop2 = () => {
};
function Subscribe(postgres2, options) {
  const subscribers = /* @__PURE__ */ new Map(), slot = "postgresjs_" + Math.random().toString(36).slice(2), state = {};
  let connection2, stream, ended = false;
  const sql = subscribe.sql = postgres2({
    ...options,
    transform: { column: {}, value: {}, row: {} },
    max: 1,
    fetch_types: false,
    idle_timeout: null,
    max_lifetime: null,
    connection: {
      ...options.connection,
      replication: "database"
    },
    onclose: async function() {
      if (ended)
        return;
      stream = null;
      state.pid = state.secret = void 0;
      connected(await init(sql, slot, options.publications));
      subscribers.forEach((event) => event.forEach(({ onsubscribe }) => onsubscribe()));
    },
    no_subscribe: true
  });
  const end = sql.end, close = sql.close;
  sql.end = async () => {
    ended = true;
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return end();
  };
  sql.close = async () => {
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return close();
  };
  return subscribe;
  async function subscribe(event, fn, onsubscribe = noop2, onerror = noop2) {
    event = parseEvent(event);
    if (!connection2)
      connection2 = init(sql, slot, options.publications);
    const subscriber = { fn, onsubscribe };
    const fns = subscribers.has(event) ? subscribers.get(event).add(subscriber) : subscribers.set(event, /* @__PURE__ */ new Set([subscriber])).get(event);
    const unsubscribe = () => {
      fns.delete(subscriber);
      fns.size === 0 && subscribers.delete(event);
    };
    return connection2.then((x) => {
      connected(x);
      onsubscribe();
      stream && stream.on("error", onerror);
      return { unsubscribe, state, sql };
    });
  }
  function connected(x) {
    stream = x.stream;
    state.pid = x.state.pid;
    state.secret = x.state.secret;
  }
  async function init(sql2, slot2, publications) {
    if (!publications)
      throw new Error("Missing publication names");
    const xs = await sql2.unsafe(
      `CREATE_REPLICATION_SLOT ${slot2} TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT`
    );
    const [x] = xs;
    const stream2 = await sql2.unsafe(
      `START_REPLICATION SLOT ${slot2} LOGICAL ${x.consistent_point} (proto_version '1', publication_names '${publications}')`
    ).writable();
    const state2 = {
      lsn: Buffer.concat(x.consistent_point.split("/").map((x2) => Buffer.from(("00000000" + x2).slice(-8), "hex")))
    };
    stream2.on("data", data);
    stream2.on("error", error);
    stream2.on("close", sql2.close);
    return { stream: stream2, state: xs.state };
    function error(e) {
      console.error("Unexpected error during logical streaming - reconnecting", e);
    }
    function data(x2) {
      if (x2[0] === 119) {
        parse2(x2.subarray(25), state2, sql2.options.parsers, handle, options.transform);
      } else if (x2[0] === 107 && x2[17]) {
        state2.lsn = x2.subarray(1, 9);
        pong();
      }
    }
    function handle(a, b2) {
      const path = b2.relation.schema + "." + b2.relation.table;
      call("*", a, b2);
      call("*:" + path, a, b2);
      b2.relation.keys.length && call("*:" + path + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
      call(b2.command, a, b2);
      call(b2.command + ":" + path, a, b2);
      b2.relation.keys.length && call(b2.command + ":" + path + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
    }
    function pong() {
      const x2 = Buffer.alloc(34);
      x2[0] = "r".charCodeAt(0);
      x2.fill(state2.lsn, 1);
      x2.writeBigInt64BE(BigInt(Date.now() - Date.UTC(2e3, 0, 1)) * BigInt(1e3), 25);
      stream2.write(x2);
    }
  }
  function call(x, a, b2) {
    subscribers.has(x) && subscribers.get(x).forEach(({ fn }) => fn(a, b2, x));
  }
}
function Time(x) {
  return new Date(Date.UTC(2e3, 0, 1) + Number(x / BigInt(1e3)));
}
function parse2(x, state, parsers2, handle, transform) {
  const char = (acc, [k, v]) => (acc[k.charCodeAt(0)] = v, acc);
  Object.entries({
    R: (x2) => {
      let i = 1;
      const r = state[x2.readUInt32BE(i)] = {
        schema: x2.toString("utf8", i += 4, i = x2.indexOf(0, i)) || "pg_catalog",
        table: x2.toString("utf8", i + 1, i = x2.indexOf(0, i + 1)),
        columns: Array(x2.readUInt16BE(i += 2)),
        keys: []
      };
      i += 2;
      let columnIndex = 0, column;
      while (i < x2.length) {
        column = r.columns[columnIndex++] = {
          key: x2[i++],
          name: transform.column.from ? transform.column.from(x2.toString("utf8", i, i = x2.indexOf(0, i))) : x2.toString("utf8", i, i = x2.indexOf(0, i)),
          type: x2.readUInt32BE(i += 1),
          parser: parsers2[x2.readUInt32BE(i)],
          atttypmod: x2.readUInt32BE(i += 4)
        };
        column.key && r.keys.push(column);
        i += 4;
      }
    },
    Y: () => {
    },
    // Type
    O: () => {
    },
    // Origin
    B: (x2) => {
      state.date = Time(x2.readBigInt64BE(9));
      state.lsn = x2.subarray(1, 9);
    },
    I: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      const { row } = tuples(x2, relation.columns, i += 7, transform);
      handle(row, {
        command: "insert",
        relation
      });
    },
    D: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key2 = x2[i] === 75;
      handle(
        key2 || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform).row : null,
        {
          command: "delete",
          relation,
          key: key2
        }
      );
    },
    U: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key2 = x2[i] === 75;
      const xs = key2 || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform) : null;
      xs && (i = xs.i);
      const { row } = tuples(x2, relation.columns, i + 3, transform);
      handle(row, {
        command: "update",
        relation,
        key: key2,
        old: xs && xs.row
      });
    },
    T: () => {
    },
    // Truncate,
    C: () => {
    }
    // Commit
  }).reduce(char, {})[x[0]](x);
}
function tuples(x, columns, xi, transform) {
  let type, column, value;
  const row = transform.raw ? new Array(columns.length) : {};
  for (let i = 0; i < columns.length; i++) {
    type = x[xi++];
    column = columns[i];
    value = type === 110 ? null : type === 117 ? void 0 : column.parser === void 0 ? x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)) : column.parser.array === true ? column.parser(x.toString("utf8", xi + 5, xi += 4 + x.readUInt32BE(xi))) : column.parser(x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)));
    transform.raw ? row[i] = transform.raw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
  }
  return { i: xi, row: transform.row.from ? transform.row.from(row) : row };
}
function parseEvent(x) {
  const xs = x.match(/^(\*|insert|update|delete)?:?([^.]+?\.?[^=]+)?=?(.+)?/i) || [];
  if (!xs)
    throw new Error("Malformed subscribe pattern: " + x);
  const [, command, path, key2] = xs;
  return (command || "*") + (path ? ":" + (path.indexOf(".") === -1 ? "public." + path : path) : "") + (key2 ? "=" + key2 : "");
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/large.js
import Stream2 from "stream";
function largeObject(sql, oid, mode = 131072 | 262144) {
  return new Promise(async (resolve2, reject) => {
    await sql.begin(async (sql2) => {
      let finish;
      !oid && ([{ oid }] = await sql2`select lo_creat(-1) as oid`);
      const [{ fd }] = await sql2`select lo_open(${oid}, ${mode}) as fd`;
      const lo = {
        writable,
        readable,
        close: () => sql2`select lo_close(${fd})`.then(finish),
        tell: () => sql2`select lo_tell64(${fd})`,
        read: (x) => sql2`select loread(${fd}, ${x}) as data`,
        write: (x) => sql2`select lowrite(${fd}, ${x})`,
        truncate: (x) => sql2`select lo_truncate64(${fd}, ${x})`,
        seek: (x, whence = 0) => sql2`select lo_lseek64(${fd}, ${x}, ${whence})`,
        size: () => sql2`
          select
            lo_lseek64(${fd}, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `
      };
      resolve2(lo);
      return new Promise(async (r) => finish = r);
      async function readable({
        highWaterMark = 2048 * 8,
        start = 0,
        end = Infinity
      } = {}) {
        let max = end - start;
        start && await lo.seek(start);
        return new Stream2.Readable({
          highWaterMark,
          async read(size2) {
            const l = size2 > max ? size2 - max : size2;
            max -= size2;
            const [{ data }] = await lo.read(l);
            this.push(data);
            if (data.length < size2)
              this.push(null);
          }
        });
      }
      async function writable({
        highWaterMark = 2048 * 8,
        start = 0
      } = {}) {
        start && await lo.seek(start);
        return new Stream2.Writable({
          highWaterMark,
          write(chunk, encoding, callback) {
            lo.write(chunk).then(() => callback(), callback);
          }
        });
      }
    }).catch(reject);
  });
}

// ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js
Object.assign(Postgres, {
  PostgresError,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
  BigInt: {
    to: 20,
    from: [20],
    parse: (x) => BigInt(x),
    // eslint-disable-line
    serialize: (x) => x.toString()
  }
});
var src_default = Postgres;
function Postgres(a, b2) {
  const options = parseOptions(a, b2), subscribe = options.no_subscribe || Subscribe(Postgres, { ...options });
  let ending = false;
  const queries = queue_default(), connecting = queue_default(), reserved = queue_default(), closed = queue_default(), ended = queue_default(), open = queue_default(), busy = queue_default(), full = queue_default(), queues = { connecting, reserved, closed, ended, open, busy, full };
  const connections = [...Array(options.max)].map(() => connection_default(options, queues, { onopen, onend, onclose }));
  const sql = Sql(handler);
  Object.assign(sql, {
    get parameters() {
      return options.parameters;
    },
    largeObject: largeObject.bind(null, sql),
    subscribe,
    CLOSE,
    END: CLOSE,
    PostgresError,
    options,
    reserve,
    listen,
    begin,
    close,
    end
  });
  return sql;
  function Sql(handler2) {
    handler2.debug = options.debug;
    Object.entries(options.types).reduce((acc, [name, type]) => {
      acc[name] = (x) => new Parameter(x, type.to);
      return acc;
    }, typed);
    Object.assign(sql2, {
      types: typed,
      typed,
      unsafe,
      notify,
      array,
      json,
      file
    });
    return sql2;
    function typed(value, type) {
      return new Parameter(value, type);
    }
    function sql2(strings, ...args) {
      const query = strings && Array.isArray(strings.raw) ? new Query(strings, args, handler2, cancel) : typeof strings === "string" && !args.length ? new Identifier(options.transform.column.to ? options.transform.column.to(strings) : strings) : new Builder(strings, args);
      return query;
    }
    function unsafe(string, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([string], args, handler2, cancel, {
        prepare: false,
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
    function file(path, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([], args, (query2) => {
        fs.readFile(path, "utf8", (err, string) => {
          if (err)
            return query2.reject(err);
          query2.strings = [string];
          handler2(query2);
        });
      }, cancel, {
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
  }
  async function listen(name, fn, onlisten) {
    const listener = { fn, onlisten };
    const sql2 = listen.sql || (listen.sql = Postgres({
      ...options,
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      fetch_types: false,
      onclose() {
        Object.entries(listen.channels).forEach(([name2, { listeners }]) => {
          delete listen.channels[name2];
          Promise.all(listeners.map((l) => listen(name2, l.fn, l.onlisten).catch(() => {
          })));
        });
      },
      onnotify(c, x) {
        c in listen.channels && listen.channels[c].listeners.forEach((l) => l.fn(x));
      }
    }));
    const channels = listen.channels || (listen.channels = {}), exists = name in channels;
    if (exists) {
      channels[name].listeners.push(listener);
      const result2 = await channels[name].result;
      listener.onlisten && listener.onlisten();
      return { state: result2.state, unlisten };
    }
    channels[name] = { result: sql2`listen ${sql2.unsafe('"' + name.replace(/"/g, '""') + '"')}`, listeners: [listener] };
    const result = await channels[name].result;
    listener.onlisten && listener.onlisten();
    return { state: result.state, unlisten };
    async function unlisten() {
      if (name in channels === false)
        return;
      channels[name].listeners = channels[name].listeners.filter((x) => x !== listener);
      if (channels[name].listeners.length)
        return;
      delete channels[name];
      return sql2`unlisten ${sql2.unsafe('"' + name.replace(/"/g, '""') + '"')}`;
    }
  }
  async function notify(channel, payload) {
    return await sql`select pg_notify(${channel}, ${"" + payload})`;
  }
  async function reserve() {
    const queue = queue_default();
    const c = open.length ? open.shift() : await new Promise((resolve2, reject) => {
      const query = { reserve: resolve2, reject };
      queries.push(query);
      closed.length && connect2(closed.shift(), query);
    });
    move(c, reserved);
    c.reserved = () => queue.length ? c.execute(queue.shift()) : move(c, reserved);
    c.reserved.release = true;
    const sql2 = Sql(handler2);
    sql2.release = () => {
      c.reserved = null;
      onopen(c);
    };
    return sql2;
    function handler2(q) {
      c.queue === full ? queue.push(q) : c.execute(q) || move(c, full);
    }
  }
  async function begin(options2, fn) {
    !fn && (fn = options2, options2 = "");
    const queries2 = queue_default();
    let savepoints = 0, connection2, prepare = null;
    try {
      await sql.unsafe("begin " + options2.replace(/[^a-z ]/ig, ""), [], { onexecute }).execute();
      return await Promise.race([
        scope(connection2, fn),
        new Promise((_, reject) => connection2.onclose = reject)
      ]);
    } catch (error) {
      throw error;
    }
    async function scope(c, fn2, name) {
      const sql2 = Sql(handler2);
      sql2.savepoint = savepoint;
      sql2.prepare = (x) => prepare = x.replace(/[^a-z0-9$-_. ]/gi);
      let uncaughtError, result;
      name && await sql2`savepoint ${sql2(name)}`;
      try {
        result = await new Promise((resolve2, reject) => {
          const x = fn2(sql2);
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve2, reject);
        });
        if (uncaughtError)
          throw uncaughtError;
      } catch (e) {
        await (name ? sql2`rollback to ${sql2(name)}` : sql2`rollback`);
        throw e instanceof PostgresError && e.code === "25P02" && uncaughtError || e;
      }
      if (!name) {
        prepare ? await sql2`prepare transaction '${sql2.unsafe(prepare)}'` : await sql2`commit`;
      }
      return result;
      function savepoint(name2, fn3) {
        if (name2 && Array.isArray(name2.raw))
          return savepoint((sql3) => sql3.apply(sql3, arguments));
        arguments.length === 1 && (fn3 = name2, name2 = null);
        return scope(c, fn3, "s" + savepoints++ + (name2 ? "_" + name2 : ""));
      }
      function handler2(q) {
        q.catch((e) => uncaughtError || (uncaughtError = e));
        c.queue === full ? queries2.push(q) : c.execute(q) || move(c, full);
      }
    }
    function onexecute(c) {
      connection2 = c;
      move(c, reserved);
      c.reserved = () => queries2.length ? c.execute(queries2.shift()) : move(c, reserved);
    }
  }
  function move(c, queue) {
    c.queue.remove(c);
    queue.push(c);
    c.queue = queue;
    queue === open ? c.idleTimer.start() : c.idleTimer.cancel();
    return c;
  }
  function json(x) {
    return new Parameter(x, 3802);
  }
  function array(x, type) {
    if (!Array.isArray(x))
      return array(Array.from(arguments));
    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap);
  }
  function handler(query) {
    if (ending)
      return query.reject(Errors.connection("CONNECTION_ENDED", options, options));
    if (open.length)
      return go(open.shift(), query);
    if (closed.length)
      return connect2(closed.shift(), query);
    busy.length ? go(busy.shift(), query) : queries.push(query);
  }
  function go(c, query) {
    return c.execute(query) ? move(c, busy) : move(c, full);
  }
  function cancel(query) {
    return new Promise((resolve2, reject) => {
      query.state ? query.active ? connection_default(options).cancel(query.state, resolve2, reject) : query.cancelled = { resolve: resolve2, reject } : (queries.remove(query), query.cancelled = true, query.reject(Errors.generic("57014", "canceling statement due to user request")), resolve2());
    });
  }
  async function end({ timeout = null } = {}) {
    if (ending)
      return ending;
    await 1;
    let timer2;
    return ending = Promise.race([
      new Promise((r) => timeout !== null && (timer2 = setTimeout(destroy, timeout * 1e3, r))),
      Promise.all(connections.map((c) => c.end()).concat(
        listen.sql ? listen.sql.end({ timeout: 0 }) : [],
        subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : []
      ))
    ]).then(() => clearTimeout(timer2));
  }
  async function close() {
    await Promise.all(connections.map((c) => c.end()));
  }
  async function destroy(resolve2) {
    await Promise.all(connections.map((c) => c.terminate()));
    while (queries.length)
      queries.shift().reject(Errors.connection("CONNECTION_DESTROYED", options));
    resolve2();
  }
  function connect2(c, query) {
    move(c, connecting);
    c.connect(query);
    return c;
  }
  function onend(c) {
    move(c, ended);
  }
  function onopen(c) {
    if (queries.length === 0)
      return move(c, open);
    let max = Math.ceil(queries.length / (connecting.length + 1)), ready = true;
    while (ready && queries.length && max-- > 0) {
      const query = queries.shift();
      if (query.reserve)
        return query.reserve(c);
      ready = c.execute(query);
    }
    ready ? move(c, busy) : move(c, full);
  }
  function onclose(c, e) {
    move(c, closed);
    c.reserved = null;
    c.onclose && (c.onclose(e), c.onclose = null);
    options.onclose && options.onclose(c.id);
    queries.length && connect2(c, queries.shift());
  }
}
function parseOptions(a, b2) {
  if (a && a.shared)
    return a;
  const env = process.env, o = (!a || typeof a === "string" ? b2 : a) || {}, { url, multihost } = parseUrl(a), query = [...url.searchParams].reduce((a2, [b3, c]) => (a2[b3] = c, a2), {}), host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || "localhost", port = o.port || url.port || env.PGPORT || 5432, user = o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER || osUsername();
  o.no_prepare && (o.prepare = false);
  query.sslmode && (query.ssl = query.sslmode, delete query.sslmode);
  "timeout" in o && (console.log("The timeout option is deprecated, use idle_timeout instead"), o.idle_timeout = o.timeout);
  query.sslrootcert === "system" && (query.ssl = "verify-full");
  const ints = ["idle_timeout", "connect_timeout", "max_lifetime", "max_pipeline", "backoff", "keep_alive"];
  const defaults = {
    max: globalThis.Cloudflare ? 3 : 10,
    ssl: false,
    sslnegotiation: null,
    idle_timeout: null,
    connect_timeout: 30,
    max_lifetime,
    max_pipeline: 100,
    backoff,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: null
  };
  return {
    host: Array.isArray(host) ? host : host.split(",").map((x) => x.split(":")[0]),
    port: Array.isArray(port) ? port : host.split(",").map((x) => parseInt(x.split(":")[1] || port)),
    path: o.path || host.indexOf("/") > -1 && host + "/.s.PGSQL." + port,
    database: o.database || o.db || (url.pathname || "").slice(1) || env.PGDATABASE || user,
    user,
    pass: o.pass || o.password || url.password || env.PGPASSWORD || "",
    ...Object.entries(defaults).reduce(
      (acc, [k, d]) => {
        const value = k in o ? o[k] : k in query ? query[k] === "disable" || query[k] === "false" ? false : query[k] : env["PG" + k.toUpperCase()] || d;
        acc[k] = typeof value === "string" && ints.includes(k) ? +value : value;
        return acc;
      },
      {}
    ),
    connection: {
      application_name: env.PGAPPNAME || "postgres.js",
      ...o.connection,
      ...Object.entries(query).reduce((acc, [k, v]) => (k in defaults || (acc[k] = v), acc), {})
    },
    types: o.types || {},
    target_session_attrs: tsa(o, url, env),
    onnotice: o.onnotice,
    onnotify: o.onnotify,
    onclose: o.onclose,
    onparameter: o.onparameter,
    socket: o.socket,
    transform: parseTransform(o.transform || { undefined: void 0 }),
    parameters: {},
    shared: { retries: 0, typeArrayMap: {} },
    ...mergeUserTypes(o.types)
  };
}
function tsa(o, url, env) {
  const x = o.target_session_attrs || url.searchParams.get("target_session_attrs") || env.PGTARGETSESSIONATTRS;
  if (!x || ["read-write", "read-only", "primary", "standby", "prefer-standby"].includes(x))
    return x;
  throw new Error("target_session_attrs " + x + " is not supported");
}
function backoff(retries) {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);
}
function max_lifetime() {
  return 60 * (30 + Math.random() * 30);
}
function parseTransform(x) {
  return {
    undefined: x.undefined,
    column: {
      from: typeof x.column === "function" ? x.column : x.column && x.column.from,
      to: x.column && x.column.to
    },
    value: {
      from: typeof x.value === "function" ? x.value : x.value && x.value.from,
      to: x.value && x.value.to
    },
    row: {
      from: typeof x.row === "function" ? x.row : x.row && x.row.from,
      to: x.row && x.row.to
    }
  };
}
function parseUrl(url) {
  if (!url || typeof url !== "string")
    return { url: { searchParams: /* @__PURE__ */ new Map() } };
  let host = url;
  host = host.slice(host.indexOf("://") + 3).split(/[?/]/)[0];
  host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
  const urlObj = new URL(url.replace(host, host.split(",")[0]));
  return {
    url: {
      username: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.host,
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      searchParams: urlObj.searchParams
    },
    multihost: host.indexOf(",") > -1 && host
  };
}
function osUsername() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  }
}

// ../core/src/db.ts
function connect(connectionString) {
  return src_default(connectionString, {
    // Notices are noise for a capture run, and postgres.js prints them by default.
    onnotice: () => {
    },
    // A capture is a handful of sequential queries, never a server workload.
    max: 4
  });
}
async function serverInfo(sql) {
  const [row] = await sql`
    select current_setting('server_version') as version,
           current_setting('server_version_num') as version_num,
           current_database() as database
  `;
  return {
    version: row?.version ?? "unknown",
    major: Math.floor(Number(row?.version_num ?? 0) / 1e4),
    database: row?.database ?? "unknown"
  };
}
var UnsupportedPostgresError = class extends Error {
  found;
  constructor(found) {
    super(
      `Tidemark needs Postgres ${MIN_POSTGRES_MAJOR} or newer, this server reports ${found}.`
    );
    this.name = "UnsupportedPostgresError";
    this.found = found;
  }
};
async function assertSupported(sql) {
  const info = await serverInfo(sql);
  if (info.major < MIN_POSTGRES_MAJOR) {
    throw new UnsupportedPostgresError(info.version);
  }
  return info;
}

// ../core/src/artifact/build.ts
function buildArtifact(input2) {
  const { handle, capture, server, config = {} } = input2;
  const schema2 = diffSchemas(capture.schemaBefore, capture.schemaAfter);
  const warnings2 = classifyWarnings(schema2, capture.tables, {
    ...config.sensitivePatterns === void 0 ? {} : { sensitivePatterns: config.sensitivePatterns }
  });
  const artifact = {
    meta: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      tidemarkVersion: TIDEMARK_VERSION,
      backend: "snapshot",
      capturedFrom: handle.startedAt,
      capturedTo: capture.stoppedAt,
      database: server.database,
      postgresVersion: server.version,
      rowThreshold: handle.rowThreshold,
      redactions: []
    },
    schema: schema2,
    tables: capture.tables,
    warnings: warnings2
  };
  return redactArtifact(artifact, config);
}

// ../render/src/text/width.ts
var ZERO_WIDTH = [
  [768, 879],
  [1155, 1161],
  [1425, 1469],
  [1552, 1562],
  [1611, 1631],
  [1648, 1648],
  [1750, 1756],
  [1809, 1809],
  [1840, 1866],
  [1958, 1968],
  [3633, 3633],
  [3636, 3642],
  [3655, 3662],
  [6832, 6911],
  [7616, 7679],
  [8203, 8207],
  [8288, 8292],
  [8400, 8432],
  [65024, 65039],
  [65056, 65071],
  [65279, 65279]
];
var WIDE = [
  [4352, 4447],
  [11904, 12350],
  [12353, 13311],
  [13312, 19903],
  [19968, 40959],
  [40960, 42191],
  [43360, 43391],
  [44032, 55203],
  [63744, 64255],
  [65040, 65049],
  [65072, 65135],
  [65280, 65376],
  [65504, 65510],
  [127744, 128591],
  [129280, 129535],
  [131072, 196605],
  [196608, 262141]
];
function inRanges(codePoint, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = low + high >> 1;
    const range = ranges[mid];
    if (!range) break;
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}
function codePointWidth(codePoint) {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || codePoint >= 127 && codePoint < 160) return 0;
  if (inRanges(codePoint, ZERO_WIDTH)) return 0;
  if (inRanges(codePoint, WIDE)) return 2;
  return 1;
}
function stringWidth(text) {
  let width = 0;
  for (const character of text) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}
function truncateToWidth(text, maxWidth, ellipsis) {
  if (maxWidth <= 0) return { text: "", truncated: text.length > 0 };
  if (stringWidth(text) <= maxWidth) return { text, truncated: false };
  const budget = maxWidth - stringWidth(ellipsis);
  if (budget <= 0) return { text: ellipsis, truncated: true };
  let width = 0;
  let out = "";
  for (const character of text) {
    const next = codePointWidth(character.codePointAt(0) ?? 0);
    if (width + next > budget) break;
    out += character;
    width += next;
  }
  return { text: out + ellipsis, truncated: true };
}

// ../render/src/value/render.ts
var NUMERIC_LOOKING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
var SENTINEL_LOOKING = /^(null|true|false)$/i;
function renderValue(value, options = {}) {
  const glyphs = options.glyphs ?? "unicode";
  const maxWidth = options.maxWidth ?? Number.POSITIVE_INFINITY;
  const ellipsis = glyphs === "ascii" ? "..." : "\u2026";
  const classified = classify(value);
  const { raw, quotable } = classified;
  const safe = makeDisplaySafe(raw, glyphs);
  const numericString = options.numericColumn === true && classified.kind === "string" && NUMERIC_LOOKING.test(raw);
  const kind = numericString ? "number" : classified.kind;
  const quoted = quotable && (raw.length === 0 || raw !== raw.trim() || SENTINEL_LOOKING.test(raw) || NUMERIC_LOOKING.test(raw) && !numericString || safe.hazards.length > 0);
  const budget = quoted ? maxWidth - 2 : maxWidth;
  const cut = truncateToWidth(safe.text, budget, ellipsis);
  const text = quoted ? `'${cut.text}'` : cut.text;
  return {
    text,
    width: stringWidth(text),
    kind,
    hazards: safe.hazards,
    truncated: cut.truncated
  };
}
function classify(value) {
  if (value === null || value === void 0) {
    return { kind: "null", raw: "NULL", quotable: false };
  }
  if (typeof value === "string") {
    return { kind: "string", raw: value, quotable: true };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", raw: value ? "true" : "false", quotable: false };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return { kind: "number", raw: String(value), quotable: false };
  }
  if (value instanceof Date) {
    const raw = Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    return { kind: "date", raw, quotable: false };
  }
  if (value instanceof Uint8Array) {
    return { kind: "bytes", raw: toHex(value), quotable: false };
  }
  return { kind: "json", raw: toJson(value), quotable: false };
}
function toHex(bytes) {
  let out = "\\x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
function toJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

// ../render/src/report/cells.ts
var NUMBER_TYPES = /^(numeric|decimal|money|bigint|integer|smallint|real|double)/i;
function renderCellValue(value, column, context) {
  const dataType = context.columns.find((c) => c.name === column)?.dataType;
  return renderValue(value ?? null, {
    maxWidth: context.maxWidth,
    glyphs: context.glyphs,
    numericColumn: dataType !== void 0 && NUMBER_TYPES.test(dataType)
  });
}

// ../render/src/report/report.ts
var NUMBER = new Intl.NumberFormat("en-US");

// ../render/src/report/markdown.ts
var COMMENT_MARKER = "<!-- tidemark:report -->";
var MAX_ROWS_PER_TABLE = 30;
var MAX_SAMPLE_ROWS = 8;
var MAX_VALUE_WIDTH = 80;
function renderMarkdown(artifact, options = {}) {
  const blocks = [];
  if (options.marker !== false) blocks.push(COMMENT_MARKER);
  blocks.push("## Tidemark");
  blocks.push(summary(artifact));
  const warningBlock = warnings(artifact.warnings);
  if (warningBlock !== null) blocks.push(warningBlock);
  const schemaBlock = schema(artifact);
  if (schemaBlock !== null) blocks.push(schemaBlock);
  for (const table of artifact.tables) blocks.push(tableBlock(table));
  blocks.push("---");
  blocks.push(footer(artifact, options.runUrl));
  return `${blocks.join("\n\n")}
`;
}
function codeSpan(text) {
  if (text === "") return "``";
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const pad2 = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad2}${text}${pad2}${fence}`;
}
function cell(text) {
  return codeSpan(text).replaceAll("|", "\\|");
}
function escapeText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|");
}
function ref2(table) {
  return `${table.schema}.${table.name}`;
}
function count(value) {
  return value.toLocaleString("en-US");
}
function contextFor(table) {
  return {
    columns: table.columns,
    glyphs: "unicode",
    maxWidth: MAX_VALUE_WIDTH
  };
}
function valueText(value, column, context) {
  return renderCellValue(value, column, context).text;
}
function summary(artifact) {
  const totals = artifact.tables.reduce(
    (acc, table) => ({
      inserted: acc.inserted + table.counts.inserted,
      updated: acc.updated + table.counts.updated,
      deleted: acc.deleted + table.counts.deleted
    }),
    { inserted: 0, updated: 0, deleted: 0 }
  );
  const parts = [];
  if (artifact.tables.length > 0) {
    parts.push(`${count(artifact.tables.length)} tables`);
  }
  if (totals.inserted > 0) parts.push(`**+${count(totals.inserted)}**`);
  if (totals.updated > 0) parts.push(`**~${count(totals.updated)}**`);
  if (totals.deleted > 0) parts.push(`**\u2212${count(totals.deleted)}**`);
  const schemaChanges = countSchemaChanges(artifact);
  if (schemaChanges > 0) {
    parts.push(`${count(schemaChanges)} schema ${schemaChanges === 1 ? "change" : "changes"}`);
  }
  if (artifact.warnings.length > 0) {
    parts.push(`**${count(artifact.warnings.length)} warnings**`);
  }
  return parts.length === 0 ? "No changes." : parts.join(" \xB7 ");
}
function warnings(list) {
  if (list.length === 0) return null;
  const rows = list.map((warning) => {
    const severity = warning.severity === "danger" ? "**danger**" : "caution";
    const rows_ = warning.rowsAffected === void 0 ? "" : count(warning.rowsAffected);
    return `| ${severity} | ${escapeText(warning.message)} | ${rows_} |`;
  });
  return [
    "### Warnings",
    "",
    "| | What | Rows |",
    "| --- | --- | --- |",
    ...rows
  ].join("\n");
}
function schema(artifact) {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  if (tablesAdded.length === 0 && tablesRemoved.length === 0 && tablesAltered.length === 0) {
    return null;
  }
  const lines = [];
  for (const table of tablesAdded) lines.push(`+ CREATE TABLE ${ref2(table)}`);
  for (const table of tablesRemoved) lines.push(`- DROP TABLE ${ref2(table)}`);
  for (const table of tablesAltered) lines.push(...alteredLines(table));
  return ["### Schema", "", "```diff", ...lines, "```"].join("\n");
}
function alteredLines(table) {
  const lines = [`! ALTER TABLE ${ref2(table)}`];
  if (table.renamedFrom !== void 0) {
    lines.push(`!   RENAMED FROM ${ref2(table.renamedFrom)}`);
  }
  for (const column of table.columnsAdded) {
    lines.push(`+   ADD COLUMN ${column.name} ${describe(column)}`);
  }
  for (const column of table.columnsRemoved) {
    lines.push(`-   DROP COLUMN ${column.name}`);
  }
  for (const column of table.columnsAltered) {
    lines.push(
      `!   ALTER COLUMN ${column.name} ${describe(column.before)} -> ${describe(column.after)}`
    );
  }
  for (const constraint of table.constraintsAdded) {
    lines.push(`+   ADD CONSTRAINT ${constraint.name} ${constraint.definition}`);
  }
  for (const constraint of table.constraintsRemoved) {
    lines.push(`-   DROP CONSTRAINT ${constraint.name}`);
  }
  for (const index of table.indexesAdded) {
    lines.push(`+   CREATE INDEX ${index.name} ${index.definition}`);
  }
  for (const index of table.indexesRemoved) {
    lines.push(`-   DROP INDEX ${index.name}`);
  }
  return lines;
}
function describe(column) {
  let text = column.dataType;
  if (!column.nullable) text += " NOT NULL";
  if (column.default !== null) text += ` DEFAULT ${column.default}`;
  return text;
}
function tableBlock(table) {
  const counts = [];
  if (table.counts.inserted > 0) counts.push(`+${count(table.counts.inserted)}`);
  if (table.counts.updated > 0) counts.push(`~${count(table.counts.updated)}`);
  if (table.counts.deleted > 0) counts.push(`\u2212${count(table.counts.deleted)}`);
  if (table.detail === "aggregate") counts.push("aggregated");
  const heading = `${ref2(table)} \u2014 ${counts.join(" ")}`;
  const body = table.detail === "rows" ? rowTable(table.rows, table) : aggregateBody(table);
  return [
    "<details>",
    `<summary><b>${escapeText(heading)}</b></summary>`,
    "",
    body,
    "",
    "</details>"
  ].join("\n");
}
function aggregateBody(table) {
  const context = contextFor(table);
  const sections = [];
  if (table.columnStats.length > 0) {
    const rows = table.columnStats.map((stat2) => {
      const shape = stat2.transitions.length > 0 ? stat2.transitions.slice(0, 3).map(
        (t) => `${cell(valueText(t.before, stat2.column, context))} \u2192 ${cell(valueText(t.after, stat2.column, context))}`
      ).join(", ") : stat2.distinctAfter === void 0 ? "values vary" : `${count(stat2.distinctAfter)} distinct values`;
      return `| ${cell(stat2.column)} | ${count(stat2.changed)} | ${shape} |`;
    });
    sections.push(
      ["| Column | Rows | Change |", "| --- | --- | --- |", ...rows].join("\n")
    );
  }
  if (table.sample.length > 0) {
    const shown = table.sample.slice(0, MAX_SAMPLE_ROWS);
    sections.push(
      `Sample, ${count(shown.length)} of ${count(totalRows(table))} changed rows:`
    );
    sections.push(rowTable(shown, table));
  }
  return sections.join("\n\n");
}
function totalRows(table) {
  return table.counts.inserted + table.counts.updated + table.counts.deleted;
}
function rowTable(rows, table) {
  const context = contextFor(table);
  const shown = rows.slice(0, MAX_ROWS_PER_TABLE);
  const body = shown.map((row) => {
    const op = row.op === "insert" ? "+" : row.op === "delete" ? "\u2212" : "~";
    const keyText = table.primaryKey === null || row.key.length === 0 ? "\u2014" : table.primaryKey.map((name, index) => `${name}=${valueText(row.key[index], name, context)}`).join(", ");
    const changes = row.cells.map((c) => describeCell(c, context)).join("<br>");
    return `| ${op} | ${cell(keyText)} | ${changes} |`;
  });
  const table_ = ["| | Key | Change |", "| --- | --- | --- |", ...body].join("\n");
  return rows.length > shown.length ? `${table_}

_${count(rows.length - shown.length)} further rows not shown._` : table_;
}
function describeCell(change, context) {
  if (change.redacted === "mask") {
    return `${cell(change.column)} = _[masked]_`;
  }
  const hasBefore = change.before !== void 0;
  const hasAfter = change.after !== void 0;
  if (hasBefore && hasAfter) {
    return `${cell(change.column)} ${cell(valueText(change.before, change.column, context))} \u2192 ${cell(valueText(change.after, change.column, context))}`;
  }
  const value = hasAfter ? change.after : change.before;
  return `${cell(change.column)} = ${cell(valueText(value, change.column, context))}`;
}
function footer(artifact, runUrl) {
  const redacted = new Set(
    artifact.meta.redactions.map((r) => `${ref2(r.table)}.${r.column}`)
  );
  const shown = [];
  for (const table of artifact.tables) {
    for (const column of table.columns) {
      if (!redacted.has(`${ref2(table)}.${column.name}`)) shown.push(column.name);
    }
  }
  const notable = [...new Set(shown.filter(isNotablePii))].sort();
  const parts = [
    `Values shown in full for ${count(shown.length)} columns` + (notable.length > 0 ? `, including ${notable.map(escapeText).join(", ")}` : "") + "."
  ];
  if (artifact.meta.redactions.length > 0) {
    const described = artifact.meta.redactions.map((r) => `${ref2(r.table)}.${r.column} (${r.mode})`).join(", ");
    parts.push(`${count(artifact.meta.redactions.length)} redacted: ${escapeText(described)}.`);
  }
  parts.push("Configure masking in `tidemark.config.ts`.");
  if (runUrl !== void 0) parts.push(`[Workflow run](${encodeURI(runUrl)})`);
  return `<sub>${parts.join(" ")}</sub>`;
}
function countSchemaChanges(artifact) {
  const { tablesAdded, tablesRemoved, tablesAltered } = artifact.schema;
  return tablesAdded.length + tablesRemoved.length + tablesAltered.reduce(
    (sum, table) => sum + table.columnsAdded.length + table.columnsRemoved.length + table.columnsAltered.length + table.constraintsAdded.length + table.constraintsRemoved.length + table.indexesAdded.length + table.indexesRemoved.length,
    0
  );
}

// src/github.ts
var PAGE_SIZE = 100;
function httpClient(token, apiUrl = "https://api.github.com", fetchImpl = fetch) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json"
  };
  async function send(url, method, body) {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${method} ${url} failed with ${response.status}: ${await response.text()}`
      );
    }
    return await response.json();
  }
  return {
    listComments: async (target) => {
      const comments = [];
      for (let page = 1; ; page++) {
        const url = `${apiUrl}/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`;
        const batch = await send(url, "GET");
        comments.push(...batch);
        if (batch.length < PAGE_SIZE) return comments;
      }
    },
    createComment: async (target, body) => {
      await send(
        `${apiUrl}/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments`,
        "POST",
        { body }
      );
    },
    updateComment: async (owner, repo, commentId, body) => {
      await send(
        `${apiUrl}/repos/${owner}/${repo}/issues/comments/${commentId}`,
        "PATCH",
        { body }
      );
    }
  };
}
async function upsertStickyComment(client, target, marker, body) {
  const comments = await client.listComments(target);
  const existing = comments.find((comment) => comment.body.includes(marker));
  if (existing === void 0) {
    await client.createComment(target, body);
    return "created";
  }
  await client.updateComment(target.owner, target.repo, existing.id, body);
  return "updated";
}

// src/inputs.ts
var InputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
};
function input(env, name) {
  const key2 = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  const value = env[key2];
  if (value === void 0) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function boolean(env, name, fallback) {
  const value = input(env, name);
  if (value === null) return fallback;
  if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  throw new InputError(`Input "${name}" must be true or false, got "${value}"`);
}
var FAIL_ON = ["none", "warnings", "danger"];
function readInputs(env) {
  const connection2 = input(env, "connection") ?? env["DATABASE_URL"] ?? null;
  if (connection2 === null) {
    throw new InputError(
      'Input "connection" is required, or set DATABASE_URL in the job environment.'
    );
  }
  const failOnRaw = input(env, "fail-on") ?? "none";
  if (!FAIL_ON.includes(failOnRaw)) {
    throw new InputError(
      `Input "fail-on" must be one of ${FAIL_ON.join(", ")}, got "${failOnRaw}"`
    );
  }
  return {
    connection: connection2,
    run: input(env, "run"),
    config: input(env, "config"),
    failOn: failOnRaw,
    comment: boolean(env, "comment", true),
    workingDirectory: input(env, "working-directory") ?? process.cwd(),
    token: input(env, "github-token") ?? env["GITHUB_TOKEN"] ?? null
  };
}
function pullRequestContext(env, payload) {
  const repository = env["GITHUB_REPOSITORY"];
  if (repository === void 0) return null;
  const [owner, repo] = repository.split("/");
  if (owner === void 0 || repo === void 0) return null;
  const event = payload;
  const raw = event?.pull_request?.number ?? event?.number;
  const issueNumber = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(issueNumber) && issueNumber > 0 ? { owner, repo, issueNumber } : null;
}

// src/main.ts
var EXIT_OK = 0;
var EXIT_ERROR = 1;
var EXIT_THRESHOLD = 2;
async function main(env = process.env, log = (m) => process.stderr.write(`${m}
`)) {
  const inputs = readInputs(env);
  const cwd = inputs.workingDirectory;
  const { config } = await loadConfig(inputs.config ?? void 0, cwd);
  const sql = connect(inputs.connection);
  try {
    const server = await assertSupported(sql);
    log("tidemark: capturing baseline");
    const handle = await startSnapshotCapture(sql, captureOptionsFrom(config));
    if (inputs.run !== null) {
      log("tidemark: running your command");
      const code = await runUserCommand(inputs.run, cwd, {
        ...env,
        DATABASE_URL: inputs.connection,
        // Colour would only become escape codes in a log file.
        NO_COLOR: "1"
      });
      if (code !== 0) {
        log(`tidemark: your command exited ${code}, capturing the diff anyway`);
      }
    }
    log("tidemark: building diff");
    const capture = await stopSnapshotCapture(sql, handle);
    const artifact = buildArtifact({ handle, capture, server, config });
    await dropShadowSchema(sql, handle.shadowSchema);
    const runUrl = workflowRunUrl(env);
    const markdown = renderMarkdown(artifact, runUrl === null ? {} : { runUrl });
    const artifactPath = await writeArtifactFile(cwd, artifact);
    await writeStepSummary(env, markdown);
    await maybeComment(inputs, env, markdown, log);
    await writeOutputs(env, artifact, artifactPath);
    return exitFor(artifact, inputs.failOn);
  } finally {
    await sql.end();
  }
}
async function runUserCommand(script, cwd, env) {
  return await new Promise((resolve2, reject) => {
    const child = spawn("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", reject);
    child.on("close", (code) => resolve2(code ?? EXIT_ERROR));
  });
}
function workflowRunUrl(env) {
  const server = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  const runId = env["GITHUB_RUN_ID"];
  if (server === void 0 || repository === void 0 || runId === void 0) {
    return null;
  }
  return `${server}/${repository}/actions/runs/${runId}`;
}
async function writeArtifactFile(cwd, artifact) {
  const dir = join2(cwd, ".tidemark");
  await mkdir(dir, { recursive: true });
  const path = join2(dir, "artifact.json");
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}
`, "utf8");
  return path;
}
async function writeStepSummary(env, markdown) {
  const path = env["GITHUB_STEP_SUMMARY"];
  if (path === void 0) return;
  await appendFile(path, `${markdown}
`, "utf8");
}
async function writeOutputs(env, artifact, artifactPath) {
  const path = env["GITHUB_OUTPUT"];
  if (path === void 0) return;
  const dangers = artifact.warnings.filter((w) => w.severity === "danger").length;
  const lines = [
    `warnings=${artifact.warnings.length}`,
    `dangers=${dangers}`,
    `tables=${artifact.tables.length}`,
    `artifact-path=${artifactPath}`
  ];
  await appendFile(path, `${lines.join("\n")}
`, "utf8");
}
async function maybeComment(inputs, env, markdown, log) {
  if (!inputs.comment) return;
  if (inputs.token === null) {
    log("tidemark: no github-token, skipping the pull request comment");
    return;
  }
  const payload = await readEventPayload(env);
  const target = pullRequestContext(env, payload);
  if (target === null) {
    log("tidemark: not a pull request, skipping the comment");
    return;
  }
  const client = httpClient(inputs.token, env["GITHUB_API_URL"] ?? void 0);
  const outcome = await upsertStickyComment(
    client,
    target,
    COMMENT_MARKER,
    markdown
  );
  log(`tidemark: ${outcome} the pull request comment`);
}
async function readEventPayload(env) {
  const path = env["GITHUB_EVENT_PATH"];
  if (path === void 0) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
function exitFor(artifact, failOn) {
  if (failOn === "none") return EXIT_OK;
  const relevant = failOn === "danger" ? artifact.warnings.filter((w) => w.severity === "danger") : artifact.warnings;
  return relevant.length > 0 ? EXIT_THRESHOLD : EXIT_OK;
}
export {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_THRESHOLD,
  exitFor,
  main
};
