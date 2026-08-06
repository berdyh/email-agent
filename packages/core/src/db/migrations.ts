// Pure helpers for the drop-and-recreate migrations in `connection.ts`.
//
// LanceDB has no ALTER TABLE, so adding a column means reading every row,
// dropping the table, recreating it under the new Arrow schema, and
// re-inserting. That sequence is only safe if the rows handed back to
// `add()` match the new schema exactly, which is what these helpers enforce —
// and they are pure, so the projection rules are testable without a real DB.

/**
 * Column names present in the target schema but missing from the table on
 * disk. A non-empty result is the signal to run a drop/recreate migration.
 */
export function missingColumns(
  existing: readonly string[],
  required: readonly string[],
): string[] {
  const present = new Set(existing);
  return required.filter((name) => !present.has(name));
}

/**
 * Projects a legacy row onto exactly the target schema's columns.
 *
 * Extra columns from an older shape are dropped (LanceDB rejects an `add()`
 * carrying fields the schema does not declare), and columns the old table
 * never had are filled from `defaults`. A column that is neither present nor
 * defaulted throws rather than being inserted as null: a null in a
 * non-nullable Arrow field fails at insert time with a message that says
 * nothing about which migration produced it, and quietly guessing a value for
 * an audit-trail row is worse than refusing to migrate.
 */
export function projectRowToSchema(
  row: Record<string, unknown>,
  fields: readonly string[],
  defaults: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in row && row[field] !== undefined && row[field] !== null) {
      projected[field] = row[field];
      continue;
    }
    if (field in defaults) {
      projected[field] = defaults[field];
      continue;
    }
    throw new Error(
      `Cannot migrate row: column "${field}" is absent and has no migration default`,
    );
  }
  return projected;
}

export function projectRowsToSchema(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[],
  defaults: Readonly<Record<string, unknown>> = {},
): Array<Record<string, unknown>> {
  return rows.map((row) => projectRowToSchema(row, fields, defaults));
}
