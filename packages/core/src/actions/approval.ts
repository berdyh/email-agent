import { randomUUID } from "node:crypto";
import {
  savePendingOperations,
  claimPendingOperations,
  getPendingOperationsForEmails,
  prunePendingOperations,
  resolveClaimedOperations,
  type PendingOperationOutcome,
} from "../db/pending-operations.js";
import type { PendingOperationRecord } from "../db/schema.js";
import { loadSettings } from "../config/settings.js";
import { applyOperations } from "./apply.js";
import type {
  ActionApplyResult,
  GmailOperation,
  GmailOperationType,
} from "./types.js";

export interface EnqueueOperationsInput {
  batchId: string;
  actionId: string;
  actionName: string;
  operations: GmailOperation[];
  createdAt?: string;
}

export function toPendingOperationRecords(
  input: EnqueueOperationsInput,
): PendingOperationRecord[] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return input.operations.map((op) => ({
    id: randomUUID(),
    batchId: input.batchId,
    actionId: input.actionId,
    actionName: input.actionName,
    // "" is the unscoped/gcloud-ADC sentinel. See `recordToGmailOperation` for
    // what replaying it later actually resolves to, and what a user sees when
    // that is no longer the mailbox the message was read from.
    //
    // Where it comes from: `scopeOperationsToAccounts` fills `op.accountEmail`
    // from the run's explicit account, or from the per-message lookup built out
    // of the `emails` rows' own `accountId`. So a "" here is inherited from an
    // email row that was itself stored under "" — fetched through the gcloud
    // ADC path, or before the `accountId` column existed. Pinning it harder at
    // enqueue time would mean a live `users.getProfile` call per batch.
    accountId: op.accountEmail ?? "",
    emailId: op.emailId,
    type: op.type,
    labelIds: JSON.stringify(op.labelIds ?? []),
    status: "pending",
    error: "",
    claimToken: "",
    createdAt,
    claimedAt: "",
    resolvedAt: "",
  }));
}

/**
 * Human-readable label for a proposed Gmail change. This is the sentence the
 * user reads before approving an irreversible mutation, so it lives in core and
 * is shared by every approval surface — a CLI/web copy that drifted would
 * describe the same queued row two different ways.
 */
export function describeGmailOperation(
  type: string,
  labelIds: string[] = [],
): string {
  switch (type) {
    case "trash":
      return "Move to Trash";
    case "spam":
      return "Mark as Spam";
    case "markRead":
      return "Mark as Read";
    case "markUnread":
      return "Mark as Unread";
    case "removeLabels":
      return labelIds.length === 1 && labelIds[0] === "INBOX"
        ? "Archive"
        : `Remove labels: ${labelIds.join(", ")}`;
    case "addLabels":
      return `Add labels: ${labelIds.join(", ")}`;
    default:
      return type;
  }
}

/** True for operations that hide or destroy mail, which warrant extra confirmation. */
export function isDestructiveOperation(type: string): boolean {
  return type === "trash" || type === "spam";
}

/**
 * Queue rows are read back from disk and may predate the current build, so a
 * malformed `labelIds` must not take down the whole approval list — a single
 * unparsable row would otherwise 500 the approvals route and hide every other
 * queued change from review.
 */
