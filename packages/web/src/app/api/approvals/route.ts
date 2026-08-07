import { NextResponse, type NextRequest } from "next/server";
import { getPendingOperations, initDb } from "@email-agent/core/db";
import { internalErrorResponse, readGuardResponse } from "@/modules/api/validation";
import { toApprovalOperations } from "@/modules/api/approval-rows";
import type { ApprovalsResponse } from "@/modules/api/approvals-contract";

export async function GET(request: NextRequest) {
  // Subjects, senders and snippets of the user's mail. Guarded like every other
  // mail read, not left open because it happens to be a GET.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const rows = await getPendingOperations({ status: "pending" });
    const operations = await toApprovalOperations(rows);

    return NextResponse.json({
      operations,
      pendingCount: operations.length,
    } satisfies ApprovalsResponse);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load pending approvals");
  }
}
