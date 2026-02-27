import { NextResponse } from "next/server";
import { getEmails } from "@email-agent/core/db";
import { generateDigest } from "@email-agent/core/analysis";

export async function POST() {
  try {
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
