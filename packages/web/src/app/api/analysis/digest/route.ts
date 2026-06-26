import { NextResponse, type NextRequest } from "next/server";
import { getEmails, initDb } from "@email-agent/core/db";
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
    const emails = emailRecords.map((e) => ({
      id: e.id,
      threadId: e.threadId,
      from: e.from,
      to: e.to,
      subject: e.subject,
      date: e.date,
      bodyText: e.bodyText,
      bodyHtml: e.bodyHtml,
      labels: JSON.parse(e.labels) as string[],
      isUnread: e.isUnread,
      senderDomain: e.senderDomain,
      snippet: e.snippet,
    }));

    const digest = await generateDigest(emails);
    return NextResponse.json(digest);
  } catch (err) {
    return internalErrorResponse(err, "Failed to generate digest");
  }
}
