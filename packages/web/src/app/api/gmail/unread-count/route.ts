import { NextResponse, type NextRequest } from "next/server";
import { getEmails } from "@email-agent/core/db";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") ?? undefined;

  try {
    const emails = await getEmails({ unreadOnly: true, accountId });
    return NextResponse.json({ count: emails.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
