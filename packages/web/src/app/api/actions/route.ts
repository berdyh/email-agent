import { NextResponse, type NextRequest } from "next/server";
import { ActionRegistry, ActionRunner, builtInActions, listUserActions, loadUserAction } from "@email-agent/core/actions";
import { getEmails } from "@email-agent/core/db";

const registry = new ActionRegistry();
const runner = new ActionRunner();
let loaded = false;

function ensureLoaded() {
  if (!loaded) {
    registry.loadStatic(builtInActions);
    loaded = true;
  }
}

export async function GET() {
  try {
    ensureLoaded();
    const builtIns = registry.getAll().map((a) => ({ ...a, builtIn: true }));

    // Merge user actions (with filename for edit/delete)
    const userActions = await listUserActions();
    const userItems = userActions.map((u) => ({
      id: u.id,
      name: u.name,
      description: u.description,
      builtIn: false,
      filename: u.filename,
    }));

    return NextResponse.json([...builtIns, ...userItems]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    ensureLoaded();
    const body = (await request.json()) as { actionId: string };
    let action = registry.get(body.actionId);

    // Fall back to user actions if not found in built-ins
    if (!action) {
      action = await loadUserAction(body.actionId);
    }

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
