import { NextResponse, type NextRequest } from "next/server";
import { getThreadById, initDb } from "@email-agent/core/db";
import { internalErrorResponse } from "@/modules/api/validation";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await initDb();
    const thread = await getThreadById(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json(thread);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load thread");
  }
}
