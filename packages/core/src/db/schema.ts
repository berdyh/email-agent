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
  // "" is the unscoped sentinel: a legacy/ADC row OR a mixed multi-account run
  // whose processed emails did not resolve to a single account.
  accountId: string;
  status: string;
  emailIds: string; // JSON array
  resultData: string; // JSON string
  agentUsed: string;
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
