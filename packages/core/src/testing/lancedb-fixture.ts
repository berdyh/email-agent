/**
 * The shared temp-directory LanceDB fixture.
 *
 * WHY THIS FILE HAS NO STATIC IMPORT OF ANYTHING IN `../`.
 *
 * `config/defaults.ts` computes `LANCEDB_DIR` from `homedir()` AT MODULE LOAD.
 * Static imports are hoisted above every statement in a module, so any test that
 * imports a core module at the top of the file has already resolved the database
 * path against the developer's REAL `$HOME` before its first line runs — and the
 * test then reads and writes `~/.email-agent/data/lancedb`. Redirecting `$HOME`
 * must therefore happen before the first core import, which means the modules
 * under test have to be pulled in with `await import(...)` *after* `useTempHome()`.
 *
 * This module is the only thing a test may import statically, and it imports
 * nothing from core itself. Every helper below reaches core through a dynamic
 * import at call time, so importing this file never fixes `LANCEDB_DIR`.
 *
 * `useTempHome()` does not trust that discipline: it re-reads `LANCEDB_DIR` after
 * redirecting `$HOME` and THROWS if the value does not point inside the temp
 * home. A test that gets the ordering wrong fails loudly on its first line
 * instead of quietly operating on the developer's real mailbox database.
 *
 * `node --test` runs each test FILE in its own process, so the `$HOME` swap is
 * confined to that file.
 *
 * NOT SHIPPED DELIBERATELY: this lives under `src/` so it type-checks with the
 * rest of core and is compiled into `dist/testing/`, but it is not re-exported
 * from `src/index.ts` and is not listed in the package `exports` map, so no
 * product code can reach it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import type {
  ActionResultRecord,
  EmailRecord,
  PendingOperationRecord,
} from "../db/schema.js";

/** Everything the fixture knows about the throwaway home it created. */
export interface TempHome {
  /** The directory now standing in for `$HOME`. */
  path: string;
  /** `LANCEDB_DIR` as core resolved it — asserted to live under `path`. */
  lancedbDir: string;
}

/**
 * Redirects `$HOME` at a fresh temp directory and verifies core agrees.
 *
 * Call this at the TOP LEVEL of a test file, before any `await import()` of a
 * core module. Registers an `after()` hook that removes the directory.
 */
export async function useTempHome(label: string): Promise<TempHome> {
  const path = await mkdtemp(join(tmpdir(), `email-agent-${label}-`));
  process.env["HOME"] = path;
  // Windows reads USERPROFILE; keep them in step so the assertion below means
  // the same thing on every platform.
  process.env["USERPROFILE"] = path;

  // THE ORDERING GUARD. If a core module was already loaded — a stray static
  // import, or a helper that pulled one in — `LANCEDB_DIR` was computed against
  // the real home and this throws instead of letting the test scribble there.
  const { LANCEDB_DIR } = await import("../config/defaults.js");
  assert.ok(
    LANCEDB_DIR.startsWith(path),
    `LANCEDB_DIR is ${LANCEDB_DIR}, which is NOT inside the temp home ${path}. ` +
      `A core module was imported before useTempHome() ran, so this test would ` +
      `operate on the real ~/.email-agent database. Move every core import ` +
      `below the useTempHome() call and use await import().`,
  );

  after(async () => {
    await rm(path, { recursive: true, force: true });
  });

  return { path, lancedbDir: LANCEDB_DIR };
}

/** Runs the real `initDb()` — schema creation and migration — against the temp home. */
export async function initTempDb(): Promise<void> {
  const { initDb } = await import("../db/connection.js");
  await initDb();
}

/** `useTempHome` + `initTempDb`, which is what almost every caller wants. */
export async function useTempDb(label: string): Promise<TempHome> {
  const home = await useTempHome(label);
  await initTempDb();
  return home;
}

// ---------------------------------------------------------------------------
// Seeding
//
// Each helper takes PARTIAL records over a complete default, so a test names
// only the fields its assertion depends on. The defaults are deliberately
// boring and valid — a seeded row is exactly what the product writes, because
// every one of these goes through the same insert path the product uses.
// ---------------------------------------------------------------------------

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function pendingOperation(
  overrides: Partial<PendingOperationRecord> = {},
): PendingOperationRecord {
  const id = (overrides.id as string | undefined) ?? nextId("op");
  return {
    id,
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk Detector",
    accountId: "me@example.com",
    emailId: `msg-${id}`,
    type: "trash",
    labelIds: "[]",
    status: "pending",
    error: "",
    claimToken: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "",
    resolvedAt: "",
    ...overrides,
  };
}

