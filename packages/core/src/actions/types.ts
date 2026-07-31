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
  tokensUsed: number;
  durationMs: number;
  pendingOperations?: GmailOperation[];
  /** Approval batch id (the action_results row id) when operations were enqueued. */
  batchId?: string;
  /** True when the user's opt-in auto-apply setting applied the batch immediately. */
  autoApplied?: boolean;
  /**
   * Set when the proposed operations could not be queued (or auto-applied).
   * The run itself succeeded, but the Gmail changes did not reach the approval
   * queue, so callers must not report them as awaiting approval.
   */
  queueError?: string;
  /** Present only for an auto-applied batch; approvals report their own result. */
  applyResult?: ActionApplyResult;
}
