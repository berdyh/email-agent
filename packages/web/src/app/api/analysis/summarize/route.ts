import { NextResponse, type NextRequest } from "next/server";
import { getEmailById, initDb } from "@email-agent/core/db";
import { summarizeEmail } from "@email-agent/core/analysis";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseEmailIdRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseEmailIdRequest(await request.json());
    await initDb();
    const email = await getEmailById(body.emailId, body.accountId);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    const summary = await summarizeEmail({
      id: email.id,
      threadId: email.threadId,
      from: email.from,
      to: email.to,
      subject: email.subject,
      date: email.date,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      labels: JSON.parse(email.labels) as string[],
      isUnread: email.isUnread,
      senderDomain: email.senderDomain,
      snippet: email.snippet,
    });

    return NextResponse.json(summary);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to summarize email");
  }
}
