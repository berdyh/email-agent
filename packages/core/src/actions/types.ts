export interface EmailAction {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** Expected JSON schema description for the agent's output */
  outputSchema?: string;
  /** Whether this is a built-in action */
  builtIn?: boolean;
}

export interface ActionOutput {
  /** Parsed structured result from the agent */
  results: ActionEmailResult[];
  rawText: string;
}

export interface ActionEmailResult {
  emailId: string;
  [key: string]: unknown;
}

export type GmailOperationType =
  | "trash"
  | "spam"
  | "markRead"
  | "markUnread"
  | "addLabels"
  | "removeLabels";

export interface GmailOperation {
  emailId: string;
  type: GmailOperationType;
  labelIds?: string[];
  accountEmail?: string;
}

export interface OperationOutcome {
  emailId: string;
  type: GmailOperationType;
  ok: boolean;
  error?: string;
}

export interface ActionApplyResult {
  applied: number;
  failed: number;
  errors: Array<{ emailId: string; error: string }>;
  /** Per-operation outcomes, in the same order as the input operations. */
  outcomes: OperationOutcome[];
}

export interface ActionRunResult {
  actionId: string;
  status: "success" | "error";
  output?: ActionOutput;
  error?: string;
  agentUsed: string;
  /**
   * Total tokens processed for the run: all input (cached input counted at FULL
   * weight) + all output. A measure of work, not of money — per-provider cache
   * discounts are deliberately not modelled, because each provider prices them
   * differently and none reports a normalized figure. `0` means "not reported",
   * never "free", so a surface must not render it as a cost of zero.
   *
   * `agents/tokens.ts` owns this definition and the per-provider arithmetic
   * (the providers disagree on whether cached input is included in or
   * additional to their `input_tokens`); call one of its helpers rather than
   * summing usage fields by hand. Persisted verbatim to
   * `action_results.tokensUsed`, where rows predating
   * feature/todos-w4-executors (2026-08-07) carry the old per-executor
   * measurements and are not comparable with new ones.
   */
  tokensUsed: number;
  durationMs: number;
  pendingOperations?: GmailOperation[];
  /** Approval batch id (the action_results row id) when operations were enqueued. */
  batchId?: string;
  /**
   * How many proposed operations were dropped at enqueue time because an
   * identical change was already pending approval. Set only when non-zero, so
   * a surface can say "3 of these were already awaiting approval" instead of
   * silently showing fewer rows than the action proposed.
   */
  duplicateOperations?: number;
  /** True when the user's opt-in auto-apply setting applied the batch immediately. */
  autoApplied?: boolean;
  /**
   * Set when the proposed operations never reached the approval queue — either
   * the enqueue itself failed, or the parent `action_results` row could not be
   * written so queueing was skipped. This is a strictly PRE-Gmail failure:
   * nothing was applied, and callers must not report the changes as awaiting
   * approval. Auto-apply failures use `applyError`, never this field.
   */
  queueError?: string;
  /**
   * Set when the opt-in auto-apply threw after the batch was queued.
   *
   * NOT interchangeable with `queueError`. `applyPendingOperationsByIds` claims
   * rows before it calls Gmail, so a throw here may mean nothing happened OR
   * that mail was really trashed/marked spam and only the bookkeeping failed.
   * Surfaces must report it as "may have been applied"; the message built by
   * `describeAutoApplyFailure` already says so, and both print it verbatim.
   * The stranded rows are LISTED by `getStaleApplyingOperations()` — a report,
   * not a recovery, and it still re-applies nothing, rolls back nothing and
   * resolves nothing itself. `verifyStrandedApplyingOperations` (`verify-
   * stranded.ts`) now sits in front of it and resolves what it can by reading
   * the message's current labels back from Gmail, WITHOUT the user, before
   * anyone is asked; `adjudicateStrandedOperations` closes out only the
   * residual it could not — a message gone, this account's credentials not
   * working, the check itself failing, an operation this build cannot
   * classify, or a `""`-account row whose match can never be trusted — by
   * recording what the USER says they found. Do not call EITHER path's rows
   * "recoverable": both record an end state, not a cause, and neither offers a
   * retry.
   */
  applyError?: string;
  /**
   * Set when the `action_results` row could not be persisted. The run itself
   * succeeded and its output is still returned, but this batch has no history
   * row — and no operations were queued against it, so nothing was applied.
   */
  persistError?: string;
  /** Present only for an auto-applied batch; approvals report their own result. */
  applyResult?: ActionApplyResult;
}
