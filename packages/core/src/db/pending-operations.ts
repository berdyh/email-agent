import type { Table } from "@lancedb/lancedb";
import { getDb } from "./connection.js";
import {
  pendingOperationsTable,
  type ApprovedVia,
  type PendingOperationRecord,
  type PendingOperationStatus,
} from "./schema.js";
import { escapeSql, UNLIMITED_QUERY_ROWS } from "./utils.js";

/**
 * A LanceDB `Table` HANDLE IS PINNED TO THE VERSION IT WAS OPENED AT. Verified
 * against `@lancedb/lancedb` 0.15.0 on a real temp-directory table (2026-08-07),
 * by racing two handles over one row:
 *
 *   * a handle advances only through its OWN writes;
 *   * `query()` on a handle another writer has moved past returns the OLD rows,
 *     with no error;
 *   * `update()` on such a handle THROWS `Commit conflict for version N`,
 *     rather than committing or matching nothing;
 *   * `checkoutLatest()` refreshes the handle in place (returns `undefined`),
 *     after which both the read and the write see the current version.
 *
 * That matters for every multi-step read/write sequence in this module. Without
 * a refresh, a sequence that is *supposed* to degrade into "my predicate now
 * matches nothing" instead explodes, and a read-back taken to count what a
 * write reached can be a snapshot from before someone else's commit.
 *
 * # WHICH FUNCTIONS HERE NEED THE WRAPPERS, AND WHICH DO NOT
 *
 * The rule is not "reads are safe": a stale handle's `countRows()` answers from
 * its own snapshot with no error (measured — 6 where the table held 5). The
 * rule is that a handle is only stale if something committed AFTER it was
 * opened, so a function that opens a fresh handle and takes ONE step is
 * reading the version current at the moment it asked, which is the most any
 * caller could get.
 *
 * SINGLE-STEP, therefore safe as written — each opens its own handle and does
 * one thing before returning:
 *   - `getPendingOperations`, `getPendingOperationsByIds`,
 *     `getPendingOperationsForEmails`, `countPendingOperations` (one read)
 *   - `savePendingOperations` (one append; appends do not conflict, and there
 *     is nothing after it to go stale)
 * `getStaleApplyingOperations` is single-step too — it delegates to
 * `getPendingOperations` and filters in JS.
 *
 * MULTI-STEP, therefore routed through the wrappers below:
 *   - `claimPendingOperations` (update, then read back by token)
 *   - `resolveClaimedOperations` (several updates, then a read back)
 *   - `resolveStrandedApplyingOperations` (claim, read, write, read, release)
 *   - `prunePendingOperations` (count, then delete)
 *
 * Elsewhere in `db/`: `emails.ts` and `clusters.ts` deliberately take the raw
 * error. `upsertEmails` and `saveClusters` are delete-then-append pairs and
 * would hit the same conflict, but they are single-write non-queue paths where
 * an error surfacing to a caller who can repeat the action is the right
 * outcome — a failed `fetch` is repeatable, a queue write that is supposed to
 * lose a race quietly is not.
 */
const COMMIT_CONFLICT_BACKOFF_MS = [1, 5, 20, 80] as const;

function isCommitConflict(err: unknown): boolean {
  return err instanceof Error && /commit conflict/i.test(err.message);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Refreshes the handle, then updates. Retries a commit conflict on a short
 * bounded ladder, because a conflict means only "someone committed between the
 * refresh and ours" — every predicate here is token- or status-scoped and
 * therefore idempotent, so re-running it against the newer version is exactly
 * right. Exhausting the ladder rethrows rather than pretending the write landed.
 */
async function updateAtLatestVersion(
  table: Table,
  args: { where: string; values: Record<string, string> },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await table.checkoutLatest();
    try {
      await table.update(args);
      return;
    } catch (err) {
      if (
        !isCommitConflict(err) ||
        attempt >= COMMIT_CONFLICT_BACKOFF_MS.length
      ) {
        throw err;
      }
      await sleep(COMMIT_CONFLICT_BACKOFF_MS[attempt] as number);
    }
  }
}

