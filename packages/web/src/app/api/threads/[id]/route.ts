import { NextResponse, type NextRequest } from "next/server";
import { getThreadById } from "@gmail-reader/core/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const thread = await getThreadById(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json(thread);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
