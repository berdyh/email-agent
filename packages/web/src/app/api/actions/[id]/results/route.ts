import { NextResponse, type NextRequest } from "next/server";
import { getActionResults } from "@email-agent/core/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const results = await getActionResults({ actionId: id, limit: 50 });
    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
