// Schema type definitions for LanceDB tables.
// These mirror the table structures in connection.ts and provide
// TypeScript interfaces for type-safe operations.

export interface EmailRecord {
  [key: string]: unknown;
  id: string;
  accountId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  labels: string; // JSON array of label strings
  isUnread: boolean;
  senderDomain: string;
  snippet: string;
  vector: number[];
}

export interface ActionResultRecord {
  [key: string]: unknown;
  id: string;
  actionId: string;
  /**
   * "" is an OVERLOADED sentinel and means either of two things: a legacy or
   * gcloud-ADC row, or an all-accounts run whose processed emails spanned more
   * than one account (`deriveResultAccountId` returns "" for a mixed batch).
   * Account-filtered history therefore cannot represent a genuine
   * multi-account run.
   *
   * DELIBERATELY NOT DISAMBIGUATED YET — the argument, so it is not re-derived:
   * the ambiguity is currently unobservable. `getActionResults` is read by
   * exactly one caller (`packages/web/src/app/api/actions/[id]/results/route.ts`),
   * and it filters by `actionId` only; the `accountId` option has no caller at
   * all. Both candidate fixes would ship a representation nothing reads, which
   * this repo already has three open entries about:
   * - A `mixed` marker separates legacy from mixed, but still cannot make a
   *   multi-account run visible under either account's filter — the
   *   user-facing half of the problem — while adding a third sentinel every
   *   future reader must learn.
   * - Per-account result rows break `batchId = action_results row id`, the key
   *   every `pending_operations` row is stamped with. One run would produce N
   *   history rows and the queue can only point at one, so the audit-trail
   *   join would have to be redesigned and both surfaces changed.
   *
   * The trigger for revisiting is a surface that actually filters action
   * history by account, i.e. the first caller to pass `accountId`. The shape to
   * reach for then is an `accountIds` JSON-array column — `"[]"` for legacy
   * rows, added in place with `ensureTableColumns`, filtered in JS, which
   * `getActionResults` already does for sorting — rather than another scalar
   * sentinel. Tracked in TODOS.md.
   */
  accountId: string;
  status: string;
  emailIds: string; // JSON array
  resultData: string; // JSON string
  agentUsed: string;
  /**
   * Total tokens processed for the request: all input (cached input counted at
   * FULL weight) + all output. A measure of work, not of money — per-provider
   * cache discounts are deliberately not modelled, because each provider prices
   * them differently and none reports a normalized figure. `0` means "not
   * reported", never "free". `agents/tokens.ts` owns the definition and the
   * per-provider arithmetic; call one of its helpers rather than summing usage
   * fields by hand.
   *
   * Rows written before feature/todos-w4-executors (2026-08-07) are NOT
   * comparable with rows written after it: each executor recorded a different
   * measurement into this one column then, and nothing in the row says which
   * side of the change it is on except `createdAt`.
   */
  tokensUsed: number;
  durationMs: number;
  createdAt: string;
}

export type PendingOperationStatus =
  | "pending"
  /** Claimed by an in-flight apply. Not pending, so it cannot also be rejected. */
  | "applying"
  | "applied"
  | "rejected"
  | "failed";

export interface PendingOperationRecord {
  [key: string]: unknown;
  id: string;
  /** Groups all operations produced by one action run (the action_results row id). */
  batchId: string;
  actionId: string;
  /** Denormalized for display — the action may be deleted before the batch is reviewed. */
  actionName: string;
  // "" is the unscoped sentinel, mirroring action_results.accountId.
  accountId: string;
  emailId: string;
  type: string; // GmailOperationType
  labelIds: string; // JSON array of label ids ("[]" when not applicable)
  status: string; // PendingOperationStatus
  error: string; // failure message when status === "failed", else ""
  /**
   * Identifies the single apply/reject attempt that claimed this row, so a
   * resolver only ever finalizes rows it actually won. "" while unclaimed.
   */
  claimToken: string;
  createdAt: string;
  /**
   * When this row left `pending` — i.e. when an apply/reject attempt claimed
   * it. "" while unclaimed. This is the age basis for stranded-row recovery:
   * `createdAt` records when the change was *proposed*, which can be days
   * before a claim, so a long-queued row claimed a second ago would otherwise
   * read as stale the moment it was picked up.
   *
   * Optional on the interface, NOT on the table: the Arrow column is
   * non-nullable and `toPendingOperationRecords` always writes "". It is
   * declared optional only so that adding it did not invalidate the
   * `PendingOperationRecord` literals the CLI and web packages already
   * construct in their fixtures. Tighten it to required once those are
   * updated (tracked in TODOS.md).
   */
  claimedAt?: string;
  resolvedAt: string; // "" while pending
}

export interface ClusterRecord {
  [key: string]: unknown;
  id: string;
  name: string;
  description: string;
  emailIds: string; // JSON array of account-scoped email keys
  method: string;
  centroid: number[];
}

// Table name constants
export const emailsTable = "emails";
export const actionResultsTable = "action_results";
export const clustersTable = "clusters";
export const pendingOperationsTable = "pending_operations";
