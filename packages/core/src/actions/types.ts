import type { GmailMessage } from "../gmail/types.js";

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

export interface ActionInput {
  action: EmailAction;
  emails: GmailMessage[];
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
}

export interface ActionApplyResult {
  applied: number;
  failed: number;
  errors: Array<{ emailId: string; error: string }>;
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
  applyResult?: ActionApplyResult;
}
