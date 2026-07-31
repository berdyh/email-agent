import { NextResponse, type NextRequest } from "next/server";
import { applyOperations } from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseApplyActionsRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseApplyActionsRequest(await request.json());

    const result = await applyOperations(body.operations, body.accountEmail);
    return NextResponse.json(result);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to apply Gmail operations");
  }
}