/**
 * Refreshes the handle, then deletes. Same contract as
 * `updateAtLatestVersion`, and needed for the same measured reason: a
 * `table.delete()` on a handle another writer has moved past THROWS
 * `Commit conflict for version N` — verified against `@lancedb/lancedb` 0.15.0
 * on a real temp-directory table (2026-08-07) by racing an `update()` from a
 * second handle between this handle's read and its delete. The error text is
 * the same one `isCommitConflict()` already keys off.
 *
 * The prune predicate is status- and time-scoped and therefore idempotent, so
 * re-running it against the newer version is exactly right.
 */
async function deleteAtLatestVersion(table: Table, where: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await table.checkoutLatest();
    try {
      await table.delete(where);
      return;
    } catch (err) {
      if (
        !isCommitConflict(err) ||
        attempt >= COMMIT_CONFLICT_BACKOFF_MS.length
      ) {
        throw err;
      }
      await sleep(COMMIT_CONFLICT_BACKOFF_MS[attempt] as number);
    }
  }
}

/** Reads at the current version, never at whatever the handle was opened at. */
async function queryAtLatestVersion(
  table: Table,
  where: string,
): Promise<PendingOperationRecord[]> {
  await table.checkoutLatest();
  return (await table
    .query()
    .where(where)
    .limit(UNLIMITED_QUERY_ROWS)
    .toArray()) as unknown as PendingOperationRecord[];
}

export function buildPendingOperationFilters(options?: {
  status?: PendingOperationStatus;
  batchId?: string;
  accountId?: string;
}): string[] {
  const filters: string[] = [];
  if (options?.status) {
    filters.push(`status = '${escapeSql(options.status)}'`);
  }
  if (options?.batchId !== undefined) {
    filters.push(`\`batchId\` = '${escapeSql(options.batchId)}'`);
  }
  if (options?.accountId !== undefined) {
    filters.push(`\`accountId\` = '${escapeSql(options.accountId)}'`);
  }
  return filters;
}

/**
 * `column IN (...)` over string values.
 *
 * `column` is a literal from this module, never user input — only the values
 * are escaped. camelCase columns must be backticked by the caller: LanceDB's
 * DataFusion parser folds unquoted identifiers to lowercase.
 */
export function buildInFilter(column: string, values: string[]): string {
  // `IN ()` is a parse error in DataFusion, so an empty list must never reach
  // the query builder — callers short-circuit before this point.
  if (values.length === 0) {
    throw new Error(`buildInFilter requires at least one value for ${column}`);
  }
  const quoted = values.map((value) => `'${escapeSql(value)}'`);
  return `${column} IN (${quoted.join(", ")})`;
}

export function buildIdListFilter(ids: string[]): string {
  if (ids.length === 0) {
    throw new Error("buildIdListFilter requires at least one id");
  }
  return buildInFilter("id", ids);
}

/**
 * Still-pending rows touching any of `emailIds` — the dedupe lookup for a new
 * enqueue, scoped to the emails in question rather than scanning the whole
 * queue.
 */
export function buildPendingEmailFilter(emailIds: string[]): string {
  return `status = 'pending' AND ${buildInFilter("`emailId`", emailIds)}`;
}

