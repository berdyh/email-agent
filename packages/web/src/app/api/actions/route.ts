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
  parseJsonBody,
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
    const body = parseActionRunRequest(await parseJsonBody(request));
    let action = registry.get(body.actionId);

    // Fall back to user actions if not found in built-ins
    if (!action) {
      action = await loadUserAction(body.actionId);
    }

    if (!action) {
      // TWO DIFFERENT SITUATIONS REACH HERE, and they used to give the same
      // flat 404: no file answers to this id at all, and a file answers to it
      // and could not be loaded (a numeric `id`, a value import, some construct
      // the source evaluator refuses). The second is diagnosed loudly in the
      // SERVER LOG by `loadUserAction` and reached the browser as "not found" —
      // which is exactly how a tightened validation rule goes silent: the user
      // is looking at the action on the page and is told it does not exist.
      //
      // `listUserActions()` carries the reason on `UserActionMeta.problem` for
      // precisely this. A file that PRESENTS the id answers 422 with the
      // reason; 404 is reserved for an id nothing on disk presents.
      const problem = (await listUserActions()).find(
        (meta) => meta.id === body.actionId && meta.problem !== undefined,
      )?.problem;

      if (problem !== undefined) {
        return NextResponse.json(
          { error: `Action "${body.actionId}" could not be loaded: ${problem}` },
          { status: 422 },
        );
      }
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