export function parseLabelIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Rebuilds the Gmail operation a queue row describes, for replay at approval
 * time.
 *
 * WHAT AN UNSCOPED ROW REPLAYS AGAINST. `accountId` is carried through as
 * `accountEmail`, so a row queued under the "" sentinel reaches
 * `createGmailClient("")`, which is documented to mean gcloud ADC and nothing
 * else: an explicit empty string never falls through to a configured default
 * account (`gmail/client.ts`). The row is therefore applied against whatever
 * identity `gcloud auth application-default print-access-token` resolves to
 * **at approval time**, which is not necessarily the identity the message was
 * read under — approval can be hours or days later, and ADC is re-pointed by a
 * plain `gcloud auth application-default login`.
 *
 * Named-account rows are unaffected. `createGmailClient("me@example.com")`
 * loads that account's stored tokens and throws if they are missing rather than
 * falling back to ADC, so it cannot silently address a different mailbox.
 *
 * WHAT A USER WOULD OBSERVE if ADC has moved to a different Google account
 * between queueing and approval. Gmail message ids are per-mailbox, so the id
 * on the row is looked up in a mailbox that does not have it: the API answers
 * 404, `applyOperations` catches it per operation, and the row is resolved
 * `failed` with the Gmail error text. The approval surface shows the change as
 * failed; no mail is trashed or labelled in either mailbox. A `failed` row is
 * terminal — it is not `pending`, so it cannot be approved again, and
 * re-proposing the change means re-running the action. If ADC has instead been
 * revoked (or `gcloud` is gone), the token fetch throws and every unscoped row
 * in the batch fails the same way.
 *
 * NOT claimed: that mutating the wrong mailbox is impossible. Nothing here
 * checks that the resolved identity matches the one that produced the row; the
 * 404 is a property of Gmail's id space, not a guard we implement. If the id
 * did exist in the other mailbox, that message would be mutated.
 *
 * Two additions were considered and are recorded in TODOS.md rather than done:
 * resolving the identity with `users.getProfile` at enqueue time — a live API
 * call added to a path that is currently DB-only, and whose failure means the
 * proposal is never recorded at all — and re-resolving it at apply time to
 * compare, which costs the same call and can only report the mismatch after
 * the row has already been claimed.
 */
export function recordToGmailOperation(
  record: PendingOperationRecord,
): GmailOperation {
  const labelIds = parseLabelIds(record.labelIds);
  const operation: GmailOperation = {
    emailId: record.emailId,
    type: record.type as GmailOperationType,
    accountEmail: record.accountId,
  };
  if (labelIds.length > 0) operation.labelIds = labelIds;
  return operation;
}

/**
 * Identity of a proposed Gmail change, for dedupe purposes.
 *
 * Account, message, operation type and labels all participate: "archive m1"
 * and "add label Work to m1" are different proposals, and the same message id
 * in two accounts is two different messages. Labels are sorted so two
 * orderings of the same set collapse. Built with `JSON.stringify` rather than
 * a delimiter join so a value containing the delimiter cannot forge a
 * collision.
 */
export function operationDedupeKey(record: PendingOperationRecord): string {
  return JSON.stringify([
    record.accountId,
    record.emailId,
    record.type,
    [...parseLabelIds(record.labelIds)].sort(),
  ]);
}

/**
 * Indexes of `records` that are not already awaiting approval, given a
 * snapshot `existingKeys` of what was pending when the caller looked.
 *
 * Deduping is deliberately scoped to rows that are still PENDING. A
 * re-proposal after a rejection is legitimate — the user said no to one
 * instance, and suppressing the next one would hide the proposal entirely,
 * leaving them no way to see or act on it. The same argument covers `applied`:
 * the state that justified the change can recur (mail restored from Trash, a
 * label re-added), and a queue row is a proposal, not a mutation. What is
 * never useful is two identical rows sitting in the pending list at once,
 * which is exactly what re-running an action over the same unread mail before
 * approving produced.
 *
 * Duplicates inside the incoming batch are collapsed too, keeping the first —
 * that part IS exact, because the whole batch is in hand.
 *
 * Against rows already in the table it is only as good as the snapshot: see
 * `enqueueOperationsDetailed` for why this is best-effort.
 */
export function selectNewOperationIndexes(
  records: readonly PendingOperationRecord[],
  existingKeys: ReadonlySet<string>,
): number[] {
  const seen = new Set(existingKeys);
  const kept: number[] = [];
  records.forEach((record, index) => {
    const key = operationDedupeKey(record);
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(index);
  });
  return kept;
}

export interface EnqueueOperationsResult {
  /** Queue row ids actually written, in operation order. */
  ids: string[];
  /** The subset of the input operations those rows represent. */
  operations: GmailOperation[];
  /** How many proposals were dropped as already awaiting approval. */
  duplicates: number;
}

