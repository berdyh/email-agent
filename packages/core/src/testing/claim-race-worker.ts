/**
 * One side of the two-PROCESS claim race driven by
 * `db/cross-process-claim.race.test.ts`.
 *
 * This is a real forked OS process with its own LanceDB handle over a shared
 * directory — the scenario the in-process probes could only approximate (a CLI
 * run racing a `serve`). `$HOME` arrives through the fork's env, so
 * `config/defaults.ts` resolves `LANCEDB_DIR` inside the parent's temp home at
 * module load, exactly as it would for a real process started by the user.
 *
 * PROTOCOL — a two-phase barrier, because timing alone is not evidence.
 *
 *   parent -> "prepare"  : open a FRESH table handle at the current version and
 *                          reply "ready". Both sides do this before either
 *                          writes, which is what makes the outcome a property of
 *                          LanceDB's commit check rather than of who woke first.
 *   parent -> "go"       : perform the write immediately and report what
 *                          happened, including the error text if it threw.
 *
 * Two modes, because the two levels answer different questions:
 *   "raw"   — `table.update()` straight on the pinned handle, no retry. This is
 *             the LanceDB primitive the whole claim/lease design rests on.
 *   "claim" — `claimPendingOperations()`, the function the product calls, which
 *             wraps the primitive in refresh + bounded conflict retry.
 */

import { getDb } from "../db/connection.js";
import { pendingOperationsTable } from "../db/schema.js";
import { claimPendingOperations } from "../db/pending-operations.js";
import type { Table } from "@lancedb/lancedb";

export type WorkerMode = "raw" | "claim";

export interface PrepareMessage {
  type: "prepare";
  round: number;
}
export interface GoMessage {
  type: "go";
  round: number;
  ids: string[];
  token: string;
}
export type ParentMessage = PrepareMessage | GoMessage;

export interface ReadyMessage {
  type: "ready";
  round: number;
}
export interface DoneMessage {
  type: "done";
  round: number;
  /** Row ids this process ended up owning. Empty when it lost. */
  won: string[];
  /** The error text, or null when the write committed. */
  error: string | null;
  /** Wall clock at the instant the write was issued, for the race report. */
  startedAt: number;
}
export type WorkerMessage = ReadyMessage | DoneMessage;

const mode = (process.argv[2] ?? "raw") as WorkerMode;
const label = process.argv[3] ?? "?";

let table: Table | null = null;

function send(message: WorkerMessage): void {
  process.send?.(message);
}

async function prepare(): Promise<void> {
  const db = await getDb();
  // A FRESH handle each round, pinned at whatever version the previous round
  // left. Both processes take theirs before either writes.
  table = await db.openTable(pendingOperationsTable);
}

async function runRaw(ids: string[], token: string): Promise<string[]> {
  const list = ids.map((id) => `'${id}'`).join(", ");
  // Deliberately NOT `updateAtLatestVersion`: no `checkoutLatest()`, no retry.
  // The pinned read version is the whole point — it is what makes the loser's
  // commit conflict deterministic rather than a matter of microseconds.
  await (table as Table).update({
    where: `id IN (${list}) AND status = 'pending'`,
    values: { status: "applying", claimToken: token },
  });
  await (table as Table).checkoutLatest();
  const rows = (await (table as Table)
    .query()
    .where(`\`claimToken\` = '${token}'`)
    .limit(1_000_000)
    .toArray()) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function runClaim(ids: string[], token: string): Promise<string[]> {
  const won = await claimPendingOperations(ids, token, "applying");
  return won.map((row) => row.id);
}

process.on("message", (message: ParentMessage) => {
  void (async () => {
    if (message.type === "prepare") {
      await prepare();
      send({ type: "ready", round: message.round });
      return;
    }

    const startedAt = Date.now();
    try {
      const won =
        mode === "raw"
          ? await runRaw(message.ids, message.token)
          : await runClaim(message.ids, message.token);
      send({ type: "done", round: message.round, won, error: null, startedAt });
    } catch (err) {
      send({
        type: "done",
        round: message.round,
        won: [],
        error: err instanceof Error ? err.message : String(err),
        startedAt,
      });
    }
  })().catch((err: unknown) => {
    send({
      type: "done",
      round: message.round,
      won: [],
      error: `worker ${label} crashed: ${String(err)}`,
      startedAt: Date.now(),
    });
  });
});