/**
 * Inserts queue rows through `savePendingOperations` — the product's own insert
 * path, not a hand-rolled `table.add`.
 */
export async function seedPendingOperations(
  rows: Array<Partial<PendingOperationRecord>>,
): Promise<PendingOperationRecord[]> {
  const records = rows.map((row) => pendingOperation(row));
  const { savePendingOperations } = await import("../db/pending-operations.js");
  await savePendingOperations(records);
  return records;
}

export function emailRecord(overrides: Partial<EmailRecord> = {}): EmailRecord {
  const id = (overrides.id as string | undefined) ?? nextId("msg");
  return {
    id,
    accountId: "me@example.com",
    threadId: `thread-${id}`,
    from: "sender@example.com",
    to: "me@example.com",
    subject: `Subject ${id}`,
    date: "2026-08-01T00:00:00.000Z",
    bodyText: "body",
    bodyHtml: "<p>body</p>",
    labels: '["INBOX"]',
    isUnread: true,
    senderDomain: "example.com",
    snippet: `snippet ${id}`,
    vector: [],
    ...overrides,
  };
}

/**
 * Inserts email rows through `upsertEmails`.
 *
 * `vector` is filled with the zero vector at the table's declared dimension
 * when the caller does not supply one — the Arrow column is a fixed-size list,
 * so a wrong-length array is rejected at insert time rather than at read time.
 */
export async function seedEmails(
  rows: Array<Partial<EmailRecord>>,
): Promise<EmailRecord[]> {
  const { VECTOR_DIMENSION } = await import("../shared/vector.js");
  const records = rows.map((row) => {
    const record = emailRecord(row);
    if (record.vector.length === 0) {
      record.vector = new Array<number>(VECTOR_DIMENSION).fill(0);
    }
    return record;
  });
  const { upsertEmails } = await import("../db/emails.js");
  await upsertEmails(records);
  return records;
}

export function actionResult(
  overrides: Partial<ActionResultRecord> = {},
): ActionResultRecord {
  const id = (overrides.id as string | undefined) ?? nextId("res");
  return {
    id,
    actionId: "junk",
    accountId: "me@example.com",
    status: "success",
    emailIds: "[]",
    resultData: "{}",
    agentUsed: "claude",
    tokensUsed: 0,
    durationMs: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Inserts action-history rows through `saveActionResult`. */
export async function seedActionResults(
  rows: Array<Partial<ActionResultRecord>>,
): Promise<ActionResultRecord[]> {
  const records = rows.map((row) => actionResult(row));
  const { saveActionResult } = await import("../db/actions.js");
  for (const record of records) await saveActionResult(record);
  return records;
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/** Every queue row, id-sorted, read with a fresh handle at the latest version. */
export async function readAllPendingOperations(): Promise<
  PendingOperationRecord[]
> {
  const { getDb } = await import("../db/connection.js");
  const { pendingOperationsTable } = await import("../db/schema.js");
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.checkoutLatest();
  const { UNLIMITED_QUERY_ROWS } = await import("../db/utils.js");
  const rows = (await table
    .query()
    .limit(UNLIMITED_QUERY_ROWS)
    .toArray()) as unknown as PendingOperationRecord[];
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** One queue row by id, asserting it exists. */
export async function readPendingOperation(
  id: string,
): Promise<PendingOperationRecord> {
  const rows = await readAllPendingOperations();
  const row = rows.find((candidate) => candidate.id === id);
  assert.ok(row, `queue row ${id} is not in the table`);
  return row;
}

/**
 * Ages a claimed row so it looks hung rather than merely in flight.
 *
 * The staleness rule is a real timestamp comparison, so the only honest way to
 * exercise it is to move the timestamp. Writes straight to the table because
 * there is deliberately no product function that back-dates a claim.
 */
export async function backdateClaim(
  id: string | readonly string[],
  ms: number,
): Promise<void> {
  const ids = typeof id === "string" ? [id] : id;
  if (ids.length === 0) return;

  const { getDb } = await import("../db/connection.js");
  const { pendingOperationsTable } = await import("../db/schema.js");
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.checkoutLatest();
  // ONE update for the whole list, deliberately. A `Promise.all` of per-id
  // updates races LanceDB's MVCC commits against each other and fails with
  // `Commit conflict for version N` — the same conflict the product's
  // `updateAtLatestVersion` exists to absorb, which a raw fixture write does
  // not have.
  const list = ids.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  await table.update({
    where: `id IN (${list})`,
    values: { claimedAt: new Date(Date.now() - ms).toISOString() },
  });
}

/** Runs `fn` with `console.warn` captured, returning both the value and the lines. */
export async function capturingWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}
