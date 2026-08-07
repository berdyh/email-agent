import { NextResponse, type NextRequest } from "next/server";
import { getPendingOperations, initDb } from "@email-agent/core/db";
import {
  describeGmailOperation,
  isDestructiveOperation,
  parseLabelIds,
} from "@email-agent/core/actions";
import { internalErrorResponse, readGuardResponse } from "@/modules/api/validation";
import { emailRefKey, getEmailsByRefs } from "@/modules/api/email-lookup";
import type {
  ApprovalEmailSummary,
  ApprovalOperation,
  ApprovalsResponse,
} from "@/modules/api/approvals-contract";

export async function GET(request: NextRequest) {
  // Subjects, senders and snippets of the user's mail. Guarded like every other
  // mail read, not left open because it happens to be a GET.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const rows = await getPendingOperations({ status: "pending" });

    // One batched scan for every queued email, instead of one scan per row.
    const emails = await getEmailsByRefs(
      rows.map((row) => ({ accountId: row.accountId, emailId: row.emailId })),
    );

    const operations: ApprovalOperation[] = rows.map((row) => {
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
        // Rendered verbatim by the panel. Derived here so the wording the user
        // approves comes from one place in core and cannot drift per surface —
        // web components may not import core runtime themselves.
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

    return NextResponse.json({
      operations,
      pendingCount: operations.length,
    } satisfies ApprovalsResponse);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load pending approvals");
  }
}
