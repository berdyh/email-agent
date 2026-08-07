import { NextResponse, type NextRequest } from "next/server";
import { countEmails, initDb } from "@email-agent/core/db";
import { internalErrorResponse, readGuardResponse } from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  // Every mail-derived read carries the same origin check, counts included, so
  // there is no "this one is only a number" exception to keep track of.
  const guard = readGuardResponse(request);
  if (guard) return guard;

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
