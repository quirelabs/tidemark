import type {
  AlteredColumn,
  AlteredTable,
  ColumnDefinition,
  NamedDefinition,
  SchemaDiff,
  TableRef,
} from "../artifact/schema.ts";
import type {
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
  SchemaSnapshot,
  TableSchema,
} from "../schema/types.ts";

/**
 * Compares two catalog snapshots. Tables are matched by oid, so a table dropped
 * and recreated under the same name reads as a removal plus an addition, and a
 * renamed table stays one table.
 *
 * Everything is sorted, so two runs over the same change produce byte-identical
 * output.
 */
export function diffSchemas(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
): SchemaDiff {
  const beforeByOid = new Map(before.tables.map((t) => [t.oid, t]));
  const afterByOid = new Map(after.tables.map((t) => [t.oid, t]));

  const tablesAdded: TableRef[] = [];
  const tablesAltered: AlteredTable[] = [];

  for (const table of after.tables) {
    const previous = beforeByOid.get(table.oid);
    if (previous === undefined) {
      tablesAdded.push(ref(table));
      continue;
    }
    const altered = diffTable(previous, table);
    if (altered !== null) tablesAltered.push(altered);
  }

  const tablesRemoved = before.tables
    .filter((t) => !afterByOid.has(t.oid))
    .map(ref);

  return {
    tablesAdded: sortRefs(tablesAdded),
    tablesRemoved: sortRefs(tablesRemoved),
    tablesAltered: tablesAltered.sort((a, b) => label(a).localeCompare(label(b))),
  };
}

function ref(table: TableSchema): TableRef {
  return { schema: table.schema, name: table.name };
}

function label(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

function sortRefs(refs: TableRef[]): TableRef[] {
  return refs.sort((a, b) => label(a).localeCompare(label(b)));
}

function diffTable(before: TableSchema, after: TableSchema): AlteredTable | null {
  const beforeColumns = new Map(before.columns.map((c) => [c.name, c]));
  const afterColumns = new Map(after.columns.map((c) => [c.name, c]));

  const columnsAdded: ColumnDefinition[] = [];
  const columnsAltered: AlteredColumn[] = [];

  for (const column of after.columns) {
    const previous = beforeColumns.get(column.name);
    if (previous === undefined) {
      columnsAdded.push(definition(column));
      continue;
    }
    if (columnChanged(previous, column)) {
      columnsAltered.push({
        name: column.name,
        before: definition(previous),
        after: definition(column),
      });
    }
  }

  const columnsRemoved = before.columns
    .filter((c) => !afterColumns.has(c.name))
    .map(definition);

  // A constraint or index whose definition changed is reported as a removal
  // plus an addition. There is no useful middle ground: the text is canonical,
  // so a partial diff of it would be noise rather than information.
  const constraints = diffNamed(
    before.constraints.map(namedConstraint),
    after.constraints.map(namedConstraint),
  );
  const indexes = diffNamed(
    before.indexes.map(namedIndex),
    after.indexes.map(namedIndex),
  );

  const renamed = before.name !== after.name || before.schema !== after.schema;
  const changed =
    columnsAdded.length > 0 ||
    columnsRemoved.length > 0 ||
    columnsAltered.length > 0 ||
    constraints.added.length > 0 ||
    constraints.removed.length > 0 ||
    indexes.added.length > 0 ||
    indexes.removed.length > 0;

  if (!changed && !renamed) return null;

  return {
    schema: after.schema,
    name: after.name,
    ...(renamed ? { renamedFrom: ref(before) } : {}),
    columnsAdded,
    columnsRemoved,
    columnsAltered,
    constraintsAdded: constraints.added,
    constraintsRemoved: constraints.removed,
    indexesAdded: indexes.added,
    indexesRemoved: indexes.removed,
  };
}

function columnChanged(before: ColumnSchema, after: ColumnSchema): boolean {
  return (
    before.dataType !== after.dataType ||
    before.nullable !== after.nullable ||
    before.default !== after.default ||
    before.identity !== after.identity ||
    before.generated !== after.generated
  );
}

function definition(column: ColumnSchema): ColumnDefinition {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    default: column.default,
  };
}

function namedConstraint(constraint: ConstraintSchema): NamedDefinition {
  return { name: constraint.name, definition: constraint.definition };
}

function namedIndex(index: IndexSchema): NamedDefinition {
  return { name: index.name, definition: index.definition };
}

function diffNamed(
  before: readonly NamedDefinition[],
  after: readonly NamedDefinition[],
): { added: NamedDefinition[]; removed: NamedDefinition[] } {
  const beforeByName = new Map(before.map((d) => [d.name, d]));
  const afterByName = new Map(after.map((d) => [d.name, d]));

  const added = after.filter((d) => {
    const previous = beforeByName.get(d.name);
    return previous === undefined || previous.definition !== d.definition;
  });
  const removed = before.filter((d) => {
    const next = afterByName.get(d.name);
    return next === undefined || next.definition !== d.definition;
  });

  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
  };
}

function byName(a: NamedDefinition, b: NamedDefinition): number {
  return a.name.localeCompare(b.name);
}
