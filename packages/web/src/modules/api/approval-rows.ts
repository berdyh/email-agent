import {
  describeGmailOperation,
  isDestructiveOperation,
  parseLabelIds,
} from "@email-agent/core/actions";
import { emailRefKey, getEmailsByRefs } from "@/modules/api/email-lookup";
import type {
  ApprovalEmailSummary,
  ApprovalOperation,
} from "@/modules/api/approvals-contract";

/**
 * The minimum a queue row must carry to be rendered on an approval surface.
 * Structural rather than `PendingOperationRecord`, so this module's only core
 * dependency is the three display helpers.
 */
export interface ApprovalRowInput {
  id: string;
  batchId: string;
  actionId: string;
  actionName: string;
  accountId: string;
  emailId: string;
  type: string;
  labelIds: string;
  createdAt: string;
}

/**
 * Turns queue rows into the wire shape both approval lists render.
 *
 * Shared by `GET /api/approvals` (pending) and `GET /api/approvals/stranded`
 * (`applying`) on purpose: the label a user reads before deciding the fate of a
 * message must not depend on which list the row happens to be in. It does ONE
 * batched email scan for the whole set, not one per row.
 */
export async function toApprovalOperations(
  rows: readonly ApprovalRowInput[],
): Promise<ApprovalOperation[]> {
  const emails = await getEmailsByRefs(
    rows.map((row) => ({ accountId: row.accountId, emailId: row.emailId })),
  );

  return rows.map((row) => {
    const email = emails.get(emailRefKey(row.accountId, row.emailId));
    const labelIds = parseLabelIds(row.labelIds);
    return {
      id: row.id,
      batchId: row.batchId,
      actionId: row.actionId,
      actionName: row.actionName,
      accountId: row.accountId,
      emailId: row.emailId,
      type: row.type,
      labelIds,
      // Derived here so the wording the user approves comes from one place in
      // core and cannot drift per surface — web components may not import core
      // runtime themselves.
      label: describeGmailOperation(row.type, labelIds),
      destructive: isDestructiveOperation(row.type),
      createdAt: row.createdAt,
      email: email
        ? ({
            subject: email.subject,
            from: email.from,
            date: email.date,
            snippet: email.snippet,
          } satisfies ApprovalEmailSummary)
        : null,
    };
  });
}
