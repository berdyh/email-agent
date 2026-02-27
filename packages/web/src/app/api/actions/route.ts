import { NextResponse, type NextRequest } from "next/server";
import { ActionRegistry, ActionRunner } from "@email-agent/core/actions";
import { getEmails } from "@email-agent/core/db";

const registry = new ActionRegistry();
const runner = new ActionRunner();
let loaded = false;

async function ensureLoaded() {
  if (!loaded) {
    await registry.loadAll();
    loaded = true;
  }
}

export async function GET() {
  try {
    await ensureLoaded();
    const actions = registry.getAll();
    return NextResponse.json(actions);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureLoaded();
    const body = (await request.json()) as { actionId: string };
    const action = registry.get(body.actionId);
    if (!action) {
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }

    // Get unread emails to run the action on
    const emailRecords = await getEmails({ unreadOnly: true, limit: 20 });
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

    const result = await runner.run(action, emails);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
