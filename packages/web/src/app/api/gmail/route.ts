import { NextResponse, type NextRequest } from "next/server";
import { getEmails, initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  parseEmailListQuery,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(request: NextRequest) {
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
