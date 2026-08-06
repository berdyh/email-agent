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
  isFullyStaleApply,
  staleApplyMessage,
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
    // was empty and when every row had already been resolved by another tab,
    // the CLI, or an auto-apply run — and the UI used to toast the second case
    // as "Applied 0 changes". Say which one actually happened.
    if (isFullyStaleApply(ids, result)) {
      return NextResponse.json(
        { ...body, error: staleApplyMessage(requested) },
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