export async function getPendingOperationsForEmails(
  emailIds: string[],
): Promise<PendingOperationRecord[]> {
  if (emailIds.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const results = await table
    .query()
    .where(buildPendingEmailFilter(emailIds))
    .limit(UNLIMITED_QUERY_ROWS)
    .toArray();
  return results as unknown as PendingOperationRecord[];
}

/**
 * Resolution is only ever valid for a row that is still pending. Carrying the
 * status into the update predicate keeps two concurrent resolvers (two browser
 * tabs, the CLI racing the web UI) from overwriting each other's decision —
 * notably from flipping a row the user just rejected back to "applied".
 */
export function buildPendingResolutionFilter(ids: string[]): string {
  return `${buildIdListFilter(ids)} AND status = 'pending'`;
}

export function buildClaimFilter(token: string, status: string): string {
  return `\`claimToken\` = '${escapeSql(token)}' AND status = '${escapeSql(status)}'`;
}

/**
 * Atomically moves rows from `pending` to `status`, stamping them with this
 * attempt's `token`. LanceDB's update() reports no row count, so the caller
 * MUST read back by token to learn which rows it actually won — a concurrent
 * apply or reject may have taken some of them first.
 *
 * `approvedVia` is REQUIRED and has no default, deliberately: "" is reserved for
 * a row that is unclaimed or predates the column, so a claim that omitted a
 * surface would be indistinguishable from a legacy row in the audit trail. It is
 * a `values`-only field and never appears in a `where` predicate, so the claim's
 * atomic write predicate is exactly what it was. Attribution only — see
 * `ApprovedVia`; it prevents nothing.
 */
export async function claimPendingOperations(
  ids: string[],
  token: string,
  status: Exclude<PendingOperationStatus, "pending">,
  approvedVia: ApprovedVia,
  resolvedAt = "",
  claimedAt = new Date().toISOString(),
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  // `claimedAt` is stamped for every claim, not just `applying`. It records
  // when the row left `pending`, which is the only correct age basis for
  // spotting a row stranded by a crash mid-apply — `createdAt` is when the
  // change was proposed and can be arbitrarily older.
  //
  // Refreshed before the write: a second apply or reject committing between
  // `openTable` and here would otherwise make this THROW a commit conflict
  // rather than lose the race quietly, which is what the claim protocol
  // assumes. See COMMIT_CONFLICT_BACKOFF_MS.
  await updateAtLatestVersion(table, {
    where: buildPendingResolutionFilter(ids),
    values: { status, claimToken: token, resolvedAt, claimedAt, approvedVia },
  });

  return queryAtLatestVersion(table, buildClaimFilter(token, status));
}

export async function savePendingOperations(
  records: PendingOperationRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.add(records);
}

export async function getPendingOperations(options?: {
  status?: PendingOperationStatus;
  batchId?: string;
  accountId?: string;
  limit?: number;
}): Promise<PendingOperationRecord[]> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  // Unlimited by default is 10 rows in LanceDB — see UNLIMITED_QUERY_ROWS.
  // The newest-first sort and `limit` below both run in JS over the full match
  // set, so a truncated scan would silently hide queued Gmail changes.
  let query = table.query().limit(UNLIMITED_QUERY_ROWS);
  // One combined predicate — chained .where() calls REPLACE rather than AND
  // (see the same note in emails.ts), which would drop the status filter.
  const filters = buildPendingOperationFilters(options);
  if (filters.length > 0) {
    query = query.where(filters.join(" AND "));
  }
  // Fetch all matching rows, sort newest-batch-first, then slice. LanceDB
  // applies limit before this JS sort, so limiting in-query would return an
  // arbitrary N rows rather than the most recent N.
  const results = await query.toArray();
  const records = results as unknown as PendingOperationRecord[];
  // Every row in a batch shares one createdAt, so tie-break on batchId then id
  // for a total order — otherwise rows from two batches queued in the same
  // millisecond interleave and the grouped display repeats batch headers.
  records.sort((a, b) => {
    const byDate =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byDate !== 0) return byDate;
    if (a.batchId !== b.batchId) return a.batchId < b.batchId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return options?.limit ? records.slice(0, options.limit) : records;
}

/**
 * How long a row may sit in `applying` before it is treated as stranded.
 *
 * A healthy apply moves a row out of `applying` within one Gmail round trip
 * (chunked resolution keeps that to a handful of operations), so anything
 * still claimed after this long means the process died between the Gmail call
 * and the status write.
 */
export const STALE_APPLYING_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Rows claimed before `cutoffIso` and never resolved. Pure, so the age rule is
 * testable without a DB.
 *
 * Age is measured from `claimedAt`, falling back to `createdAt` for rows
 * migrated in from a table that predates the column — those have no recorded
 * claim time, and `createdAt` is necessarily older, so they surface rather
 * than hide.
 */
export function selectStaleApplyingOperations(
  rows: readonly PendingOperationRecord[],
  cutoffIso: string,
): PendingOperationRecord[] {
  const cutoff = new Date(cutoffIso).getTime();
  return rows.filter((row) => {
    if (row.status !== "applying") return false;
    const stamp = row.claimedAt || row.createdAt;
    const claimed = new Date(stamp).getTime();
    // An unparsable timestamp must surface, not hide: a row we cannot age is
    // exactly the row a crash left behind.
    if (Number.isNaN(claimed)) return true;
    return claimed <= cutoff;
  });
}

/**
 * Rows a crash left stranded mid-apply.
 *
 * The claim/lease means such a row is `applying`, not `pending`, so it can
 * never be silently re-applied — but it is also invisible to every surface,
 * which all list `status: "pending"`. Its Gmail mutation may or may not have
 * landed, so this is deliberately a *report*, not an auto-retry. What has NOT
 * changed: nothing here re-applies or rolls back anything.
 *
 * WHAT DID CHANGE, and this comment used to deny it. "Only the user can decide
 * whether the change went through" was true when this was written and is not
 * true now: `verifyStrandedApplyingOperations` (`actions/verify-stranded.ts`)
 * is a THIRD caller, it uses this as its own cheap gate, and it reads the
 * message's current labels back from Gmail and resolves what it can BEFORE any
 * human is shown the row. It still establishes no CAUSATION — an end-state
 * match is not proof this app's call produced it — and it deliberately refuses
 * to record an `accountId: ""` ADC row as applied. A present-tense sentence
 * denying that a check exists teaches the behaviour back, which is the failure
 * this repo keeps getting bitten by.
 *
 * Callers: `verifyStrandedApplyingOperations` (which resolves what it can and
 * leaves the rest), `GET /api/approvals/stranded` (rendered by
 * `StrandedOperationsPanel` on the web Actions page) and `email-agent approvals
 * stranded`. The two human surfaces LIST the residual and ask the user to
 * adjudicate it through `resolveStrandedApplyingOperations`.
 */
export async function getStaleApplyingOperations(options?: {
  olderThanMs?: number;
  now?: Date;
  accountId?: string;
}): Promise<PendingOperationRecord[]> {
  const olderThanMs = options?.olderThanMs ?? STALE_APPLYING_THRESHOLD_MS;
  const now = options?.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - olderThanMs).toISOString();
  const rows = await getPendingOperations({
    status: "applying",
    ...(options?.accountId !== undefined
      ? { accountId: options.accountId }
      : {}),
  });
  return selectStaleApplyingOperations(rows, cutoffIso);
}

