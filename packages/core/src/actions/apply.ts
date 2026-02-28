import {
  markAsRead,
  markAsUnread,
  trashMessage,
  markAsSpam,
  addLabels,
  removeLabels,
} from "../gmail/operations.js";
import type {
  ActionEmailResult,
  GmailOperation,
  ActionApplyResult,
} from "./types.js";

/**
 * Maps action output results to concrete Gmail operations.
 * Each action type has its own mapping logic based on the AI's output fields.
 */
export function mapResultToOperations(
  actionId: string,
  results: ActionEmailResult[],
): GmailOperation[] {
  const operations: GmailOperation[] = [];

  for (const result of results) {
    const ops = mapSingleResult(actionId, result);
    operations.push(...ops);
  }

  return operations;
}

function mapSingleResult(
  actionId: string,
  result: ActionEmailResult,
): GmailOperation[] {
  switch (actionId) {
    case "junk":
      return mapJunkResult(result);
    case "subscription":
      return mapSubscriptionResult(result);
    default:
      return [];
  }
}

function mapJunkResult(result: ActionEmailResult): GmailOperation[] {
  const recommendation = result["recommendation"] as string | undefined;
  if (!recommendation) return [];

  switch (recommendation) {
    case "delete":
      return [{ emailId: result.emailId, type: "trash" }];
    case "spam":
      return [{ emailId: result.emailId, type: "spam" }];
    case "archive":
      return [
        { emailId: result.emailId, type: "removeLabels", labelIds: ["INBOX"] },
      ];
    default:
      return [];
  }
}

function mapSubscriptionResult(result: ActionEmailResult): GmailOperation[] {
  const isSubscription = result["isSubscription"] as boolean | undefined;
  const category = result["category"] as string | undefined;

  if (!isSubscription) return [];

  // Marketing emails that aren't digest-worthy → archive
  if (category === "marketing" && !result["digestWorthy"]) {
    return [
      { emailId: result.emailId, type: "removeLabels", labelIds: ["INBOX"] },
    ];
  }

  return [];
}

/**
 * Executes Gmail operations, collecting successes and failures.
 */
export async function applyOperations(
  operations: GmailOperation[],
  accountEmail?: string,
): Promise<ActionApplyResult> {
  let applied = 0;
  let failed = 0;
  const errors: Array<{ emailId: string; error: string }> = [];

  for (const op of operations) {
    try {
      switch (op.type) {
        case "trash":
          await trashMessage(op.emailId, accountEmail);
          break;
        case "spam":
          await markAsSpam(op.emailId, accountEmail);
          break;
        case "markRead":
          await markAsRead(op.emailId, accountEmail);
          break;
        case "markUnread":
          await markAsUnread(op.emailId, accountEmail);
          break;
        case "addLabels":
          if (op.labelIds?.length) {
            await addLabels(op.emailId, op.labelIds, accountEmail);
          }
          break;
        case "removeLabels":
          if (op.labelIds?.length) {
            await removeLabels(op.emailId, op.labelIds, accountEmail);
          }
          break;
      }
      applied++;
    } catch (err) {
      failed++;
      errors.push({
        emailId: op.emailId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { applied, failed, errors };
}

/**
 * Returns a summary of operations grouped by type for display.
 */
export function summarizeOperations(
  operations: GmailOperation[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const op of operations) {
    summary[op.type] = (summary[op.type] ?? 0) + 1;
  }
  return summary;
}
