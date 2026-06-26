import { NextResponse, type NextRequest } from "next/server";
import { clusterEmails } from "@email-agent/core/analysis";
import {
  internalErrorResponse,
  mutationGuardResponse,
} from "@/modules/api/validation";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const clusters = await clusterEmails();
    return NextResponse.json(clusters);
  } catch (err) {
    return internalErrorResponse(err, "Failed to cluster emails");
  }
}
