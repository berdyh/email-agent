import { NextResponse, type NextRequest } from "next/server";
import { getEmails } from "@email-agent/core/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const unreadOnly = params.get("unreadOnly") === "true";
  const limit = Number(params.get("limit")) || 50;
  const offset = Number(params.get("offset")) || 0;
  const accountId = params.get("accountId") ?? undefined;

  try {
    const emails = await getEmails({ unreadOnly, limit, offset, accountId });
    return NextResponse.json(emails);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
