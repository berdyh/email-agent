import { NextResponse, type NextRequest } from "next/server";
import { getEmailById } from "@gmail-reader/core/db";
import { summarizeEmail } from "@gmail-reader/core/analysis";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { emailId: string };
    const email = await getEmailById(body.emailId);
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
