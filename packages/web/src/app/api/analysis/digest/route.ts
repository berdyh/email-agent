import { NextResponse, type NextRequest } from "next/server";
import { getEmails, initDb, recordToGmailMessage } from "@email-agent/core/db";
import { generateDigest } from "@email-agent/core/analysis";
import {
  internalErrorResponse,
  mutationGuardResponse,
} from "@/modules/api/validation";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const emailRecords = await getEmails({ limit: 100 });
    const emails = emailRecords.map(recordToGmailMessage);

    const digest = await generateDigest(emails);
    return NextResponse.json(digest);
  } catch (err) {
    return internalErrorResponse(err, "Failed to generate digest");
  }
}
