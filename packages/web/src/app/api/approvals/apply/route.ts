import { NextResponse, type NextRequest } from "next/server";
import { applyPendingOperationsByIds } from "@email-agent/core/actions";
import { initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseApprovalIdsRequest,
  validationResponse,
} from "@/modules/api/validation";
import {
  claimedNothing,
  unclaimedApplyMessage,
  summarizeApplyResult,
  type ApplyApprovalsResult,
} from "@/modules/api/approvals-contract";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const { ids } = parseApprovalIdsRequest(await request.json());

    await initDb();
    const result = await applyPendingOperationsByIds(ids);
    const { requested, skipped } = summarizeApplyResult(ids, result);
    const body: ApplyApprovalsResult = { ...result, requested, skipped };

    // A no-op is not a success. Core returns all-zero counts both when a batch
    // was empty and when this call could claim none of the rows — and the UI
    // used to toast the second case as "Applied 0 changes". 409 says the
    // client's view of the queue conflicts with the server's, which is exactly
    // what is known; the message does not guess at why each row was unclaimable.
    if (claimedNothing(ids, result)) {
      return NextResponse.json(
        { ...body, error: unclaimedApplyMessage(requested) },
        { status: 409 },
      );
    }

    return NextResponse.json(body);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to apply approved operations");
  }
}
