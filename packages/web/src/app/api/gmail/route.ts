import { NextResponse, type NextRequest } from "next/server";
import { getEmails, initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  parseEmailListQuery,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  // Returns subjects, senders and snippets — same data class as the approval
  // queue, so it gets the same read-side origin check.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    const { unreadOnly, limit, offset, accountId } = parseEmailListQuery(
      request.nextUrl.searchParams,
    );
    await initDb();
    const emails = await getEmails({ unreadOnly, limit, offset, accountId });
    return NextResponse.json(emails);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to load emails");
  }
}