/**
 * What a well-formed `Date#toISOString()` stamp looks like to DataFusion's
 * `LIKE`: `YYYY-MM-DDTHH:MM:SS.sssZ`, 24 characters, `_` matching any one.
 *
 * Used only to recognise a stamp that is NOT one, so a row whose `claimedAt`
 * cannot be read is still adjudicable — matching `selectStaleApplyingOperations`,
 * which surfaces such a row rather than hiding it.
 */
const ISO_STAMP_PATTERN = "____-__-__T__:__:__.___Z";

/**
 * SQL mirror of `selectStaleApplyingOperations`'s age rule, for use inside an
 * update predicate.
 *
 * It has to be SQL and not a JS pre-filter: the age test must be evaluated by
 * the same atomic write that stamps the claim token. A read-then-write would
 * leave a window in which a row aged out of `applying`, was requeued and
 * re-claimed by a fresh apply between the read and the stamp — and the stamp is
 * itself destructive, since it overwrites whatever token the live apply holds.
 *
 * Verified against `@lancedb/lancedb` 0.15.0 on a real temp-directory table
 * (2026-08-07): a stale stamp, an empty stamp with a stale `createdAt`, and an
 * unreadable stamp all match; a fresh stamp and an empty stamp with a fresh
 * `createdAt` do not.
 */
