/**
 * Identifiers come from pg_catalog, so they are already trusted, but they can
 * still contain quotes, dots and mixed case. Everything that reaches SQL goes
 * through here rather than being interpolated raw.
 */

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * bigint and numeric exceed what a JS number holds exactly, and to_jsonb emits
 * them as JSON numbers, so a large id or a money column would silently lose
 * precision on parse. Those columns travel as text instead.
 */
const EXACT_NUMERIC = /^(bigint|numeric|decimal)/i;

export function needsTextCast(dataType: string): boolean {
  return EXACT_NUMERIC.test(dataType);
}

export interface SqlColumn {
  name: string;
  /**
   * Set for exact numerics, and for columns whose type changed during the
   * capture window. In the second case the two sides have no common comparison
   * operator, so text is the only thing they can both become.
   */
  castToText: boolean;
}

export function columnRef(alias: string, column: SqlColumn): string {
  const ref = `${alias}.${quoteIdent(column.name)}`;
  return column.castToText ? `${ref}::text` : ref;
}

/** Select list that fixes both the type and the output name of every column. */
export function selectList(
  alias: string,
  columns: readonly SqlColumn[],
): string {
  return columns
    .map((c) => `${columnRef(alias, c)} as ${quoteIdent(c.name)}`)
    .join(", ");
}

export function columnList(alias: string, columns: readonly string[]): string {
  return columns.map((c) => `${alias}.${quoteIdent(c)}`).join(", ");
}

/** Equality across a composite key. Primary key columns are never null. */
export function keyJoin(
  left: string,
  right: string,
  key: readonly string[],
): string {
  return key
    .map((c) => `${left}.${quoteIdent(c)} = ${right}.${quoteIdent(c)}`)
    .join(" and ");
}

/** Row-wise inequality that treats null as a value rather than as unknown. */
export function rowDistinct(
  left: string,
  right: string,
  columns: readonly SqlColumn[],
): string {
  const l = columns.map((c) => columnRef(left, c)).join(", ");
  const r = columns.map((c) => columnRef(right, c)).join(", ");
  return `(${l}) is distinct from (${r})`;
}

/** Single value as jsonb, with the same precision rule as selectList. */
export function jsonValue(alias: string, column: SqlColumn): string {
  return `to_jsonb(${columnRef(alias, column)})`;
}
