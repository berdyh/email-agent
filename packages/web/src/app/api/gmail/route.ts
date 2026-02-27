import { NextResponse, type NextRequest } from "next/server";
import { getEmails } from "@gmail-reader/core/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const unreadOnly = params.get("unreadOnly") === "true";
  const limit = Number(params.get("limit")) || 50;
  const offset = Number(params.get("offset")) || 0;

  try {
    const emails = await getEmails({ unreadOnly, limit, offset });
    return NextResponse.json(emails);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