export function buildStrandedAgeClause(cutoffIso: string): string {
  const cutoff = escapeSql(cutoffIso);
  return [
    // Migrated in before the column existed: aged from `createdAt`, exactly as
    // `selectStaleApplyingOperations` does.
    `(\`claimedAt\` = '' AND \`createdAt\` <= '${cutoff}')`,
    `(\`claimedAt\` != '' AND \`claimedAt\` <= '${cutoff}')`,
    `(\`claimedAt\` != '' AND \`claimedAt\` NOT LIKE '${ISO_STAMP_PATTERN}')`,
  ].join(" OR ");
}

/**
 * Rows a stranded-row adjudication may touch: `applying`, and older than the
 * staleness cutoff.
 *
 * TWO GUARDS, FOR TWO DIFFERENT RACES.
 *
 * `status = 'applying'` stops an adjudication from reaching a row an apply
 * already finished. The ids come from a surface's own stale-list snapshot, and
 * by the time the user answers, an apply that was merely slow may have written
 * the row `applied` or `failed` — overwriting that with the user's guess would
 * destroy a fact with an opinion.
 *
 * The age clause stops an adjudication from reaching a row that is not stranded
 * at all. Nothing else re-checks the threshold: the surfaces filter their LISTS
 * by age, but the ids they then submit are just ids, and a row claimed one
 * second ago by a healthy apply would otherwise be adjudicable by any client
 * that named it — including a stale browser tab whose snapshot has since been
 * requeued and re-claimed. With the clause, the exposure shrinks to "an apply
 * that has genuinely been hung past the threshold", which is the only case the
 * surfaces ever claimed to cover. It does NOT eliminate that case: see
 * `resolveStrandedApplyingOperations`.
 */
export function buildStrandedClaimFilter(
  ids: string[],
  cutoffIso: string,
): string {
  return [
    buildIdListFilter(ids),
    "status = 'applying'",
    `(${buildStrandedAgeClause(cutoffIso)})`,
  ].join(" AND ");
}

/** The final state a stranded-row adjudication writes. `status` is required. */
export interface StrandedResolutionValues {
  status: PendingOperationStatus;
  error?: string;
  resolvedAt?: string;
  claimedAt?: string;
  /**
   * Only ever set to "" here, and only when a row is being put BACK to
   * `pending`: a row the user just told us was never applied must not keep
   * claiming attribution for that apply. The `applied` branch deliberately
   * leaves it alone, so a stranded row keeps recording which surface initiated
   * the crashed apply — the one case where the field is genuinely informative.
   */
  approvedVia?: string;
  /**
   * HOW this resolution was established — a `ResolutionEvidence` value on the
   * `applied` branch, and "" on a requeue (a `pending` row has no resolution,
   * so it can carry no evidence of one).
   *
   * The OPPOSITE convention to `approvedVia` on the applied branch, and
   * deliberately so: `approvedVia` is carried over because the surface that
   * initiated the crashed apply is still the true answer to "who approved
   * this?", whereas the evidence is being established right now by whoever is
   * writing, so it is stamped rather than preserved.
   *
   * A `values`-only slot, like `approvedVia`. It never enters a `where`
   * predicate, so the atomic claim filter is byte-for-byte unchanged.
   */
  resolutionEvidence?: string;
}

/**
 * Test-only seams. Injected rather than faked, because the interleavings these
 * expose are exactly what the return contract below depends on, and a mock of
 * LanceDB would prove nothing about them.
 */
export interface StrandedResolutionHooks {
  /** Runs after this call has stamped its token and read back what it won. */
  afterClaim?: () => Promise<void>;
}

