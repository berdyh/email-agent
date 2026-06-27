import { NextResponse, type NextRequest } from "next/server";
import { countEmails, initDb } from "@email-agent/core/db";
import { internalErrorResponse } from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.has("accountId")
    ? request.nextUrl.searchParams.get("accountId")!
    : undefined;

  try {
    await initDb();
    const count = await countEmails({ unreadOnly: true, accountId });
    return NextResponse.json({ count });
  } catch (err) {
    return internalErrorResponse(err, "Failed to load unread count");
  }
}
