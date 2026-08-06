import { NextResponse, type NextRequest } from "next/server";
import { getActionResults, initDb } from "@email-agent/core/db";
import { internalErrorResponse, readGuardResponse } from "@/modules/api/validation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Action results carry `resultData`: the model's raw text, the email ids it
  // decided about, its reasons, and whatever fields a user action chose to
  // return. That is mail-derived content, so it needs the same guard as
  // `/api/gmail` — this route had none, which left the whole action history
  // readable by any page the user visited.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  const { id } = await params;

  try {
    await initDb();
    const results = await getActionResults({ actionId: id, limit: 50 });
    return NextResponse.json(results);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load action results");
  }
}