/**
 * Records a judgement about rows a crash left mid-apply.
 *
 * THIS FUNCTION CONTACTS NOTHING. It writes down a conclusion reached
 * elsewhere: by a person who says they looked in Gmail, or by
 * `verifyStrandedApplyingOperations`, which reads the message's current labels
 * back and compares them with the operation's target state. `values` carries
 * which of those it was (`resolutionEvidence`), so the row records not just the
 * verdict but how it was reached.
 *
 * NEITHER SOURCE ESTABLISHES CAUSATION, and the difference between them is
 * smaller than it looks: Gmail message state is not a witness to whether *this*
 * operation caused it. An `applied` verdict means the end state matches, from
 * whatever produced it. `pending` means it does not, and puts the row back in
 * the approval queue so it can be approved again.
 *
 * CLAIM-THEN-WRITE, over rows that are `applying` AND past the staleness
 * cutoff: stamp a fresh token, read back by that token to learn what was won,
 * write the final state scoped to the same token, read back again to count what
 * that write actually reached, then release the token.
 *
 * WHAT THE RETURNED ROWS MEAN. They are the rows still carrying this call's
 * token in the state this call asked for, read AFTER the write. That is a true
 * count of what this call changed in every ordinary case, and it is what an
 * earlier revision got wrong: it returned the post-claim read, so a second
 * adjudication that stole the token in between made the first report rows the
 * second had actually decided. The one way it can still be wrong is by
 * UNDERCOUNTING — a `notApplied` row this call wrote back to `pending` can be
 * claimed by a fresh apply before the count read, which re-stamps the token and
 * hides the row from it. Undercounting understates what we did; overcounting
 * claims credit for someone else's decision. The direction is deliberate.
 *
 * WHAT IT STILL CANNOT PROTECT: an apply that is in flight AT claim time. The
 * age clause narrows that to an apply hung past `STALE_APPLYING_THRESHOLD_MS`,
 * but such an apply can still return from Gmail afterwards, and its write-back
 * (scoped to the token this call just overwrote) then matches nothing. If the
 * user answered "it didn't happen", the row goes back to `pending` and the
 * change can be sent to Gmail a SECOND time, with an audit trail saying it
 * never happened. `resolveClaimedOperations` detects and logs the discarded
 * outcome; nothing prevents it. The alternative — letting the hung apply win —
 * would leave the user unable to close out a row they have personally checked,
 * which is the failure this whole surface exists to remove, so the losing
 * direction is chosen deliberately.
 */
export async function resolveStrandedApplyingOperations(
  ids: string[],
  token: string,
  cutoffIso: string,
  values: StrandedResolutionValues,
  hooks?: StrandedResolutionHooks,
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  // Every step refreshes the handle first (see COMMIT_CONFLICT_BACKOFF_MS):
  // this whole function is a read/write sequence that a second adjudication can
  // interleave with, and on a pinned handle that interleaving throws a commit
  // conflict instead of degrading into the no-op the design assumes.
  await updateAtLatestVersion(table, {
    where: buildStrandedClaimFilter(ids, cutoffIso),
    values: { claimToken: token },
  });
  const won = await queryAtLatestVersion(
    table,
    buildClaimFilter(token, "applying"),
  );
  if (won.length === 0) return [];

  if (hooks?.afterClaim) await hooks.afterClaim();

  // The token is deliberately KEPT by this write. It is the only handle that
  // identifies the rows this write reached — LanceDB's update() reports no row
  // count, and a concurrent adjudication may have stolen some of them since the
  // read above.
  await updateAtLatestVersion(table, {
    where: buildClaimFilter(token, "applying"),
    values: { ...values, claimToken: token },
  });

  const changed = await queryAtLatestVersion(
    table,
    buildClaimFilter(token, values.status),
  );
  if (changed.length === 0) return [];

  // Release the lease. A row that is no longer `applying` holds no claim, and a
  // token left behind would make a later `buildClaimFilter` read match a row it
  // does not own. If the process dies between the two writes the row keeps a
  // spent token, which is inert — every reader scopes by a freshly minted UUID
  // — and the next `claimPendingOperations` overwrites it.
  await updateAtLatestVersion(table, {
    where: buildClaimFilter(token, values.status),
    values: { claimToken: "" },
  });
  return changed;
}

