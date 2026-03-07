import { NextResponse, type NextRequest } from "next/server";
import { countEmails } from "@email-agent/core/db";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") ?? undefined;

  try {
    const count = await countEmails({ unreadOnly: true, accountId });
    return NextResponse.json({ count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