/**
 * Persist a batch of Gmail operations awaiting the user's approval.
 *
 * BEST-EFFORT DEDUPE, for the common serial case. This is a check-then-insert:
 * it reads the still-pending rows for these emails, then writes. Two action
 * runs racing (a `serve` and a CLI run, or two runs of the same action) can
 * both complete the read before either writes, and both will then insert rows
 * with distinct UUIDs. The queue shows the duplicate pending proposals and
 * will let the user apply both. It is NOT a uniqueness guarantee — do not
 * document or rely on it as one.
 *
 * Not made race-free, deliberately. LanceDB's only insert-if-absent primitive
 * is `mergeInsert(on).whenNotMatchedInsertAll()`, which matches on column
 * equality alone: it cannot express "insert unless a matching row is PENDING".
 * Keying on the dedupe identity would therefore also suppress re-proposals
 * after a rejection or an apply, which is the behaviour this dedupe exists to
 * NOT have — a suppressed re-proposal is invisible, leaving the user nothing
 * to act on. Trading a visible duplicate for a hidden proposal is the wrong
 * direction. (Whether two concurrent LanceDB commits can both land on the
 * local-filesystem backend is separately unconfirmed; see TODOS.md
 * "Cross-process claim atomicity is unconfirmed".)
 *
 * HOW BAD THE RACE IS DEPENDS ON `gmail.autoApplyActions`. With the approval
 * gate on — the default — the failure is benign in the direction that matters:
 * the duplicate is a redundant proposal sitting in the pending list, which the
 * user can see and reject, and no mutation happens without approval. With
 * auto-apply ON it is NOT benign: each racing runner immediately applies its
 * own queued ids (`actions/runner.ts`, the auto-apply branch), so neither
 * duplicate is ever pending for review and **Gmail receives both calls** for
 * the same change. Re-trashing an already-trashed message is idempotent enough
 * to be harmless; a second `addLabels`/`markUnread` pair racing an opposing
 * operation is not necessarily. Do not describe this as "a duplicate the user
 * can reject" without naming the auto-apply case, where there is nothing to
 * reject.
 */
export async function enqueueOperationsDetailed(
  input: EnqueueOperationsInput,
): Promise<EnqueueOperationsResult> {
  const records = toPendingOperationRecords(input);
  if (records.length === 0) return { ids: [], operations: [], duplicates: 0 };

  // Scoped to the emails in this batch rather than reading the whole queue.
  // A snapshot, not a lock — see the note above.
  const existing = await getPendingOperationsForEmails([
    ...new Set(records.map((record) => record.emailId)),
  ]);
  const existingKeys = new Set(existing.map(operationDedupeKey));
  const keep = selectNewOperationIndexes(records, existingKeys);

  const kept = keep.map((index) => records[index] as PendingOperationRecord);
  await savePendingOperations(kept);
  return {
    ids: kept.map((record) => record.id),
    operations: keep.map((index) => input.operations[index] as GmailOperation),
    duplicates: records.length - kept.length,
  };
}

/**
 * Persist a batch of Gmail operations awaiting the user's approval.
 * Returns the queue row ids, in operation order. Proposals identical to a row
 * already pending are skipped on a best-effort basis (see
 * `enqueueOperationsDetailed`), so this can be shorter than
 * `input.operations`.
 */
