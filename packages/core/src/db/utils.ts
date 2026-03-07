/** Escape single quotes for LanceDB `.where()` filter strings. */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
