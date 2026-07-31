import { NextResponse, type NextRequest } from "next/server";
import { getActionResults, initDb } from "@email-agent/core/db";
import { internalErrorResponse } from "@/modules/api/validation";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await initDb();
    const results = await getActionResults({ actionId: id, limit: 50 });
    return NextResponse.json(results);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load action results");
  }
}