export async function getPendingOperationsByIds(
  ids: string[],
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const results = await table
    .query()
    .where(buildIdListFilter(ids))
    .limit(UNLIMITED_QUERY_ROWS)
    .toArray();
  return results as unknown as PendingOperationRecord[];
}

/**
 * Statuses a retention sweep may delete.
 *
 * `pending` and `applying` are excluded because they are unresolved: pruning a
 * pending row silently discards a change the user was never asked about, and
 * pruning an `applying` row destroys the only evidence that a Gmail mutation
 * may have landed without being recorded.
 *
 * `failed` is excluded too, deliberately. It looks resolved, but it is the
 * diagnostic record of an attempted mutation whose outcome the user may still
 * be chasing — and failed rows are rare, so keeping them forever costs nothing
 * that pruning `applied`/`rejected` does not already recover.
 */
export const PRUNABLE_STATUSES = ["applied", "rejected"] as const;

/**
 * Rows resolved strictly before `olderThanIso`.
 *
 * `resolvedAt` holds `Date#toISOString()` output — fixed-width UTC with a
 * trailing `Z` — which orders lexicographically exactly as it orders
 * chronologically, so a string comparison is a date comparison here. The
 * explicit `!= ''` guard matters because "" sorts before every real timestamp
 * and would otherwise sweep away any unresolved row that slipped into a
 * prunable status.
 */
export function buildPruneFilter(olderThanIso: string): string {
  const statuses = PRUNABLE_STATUSES.map(
    (status) => `'${escapeSql(status)}'`,
  ).join(", ");
  return [
    `status IN (${statuses})`,
    "`resolvedAt` != ''",
    `\`resolvedAt\` < '${escapeSql(olderThanIso)}'`,
  ].join(" AND ");
}

/**
 * Deletes resolved queue rows older than `olderThanIso`. Without this the table
 * is append-only for the life of the install and every approvals query scans
 * the whole history.
 *
 * The returned count is ADVISORY. It is the count taken BEFORE the delete, so a
 * concurrent sweep or a row resolved between the count and the delete makes it
 * drift from the number of rows this call actually removed. Nothing consumes it
 * for correctness — it exists for logging, for `approvals prune` to report, and
 * for tests. Do not build a check on it; re-count if you need a true figure.
 *
 * MULTI-STEP ON ONE HANDLE, so it refreshes. The count and the delete are two
 * steps with an await between them, and a LanceDB handle is pinned to the
 * version it was opened at: an apply committing in that window makes the raw
 * `table.delete()` THROW `Commit conflict for version N` (measured, 0.15.0,
 * 2026-08-07 — same behaviour as `update()`), and makes the raw `countRows()`
 * answer from the stale snapshot with no error at all. The sweep runs after
 * every apply/reject, and the caller in `actions/approval.ts` swallows its
 * failures with a warning, so the un-refreshed version degraded into "the
 * retention sweep quietly stops running whenever anything else is writing".
 */
export async function prunePendingOperations(
  olderThanIso: string,
): Promise<number> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const filter = buildPruneFilter(olderThanIso);
  // Count first: a LanceDB delete rewrites the table, so a no-op sweep should
  // not pay for one. This runs after every apply/reject, where nothing to
  // prune is the common case. At the latest version, so the decision is not
  // made from a snapshot taken before someone else's commit.
  await table.checkoutLatest();
  const doomed = await table.countRows(filter);
  if (doomed === 0) return 0;
  await deleteAtLatestVersion(table, filter);
  return doomed;
}

export async function countPendingOperations(
  status: PendingOperationStatus = "pending",
): Promise<number> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  return table.countRows(`status = '${escapeSql(status)}'`);
}

export interface PendingOperationOutcome {
  id: string;
  status: Exclude<PendingOperationStatus, "pending">;
  error?: string;
}

export interface ClaimedResolutionResult {
  /** Outcomes whose row still carried this claim and was written. */
  resolved: number;
  /**
   * Outcomes whose row had left this claim before the write-back. The fact was
   * DISCARDED — for an `applied` entry that means a real Gmail mutation is now
   * unrecorded.
   */
  lost: PendingOperationOutcome[];
}

