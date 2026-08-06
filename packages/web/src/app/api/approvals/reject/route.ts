import { NextResponse, type NextRequest } from "next/server";
import { rejectPendingOperationsByIds } from "@email-agent/core/actions";
import { initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseApprovalIdsRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const { ids } = parseApprovalIdsRequest(await request.json());

    await initDb();
    const rejected = await rejectPendingOperationsByIds(ids);
    return NextResponse.json({ rejected });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to reject operations");
  }
}
