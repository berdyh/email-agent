import { NextResponse, type NextRequest } from "next/server";
import {
  ActionRegistry,
  ActionRunner,
  builtInActions,
  buildOperationAccountLookup,
  listUserActions,
  loadUserAction,
} from "@email-agent/core/actions";
import { getEmails, initDb, recordToGmailMessage } from "@email-agent/core/db";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseActionRunRequest,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";

const registry = new ActionRegistry();
const runner = new ActionRunner();
let loaded = false;

function ensureLoaded() {
  if (!loaded) {
    registry.loadStatic(builtInActions);
    loaded = true;
  }
}

export async function GET(request: NextRequest) {
  const guard = readGuardResponse(request);
  if (guard) return guard;

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
    return internalErrorResponse(err, "Failed to load actions");
  }
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    ensureLoaded();
    const body = parseActionRunRequest(await request.json());
    let action = registry.get(body.actionId);

    // Fall back to user actions if not found in built-ins
    if (!action) {
      action = await loadUserAction(body.actionId);
    }

    if (!action) {
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }

    // Get unread emails to run the action on
    await initDb();
    const emailRecords = await getEmails({ unreadOnly: true, limit: 20, accountId: body.accountEmail });
    const accountEmailByMessageId = buildOperationAccountLookup(emailRecords);
    const emails = emailRecords.map(recordToGmailMessage);

    const result = await runner.run(action, emails, body.accountEmail, accountEmailByMessageId);
    return NextResponse.json(result);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to run action");
  }
}