/**
 * The line logged when a claimed apply's outcome could not be written down.
 *
 * Exported so the test asserts on the same string the operator reads, and so
 * the sentence is reviewed as user-facing text rather than buried in a call.
 */
export function describeLostClaimedOutcomes(
  lost: readonly PendingOperationOutcome[],
): string {
  const appliedIds = lost
    .filter((outcome) => outcome.status === "applied")
    .map((outcome) => outcome.id);
  const base =
    `Approval queue: ${lost.length} operation outcome${lost.length === 1 ? "" : "s"} could not be ` +
    `recorded — the queue row${lost.length === 1 ? "" : "s"} left this apply's claim before the ` +
    `write-back, which happens when a stranded-row adjudication re-stamped ` +
    `${lost.length === 1 ? "it" : "them"} while this apply was still in flight. ` +
    `Row ids: ${lost.map((outcome) => outcome.id).join(", ")}.`;
  if (appliedIds.length === 0) return base;
  return (
    `${base} ${appliedIds.length} of ${lost.length === 1 ? "them" : "those"} reached Gmail ` +
    `successfully (${appliedIds.join(", ")}); if the user answered "it didn't happen", ` +
    `${appliedIds.length === 1 ? "that row is" : "those rows are"} now pending again and the change ` +
    `can be sent to Gmail a second time.`
  );
}

/**
 * Finalizes rows this attempt claimed. Every predicate is scoped to the claim
 * token, so a resolver can only ever write rows it owns.
 *
 * DETECTS ITS OWN LOST WRITES. Every update here is scoped to `claimToken AND
 * status = 'applying'`, so a stranded-row adjudication that re-stamped the row
 * while this apply was calling Gmail silently reduces the write to a no-op —
 * LanceDB reports no row count, and the earlier version of this function
 * returned void and never looked. A real `applied` fact was thrown away with
 * nothing anywhere recording it, which is the exact failure class the approval
 * queue exists to eliminate. The write-back keeps the token on every row it
 * reaches, so a single read by token afterwards says exactly which outcomes
 * landed; the rest are reported and logged.
 *
 * It reports, it does not repair. Overwriting the adjudication would replace
 * the user's checked answer with a record they have already contradicted.
 */
export async function resolveClaimedOperations(
  outcomes: PendingOperationOutcome[],
  token: string,
  resolvedAt: string,
): Promise<ClaimedResolutionResult> {
  if (outcomes.length === 0) return { resolved: 0, lost: [] };
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  const claimScope = buildClaimFilter(token, "applying");
  const idsByStatus = new Map<string, string[]>();
  const individual: PendingOperationOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.error) {
      individual.push(outcome);
    } else {
      const ids = idsByStatus.get(outcome.status) ?? [];
      ids.push(outcome.id);
      idsByStatus.set(outcome.status, ids);
    }
  }

  for (const [status, ids] of idsByStatus) {
    await updateAtLatestVersion(table, {
      where: `${buildIdListFilter(ids)} AND ${claimScope}`,
      values: { status, error: "", resolvedAt },
    });
  }
  for (const outcome of individual) {
    await updateAtLatestVersion(table, {
      where: `${buildIdListFilter([outcome.id])} AND ${claimScope}`,
      values: {
        status: outcome.status,
        error: outcome.error ?? "",
        resolvedAt,
      },
    });
  }

  // Read back by token alone (not by token + status): a row this call wrote
  // still carries the token, whatever status it was written to, while a row an
  // adjudication took has had the token replaced and then cleared.
  const survivors = await queryAtLatestVersion(
    table,
    `\`claimToken\` = '${escapeSql(token)}'`,
  );
  const survivingIds = new Set(survivors.map((row) => row.id));
  const lost = outcomes.filter((outcome) => !survivingIds.has(outcome.id));
  if (lost.length > 0) console.warn(describeLostClaimedOutcomes(lost));
  return { resolved: outcomes.length - lost.length, lost };
}
