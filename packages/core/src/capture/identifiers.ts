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
  columns: readonly string[],
): string {
  return `(${columnList(left, columns)}) is distinct from (${columnList(right, columns)})`;
}
