import { NextResponse, type NextRequest } from "next/server";
import { getEmailById } from "@gmail-reader/core/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const email = await getEmailById(id);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }
    return NextResponse.json(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
