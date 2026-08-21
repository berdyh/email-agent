import { NextResponse, type NextRequest } from "next/server";
import { rejectPendingOperationsByIds } from "@email-agent/core/actions";
import { initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseJsonBody,
  parseApprovalIdsRequest,
  validationResponse,
} from "@/modules/api/validation";
import type { RejectApprovalsResult } from "@/modules/api/approvals-contract";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const { ids } = parseApprovalIdsRequest(await parseJsonBody(request));

    await initDb();
    // Core claims each row before rejecting it and returns only the rows it
    // actually won, so anything left over was already resolved elsewhere —
    // same accounting as the apply route, so the UI can say so either way.
    const rejected = await rejectPendingOperationsByIds(ids, "web");
    const body: RejectApprovalsResult = {
      rejected,
      requested: ids.length,
      skipped: Math.max(0, ids.length - rejected),
    };
    return NextResponse.json(body);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to reject operations");
  }
}