export async function enqueueOperations(
  input: EnqueueOperationsInput,
): Promise<string[]> {
  const result = await enqueueOperationsDetailed(input);
  return result.ids;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cutoff timestamp for a retention sweep, or null when retention is disabled.
 *
 * A non-finite or non-positive window disables pruning rather than pruning
 * everything — the failure direction for a misconfigured retention value must
 * be "keep too much", because the rows are the audit trail of real Gmail
 * mutations and cannot be reconstructed.
 */
export function resolveRetentionCutoff(
  days: number | undefined,
  now: Date = new Date(),
): string | null {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * Opportunistic retention sweep, run after a batch is resolved — the moment
 * the table just grew, and the only routine point where the queue is already
 * being written.
 *
 * Never throws: a housekeeping failure must not turn a successful approval
 * into a reported failure, which would tell the user their Gmail changes did
 * not happen when they did.
 *
 * Fails CLOSED on an unreadable configuration. `loadSettings()` now throws for
 * every read/parse failure that is not ENOENT rather than silently returning
 * the built-in defaults, so a settings file that cannot be read lands in the
 * catch below and NO rows are pruned. Previously it resolved to the 365-day
 * default and deleted audit rows belonging to a user who had explicitly set
 * `approvalQueueDays: 0` to keep them forever. "Keep too much" is the only
 * acceptable direction here — the rows record Gmail mutations that really
 * happened and nothing can reconstruct them.
 */
async function pruneResolvedOperationsQuietly(): Promise<void> {
  try {
    const settings = await loadSettings();
    const cutoff = resolveRetentionCutoff(settings.retention?.approvalQueueDays);
    if (cutoff === null) return;
    await prunePendingOperations(cutoff);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to prune resolved approval-queue rows: ${message}`);
  }
}

/**
 * How many rows are claimed, applied and resolved as one unit.
 *
 * Status used to be written once, after every Gmail call in the batch had
 * completed, so a crash anywhere in a 200-operation batch left all 200 rows
 * saying "applying" while up to 200 mailbox changes had really happened. The
 * other extreme — one claim/status write per operation — closes that window
 * completely but costs two LanceDB updates per row, and a LanceDB update
 * rewrites the table.
 *
 * 10 is the compromise. `applyOperations` awaits one Gmail round trip per
 * operation (~100-300ms each), so a chunk is roughly 1-3s of exposure
 * regardless of how large the batch is, while the number of table rewrites
 * stays proportional to batch/10 instead of batch. Approval batches in
 * practice are tens of rows.
 */
export const APPLY_RESOLUTION_CHUNK_SIZE = 10;

/** Splits a list into fixed-size chunks, preserving order. */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunkList requires a chunk size of at least 1");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Maps one chunk's Gmail outcomes onto queue-row resolutions.
 *
 * Fails CLOSED. `applyOperations` returns one outcome per input operation, in
 * order, so a missing entry means that contract broke — never assume the Gmail
 * mutation happened. Recording it "applied" would retire the row from the
 * queue and silently drop a change the user approved.
 */
export function toOperationOutcomes(
  rows: readonly PendingOperationRecord[],
  result: ActionApplyResult,
): PendingOperationOutcome[] {
  return rows.map((row, index) => {
    const outcome = result.outcomes[index];
    if (!outcome) {
      return {
        id: row.id,
        status: "failed",
        error: "No apply outcome was recorded for this operation",
      };
    }
    if (outcome.ok) return { id: row.id, status: "applied" };
    return { id: row.id, status: "failed", error: outcome.error ?? "" };
  });
}

/**
 * Concatenates per-chunk apply results back into one batch result. Chunks are
 * processed in order, so concatenating outcomes preserves the caller's input
 * ordering, which `toOperationOutcomes` and every surface rely on.
 */
export function mergeApplyResults(
  results: readonly ActionApplyResult[],
): ActionApplyResult {
  const merged: ActionApplyResult = {
    applied: 0,
    failed: 0,
    errors: [],
    outcomes: [],
  };
  for (const result of results) {
    merged.applied += result.applied;
    merged.failed += result.failed;
    merged.errors.push(...result.errors);
    merged.outcomes.push(...result.outcomes);
  }
  return merged;
}

/**
 * The three side-effecting steps of a chunked apply, plus token minting.
 *
 * Injected rather than imported so the *sequencing* — which is the whole
 * correctness argument below — can be tested without a LanceDB table or a
 * Gmail account. `applyPendingOperationsByIds` supplies the real ones.
 */
export interface ChunkedApplyDeps {
  /** A fresh, unguessable claim token. */
  newToken(): string;
  /** Moves the given rows out of `pending`; returns only the rows won. */
  claim(
    ids: string[],
    token: string,
  ): Promise<PendingOperationRecord[]>;
  /** Performs the Gmail mutations. */
  apply(operations: GmailOperation[]): Promise<ActionApplyResult>;
  /** Writes the outcomes back, scoped to `token`. */
  resolve(
    outcomes: PendingOperationOutcome[],
    token: string,
  ): Promise<void>;
}

/**
 * Claims, applies and resolves `ids` one chunk at a time.
 *
 * CLAIM BEFORE MUTATING. A row is moved out of `pending` and stamped with its
 * chunk's token *before* any Gmail call, and only the rows we actually won come
 * back. Without this, a Reject issued while an apply was in flight would
 * succeed against still-pending rows, be reported to the user as honored, and
 * then be silently overwritten as the apply completed — mail destroyed after
 * the user personally refused it, which is the exact failure this whole feature
 * exists to prevent.
 *
 * CLAIM PER CHUNK, not once up front. Claiming the whole batch first bounded
 * the mutated-but-unrecorded set to one chunk but NOT the stranded set: a crash
 * or a LanceDB failure during the first chunk left every remaining row sitting
 * in `applying`, ineligible for approval or rejection, even though only ten had
 * reached Gmail. With the claim inside the loop the claimed set and the
 * in-flight set coincide.
 *
 * THE BOUND IS PER CALL, NOT PER BATCH. State it that way everywhere: at most
 * one chunk *of this invocation* can be stranded in `applying`, and every id
 * this invocation has not yet reached is still `pending`. Nothing serializes
 * two concurrent apply calls over one batch, and they leapfrog — A claims ids
 * 1-10 and starts calling Gmail; B loses those to A's claim, continues, and
 * claims 11-20 while A is still in flight; a process death now strands twenty
 * rows, two chunks, one per caller. The invariant that survives concurrency is
 * "one chunk per in-flight caller", and the only way to make it "one chunk,
 * full stop" is to serialize applies at batch level, which is not done here.
 * Do not restate the per-call bound as a per-batch one.
 *
 * A fresh token per chunk keeps the claim/lease discipline intact — resolution
 * predicates are scoped to `claimToken` AND `status`, so a chunk can only ever
 * write rows it personally won, and no two chunks share a scope.
 */
export async function applyClaimedOperationsInChunks(
  ids: readonly string[],
  deps: ChunkedApplyDeps,
  chunkSize: number = APPLY_RESOLUTION_CHUNK_SIZE,
): Promise<ActionApplyResult> {
  const results: ActionApplyResult[] = [];
  for (const idChunk of chunkList(ids, chunkSize)) {
    const token = deps.newToken();
    const rows = await deps.claim(idChunk, token);
    // Nothing won — a concurrent apply or reject took them. Move on; the next
    // chunk is independent.
    if (rows.length === 0) continue;

    const chunkResult = await deps.apply(rows.map(recordToGmailOperation));
    results.push(chunkResult);
    // Deliberately NOT wrapped: if outcomes cannot be recorded, stop rather
    // than keep mutating mail whose fate we are unable to write down. This
    // chunk's rows stay claimed and surface via `getStaleApplyingOperations()`;
    // every later id is untouched and still `pending`.
    await deps.resolve(toOperationOutcomes(rows, chunkResult), token);
  }
  return mergeApplyResults(results);
}

/**
 * Applies queued operations the user approved, by queue row id.
 * Only rows still in "pending" state are applied; each row is marked
 * applied/failed afterwards. Returns the aggregate apply result.
 */
export async function applyPendingOperationsByIds(
  ids: string[],
): Promise<ActionApplyResult> {
  if (ids.length === 0) {
    return { applied: 0, failed: 0, errors: [], outcomes: [] };
  }

  const result = await applyClaimedOperationsInChunks(ids, {
    newToken: randomUUID,
    claim: (chunkIds, token) =>
      claimPendingOperations(chunkIds, token, "applying"),
    apply: applyOperations,
    resolve: (outcomes, token) =>
      resolveClaimedOperations(outcomes, token, new Date().toISOString()),
  });

  await pruneResolvedOperationsQuietly();
  return result;
}

/**
 * Marks queued operations rejected (kept as an audit trail, never applied).
 * Returns the number of rows actually rejected.
 */
export async function rejectPendingOperationsByIds(
  ids: string[],
): Promise<number> {
  // Same claim discipline: only rows still `pending` are rejected, and the
  // count is the number actually won — never a pre-read count that might
  // include rows an in-flight apply already claimed. Telling a user their
  // rejection covered a change that was concurrently being applied would be
  // the same lie from the other direction.
  const claimed = await claimPendingOperations(
    ids,
    randomUUID(),
    "rejected",
    new Date().toISOString(),
  );
  await pruneResolvedOperationsQuietly();
  return claimed.length;
}
